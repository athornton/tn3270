# The transfer form's `Exist` offers what each direction does — design

Date: 2026-11-13. Status: approved in conversation.

## Problem (found 2026-11-13, from the user's report)

- **Browser receive:** `Exist` (Keep/Replace/Append) has no effect. The gateway's file adapter
  answers "doesn't exist" to the Keep check and treats Append as a write
  (`packages/web/src/transferGateway.ts` ~:408-425). The browser decides about name clashes
  itself: Firefox prompts, and Chrome appends ` (1)`. It's a dead control.
- **Send, in every form (GUI, TUI and browser):** only `append` reaches the host, as IND$FILE's
  `APPEND` (`frontend/src/transfer.ts:237`). `keep` and `replace` behave identically, and IND$FILE
  then REPLACES the host file. The form's default for a send is `keep`, which reads as "don't
  overwrite", but it overwrites.

## Decisions (the user, 2026-11-13: option B)

1. **The shared form model offers `Exist` values by direction:**
   - **send:** `replace`, `append` (default `replace`);
   - **receive:** `keep`, `replace`, `append` (default `keep`, unchanged).

   It lives in `transferForm.ts`'s `valuesFor`, beside the existing VM `Recfm` rule, so all three
   forms get it.
2. **On a direction change, `exist` resets to the new direction's default:** send → `replace`,
   receive → `keep`. Nothing is carried across, not even `append`.

   *Amended 2026-11-13, during implementation.* The first rule ("a value the new direction
   doesn't offer becomes that direction's default; a value both directions offer is kept") made
   a fresh receive overwrite local files: the form opens on a send, which now defaults to
   `replace`, so a switch to receive kept `replace`, and a GUI or TUI receive that used to refuse
   to overwrite an existing local file under `keep` silently overwrote it.
3. **The browser hides `Exist` on a receive,** under the same browser-only option that hides
   Local file (`deriveLocalFileOnReceive` in `canvas/src/transferUi.ts`; the plan decides whether
   to rename it). The submitted value is whatever the model holds (`keep` by default); the gateway
   ignores it.
4. **Unchanged:**
   - the CLI/script keyword parser: `Exist=keep` on a send is still accepted, as x3270 does;
   - what reaches the host;
   - GUI and TUI receives, where `keep` really does refuse to overwrite a local file
     (`transferRun.ts:124`).

## Testing

- **The form model:**
  - the offered values per direction;
  - a new send defaults to `replace`;
  - every direction change resets `exist` to the new direction's default (`replace`/`keep`),
    `append` included (amended 2026-11-13, see Decision 2);
  - `formKeywords` for a send never carries `Exist=keep`.
- **The browser view:** no `exist` on a receive; present on a send.
- **The GUI and TUI views:** `exist` present on a receive, with all three values.
- **Harnesses:**
  - `packages/web/scripts/browser-clicks.mjs` adds a check that `Exist` is absent on a receive and
    offers exactly Replace/Append on a send;
  - `packages/gui/scripts/transfer.mjs` and the TUI pty harness must still pass (read them for any
    `Exist` assumptions).
- **Mutation:** the send rule removed, or the direction normalisation removed; each fails a test.

## Docs

The README's transfer text: what `Exist` means per direction. A changelog fragment under *Bug
fixes*: "On a send, the form's default `Exist=keep` did not keep anything: IND$FILE replaced the
host file. A send now offers Replace or Append; the browser no longer shows `Exist` on a receive,
where the browser's own download handling decides."
