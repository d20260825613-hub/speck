import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import zlib from 'node:zlib';

import { analyzeFile, entropy, extractStrings } from '../src/analyze.js';
import { FORMATS, detectBom, extensionAgrees, identify, looksLikeText } from '../src/magic.js';

const cleanups = [];
after(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-'));
  cleanups.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

/** A minimal but valid PNG: signature, IHDR with dimensions, then IEND. */
function pngBuffer(width = 3, height = 2) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  const ihdr = chunk('IHDR', ihdrData);
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, iend]);
}

/**
 * A real PNG whose compressed image data is larger than the 64 KB read window.
 *
 * The size is the point: only a file this big puts IEND beyond everything the
 * analysis holds in memory, which is where the chunk walk used to lose the end
 * of the image and report nothing at all. The pixels come from a fixed
 * generator and are deflated the way an encoder deflates them, so this is a
 * legal PNG that any decoder would accept rather than a container with an
 * oversized chunk header.
 *
 * @param {number} [side] image is side x side, 8-bit RGBA
 * @param {number} [idatChunks] how many IDAT chunks to split the stream into
 */
function largePngBuffer(side = 200, idatChunks = 1) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(side, 0);
  ihdrData.writeUInt32BE(side, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);

  // Raw scanlines: a filter byte per row (0, "none"), then four bytes a pixel.
  const stride = 1 + side * 4;
  const raw = Buffer.alloc(stride * side);
  let state = 0x9e3779b9;
  for (let y = 0; y < side; y += 1) {
    for (let x = 1; x < stride; x += 1) {
      // A fixed xorshift32 stream: random-looking enough that deflate cannot
      // squeeze it, and identical on every run, so the fixture is reproducible.
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      raw[y * stride + x] = state & 0xff;
    }
  }

  const stream = zlib.deflateSync(raw);
  const perChunk = Math.ceil(stream.length / idatChunks);
  const idat = [];
  for (let at = 0; at < stream.length; at += perChunk) {
    idat.push(chunk('IDAT', stream.subarray(at, at + perChunk)));
  }
  return Buffer.concat([signature, chunk('IHDR', ihdrData), ...idat, chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** CRC32, because zlib.crc32 is not in every Node build. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal ZIP with one stored entry, a correct central directory, and an
 * optional archive comment — which the format allows and which is part of the
 * file rather than something appended to it. */
function zipBuffer(name = 'hello.txt', content = 'hi', comment = null) {
  const nameBytes = Buffer.from(name, 'latin1');
  const data = Buffer.from(content, 'latin1');
  const commentBytes = comment === null ? Buffer.alloc(0) : Buffer.from(comment, 'latin1');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const localPart = Buffer.concat([local, nameBytes, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(commentBytes.length, 20);

  return Buffer.concat([localPart, centralPart, end, commentBytes]);
}

// --- identification -------------------------------------------------------

test('every format in the table has the fields the code needs', () => {
  for (const format of FORMATS) {
    assert.equal(typeof format.id, 'string', `${format.id} needs an id`);
    assert.equal(typeof format.name, 'string', `${format.id} needs a name`);
    assert.ok(Array.isArray(format.magic) && format.magic.length > 0, `${format.id} needs magic bytes`);
    assert.ok(Array.isArray(format.extensions), `${format.id} needs an extensions list`);
    assert.ok(Array.isArray(format.kind) === false, `${format.id} kind must be a string`);
  }
});

test('identify recognises the formats it claims, from bytes alone', () => {
  const cases = [
    ['png', pngBuffer()],
    ['zip', zipBuffer()],
    ['gzip', zlib.gzipSync('hello world')],
    ['pdf', Buffer.from('%PDF-1.7\n%%EOF')],
    ['elf', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)])],
    ['pe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)])],
    ['sqlite', Buffer.from('SQLite format 3\0')],
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ['gif', Buffer.from('GIF89a')],
  ];
  for (const [expected, buffer] of cases) {
    const result = identify(buffer);
    assert.ok(result, `nothing matched for ${expected}`);
    assert.equal(result.id, expected, `expected ${expected}, got ${result.id}`);
  }
});

test('a JPEG and a PNG are told apart, since both are images', () => {
  assert.equal(identify(pngBuffer()).id, 'png');
  assert.equal(identify(Buffer.from([0xff, 0xd8, 0xff, 0xdb])).id, 'jpeg');
});

test('identify returns null rather than guessing', () => {
  assert.equal(identify(Buffer.from('just some ordinary text here')), null);
  assert.equal(identify(Buffer.alloc(0)), null);
  assert.equal(identify(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])), null);
});

test('a RIFF container is distinguished by what follows it', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(identify(wav).id, 'wav');
  assert.equal(identify(webp).id, 'webp');
});

test('extensionAgrees compares against the format, not a fixed list', () => {
  const png = identify(pngBuffer());
  assert.equal(extensionAgrees('.png', png), true);
  assert.equal(extensionAgrees('.PNG', png), true, 'case does not matter');
  assert.equal(extensionAgrees('.jpg', png), false);
  // A file with no extension is not a file whose extension disagrees: nothing
  // renamed it, so there is nothing to report. null is "no opinion", the same
  // answer as when the bytes match no known format.
  assert.equal(extensionAgrees(null, png), null);
  assert.equal(extensionAgrees('', png), null);
  assert.equal(extensionAgrees('.png', null), null, 'no format means no opinion');
});

test('looksLikeText separates text from binary', () => {
  assert.equal(looksLikeText(Buffer.from('a normal text file\nwith lines\n')), true);
  assert.equal(looksLikeText(Buffer.from([0x00, 0x01, 0x02, 0x03])), false);
  assert.equal(looksLikeText(pngBuffer()), false, 'binary with no NUL bytes is still binary');
});

test('a byte-order mark is reported when present', () => {
  assert.equal(detectBom(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'UTF-8');
  assert.equal(detectBom(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'UTF-16LE');
  assert.equal(detectBom(Buffer.from('no bom here')), null);
});

// --- entropy and strings --------------------------------------------------

test('entropy is 0 for one repeated byte and 8 for a uniform spread', () => {
  assert.equal(entropy(Buffer.alloc(1000, 0x41)), 0);
  const uniform = Buffer.alloc(256 * 4);
  for (let i = 0; i < uniform.length; i += 1) uniform[i] = i % 256;
  assert.ok(entropy(uniform) > 7.99, `expected near 8, got ${entropy(uniform)}`);
  assert.equal(entropy(Buffer.alloc(0)), 0);
});

test('entropy of compressed data is higher than of the source', () => {
  const source = Buffer.from('the same sentence over and over. '.repeat(200));
  assert.ok(entropy(zlib.gzipSync(source)) > entropy(source), 'compression should raise entropy');
});

test('extractStrings finds ASCII runs and respects the minimum', () => {
  const buffer = Buffer.concat([
    Buffer.from('short'),
    Buffer.from([0x00, 0x01]),
    Buffer.from('a longer string here'),
    Buffer.from([0xff]),
    Buffer.from('https://example.com/path'),
  ]);
  const strings = extractStrings(buffer, 6);
  assert.deepEqual(strings, ['a longer string here', 'https://example.com/path']);
  assert.equal(extractStrings(buffer, 40).length, 0);
});

test('extractStrings stops at the limit instead of reading the whole file', () => {
  const buffer = Buffer.from(Array.from({ length: 500 }, (_, i) => `string-number-${i}`).join('\0'));
  assert.equal(extractStrings(buffer, 6, 10).length, 10);
});

// --- the analysis ---------------------------------------------------------

test('a PNG is described with its real dimensions', async () => {
  const file = await makeFile('image.png', pngBuffer(1234, 567));
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'png');
  assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
  const dimensions = result.details.find((f) => f.label === 'dimensions');
  assert.equal(dimensions.value, '1234 x 567');
});

test('a PNG wearing a .jpg name is flagged, because that is the point', async () => {
  const file = await makeFile('photo.jpg', pngBuffer());
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'png');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /extension \.jpg does not match/);
  assert.match(result.warnings[0], /PNG image/);
});

test('bytes appended to a PNG are reported', async () => {
  const file = await makeFile('tail.png', Buffer.concat([pngBuffer(), Buffer.from('hidden payload')]));
  const result = await analyzeFile(file);
  assert.ok(result.warnings.some((w) => /follow the IEND chunk/.test(w)), JSON.stringify(result.warnings));
});

test('a PNG with no extension is described, not accused of a mismatched name', async () => {
  // The extension slot is empty. Nothing was renamed and nothing is hidden, so
  // neither the warning nor the exit code it drives applies.
  const file = await makeFile('no-extension', pngBuffer());
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'png');
  assert.equal(result.extension, null);
  assert.deepEqual(result.warnings, [], JSON.stringify(result.warnings));
});

test('bytes appended to a PNG larger than the read window are still reported', async () => {
  // A real 200 x 200 PNG is a little over 140 KB, so IEND sits past the first
  // 64 KB, where a chunk used to end up half inside the window and half outside
  // it. The walk gave up there and the appended payload was never mentioned —
  // the tool's headline feature quietly doing nothing on any PNG of a realistic
  // size.
  const payload = Buffer.from('HIDDEN PAYLOAD after the image!');
  const file = await makeFile('big-tail.png', Buffer.concat([largePngBuffer(200), payload]));
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'png');
  assert.ok(result.bytes > 64 * 1024, `the fixture has to cross the boundary, got ${result.bytes}`);
  assert.ok(
    result.warnings.some((w) => new RegExp(`^${payload.length} bytes follow the IEND chunk`).test(w)),
    JSON.stringify(result.warnings),
  );
});

test('the large PNG fixture is a real PNG and not just the right shape', async () => {
  // Its IDAT stream inflates back to the raw scanlines that were deflated into
  // it, which is what makes the size-boundary tests above evidence about real
  // files rather than about a container built to look like one.
  const buffer = largePngBuffer(200);
  let offset = 8;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const compressed = Buffer.concat(idat);
  assert.ok(compressed.length > 64 * 1024, `the image data is only ${compressed.length} bytes`);
  assert.equal(zlib.inflateSync(compressed).length, 200 * (1 + 200 * 4));
});

test('a large PNG split into many chunks is walked all the way to IEND', async () => {
  // The shape real encoders produce: many IDAT chunks, so the walk has to cross
  // the gap between the two read windows rather than jump over one big chunk.
  const file = await makeFile('many-chunks.png', largePngBuffer(200, 20));
  const result = await analyzeFile(file);
  assert.ok(result.bytes > 64 * 1024, `the fixture has to cross the boundary, got ${result.bytes}`);
  assert.deepEqual(result.warnings, [], JSON.stringify(result.warnings));
});

test('a PNG whose IEND is beyond the read window says so instead of staying quiet', async () => {
  // Nothing can be counted here, and saying nothing would be the same silence
  // the size boundary caused in the first place.
  const file = await makeFile('huge-tail.png', Buffer.concat([largePngBuffer(200), Buffer.alloc(70000, 0x5a)]));
  const result = await analyzeFile(file);
  assert.ok(result.warnings.some((w) => /IEND chunk is not in the first or last 64 KB/.test(w)), JSON.stringify(result.warnings));
});

test('a ZIP lists its entry count', async () => {
  const file = await makeFile('archive.zip', zipBuffer());
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'zip');
  const entries = result.details.find((f) => f.label === 'entries');
  assert.equal(entries.value, '1');
});

test('bytes appended to a ZIP are reported', async () => {
  const file = await makeFile('tail.zip', Buffer.concat([zipBuffer(), Buffer.from('appended')]));
  const result = await analyzeFile(file);
  assert.ok(result.warnings.some((w) => /follow the end of the ZIP/.test(w)), JSON.stringify(result.warnings));
});

test('a ZIP comment is part of the archive, not data appended to it', async () => {
  // The record says how long the comment is; the bytes past the comment are the
  // ones that are not part of the file. Accusing a legal comment is a false
  // positive on the exact judgement this tool exists to make.
  const file = await makeFile('commented.zip', zipBuffer('hello.txt', 'hi', 'a legal archive comment'));
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'zip');
  assert.deepEqual(result.warnings, [], JSON.stringify(result.warnings));
});

test('bytes appended after a ZIP comment are still reported', async () => {
  const file = await makeFile('commented-tail.zip', Buffer.concat([zipBuffer('hello.txt', 'hi', 'legal comment'), Buffer.from('appended')]));
  const result = await analyzeFile(file);
  assert.ok(result.warnings.some((w) => /^8 bytes follow the end of the ZIP archive/.test(w)), JSON.stringify(result.warnings));
});

test('a comment containing the end signature does not move the end of the archive', async () => {
  // An archive comment may hold any bytes, including the four that begin the
  // end-of-central-directory record. Only the record that accounts for the
  // whole file is the real end, so this one is still not accused of anything.
  const comment = `PK\x05\x06${'\0'.repeat(20)}`;
  const file = await makeFile('tricky-comment.zip', zipBuffer('hello.txt', 'hi', comment));
  const result = await analyzeFile(file);
  assert.deepEqual(result.warnings, [], JSON.stringify(result.warnings));
});

test('a ZIP larger than the read window still lists its entry count', async () => {
  // The end record is at the end of the file, so reading only the head left the
  // reader to report a central directory it had not actually looked for.
  const file = await makeFile('big.zip', zipBuffer('big.bin', Buffer.alloc(70000, 0x41)));
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'zip');
  assert.ok(result.bytes > 64 * 1024, `the fixture has to cross the boundary, got ${result.bytes}`);
  assert.ok(result.details.some((f) => f.label === 'entries' && f.value === '1'), JSON.stringify(result.details));
  assert.equal(
    result.warnings.some((w) => /central directory is not in the bytes read/.test(w)),
    false,
    JSON.stringify(result.warnings),
  );
});

test('a gzip stream reports the original name it carries', async () => {
  const gzipped = zlib.gzipSync('payload');
  const file = await makeFile('data.gz', gzipped);
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'gzip');
  assert.ok(result.details.some((f) => f.label === 'compression method' && f.value === 'deflate'));
});

test('a script is recognised as text with a shebang', async () => {
  const file = await makeFile('run.sh', '#!/bin/sh\necho hello\n');
  const result = await analyzeFile(file);
  assert.equal(result.format, null);
  assert.equal(result.text, true);
  assert.ok(result.notes.some((n) => /shebang|script/.test(n)), JSON.stringify(result.notes));
});

test('an embedded script tag in a text file is a notable string', async () => {
  const file = await makeFile('notes.txt', 'some text\n<script>alert(1)</script>\nmore text\n');
  const result = await analyzeFile(file, { strings: 6 });
  assert.ok(result.notable.some((n) => /script tag/.test(n.why)), JSON.stringify(result.notable));
});

test('a private key header is surfaced', async () => {
  const file = await makeFile('id_rsa.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n');
  const result = await analyzeFile(file, { strings: 6 });
  assert.ok(result.notable.some((n) => /private key/.test(n.why)), JSON.stringify(result.notable));
});

test('high entropy is noted for binary data that is neither archive nor image', async () => {
  const random = crypto.randomBytes(4096);
  const file = await makeFile('blob.bin', random);
  const result = await analyzeFile(file);
  assert.ok(result.entropy > 7.5);
  assert.ok(result.notes.some((n) => /compressed or encrypted/.test(n)), JSON.stringify(result.notes));
});

test('--hash hashes the whole file, not just the head', async () => {
  const content = Buffer.alloc(200000, 7);
  const file = await makeFile('big.bin', content);
  const result = await analyzeFile(file, { hash: true });
  assert.equal(result.sha256, crypto.createHash('sha256').update(content).digest('hex'));
});

test('an empty file is described rather than failing', async () => {
  const file = await makeFile('empty.bin', Buffer.alloc(0));
  const result = await analyzeFile(file);
  assert.equal(result.bytes, 0);
  assert.equal(result.format, null);
  assert.equal(result.text, false, 'an empty file is not text, it is empty');
});

test('a directory is refused with a clear message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-dir-'));
  cleanups.push(dir);
  await assert.rejects(() => analyzeFile(dir), /is a directory/);
});

test('a file whose extension is right produces no warning', async () => {
  const file = await makeFile('clean.png', pngBuffer());
  const result = await analyzeFile(file);
  assert.equal(result.warnings.length, 0);
});

test('a truncated PNG reports the damage instead of throwing', async () => {
  const full = pngBuffer();
  const file = await makeFile('cut.png', full.subarray(0, 12));
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'png');
  assert.ok(result.warnings.length > 0, 'a truncated header should be reported');
});

test('an ELF of any short length is described instead of crashing the analysis', async () => {
  // 20 to 39 bytes is the trap: the 64-bit program header offset is eight bytes
  // at offset 32, so it needs 40 bytes where the 32-bit one needs 32. Reading it
  // with the raw buffer method threw a RangeError that the caller turned into
  // "this file could not be read" — for a file that was sitting right there.
  for (let size = 4; size <= 70; size += 1) {
    const header = Buffer.alloc(size);
    header.writeUInt32BE(0x7f454c46, 0);
    header[4] = 2; // 64-bit class, the case that used to throw
    header[5] = 1; // little-endian
    const file = await makeFile(`tiny-${size}.elf`, header);
    const result = await analyzeFile(file);
    assert.equal(result.format?.id, 'elf', `${size} bytes was not identified as ELF`);
    if (size >= 20 && size < 40) {
      assert.ok(
        result.warnings.some((w) => /program header offset is outside/.test(w)),
        `${size} bytes: ${JSON.stringify(result.warnings)}`,
      );
    }
  }
});

test('a JPEG cut off inside the frame header says so instead of half-reporting it', async () => {
  // FFD8, then an APP0 segment of the declared length, then FFC0 with only one
  // byte of its payload: enough for the marker, nowhere near enough for the
  // precision, height, width and component count it promises.
  const truncated = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14, 0),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
  ]);
  const file = await makeFile('cut.jpg', truncated);
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'jpeg');
  assert.ok(result.warnings.some((w) => /frame header is cut off/.test(w)), JSON.stringify(result.warnings));
  assert.equal(result.details.some((f) => f.label === 'precision'), false, 'no field may be invented');
});

test('a PE cut off before its optional header says which field is missing', async () => {
  const buffer = Buffer.alloc(100);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write('PE\0\0', 0x40, 'latin1');
  buffer.writeUInt16LE(0x8664, 0x44);
  buffer.writeUInt16LE(3, 0x46);
  const file = await makeFile('short.exe', buffer);
  const result = await analyzeFile(file);
  assert.equal(result.format.id, 'pe');
  assert.ok(result.warnings.some((w) => /optional header is cut off/.test(w)), JSON.stringify(result.warnings));
  assert.equal(result.details.some((f) => f.label === 'subsystem'), false);
});

test('a two-character minimum for strings is honoured rather than raised to four', async () => {
  // The parser accepts 2, the documentation says 2 is the floor, and the
  // analysis used to raise 2 and 3 to 4 on the quiet.
  const file = await makeFile('runs.bin', Buffer.from('ab\0cd\0a longer run here\0'));
  const result = await analyzeFile(file, { strings: 2 });
  assert.deepEqual(result.strings, ['ab', 'cd', 'a longer run here']);
});
