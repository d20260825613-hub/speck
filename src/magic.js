/**
 * Magic-number detection.
 *
 * A format identifies itself by a fixed byte sequence at a fixed offset, which
 * is what makes this reliable: nothing here guesses from a file extension. An
 * extension is a hint the user typed; the bytes are what a program acts on.
 */

/** @typedef {{id: string, name: string, kind: string, extensions: string[], magic: number[], offset?: number, extra?: Array<{pattern: number[], offset: number}>}} Format */

/** @type {Format[]} */
export const FORMATS = [
  // Executables and object code
  { id: 'elf', name: 'ELF executable or object', kind: 'executable', extensions: ['.elf', '.so', '.o'], magic: [0x7f, 0x45, 0x4c, 0x46] },
  { id: 'pe', name: 'PE executable (Windows)', kind: 'executable', extensions: ['.exe', '.dll', '.sys'], magic: [0x4d, 0x5a] },
  { id: 'macho32', name: 'Mach-O executable (32-bit)', kind: 'executable', extensions: ['.macho'], magic: [0xfe, 0xed, 0xfa, 0xce] },
  { id: 'macho64', name: 'Mach-O executable (64-bit)', kind: 'executable', extensions: ['.macho'], magic: [0xfe, 0xed, 0xfa, 0xcf] },
  { id: 'wasm', name: 'WebAssembly module', kind: 'executable', extensions: ['.wasm'], magic: [0x00, 0x61, 0x73, 0x6d] },
  { id: 'java-class', name: 'Java class file', kind: 'executable', extensions: ['.class'], magic: [0xca, 0xfe, 0xba, 0xbe] },
  { id: 'dex', name: 'Dalvik executable (Android)', kind: 'executable', extensions: ['.dex'], magic: [0x64, 0x65, 0x78, 0x0a] },

  // Archives and compression
  { id: 'zip', name: 'ZIP archive', kind: 'archive', extensions: ['.zip', '.jar', '.docx', '.xlsx', '.apk'], magic: [0x50, 0x4b, 0x03, 0x04] },
  { id: 'zip-empty', name: 'ZIP archive (empty)', kind: 'archive', extensions: ['.zip'], magic: [0x50, 0x4b, 0x05, 0x06] },
  { id: 'gzip', name: 'gzip compressed data', kind: 'archive', extensions: ['.gz', '.tgz'], magic: [0x1f, 0x8b] },
  { id: 'bzip2', name: 'bzip2 compressed data', kind: 'archive', extensions: ['.bz2'], magic: [0x42, 0x5a, 0x68] },
  { id: 'xz', name: 'XZ compressed data', kind: 'archive', extensions: ['.xz'], magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { id: 'zstd', name: 'Zstandard compressed data', kind: 'archive', extensions: ['.zst'], magic: [0x28, 0xb5, 0x2f, 0xfd] },
  { id: '7z', name: '7-Zip archive', kind: 'archive', extensions: ['.7z'], magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { id: 'rar', name: 'RAR archive', kind: 'archive', extensions: ['.rar'], magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { id: 'tar', name: 'tar archive', kind: 'archive', extensions: ['.tar'], magic: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257 },
  { id: 'brotli', name: 'Brotli compressed data', kind: 'archive', extensions: ['.br'], magic: [0xce, 0xb2, 0xcf, 0x81] },

  // Images
  { id: 'png', name: 'PNG image', kind: 'image', extensions: ['.png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { id: 'jpeg', name: 'JPEG image', kind: 'image', extensions: ['.jpg', '.jpeg'], magic: [0xff, 0xd8, 0xff] },
  { id: 'gif', name: 'GIF image', kind: 'image', extensions: ['.gif'], magic: [0x47, 0x49, 0x46, 0x38] },
  { id: 'bmp', name: 'BMP image', kind: 'image', extensions: ['.bmp'], magic: [0x42, 0x4d] },
  { id: 'webp', name: 'WebP image', kind: 'image', extensions: ['.webp'], magic: [0x52, 0x49, 0x46, 0x46], extra: [{ pattern: [0x57, 0x45, 0x42, 0x50], offset: 8 }] },
  { id: 'tiff-le', name: 'TIFF image (little-endian)', kind: 'image', extensions: ['.tif', '.tiff'], magic: [0x49, 0x49, 0x2a, 0x00] },
  { id: 'tiff-be', name: 'TIFF image (big-endian)', kind: 'image', extensions: ['.tif', '.tiff'], magic: [0x4d, 0x4d, 0x00, 0x2a] },
  { id: 'ico', name: 'Windows icon', kind: 'image', extensions: ['.ico'], magic: [0x00, 0x00, 0x01, 0x00] },
  { id: 'heic', name: 'HEIC image', kind: 'image', extensions: ['.heic'], magic: [0x66, 0x74, 0x79, 0x70], extra: [{ pattern: [0x68, 0x65, 0x69, 0x63], offset: 8 }] },

  // Documents
  { id: 'pdf', name: 'PDF document', kind: 'document', extensions: ['.pdf'], magic: [0x25, 0x50, 0x44, 0x46] },
  { id: 'rtf', name: 'Rich Text Format', kind: 'document', extensions: ['.rtf'], magic: [0x7b, 0x5c, 0x72, 0x74, 0x66] },

  // Media
  { id: 'mp3-id3', name: 'MP3 audio (ID3 tag)', kind: 'media', extensions: ['.mp3'], magic: [0x49, 0x44, 0x33] },
  { id: 'flac', name: 'FLAC audio', kind: 'media', extensions: ['.flac'], magic: [0x66, 0x4c, 0x61, 0x43] },
  { id: 'ogg', name: 'Ogg container', kind: 'media', extensions: ['.ogg', '.oga', '.opus'], magic: [0x4f, 0x67, 0x67, 0x53] },
  { id: 'wav', name: 'WAV audio', kind: 'media', extensions: ['.wav'], magic: [0x52, 0x49, 0x46, 0x46], extra: [{ pattern: [0x57, 0x41, 0x56, 0x45], offset: 8 }] },
  { id: 'mp4', name: 'MP4 container', kind: 'media', extensions: ['.mp4', '.m4a', '.mov'], magic: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { id: 'matroska', name: 'Matroska or WebM container', kind: 'media', extensions: ['.mkv', '.webm'], magic: [0x1a, 0x45, 0xdf, 0xa3] },

  // Databases and data
  { id: 'sqlite', name: 'SQLite database', kind: 'database', extensions: ['.sqlite', '.db'], magic: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66] },
  { id: 'parquet', name: 'Apache Parquet', kind: 'data', extensions: ['.parquet'], magic: [0x50, 0x41, 0x52, 0x31] },
  { id: 'avro', name: 'Apache Avro object container', kind: 'data', extensions: ['.avro'], magic: [0x4f, 0x62, 0x6a, 0x01] },
  { id: 'bson-header', name: 'BSON-like document', kind: 'data', extensions: ['.bson'], magic: [0x05, 0x00, 0x00, 0x00] },

  // Certificates and keys
  { id: 'pem', name: 'PEM text (certificate or key)', kind: 'certificate', extensions: ['.pem', '.crt', '.key'], magic: [0x2d, 0x2d, 0x2d, 0x2d, 0x2d, 0x42, 0x45, 0x47, 0x49, 0x4e] },
  { id: 'der', name: 'DER certificate', kind: 'certificate', extensions: ['.der', '.cer'], magic: [0x30, 0x82] },
];

/**
 * Identify a buffer.
 *
 * Returns the first format whose leading bytes and any required extra pattern
 * match. Formats are checked in order, so a more specific entry must appear
 * before a more general one (`zip-empty` before nothing, `webp` before a bare
 * RIFF).
 *
 * @param {Buffer} buffer at least 512 bytes is enough for every entry here
 * @returns {{id: string, name: string, kind: string, extensions: string[]}|null}
 */
export function identify(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  for (const format of FORMATS) {
    const at = format.offset ?? 0;
    if (buffer.length < at + format.magic.length) continue;
    if (!startsWith(buffer, format.magic, at)) continue;
    if (format.extra && !format.extra.every((check) => startsWith(buffer, check.pattern, check.offset))) continue;
    return { id: format.id, name: format.name, kind: format.kind, extensions: format.extensions };
  }
  return null;
}

function startsWith(buffer, pattern, offset = 0) {
  for (let i = 0; i < pattern.length; i += 1) {
    if (buffer[offset + i] !== pattern[i]) return false;
  }
  return true;
}

/** Does the extension agree with what the bytes say? */
export function extensionAgrees(extension, format) {
  if (!format) return null;
  if (!extension) return false;
  const lower = extension.toLowerCase();
  return format.extensions.some((candidate) => candidate === lower || lower.endsWith(candidate));
}

/** Is this probably text rather than a known binary format? */
export function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Control characters other than tab, newline, carriage return and form feed.
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.05;
}

/** Detect a UTF byte-order mark, which is worth reporting on its own. */
export function detectBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'UTF-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'UTF-16LE';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'UTF-16BE';
  return null;
}
