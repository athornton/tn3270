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
      // `args.host!` is safe: `submitConnect` only returns args whose parse found a host.
      const host = args.host!;
      const port = args.port ?? 23;
      // This attempt's own choice, read once -- used below both to describe a failure (so the
      // wording is right even if the write below never happens) and, if we get that far, to write
      // `tls.current`.
      const chosenTls = args.tls ?? DEFAULT_TLS;
      try {
        const now = session.geometrySetting;
        if (now !== undefined && args.model !== undefined) session.setGeometry({ ...now, model: args.model });
        // DELIBERATE DEPARTURE FROM THE PLAN'S CODE: write `tls.current` HERE, immediately before
        // `connect()`, and only after `setGeometry` -- the one thing above that can throw. THE
        // RULE: an owner of a TLS-choice function must write a new choice only immediately before
        // a `connect()` to the target that choice belongs to, after anything that can throw first,
        // or a new choice ends up paired with the OLD target. See `reconnect()`'s comment ("THE
        // TLS TRAP") in `@tn3270/core`'s `session.ts` (~L905-930) for why: `connect()` records its
        // target before dialling, so a later `reconnect()` would otherwise replay the OLD target
        // with THIS attempt's new TLS choice.
        tls.current = chosenTls;
        await session.connect(host, port, args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: describe(err, { host, port, tls: chosenTls.kind !== 'plaintext' }), modelLocked };
      } finally {
        inFlight = false;
      }
    },
  };
}
