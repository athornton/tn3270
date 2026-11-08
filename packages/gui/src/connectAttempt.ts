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
 *
 * A host that accepts the TCP connection and then just hangs up still reports `{ ok: true }` here:
 * a plaintext `connect()` resolves on the TCP connect, before any 3270 negotiation, and a drop
 * right after is the terminal window's ordinary reconnect path (spec, behaviour rule 2) -- not
 * this module's problem, deliberately.
 *
 * Nothing else can start a connect while `attempt` is running: the Connect dialog is modal over
 * the terminal window (`main.ts`), so the dialog's own Connect button is the only thing that could
 * call `attempt` again, and it is disabled while one is in flight. That is what makes the
 * `inFlight` flag below sufficient -- it is not guarding against real concurrency, only against
 * a second press racing the first's answer back from the page.
 */
export interface AttemptSession {
  readonly geometrySetting: GeometrySetting | undefined;
  setGeometry(next: GeometrySetting): void;
  connect(host: string, port: number, per?: { tn3270e?: boolean; lus?: readonly string[] }): Promise<void>;
}

export type AttemptResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly modelLocked: boolean };

export interface DialogConnector {
  /**
   * One attempt with these args. RESOLVES with the answer for the dialog, connect failure or not;
   * it REJECTS only for our own bug -- args without a host, which `parseGuiArgs` never returns.
   */
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
      // `parseGuiArgs` guarantees a host: it throws `MissingHostError` otherwise (args.ts, the
      // host check just before the host spec is resolved). This is that contract's enforcement
      // point -- if it is ever broken, fail loudly rather than quietly dialling localhost:23.
      // OUTSIDE the `try`, and before `inFlight` is set: a broken contract is OUR bug, not an
      // answer for the dialog's error line, so it THROWS -- main's handler turns that into a
      // rejected `invoke` (spec, "Error handling") -- and it leaves no flag behind to refuse the
      // next attempt as `already connecting`.
      if (args.host === undefined) throw new Error('attempt: args without a host');
      const host = args.host;
      inFlight = true;
      const port = args.port ?? 23;
      // This attempt's own choice, read once -- used below both to describe a failure (so the
      // wording is right even if the write below never happens) and, if we get that far, to
      // write `tls.current`.
      const chosenTls = args.tls ?? DEFAULT_TLS;
      try {
        const now = session.geometrySetting;
        if (now !== undefined && args.model !== undefined) session.setGeometry({ ...now, model: args.model });
        // THE RULE (core `session.ts`'s `reconnect()`, "THE TLS TRAP"): write a new TLS choice
        // only immediately before a `connect()` to the target that choice belongs to, after
        // anything that can throw first, or a new choice ends up paired with the OLD target --
        // `connect()` records its target before dialling, and `reconnect()` later replays that
        // target through whichever choice is in force. `setGeometry` is the one thing above that
        // can throw, so the write happens here, after it.
        tls.current = chosenTls;
        // `tn3270e` is a CONNECTION override (core `ConnectOptions`), not a session-wide one: the
        // session is built ONCE, from the first press's args, so its constructor-level
        // `tn3270e` is that first press's choice. Without passing it here too, every later
        // attempt -- and every `reconnect()` after -- would fall through to that stale
        // constructor value instead of THIS attempt's own (`args.tn3270e` from `-tn3270e` or an
        // `N:` host prefix; `?? true` is the product default, matching `defaultSession`'s "absent
        // means ON" and `cli/src/runner.ts`'s `Connect()` handler, which overrides the
        // process-wide flag with the host spec's `tn3270e` the same way).
        await session.connect(host, port, {
          tn3270e: args.tn3270e ?? true,
          ...(args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {}),
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: describe(err, { host, port, tls: chosenTls.kind !== 'plaintext' }),
          modelLocked,
        };
      } finally {
        inFlight = false;
      }
    },
  };
}
