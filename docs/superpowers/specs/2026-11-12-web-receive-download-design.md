# Web gateway receive: Start downloads the file — design

Date: 2026-11-12. Status: approved in conversation, awaiting written-spec review.

## Problem (the user, 2026-11-12)

In the browser, a receive asks for a local file name, but Browse is greyed out. The operator
types a name, presses Start, then presses Save. Save then stays enabled and hands back the
previous file unless Start is pressed again. That last part is a real bug:
`packages/web/src/transferBoot.ts:492` sets `saveButton.disabled = bridge.hasUnsaved()` after a
save, which is inverted compared with line 607 (`!unsaved`).

## Decisions (the user, 2026-11-12)

- **Receive in the browser: Start fetches the file, and when it completes the browser downloads
  it.** There is no Local file field, no Browse and no Save button for a receive.
- **Every browser uses the plain `<a download>` route**, including Chromium.
  `showSaveFilePicker` needs transient user activation, which has expired by the time a
  transfer completes, and Firefox and Safari have no picker at all. So the browser's own
  download behaviour applies everywhere: the Downloads folder, or a prompt if the user has
  configured one.
- **The download is named from the host file** by one shared rule (below).
- The GUI keeps its flow, because it writes a real path, but its receive save dialog suggests the
  same default name.
- **The send direction is unchanged.**

## The name rule: `defaultLocalName(hostFile, hostType)`

A pure function in `packages/frontend`, exported for the GUI and the web.

| Host | Input | Output | Rule |
|---|---|---|---|
| vm | `NAP H A2` | `nap.h` | split on blanks, take filename and filetype, drop the filemode, lowercase, join with `.` |
| vm | `PROFILE EXEC` | `profile.exec` | |
| vm | `NAP` | `nap` | a lone filename stays as is |
| tso | `'SYS1.PROCLIB(ASMHC)'` | `sys1.proclib(asmhc)` | strip ONE pair of enclosing `'`, lowercase, keep everything else literally |
| tso | `'HERC01.NAP.H'` | `herc01.nap.h` | |
| tso | `NAP.H` | `nap.h` | unquoted is used as typed (TSO would prefix the userid; the default does not) |
| tso | `'HERC01.LOG(0)'` | `herc01.log(0)` | relative GDG numbers kept literally: one predictable rule |
| either | empty, blank, or nothing usable left | `download.bin` | today's fallback name |

Trimming: leading and trailing blanks are ignored, and runs of blanks are one separator. Quotes
that aren't balanced (`'NAP.H`) are kept as typed, lowercased. The function does no OS
sanitizing: browsers sanitize download names themselves (forbidden characters, Windows
reserved names), and the GUI's native dialog lets the user edit the name.

## Design

### 1. Browser receive flow (`packages/web`, `packages/canvas` form view)

- **The form:** for `direction=receive`, the `localFile` field is not in the view, and the
  Browse and Save buttons are not shown. A send shows `localFile` and Browse as today. Whatever
  decides field applicability must be the one source both renderers read: check `applicable()`
  in `transferForm.ts` against the GUI, which keeps its field for receive. The browser-only rule
  must not hide the GUI's field. Implement it in the web renderer, or with a front-end flag the
  form model honours. The plan decides after reading the code, and records why.
- **Submit:** the keywords still carry a `LocalFile=` (the gateway's `transferCommand` and the
  shared validator need one), with the value `defaultLocalName(hostFile, host)`. The gateway
  never writes a file (`transferGateway.ts` does not import `node-files`), so the value only
  names things.
- **Completion:** on a successful receive, the bridge immediately calls the download sink
  (`saveFallback`) once, with the derived name and the received bytes, then clears its staging.
  `savePicker` is never called for a receive. The status line reads
  `received <n> bytes; downloaded as <name>`.
- **Failure or cancel:** nothing is downloaded, and the existing error or cancel status shows.
- **The close guard:** `hasUnsaved()` is never true after a receive, so the discard
  confirmation never fires for receives. The guard against closing while a transfer runs is
  unchanged.
- **The Save button and its enable logic are removed**, along with the inverted line 492. Any
  code left only for the receive Save path goes too, unless a test or another caller still
  needs it.

### 2. GUI (`packages/gui`)

- The receive `showSaveDialog` (`main.ts` ~1168) gets `defaultPath:
  defaultLocalName(hostFile, host)` when the form's host file is non-empty, and no
  `defaultPath` otherwise. Nothing else in the GUI changes.

### 3. Docs

- `packages/web/README.md`, *File transfer*, and README *Using the web gateway*: a receive
  downloads the file when it completes, named from the host file. There is no Save step.
- Changelog fragment, under *New features* or *Bug fixes*: the inverted Save logic was a bug.

## Testing

- **`defaultLocalName`**, table-driven: every row in the table above, plus lowercase input,
  extra blanks, quotes that aren't balanced, and a blank-only input.
- **The web bridge**, through the injected sinks:
  - a successful receive calls `saveFallback` exactly once, with the derived name and identical
    bytes;
  - a failed receive and a cancelled receive call it zero times;
  - `hasUnsaved()` is false after a receive;
  - `savePicker` is not called even when provided.
- **The form view:** receive has no `localFile`; send has it. The GUI's view still has
  `localFile` for a receive.
- **The GUI:** the receive dialog is passed the derived `defaultPath`, and none when the host
  file is empty. `packages/gui/scripts/transfer.mjs` still passes.
- **The real-browser harness** `packages/web/scripts/browser-clicks.mjs` (run by hand): its
  transfer steps are updated. There is no Save button, and a receive produces exactly one
  download whose suggested name and bytes are checked, using headless Chromium's download
  handling, not merely "a download happened".
- **Mutation:** the download not called on success; called on failure; the name not derived.
  Each must fail a test.
- **Owed live, by the user:** a receive from VM/CMS in Firefox and in Chrome lands as `nap.h`,
  or similar, with no further clicks.

## Out of scope

CSS styling, themes, fonts and persistent preferences (Staging item 15). The send direction's
flow. A reverse rule (local name to host name).
