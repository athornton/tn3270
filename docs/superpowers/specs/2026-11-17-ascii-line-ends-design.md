# Ascii line ends in IND$FILE transfers, as x3270 converts them — design

Date: 2026-11-17. Status: approved in conversation. README *Staging* item 15a, the first of its
three parts (the user's order: line ends, then blink/intensify/bell, then the keyboard semantics;
the `bracket` default code page moved to 15c).

## Problem

With `Mode=ascii`, every front end asks the host for `CRLF` (`frontend/src/transfer.ts`,
`wantsCrlf`) but does no local conversion. Proven by probe (parity review, 2026-11-17): a DFT
receive of `41 42 0d 0a 43 44 0d 0a 1a` is written to the local file unchanged, where x3270 writes
`41 42 0a 43 44 0a`; a send of an LF-only file reaches the host with no CRs. The README records the
gap (*File transfer (IND$FILE)*, "`Mode=ascii` does no local line-end conversion yet"), as does the
parity row `file-transfer`.

## x3270's rule (suite3270 4.5ga6)

- **One flag, `cr_flag`:** true in ascii mode when `Cr` is `auto` (the default), `remove` or `add`;
  false for `keep` and in binary mode (`Common/ft.c:322`, `:941-951`). **The names are not
  directional**: `Cr=remove` on a send also adds CRs, and `Cr=add` on a receive also strips them.
- **Receive:** every `0x0d` and every `0x1a` (`^Z`) is dropped, wherever it appears
  (`Common/ft_cut.c:190`, `Common/ft_dft.c:301`).
- **Send:** a `0x0d` is inserted before each `0x0a` that does not already follow a `0x0d`
  (`Common/ft_cut.c:729-731`, `Common/ft_dft.c:503-513`).

## Decision (the user, 2026-11-17)

**Copy x3270 exactly** (option A of two; directional names were rejected). The README says the
names are not directional.

## Design

### `frontend/src/lineEnds.ts`, pure

- `convertsLineEnds(request)`: `request.mode === 'ascii' && request.cr !== 'keep'`. The same rule
  as `wantsCrlf` (which decides the command's `CRLF`); a test holds the two together over every
  mode and `cr` value.
- `fromHost(bytes: Uint8Array): Uint8Array`: `bytes` without any `0x0d` or `0x1a`.
- `toHost(bytes: Uint8Array): Uint8Array`: `0x0d` inserted before each `0x0a` not preceded by `0x0d`.

### Wiring, `frontend/src/transferRun.ts` only

- **Send:** the source is converted with `toHost` immediately after `files.read`, before either
  engine is built.
- **Receive:** the result is converted with `fromHost` immediately before `files.write` /
  `files.append`, in both the CUT and the DFT arm.
- Whole buffers in both directions (a send reads the file whole; a receive's result is whole), so
  there is no state across chunks. The engines, the command builder and the web gateway's adapter
  are unchanged; every front end (GUI, TUI, CLI, browser) goes through `startTransfer`.
- Progress and byte counts keep reporting what crossed the wire; the local file's size differs
  after conversion, and the messages say nothing new.

## Testing

- Unit tests of the three functions: CR and `^Z` mid-line, an existing CRLF not doubled, a lone
  trailing CR, empty input, input with nothing to convert.
- `startTransfer` with fake engines, both directions and both engines: `Cr` `auto` / `remove` /
  `add` convert, `keep` and binary do not; `convertsLineEnds` agrees with `wantsCrlf` everywhere.
- **Live, from the GUI:** an ascii receive of a known text file from VM (CUT) and from TSO (DFT),
  checking the local file has LF line ends and no `^Z`; an ascii send of an LF-only file, read back
  from the host to confirm the records survived. Recorded in `docs/live-testing.md`.

## Docs

- README *File transfer (IND$FILE)*: the "no local line-end conversion yet" paragraph becomes a
  description of the conversion, including that the `Cr` names are not directional.
- A scriv fragment (Bug fixes).
- Parity row `file-transfer`: the line-end gap is dropped and the new live heading cited.

## Out of scope

`Remap` (local character-set translation, parity row `transfer-remap`), the other `IND$FILE`
options, and any change to which `Cr` value is the default.

## Amendment 2026-11-17, while planning

**The wiring wraps `TransferFiles` once instead of converting at each read and write site.**
`withLineEnds(files)` returns a `TransferFiles` whose `read` applies `toHost` and whose `write` and
`append` apply `fromHost`; `startTransfer` uses it in place of `files` when `convertsLineEnds`
holds. Same behaviour as the design above, one wiring point instead of three, and CUT and DFT
cannot diverge because they write through the same object. `wantsCrlf` delegates to
`convertsLineEnds`, which replaces the planned agreement test with a single definition.

## Amendment 2026-11-17, from the Tasks 0-2 review

**The CLI does not go through `startTransfer`.** This spec said every front end does; the CLI runs
its own blocking loop (`packages/cli/src/runner.ts`, `Transfer()`), reading and writing the local
file itself, while still taking its command (with `CRLF`) from `transferCommand`. So it gets the
same one-line wrap with `withLineEnds`, and tests of its own. The GUI, the TUI and the web gateway
do go through `startTransfer`.
