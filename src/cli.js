#!/usr/bin/env node
/**
 * speck - what is actually inside this file?
 *
 *   speck identify <file...>   what format is it, and does the name agree
 *   speck info <file...>       everything worth knowing about one file
 *   speck strings <file>       printable runs, with the notable ones marked
 *
 * Identification is from the bytes, never from the extension. Nothing here
 * executes, decompresses or opens the file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { UsageError, formatError, installCliHandlers, unknownOptionError } from './cli-kit.js';
import { analyzeFile, analyzeMany } from './analyze.js';
import { FORMATS } from './magic.js';

const VERSION = '0.1.0';

const USAGE = `speck - what is actually inside this file?

Usage
  speck identify <file...> [options]   format, and whether the name agrees
  speck info <file...> [options]       everything worth knowing
  speck strings <file> [options]       printable runs of text
  speck formats                        list the formats this build recognises

Options
      --hash             include the sha256 of the whole file
      --strings          in info, also list printable strings
  -n, --min <n>          minimum string length (default 6)
      --json             machine-readable output
      --debug            print stack traces for unexpected errors
  -h, --help             this text
  -v, --version          version

What it looks for
  The format, from the leading bytes rather than the file name. Then the things
  that are usually the reason you looked: a file whose extension disagrees with
  its contents, an executable wearing an image extension, data appended after
  the end of an archive or image, an embedded script tag, high entropy.

  Nothing is executed or decompressed. A file is read, described, and left alone.

Exit codes
  0  everything identified
  1  a file could not be read
  2  a usage problem: an unknown option, a missing value, a missing argument
  3  a file was identified but its name disagrees with its contents

Examples
  speck identify download.zip
  speck info photo.png --hash
  speck strings suspicious.pdf -n 8
  speck identify *.bin --json
`;

/**
 * Every long option the parser below handles, for the "did you mean" hint.
 *
 * Kept beside the switch it describes, because a list maintained anywhere else
 * is a list that is wrong within a month. `--help` and `--version` are handled
 * by `run` before parsing starts, so they are not in here.
 */
export const OPTION_NAMES = ['hash', 'strings', 'min', 'json', 'debug'];

/** A concrete example for each option that takes a value, used in error hints. */
const VALUE_EXAMPLES = {
  '--min': '--min 8',
};

/**
 * `--debug` (or SPECK_DEBUG=1) turns stack traces on.
 *
 * Read at throw time rather than cached, and taken from the argv `run` was given
 * as well as from `process.argv`, so an in-process caller that passes `--debug`
 * gets the same output as the shell. Assigned on every run, never merged, so one
 * in-process run cannot leave debug on for the next.
 */
let debugRequested = false;
function isDebug() {
  return debugRequested || process.argv.includes('--debug') || process.env.SPECK_DEBUG === '1';
}

/**
 * Print whatever a command or the parser raised.
 *
 * 2 means "you asked for something impossible" and 1 means "the operation
 * failed". Keeping the two apart is the only way a script can tell a typo from
 * an unreadable file, and mixing them is how a caller ends up retrying
 * something that can never work.
 *
 * Messages are collapsed to one line: an fs error carries a whole path and an
 * errno sentence, and a raw stack trace is never printed unless --debug is on.
 */
function failFrom(error) {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
  const oneLine = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : String(message);
  const printable = error instanceof UsageError ? error : oneLine;
  process.stderr.write(formatError(printable, { tool: 'speck', usage: () => USAGE, debug: isDebug() }));
  return error instanceof UsageError ? (error.code ?? 2) : 1;
}

/** The error for an option whose value never arrived. */
function missingValueError(name) {
  const example = VALUE_EXAMPLES[name] ?? `${name} <value>`;
  return new UsageError(`${name} needs a value`, { hint: `for example ${example}` });
}

/**
 * An unknown option, with the closest real one attached.
 *
 * `unknownOptionError` strips the leading dashes itself, so the token goes in
 * exactly as the user typed it. There is one short option (`-n`), and a bare
 * `-m` has nothing long enough to compare against, so the fallback names the
 * only short option there is instead of leaving the user to guess.
 */
function failUnknownOption(token) {
  if (token.startsWith('--')) return unknownOptionError(token, OPTION_NAMES);
  const bare = String(token).replace(/^-+/, '');
  if (bare.length === 1) {
    return new UsageError(`unknown option: ${token}`, { hint: 'the only short option is -n (--min)' });
  }
  return unknownOptionError(token, OPTION_NAMES);
}

function parseArgs(argv) {
  const values = { hash: false, strings: false, json: false, min: 6, debug: false };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const inline = eq > 1 && token.startsWith('--') ? token.slice(eq + 1) : null;
    // A value-taking option is short of a value when nothing follows it, and
    // also when the inline form is empty (`--min=`). Both are caught here, at
    // the option that is at fault, instead of becoming `NaN` and failing later
    // with a message about something else.
    let missing = null;
    const take = (name) => {
      if (inline !== null) {
        if (inline !== '') return inline;
        missing ??= name;
        return undefined;
      }
      const next = argv[++i];
      if (next !== undefined) return next;
      missing ??= name;
      return undefined;
    };

    switch (token.split('=')[0]) {
      case '--hash':
        values.hash = true;
        break;
      case '--strings':
        values.strings = true;
        break;
      case '--json':
        values.json = true;
        break;
      case '--debug':
        values.debug = true;
        break;
      case '-n':
      case '--min':
        values.min = Number(take('--min'));
        break;
      default:
        if (token === '--') {
          files.push(...argv.slice(i + 1));
          return { values, files };
        }
        if (token.startsWith('-') && token !== '-') return { error: failUnknownOption(token) };
        files.push(token);
    }
    if (missing) return { error: missingValueError(missing) };
  }
  if (!Number.isInteger(values.min) || values.min < 2) {
    return {
      error: new UsageError('--min must be an integer of at least 2', { hint: 'for example --min 8' }),
    };
  }
  return { values, files };
}

/** Colour only when a terminal is reading it. */
const colorEnabled = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (text, code) => (colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const bold = (t) => paint(t, 1);
const dim = (t) => paint(t, 2);
const red = (t) => paint(t, 31);
const yellow = (t) => paint(t, 33);
const green = (t) => paint(t, 32);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** Kind to a colour, so an executable in an image slot stands out. */
function kindColour(kind) {
  if (kind === 'executable') return (t) => paint(t, 35);
  if (kind === 'archive') return (t) => paint(t, 36);
  return (t) => paint(t, 34);
}

async function commandIdentify(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return failFrom(parsed.error);
  const { values, files } = parsed;
  if (files.length === 0) {
    throw new UsageError('identify needs at least one file', { hint: 'for example speck identify photo.png' });
  }

  const results = await analyzeMany(files, { hash: values.hash });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const result of results) {
      if (result.error) {
        process.stdout.write(`${red('error')}   ${result.name ?? result.path}: ${result.error}\n`);
        continue;
      }
      const colour = result.format ? kindColour(result.format.kind) : dim;
      const label = result.format ? colour(result.format.name) : result.text ? dim('plain text') : yellow('unrecognised bytes');
      process.stdout.write(`${bold(result.name)}  ${label}  ${dim(formatBytes(result.bytes))}\n`);
      for (const warning of result.warnings) process.stdout.write(`  ${red('!')} ${warning}\n`);
    }
  }

  // A result is either an analysis or an error object; only the former has
  // warnings, and reaching for them on the latter crashed the whole command.
  const unreadable = results.some((r) => Boolean(r.error));
  const mismatched = results.some((r) => Array.isArray(r.warnings) && r.warnings.some((w) => w.includes('does not match')));
  // An unreadable file is reported first: it is the failure the caller has to
  // deal with, and it leaves the question of the other files unanswered.
  if (unreadable) return 1;
  // 3, not 2: a name that disagrees with the contents is a finding, not a usage
  // error, and a caller has to be able to tell the two apart.
  return mismatched ? 3 : 0;
}

async function commandInfo(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return failFrom(parsed.error);
  const { values, files } = parsed;
  if (files.length === 0) {
    throw new UsageError('info needs at least one file', { hint: 'for example speck info photo.png' });
  }

  const results = [];
  for (const file of files) {
    try {
      results.push(
        await analyzeFile(file, {
          hash: values.hash,
          strings: values.strings ? values.min : 0,
        }),
      );
    } catch (error) {
      // A missing file, a permission error or a directory is one line on
      // stdout next to the files that did work, and exit 1 at the end.
      results.push({ path: path.resolve(file), name: path.basename(file), error: error.message });
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
    return results.some((r) => r.error) ? 1 : 0;
  }

  for (const result of results) {
    if (result.error) {
      process.stdout.write(`${red('error')} ${result.path}: ${result.error}\n\n`);
      continue;
    }
    process.stdout.write(`${bold(result.name)}\n`);
    const row = (label, value) => process.stdout.write(`  ${label.padEnd(20)} ${value}\n`);
    row('path', dim(result.path));
    row('size', `${formatBytes(result.bytes)} (${result.bytes.toLocaleString('en-US')} bytes)`);
    row('modified', result.mtime);
    row('extension', result.extension ?? dim('(none)'));
    row(
      'contents',
      result.format
        ? `${kindColour(result.format.kind)(result.format.name)} ${dim(`(${result.format.kind})`)}`
        : result.text
          ? 'plain text'
          : yellow('unrecognised binary'),
    );
    if (result.bom) row('byte-order mark', result.bom);
    if (result.entropy !== null) {
      row(
        'entropy',
        `${result.entropy.toFixed(3)} bits/byte ${dim(result.entropy > 7.5 ? '(near maximum: compressed or encrypted)' : '')}`,
      );
    }
    if (result.sha256) row('sha256', dim(result.sha256));
    for (const field of result.details) row(field.label, field.value);
    for (const note of result.notes) process.stdout.write(`  ${dim('note')} ${note}\n`);
    for (const warning of result.warnings) process.stdout.write(`  ${red('warning')} ${warning}\n`);
    if (result.notable.length > 0) {
      process.stdout.write(`  ${yellow('notable strings')}\n`);
      for (const item of result.notable) process.stdout.write(`    ${item.value}\n      ${dim(item.why)}\n`);
    }
    if (values.strings && result.strings.length > 0) {
      process.stdout.write(`  ${dim('strings')}\n`);
      for (const value of result.strings.slice(0, 20)) process.stdout.write(`    ${value}\n`);
    }
    process.stdout.write('\n');
  }
  return results.some((r) => r.error) ? 1 : 0;
}

async function commandStrings(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return failFrom(parsed.error);
  const { values, files } = parsed;
  const file = files[0];
  if (!file) throw new UsageError('strings needs a file', { hint: 'for example speck strings suspicious.pdf' });

  let result;
  try {
    result = await analyzeFile(file, { strings: values.min });
  } catch (error) {
    // A missing file or a directory is a failed operation (1), not a usage
    // error: the command was typed correctly, the world was not as expected.
    return failFrom(error);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ path: result.path, min: values.min, strings: result.strings }, null, 2)}\n`);
    return 0;
  }
  for (const value of result.strings) process.stdout.write(`${value}\n`);
  if (result.strings.length === 0) process.stdout.write(dim(`no printable runs of ${values.min} or more characters\n`));
  return 0;
}

function commandFormats() {
  const groups = new Map();
  for (const format of FORMATS) {
    const list = groups.get(format.kind) ?? [];
    list.push(format);
    groups.set(format.kind, list);
  }
  process.stdout.write(`${bold(`${FORMATS.length} formats`)}\n\n`);
  for (const [kind, list] of [...groups.entries()].sort()) {
    process.stdout.write(`${kindColour(kind)(kind)}\n`);
    for (const format of list) {
      process.stdout.write(`  ${format.name.padEnd(34)} ${dim(format.extensions.join(' '))}\n`);
    }
  }
  return 0;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function run(argv) {
  // Taken from this invocation rather than only from process.argv, so an
  // in-process caller that passes --debug gets stack traces too.
  debugRequested = argv.includes('--debug');
  try {
    return await dispatch(argv);
  } catch (error) {
    // The one place that decides how a problem is reported: a UsageError keeps
    // its own code (2), and anything unexpected is a failed operation (1).
    return failFrom(error);
  }
}

async function dispatch(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  switch (command) {
    case 'identify':
    case 'id':
      return commandIdentify(rest);
    case 'info':
      return commandInfo(rest);
    case 'strings':
      return commandStrings(rest);
    case 'formats':
      return commandFormats();
    default:
      // A mistyped command is a usage error, so the hint names the real ones
      // instead of leaving the user to guess what "identfy" might have been.
      throw new UsageError(`unknown command: ${command}`, {
        hint: 'the commands are identify, info, strings and formats',
      });
  }
}

/**
 * Install the process-wide safety net: broken pipes, Ctrl-C, and the two
 * leftover error events.
 *
 * Exported so `bin/speck.js` installs exactly the same set. It matters because
 * the bin entry is what ends up on PATH: handlers installed only for
 * `node src/cli.js` would cover the one invocation nobody uses. The kit keeps a
 * WeakMap of what has been installed, so the bin entry and this module both
 * asking is a no-op rather than a doubled message.
 */
export function installHandlers() {
  return installCliHandlers({
    tool: 'speck',
    usage: () => USAGE,
    debug: isDebug,
  });
}

// Only run when invoked directly, so importing this module in a test is safe.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  // Installed before anything else runs, for `node src/cli.js ...`.
  installHandlers();
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.exitCode = failFrom(error);
    },
  );
}
