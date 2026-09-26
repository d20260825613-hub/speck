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

/** A minimal ZIP with one stored entry and a correct central directory. */
function zipBuffer(name = 'hello.txt', content = 'hi') {
  const nameBytes = Buffer.from(name, 'latin1');
  const data = Buffer.from(content, 'latin1');
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

  return Buffer.concat([localPart, centralPart, end]);
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
  assert.equal(extensionAgrees(null, png), false);
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
