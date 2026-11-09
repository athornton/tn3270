# Connect dialog: stay open until connected, retry on failure — design

2026-11-08. Approved in conversation (approach 1 of 3). Fixes a defect the user hit on the first
npm release (0.1.0): with TLS left ticked against a Hercules host, the GUI said
`Untick TLS in the Connect dialog: ...` after the dialog had already closed, with no way back to it
short of quitting.

## The defect, as the code stands

- `openConnectDialog` (`packages/gui/src/main.ts`) closes the dialog as soon as a submit parses,
  then calls `startSession`, which wires the session and connects as its LAST step.
- A rejected first connect goes to `fail()`, which writes the terminal window's status line. The
  dialog is gone, and by design "does NOT reopen (File > Connect... is milestone B)".
- `describeTlsError(..., 'dialog')` (`packages/frontend/src/tls.ts`) words the plaintext-host cases
  as `Untick TLS in the Connect dialog: ...`, naming a control the user can no longer reach.
- Reconnect (Enter or Clear when disconnected) replays the TLS decision sealed into the session's
  socket factory at construction (`defaultSession` closes over one `TlsOptions`), so retrying
  against the plaintext host hangs again. That sealing is deliberate (`Session.reconnect`, "THE
  TLS TRAP") and must survive this change.

## The behaviour

A launch with no host opens the Connect dialog, as now. Pressing Connect:

1. The dialog stays open. Connect is disabled, Quit stays live, and the error line shows
   `Connecting to HOST:PORT...`.
2. Success: the dialog closes. From here on everything is as today: drops go through the
   existing reconnect path.
3. Failure: the dialog stays open, showing the failure message on its error line (the same text
   `explain()` produces today with `remedy: 'dialog'`, so the plaintext-host case reads
   `Untick TLS in the Connect dialog: ...` beside the checkbox it names). Host, model and TLS keep
   what the user typed. Connect is enabled again.
4. The user changes anything and presses Connect: the SAME session tries again, with the new host,
   port, LUs, model and TLS choice.

Quit, Escape and closing the dialog quit the app at any point before a connect has succeeded,
including during an attempt — the in-flight connect dies with the process. That is today's rule
("nothing to show without a host"), now covering the retry loop as well.

The terminal window's status line is NOT written with a dialog attempt's failure: the dialog is
where it is shown. stderr still gets it, as for every failure.

## Scope — what does not change

- **A command-line launch with a host** keeps today's behaviour: the failure goes to the status
  line, with the `-insecure`-style remedy. Its user is at a shell.
- **After the first successful connect the dialog is never used again.** Switching host mid-session
  is File → Connect… (roadmap item 15), which this design prepares for but does not build.
- **`--terminal-type` given on the command line** fixes the terminal type for the session's life
  (the session is built without the geometry option, so `setGeometry` throws). The dialog's Model
  control is then DISABLED after the first attempt, with its title saying why, rather than offering
  a choice the retry would ignore. The first attempt still uses it, as today.

## Design

One session, built and wired once, as today. What changes is who connects it and when.

### 1. A TLS choice the session reads at connect time (`frontend`)

`defaultSession`'s `tls` parameter accepts either a `TlsOptions` (every existing caller, unchanged)
or a function returning one. The socket factory calls the function at each connect:

    connect: (h, p) => tcpConnect(h, p, typeof tls === 'function' ? tls() : tls)

The GUI's `buildSession` holds the choice in a small object, `{ current: TlsOptions }`, passes
`() => choice.current`, and returns the holder with the session. Only the dialog path writes it.

**The TLS trap still holds, restated precisely:** reconnect replays the LAST EXPLICIT choice. No
keypress, menu or host frame can change TLS; only a press of Connect in the dialog, with the
checkbox in view, can. `Session.reconnect`'s comment and the README's TLS section say so.

### 2. `startSession` no longer connects in dialog mode (`gui/main.ts`)

`startSession(win, fail, args, remedy)` gains a dialog mode in which it does everything it does
today EXCEPT the final `session.connect(...)` and the post-connect seams, and instead returns a
connector:

    interface DialogConnector {
      /** One attempt with these args. Resolves; never rejects. */
      attempt(args: GuiArgs): Promise<{ ok: true } | { ok: false; error: string; modelLocked: boolean }>;
    }

`startSession` still runs at most once per process, so every once-only registration (the
`ipcMain.handle` channels, `before-quit`) is untouched. The command-line path calls it exactly as
now and connects as now.

`attempt(args)`:

1. Refuses while an attempt is in flight (`already connecting`) — the page also disables Connect,
   but the once-only rule lives in main.
2. Sets the TLS choice to `args.tls ?? DEFAULT_TLS`.
3. Applies the model: in geometry mode `session.setGeometry({ model, oversize })` with the
   command line's oversize; in terminal-type mode, nothing (and `modelLocked: true` in the result).
4. `await session.connect(host, port ?? 23, { lus })`.
5. On success: runs the post-connect seams `startSession` runs today (`maybeSendKeys` … 
   `quitIfKeysOnly`), once, and resolves `{ ok: true }`.
6. On failure: resolves `{ ok: false, error: explain(err, target), ... }` with `target.tls` read
   from the choice just used and `remedy: 'dialog'`. Nothing is sent to the window.

The session's listeners are all registered before the first attempt, exactly as today, so the
`geometry` event, the first `screen` frames and the Model menu refresh are seen by the same code
in the same order. The replay seam is unaffected: it never opens the dialog.

### 3. The dialog's submit (`gui/main.ts` `openConnectDialog`, `connectBoot.ts`)

`connect:submit` parses with `submitConnect` exactly as now (a parse error is still answered in the
dialog). Then:

- first press: `connector = await startSession(..., 'dialog')` — once;
- every press: `await connector.attempt(r.args)`, and answer the page with its result;
- on `ok`: set `connected = true`, then close the dialog after the reply (the existing
  `setImmediate` reasoning). `closed` quits only while `!connected`.

The page (`connectBoot.ts`) shows `Connecting to HOST:PORT...` while the submit is in flight, shows
the error on failure (it already does), and disables `#model` when the result says `modelLocked`.
The submit's `invoke` now resolves after the connect attempt — up to the 10-second TLS handshake
deadline (`HANDSHAKE_TIMEOUT_MS`), not immediately.

### Error handling

- Every attempt resolves; a rejected connect becomes `{ ok: false, error }`. An exception from our
  own code (not a connect error) is still rethrown and surfaces as a rejected `invoke`, as today.
- A window closed during an attempt: the attempt's result has no page to go to; `attempt` must not
  throw on a destroyed window. The process is already quitting.
- `setGeometry` refuses during a connect; the in-flight refusal in step 1 makes that unreachable.

## Testing

- **`frontend`**: `defaultSession` with a function calls it at EACH connect (two connects, two
  choices, two different first bytes at a throwaway server: `IAC WILL TTYPE` for plaintext, a TLS
  ClientHello for TLS); a plain `TlsOptions` behaves exactly as before.
- **`core`**: a `connect()` that rejects leaves the session connectable — a second `connect()` on
  the same session succeeds, and `reconnect()` afterwards dials the second host.
- **`gui` unit**: `attempt` with a fake session — in-flight refusal; TLS choice set before connect;
  `setGeometry` called in geometry mode and not in terminal-type mode; failure text is `explain()`'s
  dialog wording; nothing sent to the window on failure.
- **`gui` harness (`scripts/connect.mjs`)**: the seam takes a LIST of forms, one per attempt. New
  case: a Hercules-like server that opens with `IAC DO TERMINAL-TYPE`; attempt 1 with TLS ticked
  must leave the dialog OPEN with its error line starting `Untick TLS in the Connect dialog`;
  attempt 2 with TLS unticked must get `IAC WILL TERMINAL-TYPE` back at the server and close the
  dialog. Mutation: with the retry ignoring the new TLS choice, attempt 2 must fail on exactly that
  check.
- **The existing harness cases** `TLS remedy names the checkbox` and `refused connect is not called
  TLS` check stderr only, which this design still writes, so they would pass unchanged and prove
  nothing about the new behaviour. Each gains two checks: the dialog is STILL OPEN after the
  failure, and its error line (as `driveConnectDialog` reports it) carries the same text. With the
  dialog made to close on failure as today, both must fail.
- **Live, by the user**: the Hercules host with TLS ticked, then unticked, in one run; pubvm.org
  port 623 with TLS ticked.

## Documentation

README *Installing* / Connect dialog paragraph and *Connecting over TLS* (the trap, restated);
`packages/gui/README.md`; the "does NOT reopen" comment in `main.ts`; HANDOFF. Release as 0.1.1,
with the Node 20.19 floor.
