import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { OPTION_NAMES, installHandlers } from '../src/cli.js';

const cleanups = [];
after(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A minimal PNG: signature, IHDR with the given size, IEND. */
function pngBuffer(width = 4, height = 3, idatBytes = 0) {
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
  const idat = idatBytes > 0 ? chunk('IDAT', Buffer.alloc(idatBytes, 0x41)) : Buffer.alloc(0);
  return Buffer.concat([signature, chunk('IHDR', ihdr), idat, chunk('IEND', Buffer.alloc(0))]);
}

async function makeFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-cli-'));
  cleanups.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

/** The bin entry, so the tests drive the command a user actually runs. */
const BIN = fileURLToPath(new URL('../bin/speck.js', import.meta.url));

/**
 * Run the CLI in its own process, the way a user does.
 *
 * Deliberately not in-process with `process.stdout.write` swapped for a
 * collector. The test runner reports results over that same stream when it runs
 * a file in a child process, so replacing the method swallows whole test results
 * along with the CLI output: ten of the tests here silently vanished from the
 * report while the suite still said it had passed. `test/cli-kit.test.js` now
 * runs this file under the runner and compares the count it reports with the
 * number of tests declared here, which is a check this file cannot make about
 * itself — if the results never arrive, neither does the complaint.
 *
 * Declared async, as it was when it ran the command in-process, so that every
 * call site reads the same either way.
 *
 * @param {string[]} argv
 */
async function runCli(argv) {
  const result = spawnSync(process.execPath, [BIN, ...argv], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Listener counts taken at import time, before any test has installed anything.
 * Used by the first test below; nothing here may call installHandlers first.
 * The runner itself owns some of these (it has an uncaughtException handler of
 * its own), so this records what was there rather than asserting zero.
 */
const AT_IMPORT = {
  sigint: process.listenerCount('SIGINT'),
  sigterm: process.listenerCount('SIGTERM'),
  uncaught: process.listenerCount('uncaughtException'),
  unhandled: process.listenerCount('unhandledRejection'),
};

test('importing src/cli.js installs no handlers', () => {
  // Handlers are a side effect of running the tool, not of importing it, so a
  // test or an embedded caller does not inherit SIGINT and uncaughtException
  // behaviour it never asked for. This test must run first: everything below
  // installs and removes handlers of its own.
  assert.equal(process.listenerCount('SIGINT'), AT_IMPORT.sigint);
  assert.equal(process.listenerCount('SIGTERM'), AT_IMPORT.sigterm);
  assert.equal(process.listenerCount('uncaughtException'), AT_IMPORT.uncaught);
  assert.equal(process.listenerCount('unhandledRejection'), AT_IMPORT.unhandled);
});

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

test('identify exits 3 when the extension disagrees with the contents', async () => {
  // 3, not 2: a misnamed file is a finding. 2 is reserved for usage problems, so
  // a script can tell "your argument was wrong" from "this file is misnamed".
  const file = await makeFile('photo.jpg', pngBuffer());
  const result = await runCli(['identify', file]);
  assert.equal(result.code, 3, '3 is the "identified but misnamed" code');
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

test('identify reports appended bytes in a PNG larger than the read window', async () => {
  // The whole point of the tool, on a file of a size people actually have: a
  // 70 KB image data chunk puts IEND out of reach of the first 64 KB, and the
  // payload after it used to go unmentioned on every such file.
  const payload = Buffer.from('hidden payload');
  const file = await makeFile('big.png', Buffer.concat([pngBuffer(64, 64, 70000), payload]));
  const result = await runCli(['identify', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${payload.length} bytes follow the IEND chunk of the PNG`));
});

test('identify does not accuse a file that has no extension', async () => {
  // Nothing was renamed and nothing is hidden, so there is no finding to report
  // and 3 would be a false alarm for a script watching the exit code.
  const file = await makeFile('no-extension', pngBuffer());
  const result = await runCli(['identify', file]);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stdout, /does not match/);
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

test('strings honours a two-character minimum instead of raising it to four', async () => {
  // The parser's floor is 2 and the help text says so; the analysis used to
  // raise 2 and 3 to 4, dropping runs the caller had asked for.
  const file = await makeFile('runs.bin', Buffer.from('ab\0cd\0a longer run here\0'));
  const result = await runCli(['strings', file, '--min', '2']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ab$/m);
  assert.match(result.stdout, /^cd$/m);
});

test('strings refuses a second file rather than quietly ignoring it', async () => {
  // `speck strings *.bin` used to report the first file and exit 0 as if it had
  // done them all, which is the worst of both answers.
  const first = await makeFile('one.bin', Buffer.from('first file contents\0'));
  const second = await makeFile('two.bin', Buffer.from('second file contents\0'));
  const result = await runCli(['strings', first, second]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /strings takes one file at a time/);
  assert.doesNotMatch(result.stdout, /first file contents/);
});

test('formats lists what this build knows', async () => {
  const result = await runCli(['formats']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\d+ formats/);
  assert.match(result.stdout, /PNG image/);
  assert.match(result.stdout, /ELF executable/);
});

test('bad usage is refused with exit code 2', async () => {
  // 2 is "you asked for something impossible": an unknown command, a missing
  // argument, a bad value. A missing file or a directory is 1 instead, so this
  // is the code that has to stay reserved for arguments alone.
  assert.equal((await runCli(['frobnicate'])).code, 2);
  assert.equal((await runCli(['identify'])).code, 2);
  assert.equal((await runCli(['info'])).code, 2);
  assert.equal((await runCli(['strings'])).code, 2);
  assert.equal((await runCli(['identify', '--nonsense', 'x'])).code, 2);
  assert.equal((await runCli(['strings', 'x', '-n', '1'])).code, 2);
  assert.equal((await runCli(['strings', 'x', '--min=abc'])).code, 2);
});

test('each usage problem names what was wrong', async () => {
  assert.match((await runCli(['frobnicate'])).stderr, /unknown command: frobnicate/);
  assert.match((await runCli(['identify'])).stderr, /identify needs at least one file/);
  assert.match((await runCli(['info'])).stderr, /info needs at least one file/);
  assert.match((await runCli(['strings'])).stderr, /strings needs a file/);
  assert.match((await runCli(['identify', '--nonsense', 'x'])).stderr, /unknown option --nonsense/);
  assert.match((await runCli(['strings', 'x', '-n', '1'])).stderr, /--min must be an integer of at least 2/);
});

test('a mistyped option suggests the real one', async () => {
  const result = await runCli(['identify', '--hsah', 'x']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option --hsah/);
  assert.match(result.stderr, /did you mean --hash\?/);
});

test('every name in OPTION_NAMES is one the parser actually handles', async () => {
  // A list that drifts from the parser either suggests an option that does not
  // exist, or stops suggesting one that does.
  const values = { min: '8' };
  for (const name of OPTION_NAMES) {
    const argv = [`identify`, '--debug', `--${name}`, ...(values[name] ? [values[name]] : []), 'missing-file-xyz'];
    const result = await runCli(argv);
    assert.doesNotMatch(result.stderr, /unknown option/, `--${name} is in OPTION_NAMES but not handled`);
  }
});

test('an option whose value never arrived is a usage error', async () => {
  const result = await runCli(['identify', '--min']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--min needs a value/);
  assert.match(result.stderr, /for example --min 8/);
});

test('a missing value does not swallow the next option as its value', async () => {
  // `--min --hash` used to read `--hash` as the number: the message blamed the
  // value instead of the missing one, and --hash vanished from the call.
  const result = await runCli(['identify', 'small.png', '--min', '--hash']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /--min needs a value/);
  assert.doesNotMatch(result.stderr, /must be an integer/);
});

test('an unknown short option says which short option exists', async () => {
  // `-n` is too short for a "did you mean" comparison, so the hint names it.
  const result = await runCli(['strings', 'x', '-m', '8']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option: -m/);
  assert.match(result.stderr, /the only short option is -n/);
});

test('a missing file is a failed operation, not a usage error', async () => {
  const missing = path.join(os.tmpdir(), 'speck-definitely-not-here.bin');
  const identify = await runCli(['identify', missing]);
  assert.equal(identify.code, 1, identify.stderr);

  const info = await runCli(['info', missing]);
  assert.equal(info.code, 1, info.stderr);

  const strings = await runCli(['strings', missing]);
  assert.equal(strings.code, 1, strings.stderr);
  assert.match(strings.stderr, /speck: /);
});

test('a directory is a failed operation, not a crash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-cli-dir-'));
  cleanups.push(dir);
  const result = await runCli(['strings', dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is a directory/);
});

test('a per-file failure reaches stderr too, so a redirected report keeps it', async () => {
  // `identify *.bin > report.txt` used to drop the failures on the floor: they
  // were written to stdout only, and there was nowhere left to see them.
  const missing = path.join(os.tmpdir(), 'speck-definitely-not-here.bin');
  const result = await runCli(['identify', missing]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /error/, 'the table on stdout still lists it');
  assert.match(result.stderr, /error/, 'and stderr has it as well');
  assert.match(result.stderr, /speck-definitely-not-here\.bin/);
});

test('the identify code 3 wins over nothing, and an unreadable file still wins over it', async () => {
  const mismatched = await makeFile('photo.jpg', pngBuffer());
  assert.equal((await runCli(['identify', mismatched])).code, 3);

  const missing = path.join(path.dirname(mismatched), 'nope.bin');
  const both = await runCli(['identify', mismatched, missing]);
  assert.equal(both.code, 1, 'a file that could not be read is reported before a misnamed one');
});

test('no stack frames are printed unless --debug is on', async () => {
  const frame = /at .*\(.*:\d+:\d+\)/;

  // A usage error, a failed operation and a non-existent file: none of them is
  // a crash, so none of them is allowed to print a stack trace.
  const quiet = [
    await runCli(['identify']),
    await runCli(['frobnicate']),
    await runCli(['identify', '--hsah', 'x']),
    await runCli(['strings', path.join(os.tmpdir(), 'speck-definitely-not-here.bin')]),
  ];
  for (const result of quiet) {
    assert.equal(frame.test(result.stderr), false, `a stack frame escaped: ${result.stderr}`);
    assert.match(result.stderr, /^speck: /, `every message is prefixed with the tool: ${result.stderr}`);
  }

  const debug = await runCli(['frobnicate', '--debug']);
  assert.equal(debug.code, 2, 'so that a stack trace is printed at all');
  assert.match(debug.stderr, frame, '--debug is the one path that shows a stack');
});

test('installHandlers is installed once by the bin entry and once by the module', async () => {
  // The bin entry is what ends up on PATH, so it installs its own handlers; the
  // direct-run block in src/cli.js installs them too, for `node src/cli.js`. The
  // kit makes the second call a no-op, which this checks, and the first test in
  // this file checked that importing src/cli.js installs nothing on its own.
  const baseline = process.listenerCount('SIGINT');
  const remove = installHandlers();
  const afterFirst = process.listenerCount('SIGINT');
  assert.equal(afterFirst, baseline + 1);

  installHandlers();
  assert.equal(process.listenerCount('SIGINT'), afterFirst, 'a second install added listeners');
  remove();
  assert.equal(process.listenerCount('SIGINT'), baseline);
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
  assert.equal(result.code, 3);
  assert.match(result.stdout, /PE executable/);
  assert.match(result.stdout, /does not match/);
});

test('running src/cli.js directly works from a directory whose name has a hash in it', async () => {
  // `node src/cli.js` compared import.meta.url against a hand-built file URL,
  // and import.meta.url escapes `#`, so from such a directory it did nothing at
  // all and exited 0 — a silent no-op for the whole command.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-hash#'));
  cleanups.push(dir);
  const source = fileURLToPath(new URL('../src/', import.meta.url));
  await fs.mkdir(path.join(dir, 'src'));
  for (const entry of await fs.readdir(source)) {
    await fs.copyFile(path.join(source, entry), path.join(dir, 'src', entry));
  }

  const result = spawnSync(process.execPath, [path.join(dir, 'src', 'cli.js'), '--version'], { encoding: 'utf8' });
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/, `no version printed: ${result.stderr}`);
});
