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
  try {
    const length = Math.min(headBytes, stat.size);
    head = Buffer.alloc(length);
    if (length > 0) await handle.read(head, 0, length, 0);
    const tailLength = Math.min(headBytes, stat.size);
    tail = Buffer.alloc(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, Math.max(0, stat.size - tailLength));
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
    const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const at = tail.lastIndexOf(endSignature);
    if (at >= 0) {
      const declaredEnd = stat.size - tail.length + at + 22;
      const trailing = stat.size - declaredEnd;
      if (trailing > 0) {
        warnings.push(`${trailing} bytes follow the end of the ZIP archive; something has been appended to it`);
      }
    }
  }
  if (format?.id === 'png') {
    const iend = tail.lastIndexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
    if (iend >= 0) {
      const declaredEnd = stat.size - tail.length + iend + 8;
      const trailing = stat.size - declaredEnd;
      if (trailing > 0) warnings.push(`${trailing} bytes follow the IEND chunk of the PNG`);
    }
  }

  const details = format ? readDetails(head, format) : null;
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
    for (const candidate of extractStrings(head, Math.max(4, strings), 200)) {
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
    strings: strings > 0 ? extractStrings(head, Math.max(4, strings)) : [],
    notable,
    warnings,
    notes,
  };
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
