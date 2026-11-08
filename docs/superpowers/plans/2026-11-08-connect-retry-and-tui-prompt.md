# Connect retry (GUI) and connect prompt (TUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The GUI's Connect dialog stays open until a connection succeeds and retries on failure with the user's new choices; the TUI, run with no host at a terminal, prompts for one with the same retry behaviour. Ships as 0.1.1.

**Architecture:** Specs: `docs/superpowers/specs/2026-11-08-connect-dialog-retry-design.md` and `docs/superpowers/specs/2026-11-08-tui-connect-prompt-design.md` — read both first. The shared pieces live in `@tn3270/frontend`: a TLS choice `defaultSession` reads at each connect, the form-to-argv step (moved from the GUI), and a third TLS-error wording. The GUI keeps ONE session and retries it through a small pure `connectAttempt.ts` module that main wires to the dialog. The TUI needs none of that: it has wired nothing before its first connect, so each failed round discards its session and the next builds a new one.

**Tech Stack:** TypeScript (`tsc --build`), vitest, Node ≥20.19, Electron 44 (GUI), `node:readline/promises` (TUI), Python 3 pty harness (TUI end to end).

## THE SOURCE BEATS THIS PLAN

Every code block below was written against the repo at `d925138`, but plan code is a draft (memory: *plan-code-is-a-draft-not-a-source*). Before each task, open the files it names and check the code you are about to replace is still what the task quotes. Where the repo and this plan disagree, the repo wins; record the disagreement in the commit message.

Gate for every task: `npm run build && npm run typecheck && npx vitest run` from the repo root. `vitest` does not typecheck (memory: *vitest-does-not-typecheck*), so the typecheck is not optional.

## File map

| File | Change |
|---|---|
| `packages/frontend/src/session.ts` | `tls` may be a function, read at each connect |
| `packages/frontend/src/connectForm.ts` | NEW: moved from `packages/gui/src/connectForm.ts` |
| `packages/frontend/src/tls.ts` | `TlsRemedy` gains `'prompt'` |
| `packages/frontend/src/index.ts` | exports `dialogToArgv`, `ConnectForm` |
| `packages/frontend/test/session.test.ts`, `tls.test.ts` | tests |
| `packages/core/test/session.test.ts` | connect-after-a-failed-connect test |
| `packages/core/src/session.ts` | `reconnect()` comment: "the last explicit choice" |
| `packages/gui/src/connectForm.ts` | DELETED (moved) |
| `packages/gui/src/connectDialog.ts` | imports from frontend; `parseConnectSeam` takes one form or a list |
| `packages/gui/src/connectAttempt.ts` | NEW: `makeConnector`, the retry logic, pure |
| `packages/gui/src/args.ts` | `buildSession` takes an optional TLS getter |
| `packages/gui/src/main.ts` | dialog mode in `startSession`; the submit flow; the seam driver |
| `packages/gui/src/connectBoot.ts` | "Connecting to…" text; disable model when locked |
| `packages/gui/src/connectPreload.cts` | the submit result type |
| `packages/gui/scripts/connect.mjs` | new retry case; two existing cases strengthened |
| `packages/gui/test/connectAttempt.test.ts` | NEW |
| `packages/tui/src/connectPrompt.ts` | NEW: the prompt loop |
| `packages/tui/src/main.ts` | `run()` prompts when interactive and no host |
| `packages/tui/test/connectPrompt.test.ts` | NEW |
| `packages/tui/scripts/pty-smoke.py` | `--prompt` mode |
| README, `packages/gui/README.md`, `packages/tui/README.md`, `docs/HANDOFF.md` | docs |

---

### Task 1: `defaultSession` reads a TLS choice at each connect

**Files:**
- Modify: `packages/frontend/src/session.ts` (signature and the `connect:` line, currently `connect: (h, p) => tcpConnect(h, p, tls),`)
- Test: `packages/frontend/test/session.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/frontend/test/session.test.ts` (add `import { createServer, type AddressInfo } from 'node:net';` and `import type { TlsOptions } from '../src/tls.js';` at the top):

```ts
/**
 * A throwaway server that opens with IAC DO TERMINAL-TYPE and records the FIRST bytes each client
 * sends, then hangs up. A plaintext client answers IAC WILL TERMINAL-TYPE (ff fb 18); a TLS client
 * sends a ClientHello, whose first byte is the handshake record type 0x16. So the first byte says
 * which the session dialled, which a TCP connection alone cannot.
 */
async function firstByteServer(): Promise<{ port: number; firsts: number[]; close(): Promise<void> }> {
  const firsts: number[] = [];
  const srv = createServer((sock) => {
    sock.write(Buffer.from([0xff, 0xfd, 0x18]));
    sock.once('data', (b: Buffer) => { firsts.push(b[0]!); sock.destroy(); });
    sock.on('error', () => { /* the client may reset first */ });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port,
    firsts,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('defaultSession TLS choice', () => {
  it('a function is read at EACH connect, so a changed choice is the next dial', async () => {
    const srv = await firstByteServer();
    try {
      let choice: TlsOptions = { kind: 'plaintext' };
      const session = defaultSession(undefined, () => choice);
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 1);
      choice = { kind: 'tls', verify: false };
      await session.connect('127.0.0.1', srv.port).catch(() => { /* hung up mid-handshake */ });
      await until(() => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0x16]);
    } finally { await srv.close(); }
  });

  it('a plain TlsOptions is fixed for the session, as before', async () => {
    const srv = await firstByteServer();
    try {
      const session = defaultSession(undefined, { kind: 'plaintext' });
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 1);
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0xff]);
    } finally { await srv.close(); }
  });
});
```

Also replace this file's header sentence "a real TCP connect has no place in this package's tests" with one saying the TLS-choice tests below use a loopback server because the first byte on the wire is the only witness of which scheme was dialled.

- [ ] **Step 2: Run it and see it fail.** `npm run build && npx vitest run packages/frontend/test/session.test.ts` — expected: the typecheck-free run fails the first test (`tcpConnect` receives a function as `options`, `options.kind` is undefined, so it takes the TLS path both times: `[0x16, 0x16]`), and `npm run typecheck` fails on the function argument.

- [ ] **Step 3: Implement.** In `packages/frontend/src/session.ts`: change the parameter to `tls: TlsOptions | (() => TlsOptions) = DEFAULT_TLS,`, extend its doc comment:

```ts
 * `tls` may also be a FUNCTION, called at every connect -- the GUI's Connect dialog passes one so
 * a retry can change TLS (spec 2026-11-08-connect-dialog-retry-design.md). `reconnect()` dials
 * through this same function, so it replays the LAST EXPLICIT choice: no keypress or host frame
 * can change it, only whoever owns the function.
```

and the connect line to:

```ts
    connect: (h, p) => tcpConnect(h, p, typeof tls === 'function' ? tls() : tls),
```

- [ ] **Step 4: Run the gate.** Both tests pass; typecheck clean.

- [ ] **Step 5: Mutation check.** Temporarily change the connect line to read the function once at construction (`const fixed = typeof tls === 'function' ? tls() : tls;` above `return new Session`, and `tcpConnect(h, p, fixed)`); the first test must fail with `[0xff, 0xff]`. Revert.

- [ ] **Step 6: Commit.** `git commit -m "frontend: defaultSession reads a TLS choice at each connect"` (with the attribution lines).

### Task 2: core — a failed connect leaves the session connectable

**Files:**
- Test: `packages/core/test/session.test.ts` (inside `describe('reconnect() replays the remembered target', ...)`, which has `dialRecorder`)
- Modify: `packages/core/src/session.ts` (`reconnect()`'s "WHY IT REUSES `this.opts.connect`" comment)

- [ ] **Step 1: Write the test.** Add to that `describe`:

```ts
  it('a REJECTED connect leaves the session connectable, and reconnect dials the later target', async () => {
    // The GUI's Connect dialog retries on the same session (spec 2026-11-08-connect-dialog-retry):
    // a first connect that fails must not wedge it.
    let fail = true;
    const dialled: string[] = [];
    const conns: FakeConnection[] = [];
    const session = new Session({
      connect: async (host, port) => {
        dialled.push(`${host}:${port}`);
        if (fail) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        const conn = new FakeConnection();
        conns.push(conn);
        return conn;
      },
    });
    await expect(session.connect('wrong.example', 3270)).rejects.toThrow('refused');
    expect(session.isConnecting()).toBe(false);
    fail = false;
    await session.connect('right.example', 3271);
    expect(session.isConnected()).toBe(true);
    conns[0]!.close();
    await session.reconnect();
    expect(dialled).toEqual(['wrong.example:3270', 'right.example:3271', 'right.example:3271']);
  });
```

- [ ] **Step 2: Run it.** `npx vitest run packages/core/test/session.test.ts`. It is EXPECTED TO PASS already (it pins a property the GUI now relies on). If it fails, stop and report: the GUI design assumes it.

- [ ] **Step 3: Update the comment.** In `reconnect()`'s comment, where it says the injected function closes over a `TlsOptions` "chosen once from the command line", add: "— or, in the GUI, a function the Connect dialog's latest press set (`defaultSession` accepts one); either way reconnect replays the last EXPLICIT choice, and nothing reachable from a keypress can change it."

- [ ] **Step 4: Gate, then commit** `core: pin connect-after-a-failed-connect`.

### Task 3: move `connectForm` to frontend

**Files:**
- Create: `packages/frontend/src/connectForm.ts` (the content of `packages/gui/src/connectForm.ts`)
- Delete: `packages/gui/src/connectForm.ts`
- Modify: `packages/frontend/src/index.ts`, `packages/gui/src/connectDialog.ts:3`, `packages/gui/test/connectForm.test.ts:2`

- [ ] **Step 1:** `git mv packages/gui/src/connectForm.ts packages/frontend/src/connectForm.ts`. In its comments replace `parseGuiArgs` with "the front end's own parser (`parseGuiArgs`, the TUI's `parseArgs`)" — the code is unchanged.
- [ ] **Step 2:** In `packages/frontend/src/index.ts`, beside the host-spec exports, add:

```ts
export { dialogToArgv } from './connectForm.js';
export type { ConnectForm } from './connectForm.js';
```

- [ ] **Step 3:** `packages/gui/src/connectDialog.ts`: `import { dialogToArgv, type ConnectForm } from '@tn3270/frontend';`. `packages/gui/test/connectForm.test.ts`: `import { dialogToArgv } from '@tn3270/frontend';`.
- [ ] **Step 4: Stale output.** Delete `packages/gui/dist/connectForm.*` — `tsc --build` never removes output for a moved source, and `pack.mjs` refuses the orphan (memory: *tsc-orphans-outlive-their-sources*): `rm -f packages/gui/dist/connectForm.*`.
- [ ] **Step 5: Gate.** All GUI tests pass unchanged; `node scripts/pack.mjs` reports no orphan (it needs `npm run bundle:gui` first).
- [ ] **Step 6: Commit** `frontend: dialogToArgv moves here, shared by the GUI and the TUI`.

### Task 4: a `'prompt'` wording for TLS failures

**Files:**
- Modify: `packages/frontend/src/tls.ts` (`TlsRemedy`, `describeTlsError`)
- Test: `packages/frontend/test/tls.test.ts`

- [ ] **Step 1: Failing test.** Add to `packages/frontend/test/tls.test.ts` (import `describeTlsError` if the file does not already):

```ts
describe("describeTlsError 'prompt'", () => {
  it('words both plaintext-host cases for the TUI prompt, remedy first', () => {
    for (const code of ['HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG']) {
      const m = describeTlsError(code, 'herc', 3270, 'prompt');
      expect(m.startsWith('Answer n to TLS: herc:3270 ')).toBe(true);
      expect(m).not.toContain('-insecure');
      expect(m).not.toContain('Connect dialog');
    }
  });

  it('leaves the certificate cases naming their flags', () => {
    expect(describeTlsError('CERT_HAS_EXPIRED', 'h', 992, 'prompt'))
      .toBe(describeTlsError('CERT_HAS_EXPIRED', 'h', 992, 'flag'));
  });
});
```

- [ ] **Step 2: Run, see it fail** (typecheck rejects `'prompt'`; the vitest run gets the flag wording).
- [ ] **Step 3: Implement.** `export type TlsRemedy = 'flag' | 'dialog' | 'prompt';` (extend its comment: `'prompt'` is the TUI's no-host prompt, whose fix is answering `n` to its TLS question). In `describeTlsError`, replace `const dialog = remedy === 'dialog';` and the two plaintext cases' `dialog ? … : …` with a lead chosen per remedy:

```ts
  // The remedy-first lead for the two plaintext-host cases; undefined keeps the command-line wording.
  const lead = remedy === 'dialog' ? 'Untick TLS in the Connect dialog'
    : remedy === 'prompt' ? 'Answer n to TLS' : undefined;
  switch (code) {
    case 'HANDSHAKE_TIMEOUT':
      return lead !== undefined
        ? `${lead}: ${host}:${port} accepted the connection but never `
          + 'completed a TLS handshake, so it probably does not speak TLS — a Hercules or other '
          + 'vintage system.'
        : `${host}:${port} accepted the connection but never completed a TLS handshake. `
          + 'If it does not speak TLS — a Hercules or other vintage system — use -insecure.';
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'ERR_SSL_PACKET_LENGTH_TOO_LONG':
      return lead !== undefined
        ? `${lead}: ${host}:${port} answered with something that is not `
          + 'TLS, so it is almost certainly a plaintext host.'
        : `${host}:${port} answered with something that is not TLS. `
          + 'It is almost certainly a plaintext host: use -insecure.';
```

The dialog strings must come out byte-identical to today's; the existing dialog tests prove it.

- [ ] **Step 4: Gate. Commit** `frontend: a third TLS remedy wording, for the TUI prompt`.

### Task 5: `connectAttempt.ts` — the GUI retry logic, pure

**Files:**
- Create: `packages/gui/src/connectAttempt.ts`
- Test: `packages/gui/test/connectAttempt.test.ts`

- [ ] **Step 1: Failing test.** Create `packages/gui/test/connectAttempt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { GeometrySetting } from '@tn3270/core';
import { DEFAULT_TLS, type TlsOptions } from '@tn3270/frontend';
import { makeConnector, type AttemptSession } from '../src/connectAttempt.js';
import { parseGuiArgs } from '../src/args.js';

/** A session double recording what the connector did to it, in order. */
function fakeSession(geometry: GeometrySetting | undefined, outcomes: Array<Error | 'ok'>) {
  const log: string[] = [];
  const tls = { current: DEFAULT_TLS as TlsOptions };
  let pending: (() => void) | undefined;
  const session: AttemptSession & { setting: GeometrySetting | undefined } = {
    setting: geometry,
    get geometrySetting() { return this.setting; },
    setGeometry(next) { log.push(`setGeometry ${next.model}`); this.setting = next; },
    async connect(host, port, per) {
      log.push(`connect ${host}:${port} ${tls.current.kind} lus=${(per?.lus ?? []).join(',')}`);
      const o = outcomes.shift();
      if (o === undefined) await new Promise<void>((r) => { pending = r; });   // never settles unless released
      else if (o !== 'ok') throw o;
    },
  };
  return { session, tls, log, release: () => pending?.() };
}

const describeAs = (err: unknown, t: { host: string; port: number; tls: boolean }) =>
  `${t.tls ? 'TLS' : 'plain'} ${t.host}:${t.port} ${(err as Error).message}`;

const geo: GeometrySetting = { model: '3278-2-E', oversize: { kind: 'none' } };

describe('makeConnector', () => {
  it('sets the TLS choice BEFORE connecting, from the args of this attempt', async () => {
    const f = fakeSession(geo, [new Error('no'), 'ok']);
    const c = makeConnector(f.session, f.tls, describeAs);
    expect(await c.attempt(parseGuiArgs(['-model', '3278-2-E', 'herc:3270']))).toEqual(
      { ok: false, error: 'TLS herc:3270 no', modelLocked: false });
    expect(await c.attempt(parseGuiArgs(['-insecure', '-model', '3278-2-E', 'herc:3270']))).toEqual({ ok: true });
    expect(f.log.filter((l) => l.startsWith('connect'))).toEqual(
      ['connect herc:3270 tls lus=', 'connect herc:3270 plaintext lus=']);
  });

  it('applies the model in geometry mode, keeping the rest of the setting', async () => {
    const f = fakeSession({ model: '3278-2-E', oversize: { kind: 'auto' } }, ['ok']);
    await makeConnector(f.session, f.tls, describeAs)
      .attempt(parseGuiArgs(['-insecure', '-model', '3279-4-E', 'vm']));
    expect(f.log[0]).toBe('setGeometry 3279-4-E');
    expect(f.session.setting).toEqual({ model: '3279-4-E', oversize: { kind: 'auto' } });
  });

  it('leaves the model alone and says so in terminal-type mode', async () => {
    const f = fakeSession(undefined, [new Error('down')]);
    const r = await makeConnector(f.session, f.tls, describeAs)
      .attempt(parseGuiArgs(['-insecure', '-model', '3279-4-E', 'vm']));
    expect(r).toEqual({ ok: false, error: 'plain vm:23 down', modelLocked: true });
    expect(f.log.some((l) => l.startsWith('setGeometry'))).toBe(false);
  });

  it('passes the LU list and the port', async () => {
    const f = fakeSession(geo, ['ok']);
    await makeConnector(f.session, f.tls, describeAs)
      .attempt(parseGuiArgs(['-insecure', '-model', '3278-2-E', 'LU1,LU2@vm:3270']));
    expect(f.log.at(-1)).toBe('connect vm:3270 plaintext lus=LU1,LU2');
  });

  it('refuses a second attempt while one is in flight', async () => {
    const f = fakeSession(geo, []);
    const c = makeConnector(f.session, f.tls, describeAs);
    const first = c.attempt(parseGuiArgs(['-insecure', '-model', '3278-2-E', 'vm']));
    expect(await c.attempt(parseGuiArgs(['-insecure', '-model', '3278-2-E', 'vm'])))
      .toEqual({ ok: false, error: 'already connecting', modelLocked: false });
    f.release();
    expect(await first).toEqual({ ok: true });
  });

  it('turns a setGeometry refusal into an answer, not a throw', async () => {
    const f = fakeSession(geo, ['ok']);
    f.session.setGeometry = () => { throw new Error('auto needs an -E model'); };
    const r = await makeConnector(f.session, f.tls, describeAs)
      .attempt(parseGuiArgs(['-insecure', '-model', '3278-2', 'vm']));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('auto needs an -E model');
  });
});
```

Check `parseGuiArgs`'s real handling of `LU1,LU2@vm:3270` (field names `lus`, `port`) in `packages/gui/src/args.ts` before relying on the LU test, and adjust the expected string to what the parser yields.

- [ ] **Step 2: Run, see it fail** (module missing).

- [ ] **Step 3: Implement** `packages/gui/src/connectAttempt.ts`:

```ts
import type { GeometrySetting } from '@tn3270/core';
import { DEFAULT_TLS, type TlsOptions } from '@tn3270/frontend';
import type { GuiArgs } from './args.js';

/**
 * The Connect dialog's retry loop, pulled out of main.ts (which imports electron, so vitest cannot
 * load it). Spec: docs/superpowers/specs/2026-11-08-connect-dialog-retry-design.md, "Design" 2.
 *
 * ONE SESSION, ALREADY WIRED. Each attempt changes only what the dialog owns -- the TLS choice the
 * session's socket factory reads at connect time, the model (geometry mode only), and the target --
 * and connects. Every attempt RESOLVES: a failure is an answer for the dialog's error line.
 */
export interface AttemptSession {
  readonly geometrySetting: GeometrySetting | undefined;
  setGeometry(next: GeometrySetting): void;
  connect(host: string, port: number, per?: { lus?: readonly string[] }): Promise<void>;
}

export type AttemptResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly modelLocked: boolean };

export interface DialogConnector {
  attempt(args: GuiArgs): Promise<AttemptResult>;
}

/** What a failure is described against: the target and the TLS choice of THIS attempt. */
export interface AttemptTarget { readonly host: string; readonly port: number; readonly tls: boolean }

export function makeConnector(
  session: AttemptSession,
  tls: { current: TlsOptions },
  describe: (err: unknown, target: AttemptTarget) => string,
): DialogConnector {
  // Terminal-type mode has no geometry setting, and setGeometry would throw: the model is fixed.
  const modelLocked = session.geometrySetting === undefined;
  let inFlight = false;
  return {
    async attempt(args) {
      if (inFlight) return { ok: false, error: 'already connecting', modelLocked };
      inFlight = true;
      const host = args.host!;
      const port = args.port ?? 23;
      tls.current = args.tls ?? DEFAULT_TLS;
      try {
        const now = session.geometrySetting;
        if (now !== undefined && args.model !== undefined) session.setGeometry({ ...now, model: args.model });
        await session.connect(host, port, args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: describe(err, { host, port, tls: tls.current.kind !== 'plaintext' }), modelLocked };
      } finally {
        inFlight = false;
      }
    },
  };
}
```

`args.host!` is safe: `submitConnect` only returns args whose parse found a host. Note it in a comment.

- [ ] **Step 4: Gate.** All six pass.
- [ ] **Step 5: Mutation checks** (revert each): (a) move `tls.current = …` after the `await session.connect` — the first test fails; (b) drop the `inFlight` guard — the in-flight test fails.
- [ ] **Step 6: Commit** `gui: connectAttempt, the Connect dialog's retry logic`.

### Task 6: GUI `buildSession` takes a TLS getter

**Files:**
- Modify: `packages/gui/src/args.ts` (`buildSession`, both `defaultSession` calls pass `args.tls`)
- Test: `packages/gui/test/args.test.ts`

- [ ] **Step 1: Failing test.** In `args.test.ts`, near the existing `buildSession` tests, add a test using the same first-byte server as Task 1 (copy `firstByteServer` and `until` into this file; packages do not import each other's tests):

```ts
  it('with a TLS getter, each connect dials the getter s current choice', async () => {
    const srv = await firstByteServer();
    try {
      let choice: TlsOptions = { kind: 'plaintext' };
      const session = buildSession(parseGuiArgs(['vm']), () => undefined, () => choice);
      await session.connect('127.0.0.1', srv.port);
      await until(() => srv.firsts.length === 1);
      choice = { kind: 'tls', verify: false };
      await session.connect('127.0.0.1', srv.port).catch(() => {});
      await until(() => srv.firsts.length === 2);
      expect(srv.firsts).toEqual([0xff, 0x16]);
    } finally { await srv.close(); }
  });
```

- [ ] **Step 2: Run, see it fail.**
- [ ] **Step 3: Implement.** Signature `buildSession(args, measure, tls?: () => TlsOptions)`; in both `defaultSession(...)` calls replace `args.tls` with `tls ?? args.tls`. Doc: "`tls`, when given, replaces `args.tls` and is read at each connect -- the Connect dialog's retry (see `connectAttempt.ts`)."
- [ ] **Step 4: Gate. Commit** `gui: buildSession accepts a TLS getter`.

### Task 7: the seam takes a list of forms

**Files:**
- Modify: `packages/gui/src/connectDialog.ts` (`parseConnectSeam`)
- Test: `packages/gui/test/connectDialog.test.ts` (`describe('parseConnectSeam')`)

- [ ] **Step 1: Failing tests:**

```ts
  it('reads a LIST of forms, one per Connect press', () => {
    expect(parseConnectSeam('[{"host":"a","model":"3278-2-E","tls":true},{"host":"a","model":"3278-2-E","tls":false}]'))
      .toEqual([{ host: 'a', model: '3278-2-E', tls: true }, { host: 'a', model: '3278-2-E', tls: false }]);
  });

  it('a single form is a list of one', () => {
    expect(parseConnectSeam('{"host":"a","model":"3278-2-E","tls":true}'))
      .toEqual([{ host: 'a', model: '3278-2-E', tls: true }]);
  });

  it('refuses an empty list or a malformed member', () => {
    expect(() => parseConnectSeam('[]')).toThrow(/TN3270_GUI_CONNECT/);
    expect(() => parseConnectSeam('[{"host":"a"}]')).toThrow(/TN3270_GUI_CONNECT/);
  });
```

Update the existing `parseConnectSeam` tests that expect a single object to expect a one-element array.

- [ ] **Step 2: Run, fail. Step 3: Implement:** return type `readonly ConnectForm[] | undefined`; accept `isConnectForm(value)` as `[value]`, or a non-empty array whose every member `isConnectForm`; otherwise throw `TN3270_GUI_CONNECT must be JSON {"host": string, "model": string, "tls": boolean} or a non-empty list of them, not …`. Map each to `{ host, model, tls }`.
- [ ] **Step 4: Gate** (main.ts will not typecheck until Task 8 adapts `driveConnectDialog`; do Tasks 7 and 8 in one commit if the gate is red in between). **Commit** with Task 8.

### Task 8: main.ts — dialog mode, the submit flow, the driver

**Files:**
- Modify: `packages/gui/src/main.ts` — `openConnectDialog` (~L509-572), `driveConnectDialog` (~L586-620), `startSession` (signature ~L631, its connect block ~L1742-1752, and its post-connect seam calls ~L1754-1760), the `fail` call in the `connect:submit` handler.

Read all of `openConnectDialog`, `driveConnectDialog` and the end of `startSession` first.

- [ ] **Step 1: `startSession` dialog mode.** Change the signature to

```ts
async function startSession(
  win: BrowserWindow, fail: (message: string) => void, args: GuiArgs, remedy: TlsRemedy,
  mode: 'connect' | 'dialog' = 'connect',
): Promise<{ connector: DialogConnector; afterConnect: () => Promise<void> } | undefined> {
```

Every existing early `return;` stays `return;` (undefined: setup failed, `fail()` already said why). Create the TLS holder before `buildSession` and pass its getter:

```ts
  // The TLS choice the session's socket factory reads at each connect. Only the Connect dialog's
  // retry writes it (connectAttempt.ts); reconnect replays whatever it last held.
  const tlsChoice = { current: args.tls ?? DEFAULT_TLS };
  ...
    session = buildSession(args, measure, () => tlsChoice.current);
```

Replace the tail — from `try { await session.connect(args.host!, …` to the end of the function — with:

```ts
  // THE LIVE PATH's post-connect seams, run once after the first connect: a `wait:` step earns its
  // keep only against a real host, and `live-transfer.py` drives this branch.
  const afterConnect = async (): Promise<void> => {
    await maybeSendKeys(win, session, () => keyboardWin);
    await maybeSendClicks(win, () => keypadWin);  // after the keys, for the reason the replay branch gives
    await maybeSelect(win);                // and after both, for the reason given there too
    await maybeOpenTransferWindow();
    await maybeCapture(win);
    await quitIfKeysOnly();
  };

  if (mode === 'dialog') {
    // The Connect dialog connects, as often as it takes (spec 2026-11-08-connect-dialog-retry).
    const connector = makeConnector(session, tlsChoice, (err, target) => explain(err, { ...target, remedy }));
    return { connector, afterConnect };
  }

  try {
    await session.connect(args.host!, args.port ?? 23,
      args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {});
  } catch (err) {
    // (keep the existing comment)
    fail(explain(err, {
      host: args.host!, port: args.port ?? 23,
      tls: tlsChoice.current.kind !== 'plaintext', remedy,
    }));
  }
  await afterConnect();
  return undefined;
```

Add imports: `makeConnector, type DialogConnector` from `./connectAttempt.js`; `DEFAULT_TLS` from `@tn3270/frontend` if main does not already import it (it uses `DEFAULT_TLS` at the old connect block, so it does — check).

Check the command-line call site `await startSession(win, fail, plan.args, 'flag');` still compiles (its result is ignored).

- [ ] **Step 2: `openConnectDialog`'s submit flow.** Replace the `started` flag and the `connect:submit` handler with:

```ts
  // Set once a connect has SUCCEEDED; until then, closing the dialog quits (nothing to show).
  let connected = false;
  // The session, built and wired on the first press that parses; every press after reuses it.
  let started: { connector: DialogConnector; afterConnect: () => Promise<void> } | undefined;
  let starting = false;
  ...
  cw.on('closed', () => { if (!connected) app.quit(); });

  ipcMain.handle('connect:models', () => connectModels());
  ipcMain.handle('connect:submit', async (_e, form: unknown) => {
    if (connected) return { error: 'already connected' };
    const r = submitConnect(form, commandLine);
    if (!r.ok) return { error: r.error };
    if (started === undefined) {
      if (starting) return { error: 'already connecting' };
      starting = true;
      started = await startSession(win, fail, r.args, 'dialog', 'dialog');
      starting = false;
      if (started === undefined) {
        // A setup failure (no atlas, a session the args cannot build): fail() put it in the
        // window, as for a command-line launch; there is nothing to retry, so the dialog goes.
        connected = true;   // so this close does not quit: the window shows the error
        setImmediate(() => { if (!cw.isDestroyed()) cw.close(); });
        return { ok: true };
      }
    }
    const result = await started.connector.attempt(r.args);
    if (!result.ok) return { error: result.error, modelLocked: result.modelLocked };
    connected = true;
    // AFTER the reply (the existing setImmediate reasoning), then the post-connect seams, once.
    const { afterConnect } = started;
    setImmediate(() => {
      if (!cw.isDestroyed()) cw.close();
      if (!win.isDestroyed()) afterConnect().catch((err: unknown) => { fail(explain(err)); });
    });
    return { ok: true };
  });
```

Rewrite the function's doc comment: the dialog now stays open until a connect succeeds (cite the spec); the "does NOT reopen" sentence goes; QUIT/ESCAPE/CLOSE quit until a connect has SUCCEEDED; `startSession` still runs at most once (the `started`/`starting` guard).

- [ ] **Step 3: `driveConnectDialog` takes the list.** Signature `(cw, forms: readonly ConnectForm[])`; loop over `forms`, doing for each exactly what it does now for the one form (wait for Connect enabled, fill, click, print `connect: submitted`, wait to settle, print `connect: error <text>` if any). Stop the loop if the window is destroyed. Print `connect: dialog closed` when the loop ends with the window destroyed, and `connect: dialog still open` when it ends with it open — the harness asserts on these. The settle wait (`until` Connect enabled) must allow the 10-second TLS handshake deadline: raise its bound from 10 s to 15 s.

- [ ] **Step 4: The preload's result type.** In `packages/gui/src/connectPreload.cts`, the submit result type becomes `Promise<{ ok?: true; error?: string; modelLocked?: boolean }>`; the same in `connectBoot.ts`'s `declare global` block.

- [ ] **Step 5: Gate** (with Task 7). The GUI unit suites pass; `npm run typecheck` clean.
- [ ] **Step 6: Commit** `gui: the Connect dialog stays open until connected, and retries`.

### Task 9: the dialog page

**Files:** Modify `packages/gui/src/connectBoot.ts` (the `submit` listener)

- [ ] **Step 1: Implement.** In the submit listener, replace `error.textContent = '';` with

```ts
  error.textContent = `Connecting to ${host.value.trim()}...`;
```

and in the result handler, after showing `r.error`, add `if (r.modelLocked === true) { model.disabled = true; model.title = 'fixed by --terminal-type on the command line'; }`. The success branch's comment becomes "main closes this window once the connect has succeeded".

- [ ] **Step 2: Gate. Commit** `gui: the Connect dialog says it is connecting`.

### Task 10: the GUI harness

**Files:** Modify `packages/gui/scripts/connect.mjs` (`CASES`)

- [ ] **Step 1: Strengthen the two failure cases.** In `TLS remedy names the checkbox` and `refused connect is not called TLS`, after the stderr wait, wait up to 2 s for `connect: error` on stdout and add checks:

```js
        ['the dialog is STILL OPEN', r.stdout.includes('connect: dialog still open')],
        [`the dialog's error line says "${want}"`,
          r.stdout.split('\n').some((l) => l.startsWith('connect: error') && l.includes(want))],
```

- [ ] **Step 2: New case** after `TLS remedy names the checkbox`:

```js
  {
    name: 'retry with TLS unticked connects, on the same run',
    async run() {
      const srv = await startServer();
      const host = `127.0.0.1:${srv.port}`;
      const r = launch([
        { host, model: '3278-2-E', tls: true },
        { host, model: '3278-2-E', tls: false },
      ]);
      await until(() => r.stdout.includes('connect: dialog closed') || r.exited, HANDSHAKE_BOUND_MS + 15_000);
      await until(() => srv.willTtype(), 5_000);
      const lines = r.stdout.split('\n');
      const checks = [
        ['two presses', lines.filter((l) => l === 'connect: submitted').length === 2],
        ['the first said to untick TLS', lines.some((l) => l.startsWith('connect: error Untick TLS in the Connect dialog'))],
        ['the dialog closed after the second', r.stdout.includes('connect: dialog closed')],
        ['the second was PLAINTEXT telnet (IAC WILL TERMINAL-TYPE came back)', srv.willTtype()],
      ];
      return { r, srv, checks };
    },
  },
```

`startServer()` without `{ silent: true }` opens with `IAC DO TERMINAL-TYPE` — confirm in its definition; the TLS attempt against it must fail (handshake timeout or wrong version), not connect.

- [ ] **Step 3: Run** `node packages/gui/scripts/connect.mjs` (needs `npm run build`; under Xvfb via `xvfb.mjs`). Expected: every case `ok`.
- [ ] **Step 4: Mutation checks**, each reverted: (a) in `makeConnector`, stop writing `tls.current` — the retry case fails exactly on the PLAINTEXT check; (b) in the `connect:submit` handler, close the dialog on failure as before — both strengthened cases fail on STILL OPEN.
- [ ] **Step 5: Bundle parity:** `npm run bundle:gui && TN3270_GUI_MAIN=app node packages/gui/scripts/connect.mjs` — all `ok`.
- [ ] **Step 6: Commit** `gui: connect.mjs drives a retry, and checks the dialog stays open`.

### Task 11: the TUI prompt loop

**Files:**
- Create: `packages/tui/src/connectPrompt.ts`
- Test: `packages/tui/test/connectPrompt.test.ts`

- [ ] **Step 1: Failing tests.** Create `packages/tui/test/connectPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptConnect } from '../src/connectPrompt.js';
import type { TuiArgs } from '../src/main.js';

/**
 * Drives the prompt with scripted answers. Each answer is written only when the prompt that asks
 * for it has appeared, so the test reads like the transcript a user would see.
 */
function harness(answers: string[], outcomes: Array<Error | 'ok'>) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  const tried: TuiArgs[] = [];
  output.on('data', (b: Buffer) => {
    transcript += b.toString();
    if (/(Host|Model|TLS)( \[[^\]]*\])?: $/.test(transcript) && answers.length > 0) {
      input.write(`${answers.shift()!}\n`);
    } else if (/: $/.test(transcript) && answers.length === 0) {
      input.end();                                  // out of answers: EOF, as Ctrl-D
    }
  });
  const attempt = async (args: TuiArgs) => {
    tried.push(args);
    const o = outcomes.shift() ?? 'ok';
    if (o !== 'ok') throw o;
    return { connected: args } as never;
  };
  return { input, output, tried, attempt, transcript: () => transcript };
}

const tlsError = (code: string) => Object.assign(new Error('flag wording'), { code });

describe('promptConnect', () => {
  it('one round to success: host, the default model, the default TLS', async () => {
    const h = harness(['herc:3270', '', ''], ['ok']);
    const s = await promptConnect([], h, h.attempt);
    expect(s).toBeDefined();
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.host).toBe('herc');
    expect(h.tried[0]!.port).toBe(3270);
    expect(h.tried[0]!.model).toBe('3278-2-E');
    expect(h.tried[0]!.tls).toEqual({ kind: 'tls', verify: true });
    expect(h.transcript()).toContain('Connecting to herc:3270...');
  });

  it('a TLS failure says to answer n, and the next round defaults to the last answers', async () => {
    const h = harness(['herc:3270', '', '', '', '', 'n'], [tlsError('HANDSHAKE_TIMEOUT'), 'ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toContain('Answer n to TLS: herc:3270 accepted the connection');
    expect(h.transcript()).toContain('Host [herc:3270]: ');
    expect(h.tried[1]!.host).toBe('herc');
    expect(h.tried[1]!.tls).toEqual({ kind: 'plaintext' });
  });

  it('a plaintext failure is not called TLS', async () => {
    const h = harness(['herc:1', '', 'n', '', '', ''], [tlsError('ECONNREFUSED'), 'ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toContain('cannot connect to herc:1: connection refused (ECONNREFUSED)');
  });

  it('re-asks an empty first host rather than failing', async () => {
    const h = harness(['', 'vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.tried[0]!.host).toBe('vm');
  });

  it('re-asks an unknown model, listing the known ones', async () => {
    const h = harness(['vm', '9999', '3279-2-E', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toMatch(/unknown model "9999".*3278-2-E/s);
    expect(h.tried[0]!.model).toBe('3279-2-E');
  });

  it('re-asks a TLS answer that is not y or n', async () => {
    const h = harness(['vm', '', 'maybe', 'N'], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.tried[0]!.tls).toEqual({ kind: 'plaintext' });
  });

  it('EOF quits: undefined, nothing attempted', async () => {
    const h = harness([], []);
    expect(await promptConnect([], h, h.attempt)).toBeUndefined();
    expect(h.tried).toHaveLength(0);
  });

  it('command-line flags are kept, and seed the defaults', async () => {
    const h = harness(['vm', '', ''], ['ok']);
    await promptConnect(['-insecure', '-model', '3279-4-E', '-scheme', 'green'], h, h.attempt);
    expect(h.transcript()).toContain('Model [3279-4-E]: ');
    expect(h.transcript()).toContain('TLS [y/N]: ');
    expect(h.tried[0]!.model).toBe('3279-4-E');
    expect(h.tried[0]!.tls).toEqual({ kind: 'plaintext' });
    expect(h.tried[0]!.scheme).toBeDefined();
  });

  it('a host the parser refuses is its own words, and the round restarts', async () => {
    const h = harness(['vm:99999', '', '', 'vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.host).toBe('vm');
  });
});
```

Check `TuiArgs`' real field names (`host`, `port`, `model`, `tls`, `scheme`) in `packages/tui/src/main.ts`, and what `parseArgs` says for port 99999, before running.

- [ ] **Step 2: Run, see it fail** (module missing).

- [ ] **Step 3: Implement** `packages/tui/src/connectPrompt.ts`:

```ts
import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { KNOWN_MODELS, TERMINAL_TYPE, type Session } from '@tn3270/core';
import { describeConnectError, describeTlsError, dialogToArgv } from '@tn3270/frontend';
import { parseArgs, UsageError, type TuiArgs } from './main.js';

/**
 * `tn3270` with no host, at a terminal: ask for one, connect, and on failure ask again with the
 * last answers as defaults. Spec docs/superpowers/specs/2026-11-08-tui-connect-prompt-design.md.
 *
 * ONE PARSER: the answers become the argv the user would have typed (`dialogToArgv`, the GUI
 * dialog's own step) and go through `parseArgs`, so the prompt cannot accept a host the command
 * line refuses. A failed round's session is discarded: nothing in the TUI is wired before its
 * first connect, so the next round simply builds a new one.
 *
 * Resolves the connected session, or `undefined` when the user quit (EOF or Ctrl-C).
 */
export async function promptConnect(
  commandLine: readonly string[],
  io: { input: Readable; output: Writable },
  attempt: (args: TuiArgs) => Promise<Session>,
): Promise<Session | undefined> {
  const seed = parseArgs(commandLine);              // flags only: run() found no host in them
  let host = '';
  let model = seed.model ?? TERMINAL_TYPE.replace(/^IBM-/, '');
  let tls = seed.tls?.kind !== 'plaintext';
  const rl = createInterface({ input: io.input, output: io.output });
  let closed = false;
  rl.on('close', () => { closed = true; });
  rl.on('SIGINT', () => { rl.close(); });          // Ctrl-C at a prompt quits, as EOF does
  const say = (text: string): void => { io.output.write(`${text}\n`); };
  /** One question; undefined once the interface has closed. */
  const ask = (q: string): Promise<string | undefined> => closed ? Promise.resolve(undefined)
    : new Promise((resolve) => {
      rl.once('close', () => resolve(undefined));
      rl.question(q).then((a) => resolve(a.trim()), () => resolve(undefined));
    });
  try {
    for (;;) {
      const h = await ask(host === '' ? 'Host: ' : `Host [${host}]: `);
      if (h === undefined) return undefined;
      if (h !== '') host = h;
      if (host === '') continue;
      // Re-asked IN PLACE, like TLS below: restarting the round would read the next answer as a host.
      for (;;) {
        const m = await ask(`Model [${model}]: `);
        if (m === undefined) return undefined;
        if (m === '') break;
        if (Object.prototype.hasOwnProperty.call(KNOWN_MODELS, m)) { model = m; break; }
        say(`unknown model ${JSON.stringify(m)}: one of ${Object.keys(KNOWN_MODELS).join(', ')}`);
      }
      let t: string | undefined;
      for (;;) {
        t = await ask(`TLS [${tls ? 'Y/n' : 'y/N'}]: `);
        if (t === undefined) return undefined;
        if (t === '' || /^(y|yes|n|no)$/i.test(t)) break;
        say('answer y or n');
      }
      if (t !== '') tls = /^y/i.test(t);

      let args: TuiArgs;
      try {
        args = parseArgs(dialogToArgv({ host, model, tls }, commandLine));
      } catch (err) {
        if (err instanceof UsageError) { say(err.message); host = ''; continue; }
        throw err;
      }
      const target = `${args.host}:${args.port ?? 23}`;
      say(`Connecting to ${target}...`);
      try {
        const session = await attempt(args);
        return session;
      } catch (err) {
        say(describeFailure(err, args.host!, args.port ?? 23, tls));
      }
    }
  } finally {
    rl.close();   // before raw mode and the alternate screen take stdin
  }
}

/** The failure in the prompt's words: `describeTlsError`'s `'prompt'` remedy for a TLS attempt. */
function describeFailure(err: unknown, host: string, port: number, tls: boolean): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: string }).code;
  if (code === undefined) return err.message;
  return tls ? describeTlsError(code, host, port, 'prompt') : describeConnectError(code, host, port, err.message);
}
```

Notes for the implementer, each to be checked against the source, not trusted:
- `TERMINAL_TYPE` is `'IBM-3278-2-E'` (`packages/core/src/constants.ts`); the model name is the part after `IBM-`. If `@tn3270/core` does not export `TERMINAL_TYPE`, use `'3278-2-E'` with a comment naming where the default lives.
- An empty host re-asks: after an unparseable host, `host = ''` makes the next round ask `Host: ` with no default — matching the empty-first-host rule. Adjust the "parser refuses" test's answers if the flow differs.
- The importing of `parseArgs` from `./main.js` creates a cycle once Task 12 imports this module from `main.ts`. If it bites (it should not: both are only called at run time), move `parseArgs`, `UsageError` and `TuiArgs` into `packages/tui/src/args.ts` and re-export them from `main.ts` so the existing tests' imports keep working.

- [ ] **Step 4: Gate.** All nine pass.
- [ ] **Step 5: Mutation checks**, each reverted: carry `tls` NOT updated from the answer — the TLS-failure test fails on `plaintext`; describe with `'flag'` — it fails on `Answer n to TLS`.
- [ ] **Step 6: Commit** `tui: promptConnect, the no-host prompt loop`.

### Task 12: TUI `run()` prompts when interactive

**Files:**
- Modify: `packages/tui/src/main.ts` (`run()`, `HostProcess` import/type, `realHost`, the `isMain` block)
- Test: `packages/tui/test/main.test.ts`

- [ ] **Step 1: Failing test** in `main.test.ts`:

```ts
describe('run() with no host', () => {
  it('without a terminal, is the usage error it always was (scripts never meet a prompt)', async () => {
    const host = { on: () => {}, exit: () => {}, stderr: { write: () => true } };
    await expect(run([], host as never)).rejects.toThrow(/usage: tn3270/);
  });
});
```

(It passes before the change too — it pins the script case so Step 3 cannot break it. Confirm `HostProcess`'s shape in `packages/tui/src/app.ts:178` and match it.)

- [ ] **Step 2: Implement.** Add an optional `interactive?: { input: Readable; output: Writable }` to the `run` call path — NOT to `HostProcess` in `app.ts` (the App does not need it): `run(argv, host, interactive?)`. In `run()`:

```ts
  const args = parseArgs(argv);
  let session: Session;
  if (args.host === undefined) {
    if (interactive === undefined) throw new UsageError(/* the existing usage line, unchanged */);
    const s = await promptConnect(argv, interactive, (a) => connectFirst(a, host.stderr));
    if (s === undefined) { host.exit(1); return 1; }
    session = s;
  } else {
    session = await connectFirst(args, host.stderr);
  }
```

and the rest of `run()` uses `session` exactly as now. NOTE: the App later needs `args` for `colors`/`scheme`; after a prompt those come from the command line, which `parseArgs(argv)` already gave — keep using `args` for them.

In the `isMain` block: `run(process.argv.slice(2), realHost, process.stdin.isTTY && process.stdout.isTTY ? { input: process.stdin, output: process.stdout } : undefined)`.

- [ ] **Step 3: Gate. Commit** `tui: prompt for a host when run at a terminal without one`.

### Task 13: TUI end to end in a pty

**Files:** Modify `packages/tui/scripts/pty-smoke.py` (a `--prompt` mode, like `--oversize-auto`)

- [ ] **Step 1: Implement** `def prompt_mode():` modelled on `oversize_auto()`: start a FakeHost (it opens with the TERMINAL-TYPE negotiation — confirm in `FakeHost.run`); spawn `node packages/tui/dist/main.js` with NO arguments in a 24x80 pty; when the output shows `Host: ` send `127.0.0.1:<port>\r`, `Model [3278-2-E]: ` → `\r`, `TLS [Y/n]: ` → `\r`; expect within 15 s `Answer n to TLS: 127.0.0.1:<port>`; then `Host [127.0.0.1:<port>]: ` → `\r`, `Model` → `\r`, `TLS [Y/n]: ` → `n\r`; assert the FakeHost then completes negotiation and the screen draws (reuse the default run's drawn-screen assertion), send Ctrl-] and assert the tty echoes afterwards as the default run does. Wire it to `--prompt` in `main()`'s argument handling. `harness-flags.test.ts` requires `-insecure` in the file — the existing modes keep it, so it still passes; do not add one to the prompt run (the point is the prompt's own TLS answer).
- [ ] **Step 2: Run** `python3 packages/tui/scripts/pty-smoke.py --prompt`; also the default run and `--oversize-auto`, which must be unaffected.
- [ ] **Step 3: Mutation check:** make `promptConnect` ignore the TLS answer — the run must fail at negotiation. Revert.
- [ ] **Step 4: Commit** `tui: pty-smoke --prompt drives a failed round and a retry`.

### Task 14: documentation

**Files:** `README.md` (Installing: the Connect dialog paragraph; the TUI section; *Connecting over TLS*), `packages/gui/README.md`, `packages/tui/README.md`, `docs/HANDOFF.md`

- [ ] **Step 1:** GUI: the dialog stays open until connected and retries with your changes; quitting before a successful connect quits the app. TUI: `tn3270` with no host at a terminal prompts (show the transcript from the spec); scripts keep the usage error. TLS section: reconnect replays the last explicit choice — the command line's, or the Connect dialog's latest press.
- [ ] **Step 2:** HANDOFF: a dated entry naming both specs and this plan, and what is owed live (the user's Hercules host with TLS ticked then not, in the GUI and in the TUI; pubvm.org port 623 with TLS).
- [ ] **Step 3:** Check every heading and summary line that describes the Connect dialog or the TUI's no-host behaviour, not only the body text (memory: *summary-lines-outlive-their-corrections*): `grep -n -i "does not reopen\|usage error\|no host" README.md docs/HANDOFF.md packages/*/README.md`.
- [ ] **Step 4: Commit** `docs: Connect dialog retry and the TUI prompt`.

### Task 15: whole-branch gate

- [ ] `npm ci && npm run build && npm run typecheck && npx vitest run` — all green; the test count rises by the tests added above.
- [ ] `npm run bundle:gui && npm run pack:npm && node scripts/install-smoke.mjs` — 5/5.
- [ ] `node packages/gui/scripts/connect.mjs` and with `TN3270_GUI_MAIN=app` — all `ok`.
- [ ] `python3 packages/tui/scripts/pty-smoke.py`, `--oversize-auto`, `--prompt` — all pass.
- [ ] Push the branch, run CI (`gh workflow run package.yml --ref connect-retry`), all six jobs green. Merging, the 0.1.1 version bump (`npm run version:set -- 0.1.1`) and publishing are the user's calls.
