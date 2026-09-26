# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-26

### Added

- `speck identify`, `info`, `strings` and `formats`, covering 40 file formats
  across executables, archives, images, documents, media, databases and
  certificates. Identification is from the leading bytes, never the extension.
- Files whose extension disagrees with their contents are reported, and
  `speck identify` exits 2 for them so a script can act on it.
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