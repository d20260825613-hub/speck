import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { run } from '../src/cli.js';

const cleanups = [];
after(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A minimal PNG: signature, IHDR with the given size, IEND. */
function pngBuffer(width = 4, height = 3) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

async function makeFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-cli-'));
  cleanups.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

/** Capture output by swapping process.stdout, restored in a finally. */
async function runCli(argv) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('--help and --version are self-contained', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /speck - what is actually inside this file/);
  assert.match(help.stdout, /Nothing is executed or decompressed/);

  const version = await runCli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('identify prints one line per file and exits 0 for matching names', async () => {
  const file = await makeFile('clean.png', pngBuffer());
  const result = await runCli(['identify', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /clean\.png/);
  assert.match(result.stdout, /PNG image/);
});

test('identify exits 2 when the extension disagrees with the contents', async () => {
  const file = await makeFile('photo.jpg', pngBuffer());
  const result = await runCli(['identify', file]);
  assert.equal(result.code, 2, '2 is the "identified but misnamed" code');
  assert.match(result.stdout, /does not match/);
});

test('identify exits 1 for a missing file and still reports the others', async () => {
  const good = await makeFile('good.png', pngBuffer());
  const missing = path.join(path.dirname(good), 'nope.bin');
  const result = await runCli(['identify', missing, good]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /error/);
  assert.match(result.stdout, /good\.png/);
});

test('identify --json is machine readable', async () => {
  const file = await makeFile('photo.jpg', pngBuffer());
  const result = await runCli(['identify', file, '--json']);
  const report = JSON.parse(result.stdout);
  assert.equal(report[0].format.id, 'png');
  assert.equal(report[0].extension, '.jpg');
  assert.ok(report[0].warnings.length > 0);
});

test('info prints the header fields a person wants', async () => {
  const file = await makeFile('image.png', pngBuffer(640, 480));
  const result = await runCli(['info', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /640 x 480/);
  assert.match(result.stdout, /dimensions/);
  assert.match(result.stdout, /entropy/);
});

test('info --hash includes a sha256 and it is the real one', async () => {
  const content = pngBuffer();
  const file = await makeFile('hashed.png', content);
  const result = await runCli(['info', file, '--hash', '--json']);
  const report = JSON.parse(result.stdout);
  const crypto = await import('node:crypto');
  assert.equal(report.sha256, crypto.createHash('sha256').update(content).digest('hex'));
});

test('info on a non-existent file reports it without crashing', async () => {
  const result = await runCli(['info', path.join(os.tmpdir(), 'definitely-not-here.bin')]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /error/);
});

test('strings prints printable runs and honours --min', async () => {
  const file = await makeFile('text.bin', Buffer.from('ab\0a longer run here\0cd\0https://example.com/x'));
  const short = await runCli(['strings', file, '-n', '4']);
  assert.equal(short.code, 0, short.stderr);
  assert.match(short.stdout, /a longer run here/);
  assert.match(short.stdout, /https:\/\/example\.com\/x/);

  const long = await runCli(['strings', file, '-n', '40']);
  assert.match(long.stdout, /no printable runs/);
});

test('formats lists what this build knows', async () => {
  const result = await runCli(['formats']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\d+ formats/);
  assert.match(result.stdout, /PNG image/);
  assert.match(result.stdout, /ELF executable/);
});

test('bad usage is refused with a clear message', async () => {
  assert.equal((await runCli(['frobnicate'])).code, 1);
  assert.match((await runCli(['identify'])).stderr, /needs at least one file/);
  assert.match((await runCli(['strings'])).stderr, /needs a file/);
  assert.match((await runCli(['identify', '--nonsense', 'x'])).stderr, /unknown option/);
  assert.match((await runCli(['strings', 'x', '-n', '1'])).stderr, /at least 2/);
});

test('an executable wearing an image extension is caught', async () => {
  // MZ header with a PE signature at the documented offset.
  const buffer = Buffer.alloc(256);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write('PE\0\0', 0x40, 'latin1');
  buffer.writeUInt16LE(0x8664, 0x44);
  buffer.writeUInt16LE(3, 0x46);
  const file = await makeFile('holiday.png', buffer);

  const result = await runCli(['identify', file]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /PE executable/);
  assert.match(result.stdout, /does not match/);
});
