/**
 * Header readers for a handful of formats.
 *
 * Only the parts that are worth printing: image dimensions, archive entries,
 * container metadata. Each reader takes an already-truncated buffer and must
 * tolerate it being short — a truncated download should produce a partial report,
 * not a crash. Every field read is bounds-checked for that reason.
 */

/** Read a big-endian unsigned 32-bit integer, or null when out of range. */
function u32be(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32BE(offset) : null;
}

function u32le(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null;
}

function u16be(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16BE(offset) : null;
}

function u16le(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : null;
}

function u64le(buffer, offset) {
  return offset + 8 <= buffer.length ? Number(buffer.readBigUInt64LE(offset)) : null;
}

/** Shift-JIS and other legacy text encodings aside, printable ASCII and UTF-8. */
function printable(buffer, offset, length) {
  if (offset + length > buffer.length) return null;
  const slice = buffer.subarray(offset, offset + length);
  return slice.toString('utf8').replace(/\0+$/, '') || null;
}

/**
 * @typedef {{format: string, fields: Array<{label: string, value: string}>, warnings: string[]}} Details
 */

/** Everything the readers can add about a file, keyed by format id. */
export function readDetails(buffer, format) {
  switch (format?.id) {
    case 'png':
      return png(buffer);
    case 'jpeg':
      return jpeg(buffer);
    case 'gif':
      return gif(buffer);
    case 'wav':
      return wav(buffer);
    case 'gzip':
      return gzip(buffer);
    case 'zip':
      return zip(buffer);
    case 'elf':
      return elf(buffer);
    case 'pe':
      return pe(buffer);
    case 'pdf':
      return pdf(buffer);
    default:
      return null;
  }
}

function png(buffer) {
  const fields = [];
  const warnings = [];
  // The first chunk must be IHDR: 8 bytes of signature, 4 length, 4 type.
  const type = printable(buffer, 12, 4);
  if (type !== 'IHDR') {
    warnings.push(`the first chunk is ${type ?? '(unreadable)'}, not IHDR; the file may be damaged`);
    return { format: 'png', fields, warnings };
  }
  const width = u32be(buffer, 16);
  const height = u32be(buffer, 20);
  const depth = buffer.length > 24 ? buffer.readUInt8(24) : null;
  const colorType = buffer.length > 25 ? buffer.readUInt8(25) : null;
  const interlaced = buffer.length > 28 ? buffer.readUInt8(28) : null;
  const colourNames = { 0: 'greyscale', 2: 'truecolour', 3: 'indexed', 4: 'greyscale + alpha', 6: 'truecolour + alpha' };

  if (width && height) fields.push({ label: 'dimensions', value: `${width} x ${height}` });
  if (depth) fields.push({ label: 'bit depth', value: `${depth} per channel` });
  if (colorType !== null) fields.push({ label: 'colour type', value: `${colorType} (${colourNames[colorType] ?? 'unknown'})` });
  if (interlaced !== null) fields.push({ label: 'interlaced', value: interlaced === 1 ? 'Adam7' : 'no' });
  return { format: 'png', fields, warnings };
}

function jpeg(buffer) {
  const fields = [];
  const warnings = [];
  // Walk the marker segments looking for a start-of-frame, which holds the size.
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(buffer, offset + 2);
    if (length === null) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const precision = buffer[offset + 4];
      const height = u16be(buffer, offset + 5);
      const width = u16be(buffer, offset + 7);
      const components = buffer[offset + 9];
      if (width && height) fields.push({ label: 'dimensions', value: `${width} x ${height}` });
      if (precision) fields.push({ label: 'precision', value: `${precision} bit` });
      if (components) fields.push({ label: 'components', value: `${components}` });
      const names = { 0xc0: 'baseline', 0xc1: 'extended sequential', 0xc2: 'progressive', 0xc3: 'lossless' };
      if (names[marker]) fields.push({ label: 'encoding', value: names[marker] });
      break;
    }
    if (marker === 0xda) {
      warnings.push('reached the scan data before finding a frame header; no dimensions available');
      break;
    }
    offset += 2 + length;
  }
  return { format: 'jpeg', fields, warnings };
}

function gif(buffer) {
  const width = u16le(buffer, 6);
  const height = u16le(buffer, 8);
  const fields = [];
  const version = printable(buffer, 3, 3);
  if (width && height) fields.push({ label: 'dimensions', value: `${width} x ${height}` });
  if (version) fields.push({ label: 'version', value: version });
  if (buffer.length > 10) {
    const packed = buffer.readUInt8(10);
    fields.push({ label: 'global colour table', value: packed & 0x80 ? `${2 ** ((packed & 0x07) + 1)} colours` : 'none' });
  }
  return { format: 'gif', fields, warnings: [] };
}

function wav(buffer) {
  const fields = [];
  const warnings = [];
  // RIFF header: "RIFF", size, "WAVE", then chunks.
  const declared = u32le(buffer, 4);
  if (declared !== null) fields.push({ label: 'declared RIFF size', value: `${declared + 8} bytes` });
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = printable(buffer, offset, 4);
    const size = u32le(buffer, offset + 4);
    if (id === 'fmt ' && size !== null) {
      const channels = u16le(buffer, offset + 10);
      const sampleRate = u32le(buffer, offset + 12);
      const bits = u16le(buffer, offset + 22);
      if (channels) fields.push({ label: 'channels', value: `${channels}` });
      if (sampleRate) fields.push({ label: 'sample rate', value: `${sampleRate} Hz` });
      if (bits) fields.push({ label: 'bit depth', value: `${bits}` });
      if (channels && sampleRate && bits && size >= 16) {
        const byteRate = channels * sampleRate * (bits / 8);
        if (byteRate > 0) {
          const seconds = (buffer.length - 44) / byteRate;
          if (seconds > 0) fields.push({ label: 'approximate duration', value: `${seconds.toFixed(2)}s` });
        }
      }
    }
    if (size === null) break;
    offset += 8 + size + (size % 2);
  }
  if (fields.length === 1) warnings.push('no fmt chunk found in the first bytes; the header may be unusual');
  return { format: 'wav', fields, warnings };
}

function gzip(buffer) {
  const fields = [];
  const warnings = [];
  if (buffer.length < 10) {
    warnings.push('the gzip header is incomplete');
    return { format: 'gzip', fields, warnings };
  }
  const method = buffer.readUInt8(2);
  const flags = buffer.readUInt8(3);
  const mtime = u32le(buffer, 4);
  fields.push({ label: 'compression method', value: method === 8 ? 'deflate' : `${method} (unexpected)` });
  if (mtime) fields.push({ label: 'modification time', value: new Date(mtime * 1000).toISOString() });
  const flagNames = [];
  if (flags & 0x01) flagNames.push('text');
  if (flags & 0x02) flagNames.push('header crc');
  if (flags & 0x04) flagNames.push('extra field');
  if (flags & 0x08) flagNames.push('original name');
  if (flags & 0x10) flagNames.push('comment');
  if (flagNames.length > 0) fields.push({ label: 'flags', value: flagNames.join(', ') });
  if (flags & 0x08 && buffer.length > 10) {
    const name = printable(buffer, 10, Math.min(255, buffer.length - 10));
    if (name) fields.push({ label: 'original name', value: name.split('\0')[0] });
  }
  return { format: 'gzip', fields, warnings };
}

/**
 * ZIP central directory.
 *
 * The entries are at the end of the file, so a truncated buffer cannot list
 * them; that is reported rather than guessed at.
 */
function zip(buffer) {
  const fields = [];
  const warnings = [];
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const at = buffer.lastIndexOf(endSignature);
  if (at < 0 || at + 22 > buffer.length) {
    warnings.push('the central directory is not in the bytes read; the archive is large or truncated');
    return { format: 'zip', fields, warnings };
  }
  const count = u16le(buffer, at + 10);
  const size = u32le(buffer, at + 12);
  const offset = u32le(buffer, at + 16);
  if (count !== null) fields.push({ label: 'entries', value: `${count}` });
  if (size !== null) fields.push({ label: 'central directory size', value: `${size} bytes` });
  if (offset !== null) fields.push({ label: 'central directory offset', value: `${offset}` });
  if (count === 0) fields.push({ label: 'contents', value: 'empty archive' });
  return { format: 'zip', fields, warnings };
}

function elf(buffer) {
  const fields = [];
  const warnings = [];
  if (buffer.length < 20) {
    warnings.push('the ELF header is incomplete');
    return { format: 'elf', fields, warnings };
  }
  const is64 = buffer.readUInt8(4) === 2;
  const little = buffer.readUInt8(5) === 1;
  const types = { 1: 'relocatable object', 2: 'executable', 3: 'shared object', 4: 'core dump' };
  const machines = { 0x03: 'x86', 0x28: 'ARM', 0x3e: 'x86-64', 0xb7: 'AArch64', 0xf3: 'RISC-V' };
  const type = u16le(buffer, 16);
  const machine = u16le(buffer, 18);
  fields.push({ label: 'class', value: is64 ? '64-bit' : '32-bit' });
  fields.push({ label: 'byte order', value: little ? 'little-endian' : 'big-endian' });
  if (type) fields.push({ label: 'type', value: types[type] ?? `unknown (${type})` });
  if (machine) fields.push({ label: 'machine', value: machines[machine] ?? `unknown (0x${machine.toString(16)})` });

  // The program header offset tells us where the entry point lives, and for a
  // position-independent executable it is also where the interpreter is named.
  const phoff = is64 ? Number(buffer.readBigUInt64LE(32)) : u32le(buffer, 28);
  if (phoff) fields.push({ label: 'program headers at', value: `${phoff}` });
  return { format: 'elf', fields, warnings };
}

/**
 * PE: the "MZ" stub holds a pointer to a PE signature, which holds the machine
 * type and the subsystem.
 */
function pe(buffer) {
  const fields = [];
  const warnings = [];
  const peOffset = u32le(buffer, 0x3c);
  if (peOffset === null || peOffset + 24 > buffer.length) {
    warnings.push('not enough bytes to reach the PE header; listing the DOS stub only');
    return { format: 'pe', fields, warnings };
  }
  if (buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    warnings.push('the MZ header does not point at a PE signature; this may be a DOS executable');
    return { format: 'pe', fields, warnings };
  }
  const machines = { 0x014c: 'x86', 0x8664: 'x86-64', 0x01c0: 'ARM', 0xaa64: 'ARM64' };
  const subsystems = { 1: 'native', 2: 'Windows GUI', 3: 'Windows console', 9: 'Windows CE', 10: 'EFI application', 14: 'EFI ROM' };
  const machine = u16le(buffer, peOffset + 4);
  const sections = u16le(buffer, peOffset + 6);
  const characteristics = u16le(buffer, peOffset + 22);
  const optionalMagic = u16le(buffer, peOffset + 24);
  const subsystem = u16le(buffer, peOffset + 24 + 68);
  fields.push({ label: 'PE header at', value: `${peOffset}` });
  if (machine) fields.push({ label: 'machine', value: machines[machine] ?? `unknown (0x${machine.toString(16)})` });
  if (sections !== null) fields.push({ label: 'sections', value: `${sections}` });
  if (optionalMagic === 0x10b) fields.push({ label: 'optional header', value: 'PE32 (32-bit)' });
  else if (optionalMagic === 0x20b) fields.push({ label: 'optional header', value: 'PE32+ (64-bit)' });
  if (subsystem) fields.push({ label: 'subsystem', value: subsystems[subsystem] ?? `unknown (${subsystem})` });
  if (characteristics !== null) {
    if (characteristics & 0x2000) fields.push({ label: 'note', value: 'marked as a DLL' });
    if (characteristics & 0x0002) fields.push({ label: 'note', value: 'marked as an executable' });
    if (characteristics & 0x0100) fields.push({ label: 'note', value: '32-bit capable, not 64-bit' });
  }
  return { format: 'pe', fields, warnings };
}

function pdf(buffer) {
  const fields = [];
  const warnings = [];
  const head = buffer.toString('latin1');
  const version = /^%PDF-(\d+\.\d+)/.exec(head);
  if (version) fields.push({ label: 'version', value: version[1] });
  if (head.includes('/Encrypt')) fields.push({ label: 'encrypted', value: 'yes, a /Encrypt dictionary is present' });
  if (!head.includes('%%EOF')) warnings.push('no %%EOF marker in the bytes read; the file may be truncated');
  return { format: 'pdf', fields, warnings };
}

export { u16le, u32le, u32be, u64le };
