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
- **The executables are `IND$FILD` and `IND$FILS`, NOT `IND$FILE`.** An earlier draft
  of this spec had this wrong. `IND$FILE` exists only as `C` (source) and `TEXT`
  (object); the runnable modules carry the `D`/`S` suffixes for the dynamically- and
  statically-linked variants the readme describes. `LISTFILE IND$FILE * *` returns
  `Ready(00028)` and looks like "not installed" when it is really "wrong name".
- **They ARE already on `CMSUSER`'s default disks** — `IND$FILD MODULE Y2` and
  `IND$FILS MODULE Y2`, on the `19E` system disk accessed as Y. No `LINK` or `ACCESS`
  is needed; an earlier draft of this spec wrongly said setup was required.
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
  `O_UP_CSUM` — exactly `ft_cut.c:550-554`. In principle the host verifies it and can
  demand a retransmit. **But MECAFF does not:** its `receiveData` reads
  `char csum; /* checksum is simply ignored ! */` (`IND$FILE C` on the MECAFF disk).
  So against *this* host a checksum bug would not be caught by the host at all — only
  by comparing the transferred file. Send it correctly regardless, because a real IBM
  host does check, but do not rely on the host to catch our mistakes.
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

## MVS/TSO HOST FOUND, and it is the friendlier one (2026-08-18)

The user installed the CBT disks on TK5 and cataloged them. **TK5 now has a working
IND$FILE that talks to a plain 3270 client.** `IND$FILE` with no arguments prints:

```
Free File Transfer Program, version 2.0.5, Compiled: Sep  1 2016 08:50:49
Copyright(c) 2002-2016 Mike Rayborn, mailto:mikerayborn@comcast.net
Usage: IND$FILE {GET|PUT} 'dataset.name' options
       IND$FILE {GET|PUT} dd:ddname      options
options: ASCII CRLF APPEND TRACE DEBUG
         RECFM(F|V|U) LRECL(nn) BLKSIZE(nn) TRACKS|CYLS SPACE(n,n)
         UNIT(x) VOLUME(vvvvvv) CODEPAGE(cdpg)
         RDW RDW4 RDWPC RDWPC4
```

So it is an open-source reimplementation, not IBM's — but unlike MECAFF it has **no
fullscreen gatekeeping**, and its options confirm the dialect this design anticipated:

- **Binary is the default**; `ASCII` is opt-in. Matches our choice.
- **TSO keyword form** — `RECFM(F)` with parens, versus CMS's bare `RECFM F`. Exactly
  the dialect seam already designed in.
- Three host-file forms to accept: quoted `'dataset.name'`, unquoted (userid
  prepended), and `dd:ddname` for a pre-allocated ddname.
- `TRACE` writes host-side diagnostics to a dataset allocated to `INDTRACE` — a real
  gift when debugging a transfer, and worth using on the first live run.
- `CODEPAGE(cdpg)` names an external translation table, default `CDPGDFLT`. Relevant
  given the codec finding below that x3270's tables are not cp037.

**Crucially: TK5 asks with a PLAIN QUERY, not a Query List.** Measured
`ReadPartition(pid=0xff,type=0x02)`, and our stage 2a Query Reply answers it correctly
(observed on the wire: `88 00 07 81 80 80 81 a6 00 17 81 81 ...`). **So MVS/TSO is not
blocked on the Query List work that VM/CMS needs** — it may well be the first host to
complete a transfer, inverting the original plan's ordering.

Still unknown for TK5: **whether it speaks CUT or DFT.** The usage text does not say,
and the one `GET` attempt so far failed for an unrelated scripting reason
(`IKJ56410I ... COMMAND NOT ACCEPTED DURING LOGON` — a desynchronized logon script,
plus a userid left logged on by a previous probe). That question must be answered before
`transfer.ts` is written, because CUT and DFT are different protocols and only the CUT
codec is built.

**Operational note that cost a probe round:** TSO leaves a userid logged on if a script
does not reach `LOGOFF`, and the next attempt then draws
`IKJ56425I LOGON REJECTED, USERID IN USE` — which looks like a failure of the thing
being tested. Rotate among `HERC01`/`HERC02` (`CUL8TR`) and `HERC03`/`HERC04`
(`PASS4U`), and always reach a real `LOGOFF`.

## PROTOCOL CONFIRMED: TK5 SPEAKS CUT, AND OUR CODEC ALREADY DECODES IT

The open question — CUT or DFT — is settled by measurement. **TK5's IND$FILE speaks
CUT**, and our `ft/cut.ts` decoded a live frame from the real host on the first attempt.

The host records are unmistakable against `ft_cut_ds.h`:

```
EraseWrite SBA(1919) SBA(0) data[5]    SBA(1914) SF(0xc1) IC data[4] SF(0x7c)
EraseWrite SBA(1919) SBA(0) data[1909] SBA(1914) SF(0xc1) IC data[4] SF(0x7c)
```

`SBA(1919)` is `O_SF`; `SBA(1914)` is `O_RESPONSE` (`O_SF-5`); `SF(0xc1)` is `FT_DATA`;
and `data[1909]` is exactly `O_RESPONSE - O_DT_DATA`, the maximum download payload
derived from the header.

**Decoding a real frame end to end** (`IND$FILE GET 'SYS1.PARMLIB(IEASYS00)' ASCII
CRLF`):

```
frame type 0xc1 = FT_DATA,  seq = 1,  csum6 = 62,  declared len = 1904
hostToLocal -> 1498 bytes:
" APF=00,     Suffix for authorized lib list IEAAPFxx\r\n
  APG=07,     Automatic Prority Group\r\n
  BLDLF=BA,   Suffix for BLDL list IEABLDxx\r\n ..."
```

That is genuinely the contents of `SYS1.PARMLIB(IEASYS00)`, with the `\r\n` the `CRLF`
option asked for. The frame layout, the 12-bit length across two 6-bit chars, the
quadrant state machine and the EBCDIC tables are all confirmed correct against a real
host — not just against x3270.

**AND THE DOWNLOAD CHECKSUM IS REAL ON THIS HOST: host sent 6-bit 62, we computed 62.**
This settles the earlier open question. MECAFF ignores the checksum on receive, but
TK5's IND$FILE *populates* it on send, so verifying it is meaningful here rather than
spurious — the "verify but warn, never abort" decision now rests on evidence.

**Consequences for the plan:**

- The CUT codec needs no changes. It is verified against a live host.
- `frames.ts` as designed is the correct next step; no DFT engine is needed for TK5.
- **MVS/TSO is now the lead host**, not VM/CMS: it asks with a plain Query we already
  answer, needs no Query List work, and has no fullscreen gatekeeping. VM remains
  blocked on Query List support.

**Operational lesson, learned the hard way:** every host script must reach `LOGOFF` on
*every* exit path. Probes that ended at `Quit` without logging off left all four TSO
userids stuck `IN USE`, which then looks exactly like a failure of whatever is being
tested — and it cost a wrong conclusion (fields at 1915/1919 read as CUT frames when the
session had never got past logon). The stage 1 runbook already says this; it is repeated
here because it was ignored anyway.

## FIRST LIVE TRANSFER WORKS — download from MVS TK5, 2026-08-18

```
Transfer(Direction=receive,HostFile='SYS1.PARMLIB(IEASYS00)',
         LocalFile=/tmp/got.txt,Mode=ascii,Cr=add)
```

**1742 bytes arrived, correct start to finish, with CRLF line terminators as
requested.** `file` reports "ASCII text, with CRLF line terminators"; the content is
genuinely `IEASYS00` from `APF=00` through `WTORPLY=10`. The whole stack works end to
end against a real host: telnet framing, Query Reply, CUT frame detection, frame
parsing, the base-77 codec with its quadrant state machine, the transfer state machine,
and the CLI action.

Client invocation: `-model 3278-2-E` (a plain `IBM-3278-2` is refused by TSO with
`IKT00405I`).

**Two operational lessons from the run, both worth carrying into the runbook:**

1. **`Wait(Unlock)` before typing after a transfer.** The `String("LOGOFF")` that
   followed the transfer was refused with `input inhibited` — the status line shows `L`
   (locked) for that command and `U` immediately after, so the keystroke simply raced
   the post-transfer screen. Adding `Wait(Unlock,20)` before it fixes it, verified: a
   clean `LOGOFF` back to the VTAM panel with no inhibited keystroke. **A transfer
   leaves the keyboard briefly locked and a script must wait for it.**
2. **That refused `LOGOFF` left the userid logged on**, which then blocks the next run
   with `IKJ56425I ... IN USE`. Same trap as before, from a different cause: last time
   the script never reached `LOGOFF`, this time it reached it and the host refused it.
   **Check the reply status, not just that the command was issued** — the `error` line
   was right there in the output.

**TSO quoting is semantic.** `HostFile='SYS1.PARMLIB(IEASYS00)'` — with quotes — fetches
that dataset; without them TSO prepends the userid and looks for
`HERC02.SYS1.PARMLIB(IEASYS00)`. The host name passes through verbatim, matching x3270
(`ft.c:687`), so the operator owns the quoting. Both forms are legitimate and only the
operator knows which is meant.

**Still untested against a live host: upload (`Direction=send`).** That is the primary
use case — getting software onto a system with no TCP/IP — and it exercises the encoder,
the checksum the host actually verifies, and the retransmit path, none of which a
download touches.

## UPLOAD WORKS TOO — round trip byte-exact against MVS TK5, 2026-08-18

The primary use case is proven. A deliberately nasty 249-byte binary — nulls,
`0xFF`, all four quadrant selectors, the twelve punctuation bytes shared between
quadrants 0 and 1, `0x00`-`0xFF` at stride 17, and 200 random bytes; 160 distinct
values — was uploaded and downloaded back.

**`Recfm=variable` round-trips exactly:**

```
Transfer(Direction=send,LocalFile=/tmp/nasty.bin,HostFile=NASTYV.BIN,
         Recfm=variable,Lrecl=1024)          -> 249 bytes transferred
Transfer(Direction=receive,HostFile='HERC02.NASTYV.BIN',
         LocalFile=/tmp/back2.bin)           -> 249 bytes transferred
sent 249, back 249, IDENTICAL: true
```

Both transfers ran **in one session**, upload then download without reconnecting.

**`Recfm=fixed` pads, and that is correct behaviour rather than a bug.** The same
payload with `Recfm=fixed,Lrecl=80` came back as **320 bytes: the original 249
followed by 71 nulls.** `ceil(249/80) = 4` records × 80 = 320, padding 71 — which
matches the observed padding exactly. A fixed-record dataset has no way to record
that the last record was short. **For shipping a MODULE, use `Recfm=variable`**,
and expect padding if you ask for `fixed`.

**WHICH RECFM TO USE, from the CMS Gopher readme rather than guesswork.** Troth's
`GOPHER24 README` gives the convention for the two things you actually ship to a
VM system, and they differ:

```
  PLEASE NOTE:   when fetching MODULEs and VMARC files from some hosts,
  the record structure must be restored.   If you pick-up a MODULE from
  a UNIX FTP host,  you must  "deblock" it back into its CMS form with:

        PIPE < program MODRAW | DEBLOCK CMS | > program MODULE A

  For VMARC files,  reblock to  Fixed 80  with:

        PIPE < package VMARCRAW | FBLOCK 80 00 | > package VMARC A
```

- **VMARC → `Recfm=fixed,Lrecl=80`.** Note `FBLOCK 80 00` pads with **nulls** —
  which is precisely the padding measured above and called a "quirk". It is not a
  quirk; it is the convention the format expects. Confirmed against the local
  copies: `gop242s.vmarc` is 9920 bytes (124 records) and `gopher24.vmarc` is
  601840 (7523), both **exactly divisible by 80**.
- **MODULE → NOT fixed-80.** A CMS MODULE carries its own internal record
  structure, restored with `DEBLOCK CMS`, so a plain fixed-80 upload is not
  sufficient. This is a gap worth knowing before trying to ship an executable.
- **Anything where byte-exactness matters and the host format is ours to choose →
  `Recfm=variable`**, which round-trips exactly (measured above).

(Aside, since it comes up: `gopher24.vmarc` being cleanly divisible by 80 means
its blocking is fine, so `vma`'s failure to unpack it is about the `:CFF`
compressed members, not the record format.)

This exercises everything a download does not: the encoder, the quadrant state
machine in the emitting direction, the checksum the host verifies, and frame
sequencing on the sending side. The retained-encoded-bytes design for retransmit
was not observably triggered (no retransmit occurred on a clean local link), so
**that path remains unit-tested only** — see the note below on why re-encoding
would have corrupted data silently.

## Codec findings, from the implementation (2026-08-18)

`packages/core/src/ft/cut.ts` is built and committed (`3b3b386`), 50 tests, exhaustive
round-trip over every byte 0x00-0xFF. Four findings worth keeping, each independently
verified rather than taken on report:

**1. x3270's EBCDIC tables are NOT cp037, and the difference is reachable.**
`ebc2asc0` differs from cp037 in **66 of 256 entries** — it flattens the whole EBCDIC
control range below 0x40 to space, except X'1C'→`*` and X'1E'→`;`, which are two
selectors' ASCII forms. Only two differences sit at or above 0x40 and exactly one is
reachable: **EBCDIC X'41' is space (0x20) to x3270 but NO-BREAK SPACE (0xA0) to
cp037**, and NBSP is not in `ALPHAS` — so a cp037-based codec throws a conversion error
where x3270 decodes successfully. **The codec therefore carries its own private
tables**, and must keep doing so. Over the 64 `TABLE6` and 77 `ALPHAS` characters the
two agree exactly, which is why the encode path would have looked fine in testing.

**2. All 256 byte values are representable** — no gaps. `0x00` sits at index 0 of
*both* quadrant 2 and quadrant 3, which is exactly why `localToHost` must special-case
NULL before the generic quadrant search rather than letting it pick whichever it finds
first. Zero counts per quadrant are `[0, 0, 32, 9]`; twelve punctuation bytes
(0x4B-0x4E, 0x50, 0x61, 0x6B-0x6F, 0x7A) are shared between quadrants 0 and 1.

**3. ONE CODEC INSTANCE PER TRANSFER, held across all frames.** The quadrant is
persistent state and a selector byte is emitted only when it changes. x3270 uses a
file-static (`ft_cut.c:108`), which we deliberately did not copy — it would make
concurrent transfers corrupt each other and tests order-dependent. `frames.ts` and
`transfer.ts` must hold a single `CutCodec`; the module-level `hostToLocal`/
`localToHost` helpers build a fresh codec per call and are whole-buffer only. A
per-frame reset would emit spurious leading selectors on upload and reject legitimate
data-first frames on download.

**4. The `c != XLATE_NULL` clause at `ft_cut.c:181` is dead code.** It can only change a
decision when the quadrant is not `OTHER_2`, `xlate[ix]` is 0, and `c` is 0xC1 — but
`ebc2asc0[0xC1]` is `'A'`, always `ALPHAS` index 1, and no non-`OTHER_2` quadrant has a
zero at index 1. Unsatisfiable. Ported anyway (quadrants are data, so it costs nothing)
with a test asserting the unsatisfiability, so we would learn if that ever changed.

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

## BLOCKER RESOLVED 2026-08-18 — it was the terminal type, then Query List

**The cause was `IBM-3278-2`.** MECAFF refuses fullscreen to a terminal that does not
claim extended data stream. Single-variable test, everything else identical:

| terminal type | `FSQRY` |
|---|---|
| `IBM-3278-2` (our default) | "Please press ENTER to cancel fullscreen operation" |
| `IBM-3278-2-E` | `Ready;` — succeeds |
| `IBM-DYNAMIC` | succeeds |

The user confirmed EE and XXLIST work from their own client, which is what ruled out
DIAG-58 and made the client the remaining variable. **So the earlier hypothesis that
DIAG-58 might be absent in CE 1.1.2 was WRONG** — fullscreen is healthy; we were simply
not claiming enough capability to be offered it.

**With `-model 3278-2-E`, `IND$FILS GET` gets much further and reveals the real
blocker:** the refusal is gone and MECAFF sends us a structured field —

```
f3 00 07 01 ff ff 03 80 00 ff ef
   ^^^^^ L=7  ^^ SFID 01 = Read Partition
              ^^ PID ff   ^^ TYPE 03 = QUERY LIST   ^^ REQTYP 80   ^^ QCODE 00
```

**It is a Query LIST (TYPE=0x03), which stage 2a deliberately does not answer.** We
count it and stay silent, so MECAFF waits for a reply that never comes. Verified: we
send nothing after that record.

**REQTYP `0x80` is ALL.** GA23-0059 p. 6-19 (`pages.txt:8508-8512`) puts REQTYP in
*bits 0-1* of byte 5, so `0x80` is B'10' = ALL: "Requests the 3270 data stream device or
workstation to return all the Query Replies supported… the QCODE list is ignored".

**So the fix is small and well-defined:** answer Query List. x3270 handles all three
versions (`Common/sf.c:240-297`); for `SF_RPQ_ALL` it emits every reply it supports,
which for us is exactly the three units `buildQueryReply` already produces. The other
two versions are QCODE List (return the requested subset, or a Null Query Reply
`QR_NULL` if none are supported) and Equivalent (same set as a plain Query).

**This is the stage 2a deferral coming due**, and it now blocks file transfer. It is a
prerequisite, not a nice-to-have.

## SUPERSEDED — the original probe failure, kept for the reasoning



The gate below did its job: **it fired before any code was written.** Findings,
2026-08-18:

**MECAFF's fullscreen tools will not run in our session, and IND$FILE is only one
casualty.** `IND$FILD GET ...`, `IND$FILS GET ...` and — decisively — **`FSQRY`, MECAFF's
own capability-query tool** all respond with the same thing:

```
Please press ENTER to cancel fullscreen operation
```

`FSQRY` failing identically is what proves this is not an IND$FILE problem and not a
protocol mismatch with our client. **Zero WSF records reach us** in any attempt, so the
host declines before it ever queries the terminal.

What is nonetheless confirmed working on the host side:

- **MECAFF's `IND$FILE` really does implement CUT.** `IND$FILE C` contains `frameSeq`,
  `sentInitialAck`, `sendStatus(code, message)`, `sendData`, `receiveData`, and the
  status codes `CODE_ABORT_FILE` / `CODE_ABORT_XMIT`.
- **It reaches the terminal through DIAG-58**, i.e. CP's own fullscreen 3270 I/O — no
  external MECAFF service is required. `FSIO.C` is the "MECAFF API implementation"
  (Dr. Hans-Walter Latz, 2011-2013) and declares `put3270`, `get3270`, `wsfqry` and
  `pgpl3270`, with `PUT3270_CCW_WSF 0x20` among the CCW opcodes — it can write
  structured fields, which is exactly what CUT needs.
- `FSIO.C` carries explicit DIAG-58 presence checks, `cx58v107()` and `cx58v108()`,
  "in 2 variants for V1.07 resp. V1.08-or-later".

**Version question, settled so nobody re-derives it:** the running system reports
`VM/370 Community Edition Version 1 Release 1.2 07/19/22`, and that is the newest.
The `readme-1_3.txt` in the distribution — whose item 3 is the tempting "Changed 3270
config so 'Escape' is 'escape' as needed for ind$file" — is dated **March 2021** and
belongs to the older *Sixpack* numbering that CE superseded. CE 1.1.2 (July 2022) is
newer than Sixpack 1.3 despite the smaller number. **There is no 1.3 to upgrade to.**

Tried and did not help: `CP TERMINAL ESCAPE OFF`. `CP QUERY TERMINAL` reports
`MODE VM, LINESIZE 080, ESCAPE "`.

**Leading hypotheses, untested:**

1. DIAG-58 is absent or at a level `cx58v107`/`cx58v108` rejects in this CE build — CE
   may have taken the MECAFF *tools* without the CP-side support Sixpack 1.3 added.
2. The terminal type. We advertise `IBM-3278-2`; MECAFF must know the geometry to paint
   fullscreen, so a plain model 2 may be declined. Stage 2a gave us `-model 3278-2-E`
   and `--terminal-type IBM-DYNAMIC` to test this cheaply. **Caveat:** we answer Query
   Reply with 24×80 as *both* sizes, so advertising `IBM-DYNAMIC` may not suffice on its
   own — which would make alternate geometry a real prerequisite.
3. A CP terminal-definition (`DMKRIO`) attribute marking the device fullscreen-capable.

**The user is testing whether `EE`, the MECAFF editor, works** — they have used it on a
VM/CE system before. If EE paints, DIAG-58 is fine and the cause is narrower than
"no fullscreen support"; if EE also fails, it is systemic.

**Consequence for sequencing:** the codec and frame layer are host-independent and
proceed regardless. The live acceptance test is blocked on VM/CMS until the above is
resolved, and MVS/TSO may well be the first host to answer — the user is installing
IND$FILE there from CBT, and that is likely IBM's genuine implementation with no MECAFF
layer in the way.

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
