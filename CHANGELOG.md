# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** `speck identify` now exits `3`, not `2`, when a file is
  identified but its extension disagrees with its contents. Exit `2` is now
  reserved for usage problems, so a script can tell "you typed the command
  wrong" (2) from "this file is misnamed" (3) from "a file could not be read"
  (1). A script that treated `2` as the misnamed signal must be updated.
- Arguments are parsed and reported by the shared CLI kit. An unknown option now
  says `speck: unknown option --hsah` with a `did you mean --hash?` hint, a
  missing option value says which option and gives an example, and a missing
  required argument or an unknown command is a usage error (exit 2) rather than
  a failed operation (exit 1).
- Every failure is reported as one `speck: ...` line, with the usage text where
  it helps, and a stack trace only with `--debug` (or `SPECK_DEBUG=1`). A file
  that cannot be read is still exit 1, and no longer prints a stack trace from
  the direct-run path.
- Broken pipes, Ctrl-C and leftover uncaught errors are handled by the kit's
  handlers, installed by both `bin/speck.js` and the direct-run block so that
  `speck strings big.bin | head` exits quietly rather than printing an EPIPE
  stack trace.

### Added

- `--debug` turns stack traces on for unexpected errors.
- `test/cli-kit.test.js`, 11 tests covering the shared error formatting, the
  handler lifecycle, and the bin entry. The suite is 51 tests across three files
  now. The bin case spawns a subprocess that imports `bin/speck.js` the way a
  command on PATH does: deleting the `installHandlers()` call there makes it fail
  with `sigint=0 pipe=0`, which is how the bug below was confirmed rather than
  assumed.

### Fixed

- `installCliHandlers` was called only from the direct-run block in
  `src/cli.js`, so it never fired for the installed `speck` command: the bin
  entry imports the module rather than running it directly. `bin/speck.js` now
  installs the handlers itself, which is what makes the broken-pipe and Ctrl-C
  cases work in real use.
- The unused `entropy` and `looksLikeText` imports in `src/cli.js` are gone.

## [0.1.0] - 2026-09-26

### Added

- `speck identify`, `info`, `strings` and `formats`, covering 40 file formats
  across executables, archives, images, documents, media, databases and
  certificates. Identification is from the leading bytes, never the extension.
- Files whose extension disagrees with their contents are reported, and
  `speck identify` exits 2 for them so a script can act on it. (Changed to exit 3
  in the unreleased entry above, because 2 now means a usage problem.)
- Bytes appended after the end of a PNG (past IEND) or a ZIP (past the central
  directory) are counted and reported. That is how one file gets hidden inside
  another.
- Header details worth reading: PNG and JPEG dimensions, GIF colour tables, WAV
  sample rate and duration, ZIP entry counts, ELF class and machine, PE
  subsystem, gzip original name, PDF version and encryption.
- Shannon entropy per byte, with a note when the value is near maximum and the
  format does not already explain why.
- Notable strings: script tags, SVG, shebangs, private keys, certificate headers
  and AWS-style key ids get surfaced with what they mean.
- Nothing is executed or decompressed; the first and last 64 KB are read.
- 38 tests whose fixtures build real PNG, ZIP and gzip containers byte by byte,
  so the tests show which bytes are being relied on.

[Unreleased]: https://github.com/d20260825613-hub/speck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/d20260825613-hub/speck/releases/tag/v0.1.0