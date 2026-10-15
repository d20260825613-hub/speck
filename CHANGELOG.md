# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-15

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
- 两处可观察的行为变化,脚本需要留意:无扩展名的文件不再算作"扩展名与内容不符",
  `speck identify` 对这类文件的退出码从 `3` 变成 `0`;`speck strings` 传入多个文件
  时现在是用法错误(退出 `2`),此前它会只处理第一个、静默忽略其余并以 `0` 退出。

### Added

- `--debug` turns stack traces on for unexpected errors.
- `test/cli-kit.test.js`, 12 tests covering the shared error formatting, the
  handler lifecycle, and the bin entry. The suite is 82 tests across three files
  now. The bin case spawns a subprocess that imports `bin/speck.js` the way a
  command on PATH does: deleting the `installHandlers()` call there makes it fail
  with `sigint=0 pipe=0`, which is how the bug below was confirmed rather than
  assumed. The twelfth runs `test/cli.test.js` under the test runner and compares
  the number of tests it reports with the number it declares.

### Fixed

- 大于 64 KB 的 PNG,`IEND` 之后追加的数据现在能被报告。此前分块遍历把前 64 KB 与
  后 64 KB 拼成一块内存当连续数据走,只要某个 chunk(真实 PNG 的 IDAT 通常有几十
  KB)跨过 64 KB 边界,遍历就放弃并返回 `null`,调用处于是整段跳过,一句警告都不
  打——核心功能在真实尺寸的文件上静默失效。现在每个 chunk 头从包含它的那个窗口读
  取,并把尾部窗口的文件偏移单独记录;遍历停在两个窗口之间的空隙时,再按 `IEND`
  空 chunk 的固定头在尾部定位。若 64 KB 追加数据把 `IEND` 挤出两个窗口,则明确报
  告"无法清点",不再沉默。
- 20~39 字节的 ELF 不再让分析抛 `RangeError` 并以 1 退出(被当成"文件读不了")。
  64 位 ELF 的程序头偏移是 offset 32 处的 8 字节,需要 40 字节,而守卫只检查了 20
  字节,那一行还绕过了同文件里越界返回 `null` 的 `u64le()`。现在改用它读取,越界
  时补一条 "the program header offset is outside the bytes read" 警告。
- 合法的 ZIP 注释不再被误报为"有人往归档末尾追加了数据"。此前终点被硬编码为 EOCD
  签名位置加 22 字节,注释长度字段从未被读取;现在按规范把它计入声明的终点,并且
  只在确实多出字节时才报警。注释里出现 EOCD 签名这类边角情况也一并处理:优先采用
  能解释整个文件的那条记录。
- ZIP 读者改读文件尾部而不是头部:EOCD 本来就在末尾,大于 64 KB 的归档不再凭空多
  出一条"central directory is not in the bytes read"假警告,条目数也能正常列出。
- 无扩展名的文件不再被报成"扩展名与内容不符",`speck identify` 对这类文件不再以 3
  退出。缺失扩展名不是"不符":`extensionAgrees()` 现在返回 `null`(与"字节没匹配
  上任何格式"同义),而不是 `false`。
- 截断的 JPEG 不再打印出看似完整的帧头字段却没有任何提示:帧头(标记、长度、精度、
  高、宽、分量数共 10 字节)读不全时输出 "the frame header is cut off at the end of
  the bytes read" 并不再凭空给出 precision。
- 截断的 PE 不再静默丢掉 subsystem:可选头读不到时输出 "the optional header is cut
  off at the end of the bytes read",而不是把缺失字段当作不存在。
- `readDetails()` 的解析器异常不再被当成"文件读不了":任何读取器抛错都记为一条针对
  该格式的警告,文件本身仍被描述。
- 文件读取现在核对实际读到的字节数。此前 `handle.read()` 的返回值被丢弃,短读时缓
  冲区尾部是 `Buffer.alloc` 留下的 0,会被当作文件自己的字节参与识别、熵与文本判
  断;现在只保留真正读到的部分,尾部窗口的起始偏移单独记录,偏移计算不会因此错位。
- `speck strings` 不再接受多个文件却只处理第一个:多给一个文件现在是用法错误(退出
  2),而不是静默忽略其余、退出 0。
- `speck info` 与 `speck identify` 的逐文件错误现在会同时写到 stderr(stdout 不是终
  端时,或 `--json` 时),`speck identify *.bin > report.txt` 不会再悄悄丢掉失败信
  息。
- `--min 2` 和 `--min 3` 不再被悄悄抬到 4:`analyze.js` 里的 `Math.max(4, ...)` 去
  掉,解析器允许的下界(2)与实际使用的下界终于一致。
- 缺值的选项不再把紧随其后的另一个选项当成自己的值:`--min --hash` 现在报
  "--min needs a value",而不是把 `--hash` 读成数字后再报一个指向错误原因的错。
- 直接运行 `src/cli.js` 时,路径含 `#` 或 `%` 的目录不再静默什么都不做并退出 0:入
  口判断改用 `pathToFileURL()` 构造 URL,而不是手工拼接 `file://`。
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
  in 0.2.0, because 2 now means a usage problem.)
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

[Unreleased]: https://github.com/d20260825613-hub/speck/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/d20260825613-hub/speck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/d20260825613-hub/speck/releases/tag/v0.1.0