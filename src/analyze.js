/**
 * The analysis itself: identify a file, then say everything worth saying about
 * it in one pass.
 *
 * Two kinds of output here. Facts (size, format, dimensions, entry counts) and
 * judgements (this extension does not match these bytes, there is data after the
 * end of the archive, this is an executable with a .jpg name). The judgements
 * are the reason the tool exists, so each one carries the evidence that produced
 * it rather than just an assertion.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readDetails } from './details.js';
import { detectBom, extensionAgrees, identify, looksLikeText } from './magic.js';

/** How much of a file to read for identification. Enough for every header here. */
export const HEAD_BYTES = 64 * 1024;

/**
 * Shannon entropy over the whole byte range, in bits per byte.
 *
 * 8 means every byte value appears about equally often, which is what encrypted
 * and already-compressed data looks like. It is a description, not a verdict:
 * a JPEG and a ZIP both sit near 8, and so does random noise.
 */
export function entropy(buffer) {
  if (buffer.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of buffer) counts[byte] += 1;
  let value = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    value -= p * Math.log2(p);
  }
  return value;
}

/**
 * Printable runs of a given minimum length.
 *
 * ASCII only, because the point is to spot embedded paths, URLs, script tags and
 * error messages. Multi-byte text is left out on purpose: a UTF-8 run of CJK
 * characters produces enormous meaningless "strings", and a run of Latin-1
 * accents produces noise.
 *
 * @param {Buffer} buffer
 * @param {number} [minLength]
 * @param {number} [limit]
 */
export function extractStrings(buffer, minLength = 6, limit = 40) {
  const out = [];
  let current = '';
  for (const byte of buffer) {
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= minLength) {
      out.push(current);
      if (out.length >= limit) return out;
    }
    current = '';
  }
  if (current.length >= minLength) out.push(current);
  return out.slice(0, limit);
}

/** Patterns that are worth flagging on sight, with what they mean. */
const NOTABLE_STRINGS = [
  { pattern: /<!--/, why: 'an HTML comment inside a non-HTML file' },
  { pattern: /<script/i, why: 'a script tag inside a non-HTML file' },
  { pattern: /<svg/i, why: 'embedded SVG, which browsers treat as active content' },
  { pattern: /\bMZ\b|This program cannot be run in DOS mode/, why: 'a Windows executable stub' },
  { pattern: /^#!\s*\//, why: 'a shebang line, so this is a script' },
  { pattern: /BEGIN [A-Z ]*PRIVATE KEY/, why: 'a private key' },
  { pattern: /BEGIN CERTIFICATE/, why: 'a certificate' },
  { pattern: /AKIA[0-9A-Z]{16}/, why: 'what looks like an AWS access key id' },
  { pattern: /https?:\/\//, why: 'a URL' },
];

/** Text formats worth naming, because "text" is not a useful answer. */
const TEXT_HINTS = [
  { id: 'shebang', name: 'script with a shebang', test: (s) => /^#!/.test(s) },
  { id: 'json', name: 'JSON document', test: (s) => /^[[{]/.test(s.trimStart()) },
  { id: 'xml', name: 'XML document', test: (s) => /^\s*<\?xml/.test(s) },
  { id: 'html', name: 'HTML document', test: (s) => /^\s*<(!doctype|html)/i.test(s) },
  { id: 'csv', name: 'delimited text', test: (s) => s.split('\n').slice(0, 5).filter((l) => l.split(',').length > 2).length >= 3 },
  { id: 'yaml', name: 'YAML document', test: (s) => /^---\n/.test(s) || /^[a-z_]+:\s/m.test(s) },
];

/**
 * @param {string} file
 * @param {object} [options]
 * @param {number} [options.headBytes]
 * @param {boolean} [options.hash]
 * @param {number} [options.strings]
 */
export async function analyzeFile(file, options = {}) {
  const { headBytes = HEAD_BYTES, hash = false, strings = 0 } = options;
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) {
    throw Object.assign(new Error(`${file} is a directory`), { code: 'EISDIR' });
  }

  const handle = await fs.open(absolute, 'r');
  let head;
  let tail;
  let tailStart = 0;
  try {
    const length = Math.min(headBytes, stat.size);
    head = Buffer.alloc(length);
    // A read may return fewer bytes than it was asked for — the file can shrink
    // between the stat above and the read below, and a network share or a
    // special file need not fill the request. The rest of the buffer is then the
    // zeroes it was allocated with, and analysing those as if they were the
    // file's own bytes would be a silent lie. Keep only what arrived.
    if (length > 0) {
      const { bytesRead } = await handle.read(head, 0, length, 0);
      if (bytesRead < length) head = head.subarray(0, bytesRead);
    }
    const tailLength = Math.min(headBytes, stat.size);
    tailStart = Math.max(0, stat.size - tailLength);
    tail = Buffer.alloc(tailLength);
    if (tailLength > 0) {
      const { bytesRead } = await handle.read(tail, 0, tailLength, tailStart);
      if (bytesRead < tailLength) tail = tail.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }

  const format = identify(head);
  const warnings = [];
  const notes = [];

  const extension = path.extname(absolute).toLowerCase();
  const agreement = extensionAgrees(extension, format);

  if (format && agreement === false) {
    warnings.push(
      `the extension ${extension} does not match the contents, which are ${format.name}; this is how a file gets a wrong name, or how one is hidden`,
    );
  }
  if (!format && extension && looksLikeText(head) === false) {
    notes.push(`no known format matched, and the bytes are not text either`);
  }
  if (!format && looksLikeText(head)) {
    const text = head.toString('utf8');
    const hint = TEXT_HINTS.find((candidate) => candidate.test(text));
    if (hint) notes.push(`looks like ${hint.name}`);
  }

  // Data appended after a container's declared end is the classic way to hide
  // one file inside another.
  if (format?.id === 'zip') {
    const declaredEnd = zipEndOffset(tail, tailStart, stat.size);
    if (declaredEnd !== null && stat.size > declaredEnd) {
      warnings.push(`${stat.size - declaredEnd} bytes follow the end of the ZIP archive; something has been appended to it`);
    }
  }
  if (format?.id === 'png') {
    const { end, outOfWindow } = pngEndOffset(head, tail, tailStart, stat.size);
    if (end !== null && stat.size > end) {
      warnings.push(`${stat.size - end} bytes follow the IEND chunk of the PNG`);
    } else if (outOfWindow) {
      // Saying nothing here is the failure this tool exists to avoid: the image
      // may well stop well before the end of the file and we cannot see where.
      warnings.push('the IEND chunk is not in the first or last 64 KB, so anything appended after it cannot be counted');
    }
  }

  // The ZIP reader needs the end of the file, every other reader the start.
  // A reader that throws is a defect in the reader, and reporting it as a file
  // that "could not be read" would blame the wrong thing: the bytes are here,
  // they were only unexpected.
  let details = null;
  if (format) {
    try {
      details = readDetails(format.id === 'zip' ? tail : head, format);
    } catch (error) {
      warnings.push(`the ${format.name} header could not be read: ${error.message}`);
    }
  }
  if (details) warnings.push(...details.warnings);

  const bom = detectBom(head);
  const isText = format === null && looksLikeText(head);
  const binary = !isText;

  const fileEntropy = binary ? entropy(head) : null;
  if (fileEntropy !== null && fileEntropy > 7.5) {
    // Say it whenever it is true. A known archive or image is expected to look
    // like this; anything else — especially an unidentified blob — is worth
    // knowing, and that is the case where the note is most useful.
    const expected = format && ['archive', 'media'].includes(format.kind);
    if (!expected) {
      notes.push('entropy is near the maximum, which usually means the payload is compressed or encrypted');
    }
  }

  const notable = [];
  if (strings > 0) {
    // The minimum asked for, not a floor of this function's own: the parser
    // accepts anything from 2 up, and quietly raising 2 to 4 rewrites the
    // caller's request.
    for (const candidate of extractStrings(head, strings, 200)) {
      for (const rule of NOTABLE_STRINGS) {
        if (rule.pattern.test(candidate)) {
          notable.push({ value: candidate.slice(0, 120), why: rule.why });
          break;
        }
      }
    }
  }

  let digest = null;
  if (hash) {
    const whole = await fs.readFile(absolute);
    digest = crypto.createHash('sha256').update(whole).digest('hex');
  }

  return {
    path: absolute,
    name: path.basename(absolute),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    extension: extension || null,
    format: format ? { id: format.id, name: format.name, kind: format.kind } : null,
    text: isText,
    bom,
    entropy: fileEntropy,
    sha256: digest,
    details: details ? details.fields : [],
    strings: strings > 0 ? extractStrings(head, strings) : [],
    notable,
    warnings,
    notes,
  };
}

/** IEND is always empty, so its chunk header is always this exact run of bytes. */
const IEND_CHUNK_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]);

/** The end-of-central-directory record: where a ZIP says its contents stop. */
const ZIP_END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Where a PNG's data ends, according to the chunk list.
 *
 * Chunks are walked in order rather than searched for, because searching for
 * IEND needs its CRC to be correct — and plenty of writers, including test
 * fixtures, emit a wrong or zero CRC. Walking also rejects a stray "IEND" that
 * happens to appear inside compressed image data.
 *
 * Only the first and last 64 KB are in memory. Each chunk header is read from
 * whichever of the two holds it, which is what makes a chunk that spans the
 * boundary harmless: the walk follows the declared lengths instead of assuming
 * the two windows are adjacent in memory. `tailStart` is the file offset the
 * tail begins at, so a header in the tail can be translated back.
 *
 * @returns {{end: number|null, outOfWindow: boolean}} `end` is the byte offset
 * just past the IEND chunk, or null when the walk could not reach it.
 * `outOfWindow` says the walk stopped because the bytes it needed next are
 * neither in the head nor in the tail, which is not the same as a damaged file.
 */
function pngEndOffset(head, tail, tailStart, totalSize) {
  const headerAt = (offset) => {
    if (offset + 12 <= head.length) return head.subarray(offset, offset + 12);
    const index = offset - tailStart;
    if (index >= 0 && index + 12 <= tail.length) return tail.subarray(index, index + 12);
    return null;
  };

  let offset = 8; // past the signature
  let stalled = false;
  while (offset + 12 <= totalSize) {
    const header = headerAt(offset);
    if (header === null) {
      stalled = true;
      break;
    }
    const length = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return { end: null, outOfWindow: false }; // not a chunk header; give up
    if (type === 'IEND') return { end: offset + 12 + length, outOfWindow: false };
    const chunkEnd = offset + 12 + length;
    if (chunkEnd + 12 > totalSize) return { end: null, outOfWindow: false }; // no room left for one
    offset = chunkEnd;
  }

  // The head covers the whole file, so the walk above had every byte there is:
  // an IEND it did not find is a damaged file, not a missing window.
  if (!stalled || head.length >= totalSize) return { end: null, outOfWindow: false };

  // A chunk header landed in the gap between the two windows, which is the
  // normal case for a PNG with enough chunks to cross 64 KB. IEND is the last
  // chunk of a PNG, so it is in the tail whatever the gap holds: look for the
  // empty chunk's exact header. Eight bytes spelling "no length, IEND" are not
  // something compressed image data produces by accident.
  const at = tail.lastIndexOf(IEND_CHUNK_HEADER);
  if (at >= 0) return { end: tailStart + at + 12, outOfWindow: false };
  return { end: null, outOfWindow: true };
}

/**
 * Where a ZIP's declared contents end: just past the end-of-central-directory
 * record, plus the archive comment the format allows after it.
 *
 * The comment is a legal part of the file, so it does not count as appended
 * data — mistaking it for that accuses an honest archive of hiding something.
 * The signature is searched for from the end because an occurrence inside a
 * comment is a false one, and an archive comment is free to contain those four
 * bytes. Of the records that fit inside the file, the one that accounts for
 * every byte is the real end; failing that, the last one is the best answer
 * there is.
 *
 * @returns {number|null} the declared end offset, or null when no record that
 * fits is within the bytes read.
 */
function zipEndOffset(tail, tailStart, totalSize) {
  let best = null;
  for (let at = tail.lastIndexOf(ZIP_END_SIGNATURE); at >= 0; at = tail.lastIndexOf(ZIP_END_SIGNATURE, at - 1)) {
    if (at + 22 > tail.length) continue; // too close to the end to hold a record
    const end = tailStart + at + 22 + tail.readUInt16LE(at + 20);
    if (end > totalSize) continue; // the record claims to end past the file
    if (end === totalSize) return end;
    best ??= end;
  }
  return best;
}

/** Analyse several files, keeping going when one of them fails. */
export async function analyzeMany(files, options = {}) {
  const results = [];
  for (const file of files) {
    try {
      results.push(await analyzeFile(file, options));
    } catch (error) {
      results.push({ path: path.resolve(file), error: error.message, code: error.code ?? null });
    }
  }
  return results;
}

export { entropy as shannonEntropy };
