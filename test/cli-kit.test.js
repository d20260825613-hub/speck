/**
 * Test the shared CLI behaviour speck relies on.
 *
 * These are the cases that are invisible until they are wrong: an unknown
 * option that suggests nothing, a stack trace where a user expected a sentence,
 * or a set of handlers installed twice so every message is printed twice.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { UsageError, formatError, installCliHandlers, nearestName, unknownOptionError } from '../src/cli-kit.js';

test('nearestName suggests a close option and stays quiet otherwise', () => {
  // The option list speck actually has, so a typo suggests a real option.
  const options = ['hash', 'strings', 'min', 'json', 'debug'];
  assert.equal(nearestName('hsah', options), 'hash');
  assert.equal(nearestName('strigns', options), 'strings');
  assert.equal(nearestName('jason', options), 'json');
  assert.equal(nearestName('completely-different', options), null);
});

test('nearestName refuses to guess from a name too short to be a typo', () => {
  // `min` is one edit from `max` and also one from `man`; at that length there
  // is no such thing as intent, so no suggestion is the honest answer.
  assert.equal(nearestName('mi', ['min', 'json']), null);
  assert.equal(nearestName('n', ['min', 'json']), null);
});

test('an unknown option comes back with a did-you-mean hint', () => {
  const error = unknownOptionError('--hsah', ['hash', 'json']);
  assert.ok(error instanceof UsageError);
  assert.equal(error.message, 'unknown option --hsah');
  assert.equal(error.hint, 'did you mean --hash?');
});

test('an unknown option with nothing close suggests the help flag instead', () => {
  const error = unknownOptionError('--totally-made-up', ['hash', 'json']);
  assert.equal(error.hint, 'run with --help to see every option');
});

test('formatError prints a message and a hint, and not a stack trace', () => {
  const error = new UsageError('unknown option --hsah', { hint: 'did you mean --hash?' });
  const text = formatError(error, { tool: 'speck' });
  assert.match(text, /^speck: unknown option --hsah\n/);
  assert.match(text, /did you mean --hash\?/);
  assert.equal(/at .*\(.*:\d+:\d+\)/.test(text), false, 'no stack frames');
});

test('formatError shows a stack trace only in debug mode', () => {
  const error = new Error('boom');
  assert.equal(/at .*\(.*:\d+:\d+\)/.test(formatError(error, { tool: 'speck' })), false);
  assert.match(formatError(error, { tool: 'speck', debug: true }), /Error: boom/);
});

test('formatError copes with a thrown non-Error', () => {
  assert.match(formatError('just a string', { tool: 'speck' }), /speck: just a string/);
  assert.match(formatError({ code: 'ENOENT' }, { tool: 'speck' }), /speck: /);
});

test('installCliHandlers registers and removes every handler', () => {
  const before = {
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
    uncaught: process.listenerCount('uncaughtException'),
    unhandled: process.listenerCount('unhandledRejection'),
  };
  const stdoutError = process.stdout.listenerCount('error');

  const remove = installCliHandlers({ tool: 'test' });
  assert.equal(process.listenerCount('SIGINT'), before.sigint + 1);
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm + 1);
  assert.equal(process.listenerCount('uncaughtException'), before.uncaught + 1);
  assert.equal(process.listenerCount('unhandledRejection'), before.unhandled + 1);
  assert.equal(process.stdout.listenerCount('error'), stdoutError + 1);

  remove();
  assert.equal(process.listenerCount('SIGINT'), before.sigint);
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm);
  assert.equal(process.listenerCount('uncaughtException'), before.uncaught);
  assert.equal(process.listenerCount('unhandledRejection'), before.unhandled);
  assert.equal(process.stdout.listenerCount('error'), stdoutError);
});

test('installCliHandlers is idempotent within a process', () => {
  // The bin entry and the module it imports may both ask for the handlers.
  // Installing twice would double every message and leak a listener per call, so
  // a second call adds nothing.
  const first = installCliHandlers({ tool: 'a' });
  const afterFirst = process.listenerCount('SIGINT');
  const second = installCliHandlers({ tool: 'b' });

  assert.equal(process.listenerCount('SIGINT'), afterFirst, 'a second install added listeners');
  assert.equal(typeof second, 'function');
  assert.equal(first(), undefined);
});

test('handlers can be installed again after being removed', () => {
  const baseline = process.listenerCount('SIGINT');
  const first = installCliHandlers({ tool: 'a' });
  first();
  assert.equal(process.listenerCount('SIGINT'), baseline);

  const second = installCliHandlers({ tool: 'b' });
  assert.equal(process.listenerCount('SIGINT'), baseline + 1);
  second();
  assert.equal(process.listenerCount('SIGINT'), baseline);
});

test('the bin entry installs the handlers, which the module alone cannot do', async () => {
  // The bug this pins down: importing `run` makes src/cli.js's direct-run check
  // false, so handlers installed only there never fire for the installed
  // `speck` command. A subprocess is the only way to see it: the probe imports
  // `bin/speck.js` exactly the way a command on PATH does, then reports what the
  // entry point left behind on `process`. Undo the `installHandlers()` call in
  // the bin and this fails with sigint=0 pipe=0.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speck-kit-'));
  try {
    const bin = new URL('../bin/speck.js', import.meta.url).href;
    const probe = path.join(dir, 'probe.mjs');
    await fs.writeFile(
      probe,
      `await import(${JSON.stringify(bin)});\n` +
        "process.stdout.write(`sigint=${process.listenerCount('SIGINT')} pipe=${process.stdout.listenerCount('error')}\\n`);\n",
    );

    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /speck - what is actually inside this file/, 'the bin did not run the CLI');
    assert.match(result.stdout, /sigint=1 pipe=1/, 'the bin entry installed no handlers');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
