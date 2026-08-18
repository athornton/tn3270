# IND$FILE File Transfer (CUT mode) — Design

Design settled 2026-08-18. Goal: **transfer files between the local filesystem and
VM/CMS using the host's `IND$FILE` program**, in CUT mode, both directions, binary by
default.

**Why this matters more than it looks:** VM/370 has no TCP/IP, so `IND$FILE` is the
practical way to get new software *onto* the system. Upload is the primary use, not an
afterthought — the user said so explicitly. Download is implemented first only because
it verifies the shared codec, so that a subsequent upload failure is unambiguously an
upload bug.

Prerequisite reading: `docs/live-testing.md` (host runbook), and x3270's
`Common/ft_cut.c` plus `include/ft_cut_ds.h` at `~/src/suite3270-4.5/`.

## Governing principle

**Where CUT behaviour is underspecified, do what x3270 does.** It is the client these
hosts have actually been driven with for decades, so its choices are the de facto
protocol. `ft_cut_ds.h` is 82 lines and documents every offset, frame type, status code
and AID; `ft_cut.c` is the algorithm. Both are on local disk. Diff against them rather
than reasoning from first principles.

## TWO NAMING TRAPS, both of which would produce confidently wrong code

**1. x3270's "upload"/"download" are from the HOST's perspective, inverted from
ordinary usage.** Verified from the comments in `ft_cut.c`:

| x3270 name | Direction | What a user calls it | IND$FILE verb |
|---|---|---|---|
| `upload_convert` (`ft_cut.c:134`, comment at `:129` "Convert a buffer for uploading (host->local)") | host → local | **download** | `GET` |
| `download_convert` (`ft_cut.c:307`, "Convert a buffer for downloading (local->host)"), `store_download` (`:270`) | local → host | **upload** | `PUT` |

**Our code uses `hostToLocal` and `localToHost`,** which cannot be misread. Every
citation of an x3270 function must note which direction it actually is.

**2. MECAFF's `IND$FILE` is CUT mode, not DFT.** Established from the host's own
source — `IND$FILE C` on the `MECAFF` userid's E disk (label `MCF294`) opens:

```
** IND$FILE - main program for IND$FILE in CUT-mode
```

This matters because DFT is the more modern protocol and the natural assumption for a
2010s reimplementation. It would have been the wrong engine entirely.

## Host facts, established by probing

- **VM/370 CE ships `IND$FILE`** as part of the MECAFF tools: `IND$FILE C` and
  `IND$FILE TEXT` on the `MECAFF` userid's E disk (`MCF294`), `IND$FILE C` and
  `IND$FILE H` on F (`MCF394`). The C source is on disk, so host-side behaviour can be
  read rather than guessed.
- **It is NOT on `CMSUSER`'s accessed disks.** `LISTFILE IND$FILE * *` as `CMSUSER`
  returns `Ready(00028)` (file not found). Setup requires an `ACCESS` of a MECAFF disk
  or a copy onto the user's A disk. **The runbook must state this** — it cost a probe
  round to discover.
- **Credentials** (from `readme-1_2.txt`, not guessed): `CMSUSER`/`CMSUSER`,
  `MAINT`/`CPCMS`, `MECAFF`/`MECAFF`, `GCCCMS`/`GCCCMS`, `BREXX`/`BREXX`.
- VM/CE's own changelog records "Changed 3270 config so "Escape" is "escape" as needed
  for ind$file" (`readme-1_3.txt` item 3), i.e. the distributor treated this as a
  supported path.
- **MVS 3.8j TK5 does NOT have `IND$FILE` yet.** The user will install it from CBT.
  Nothing in the TK5 distribution provides it (only `FTPD.zip`, which is TCP/IP FTP).
  So TSO is out of scope for now but must be *additive* later — see Dialect seam.
- **CMS Pipelines is not available** on this VM/370, so `PIPE` cannot be used to
  inspect host files. `TYPE <fn> <ft> <fm> <first> <last>` works and pages with
  `MORE...`.

## Scope

In scope:

1. **CUT-mode codec** — the 6-bit `table6` encoding (64-char alphabet), the four
   77-entry quadrant translation tables, and the XOR checksum.
2. **Download** (`GET`, host→local), then **upload** (`PUT`, local→host).
3. **Binary by default**, `Mode=ascii` opt-in. A wrong default silently corrupts a
   MODULE; a wrong explicit choice is visible in the command.
4. **s3270-compatible `Transfer()`** CLI action with keyword=value parameters.
5. **CMS dialect only**, structured so a TSO dialect is additive.

Not in scope, stated so it is not mistaken for delivered:

- **DFT mode.** MECAFF is CUT; DFT is a different protocol and a separate project.
- **TSO/MVS dialect.** Blocked on the host program existing. The seam is designed in.
- **CICS dialect.** No host to test against.
- **Sugar commands** (`Get`/`Put`). Deliberately deferred; `Transfer()` is canonical
  and sugar is cheap to add later, whereas removing a diverging vocabulary is not.
- **Alternate screen geometry.** See the coupling warning below.

## THE GEOMETRY COUPLING, which must not be broken silently

CUT works by the host planting a structured field at **`O_SF` = 1919**, which is the
last cell of a **24×80** buffer, and by both sides reading and writing data at fixed
offsets within that buffer. Stage 2a pinned the advertised geometry to 24×80 as both
default and alternate size, so this works today.

**These two facts are now coupled.** Implementing alternate screen sizes later — a
stage 2b-or-later item — must not silently break file transfer. Whoever does that work
needs to read this paragraph. x3270 handles it because CUT is only used on the
implicit partition at model-2 dimensions.

## Wire format, from `ft_cut_ds.h`

Every constant below is cited to that header, which is authoritative and on disk.

```
O_SF                1919    offset to the CUT structured field (last cell, 24x80)

Primary area (host -> us)
  O_FRAME_TYPE         0
    FT_CONTROL_CODE  0xc3     O_CC_FRAME_SEQ 1, O_CC_STATUS_CODE 2, O_CC_MESSAGE 4
      SC_HOST_ACK      0x8181   ack of the IND$FILE command
      SC_XFER_COMPLETE 0x8189   transfer complete
      SC_ABORT_FILE    0x8194   abort, file error
      SC_ABORT_XMIT    0x8198   abort, transmission error
    FT_DATA_REQUEST  0xc2     O_DR_SF 1, O_DR_DATA_CODE 2, O_DR_FRAME_SEQ 3
    FT_RETRANSMIT    0x4c     re-send the previous frame
    FT_DATA          0xc1     O_DT_FRAME_SEQ 1, O_DT_CSUM 2, O_DT_LEN 3, O_DT_DATA 5

Response area (us -> host)
  O_RESPONSE      O_SF-5 = 1914
  RO_FRAME_TYPE   1915   RFT_RETRANSMIT 0x4c, RFT_CONTROL_CODE 0xc3
  RO_FRAME_SEQ    1916
  RO_REASON_CODE  1917

Upload data area (us -> host)
  O_UP_DATA_CODE  2,  O_UP_FRAME_SEQ 3,  O_UP_CSUM 4,  O_UP_LEN 5,  O_UP_DATA 7
  O_UP_MAX = O_SF - O_UP_DATA = 1912 bytes per frame

Special data
  EOF_DATA1 0x5c, EOF_DATA2 0xa9      two-byte end-of-file sentinel

Acknowledgement AIDs
  ACK_OK          = Enter (0x7d)
  ACK_RETRANSMIT  = PF1   (0xf1)
  ACK_RESYNC_VM   = Clear (0x6d)      <-- VM
  ACK_RESYNC_TSO  = PA2   (0x6e)      <-- TSO; the dialect difference is already here
  ACK_ABORT       = PF2   (0xf2)
```

Max download payload is `O_RESPONSE - O_DT_DATA` = 1909 bytes; a longer declared length
is an abort with `SC_ABORT_XMIT` (`ft_cut.c` "ftCutOversize").

The 6-bit alphabet (`ft_cut.c:105`):
`"abcdefghijklmnopqrstuvwxyz&-.,:+ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"`.
Four quadrants (`NQ 4`) of 77 elements (`NE 77`); `XLATE_NULL 0xc1`; NULL lives in the
`OTHER_2` quadrant (2).

## The checksum decision

**Upload computes a checksum; download's is verified but never fatal.**

- Upload: XOR every data byte, mask to 6 bits, encode through `table6`, write at
  `O_UP_CSUM` — exactly `ft_cut.c:550-554`. The host verifies it and can demand a
  retransmit, so this one is load-bearing.
- Download: `O_DT_CSUM` exists at offset 2 and **x3270 never reads it** — the only
  reference anywhere in the x3270 tree is the `#define` itself (verified by
  `grep -rn O_DT_CSUM`). It is a deliberate omission, not an oversight.

The user asked for verification anyway, which is a reasonable instinct: we get a real
diagnostic for free. So **compute it and emit a trace note on mismatch, but do not
abort** — a mismatch must not fail a transfer that x3270 would have completed, and the
protocol offers no client-initiated retransmit to recover with in any case.

**PREREQUISITE, and it gates this decision:** confirm MECAFF actually populates that
byte. If it writes zero, every frame would log a spurious warning and the feature
collapses to x3270's behaviour (ignore it). Measure before trusting a mismatch as
meaningful — see the probe below.

## Architecture

Four units, each testable without the one above it.

| File | Responsibility |
|---|---|
| `packages/core/src/ft/cut.ts` | Pure codec: the 6-bit `table6` alphabet, the four 77-entry quadrant tables, `from6`/`to6`, XOR checksum, `hostToLocal()` and `localToHost()`. No screen, no session, no I/O. |
| `packages/core/src/ft/frames.ts` | Frame layout over a `Screen`: read a frame out, write a response in. Constants from `ft_cut_ds.h`. |
| `packages/core/src/ft/transfer.ts` | The state machine. Holds direction, mode, file bytes, sequence, EOF and the last sent block. `onFrame(screen) → {ack, done?}`. |
| `packages/cli/src/transfer.ts` | `Transfer()` keyword parsing → engine options; drives the engine through `Session`. |

**How it hooks in: as an observer, not a session feature.** The transfer subscribes to
the session's existing `screen` event, tests whether the buffer holds a CUT frame, and
if so processes it and calls `session.sendAID()`. **Nothing in `session.ts` changes.**
That file already carries connection, telnet, screen, keyboard, OIA and Query Reply at
325 lines; a stateful multi-frame transfer with retransmit does not belong in it, and
file transfer is genuinely optional to a session.

Frame detection uses x3270's test (`ft_cut.c:394`): an auto-skip field attribute at
`O_SF`. Ours already has `screen.attributeAt()` and `FA` masks, so this is a predicate,
not new plumbing.

**Everything CUT needs already exists in stage 1's screen model** — `setChar`,
`cellAt`, `attributeAt`, `setFieldAttribute`, and all five acknowledgement AIDs
(`AID.ENTER`, `PF1`, `PF2`, `CLEAR`, `PA2`). CUT is not a side channel; it is the 3270
screen used as a data pipe, which is why it lands on top of what we have.

## Dialect seam

Host-independent: the codec, the frame layout, the state machine. Host-dependent, and
therefore the only thing a TSO dialect adds:

1. **Command construction.** CMS takes `(` before options and a `fn ft fm` triple; TSO
   takes a dataset name and `RECFM()`/`LRECL()`/`BLKSIZE()`/`SPACE()` keywords. From
   x3270's builder (`ft.c:683-740`): the `(` is emitted only when `host_type != HT_TSO`.
2. **Resync AID.** `ACK_RESYNC_VM` is Clear, `ACK_RESYNC_TSO` is PA2.
3. **The `$` escape.** x3270 emits `IND\e005BFILE` — the `$` as EBCDIC `0x5B`. We must
   verify the byte we actually put on the wire is `0x5B` rather than trusting a
   character round-trip through cp037.

A `Dialect` interface with `buildCommand(opts)` and `resyncAid` covers all three.

## Data flow

**Download** (`Direction=receive`):

```
CLI:  Transfer(Direction=receive,HostFile=PROFILE EXEC A,LocalFile=/tmp/p.exec)
us:   "IND$FILE GET PROFILE EXEC A (" + Enter
host: FT_CONTROL_CODE / SC_HOST_ACK       -> ack (Enter)
host: FT_DATA (seq, csum, len, data)      -> hostToLocal, append, ack   [repeats]
host: FT_DATA with 5c a9                  -> EOF, ack
host: FT_CONTROL_CODE / SC_XFER_COMPLETE  -> done
```

**Upload** (`Direction=send`) — the primary use:

```
us:   "IND$FILE PUT X MODULE A (" + Enter
host: FT_CONTROL_CODE / SC_HOST_ACK       -> ack
host: FT_DATA_REQUEST (seq)               -> localToHost up to O_UP_MAX into the screen
                                             at O_UP_DATA; write seq, XOR csum, and the
                                             length as two 6-bit chars (12 bits); Enter                  [repeats]
us:   5c a9 as the data                   -> EOF
host: FT_CONTROL_CODE / SC_XFER_COMPLETE  -> done
```

**`FT_RETRANSMIT` means re-send the previous frame**, so upload must RETAIN the last
encoded block rather than stream-and-forget. This is upload's characteristic failure
path and needs a deliberate test.

**Abort is bidirectional.** We write `RFT_CONTROL_CODE` into the response area with a
reason and send `ACK_ABORT` (PF2); the host sends `SC_ABORT_FILE`/`SC_ABORT_XMIT` in a
control code with message text at `O_CC_MESSAGE`. Either way the transfer ends failed,
carrying the host's message.

## Error handling

Follows the established pattern: **a transfer fault does not kill the session.** A
malformed frame or oversize length aborts the transfer and reports, exactly as a
program check reports without dropping the connection.

A local file error — unreadable source, or destination existing without
`Exist=replace` — fails **before** the host command is typed, so the host is never left
sitting in transfer mode waiting for a client that has already given up.

## Testing

**1. Codec tests, exhaustive where exhaustive is available.** `from6`/`to6` over all
256 byte values and all 64 alphabet positions; every non-zero quadrant entry; and the
round-trip property `hostToLocal(localToHost(b)) === b` for every byte 0-255 plus
random buffers. The codec is pure and small, so this is genuinely exhaustive, not
sampled.

**2. Frame layout tests citing `ft_cut_ds.h` line numbers**, same discipline as the
Query Reply work. Plus the detection predicate: auto-skip FA at 1919 means CUT frame.

**3. State-machine tests over synthetic screens.** Host ack → Enter; data → decoded and
appended; EOF sentinel → ack; complete → done; abort → failed with the host's text;
**retransmit → previous block re-sent byte-identical**; oversize → abort
`SC_ABORT_XMIT`.

**4. Full scripted transfers against synthetic host screens**, both directions, proving
frames sequence correctly rather than only individually.

**5. The live runs — the real acceptance test.** Against VM/CE:
- Download a file whose contents are independently readable via `TYPE`, and byte-compare.
- Upload a binary file, download it back, compare to the original; and check
  recfm/lrecl on the host with `LISTFILE (FORMAT`.
- **A deliberately nasty binary payload** containing `0x00`, `0xFF`, bytes colliding
  with the 6-bit alphabet, and bytes from each quadrant. A text file exercises none of
  the quadrant machinery.

## Prerequisite probe, BEFORE implementation

Everything above assumes MECAFF speaks the CUT dialect x3270 expects. Its source says
"CUT-mode" and it was built to work with wc3270, so that is a strong prior — **but a
prior is not a measurement.** Drive `IND$FILE GET` by hand, capture the raw screen, and
record:

1. Does an auto-skip field attribute actually appear at 1919?
2. What does MECAFF put in `O_DT_CSUM`? (Gates the checksum decision above.)
3. Does the frame layout match `ft_cut_ds.h` at all — frame type at 0, sequence at 1,
   length at 3?

If MECAFF diverges anywhere, that must be known before the state machine is written,
not after.
