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

import { analyzeFile, analyzeMany, entropy } from './analyze.js';
import { FORMATS, looksLikeText } from './magic.js';

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
  2  a file was identified but its name disagrees with its contents

Examples
  speck identify download.zip
  speck info photo.png --hash
  speck strings suspicious.pdf -n 8
  speck identify *.bin --json
`;

function fail(message, code = 1) {
  process.stderr.write(`speck: ${message}\n`);
  return code;
}

function parseArgs(argv) {
  const values = { hash: false, strings: false, json: false, min: 6 };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--hash') values.hash = true;
    else if (token === '--strings') values.strings = true;
    else if (token === '--json') values.json = true;
    else if (token === '-n' || token === '--min') values.min = Number(argv[++i]);
    else if (token.startsWith('--min=')) values.min = Number(token.slice(6));
    else if (token === '--') files.push(...argv.slice(i + 1));
    else if (token.startsWith('-') && token !== '-') return { error: `unknown option: ${token}` };
    else files.push(token);
  }
  if (!Number.isInteger(values.min) || values.min < 2) return { error: '--min must be an integer of at least 2' };
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
  if (parsed.error) return fail(parsed.error);
  const { values, files } = parsed;
  if (files.length === 0) return fail('identify needs at least one file');

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
  if (unreadable) return 1;
  return mismatched ? 2 : 0;
}

async function commandInfo(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return fail(parsed.error);
  const { values, files } = parsed;
  if (files.length === 0) return fail('info needs at least one file');

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
  if (parsed.error) return fail(parsed.error);
  const { values, files } = parsed;
  const file = files[0];
  if (!file) return fail('strings needs a file');

  let result;
  try {
    result = await analyzeFile(file, { strings: values.min });
  } catch (error) {
    return fail(error.message);
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
      return fail(`unknown command: ${command}. Try "speck --help"`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`speck: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
