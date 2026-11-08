import { describe, it, expect } from 'vitest';
import type { GeometrySetting } from '@tn3270/core';
import { DEFAULT_TLS, type TlsOptions } from '@tn3270/frontend';
import { makeConnector, type AttemptSession } from '../src/connectAttempt.js';
import { parseGuiArgs } from '../src/args.js';

/**
 * A session double recording what the connector did to it, in order. Each attempt consumes one
 * outcome: `'ok'` resolves, an `Error` rejects, and `'hang'` is the one DELIBERATE wait -- used
 * only by the in-flight test, which releases it with `release()`. Running OUT of outcomes is a
 * test bug, not a hang to wait out: it throws, so a mutant that calls `connect()` an extra time
 * (e.g. the in-flight guard removed) fails on a clean assertion instead of timing out.
 */
function fakeSession(geometry: GeometrySetting | undefined, outcomes: Array<Error | 'ok' | 'hang'>) {
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
      if (o === undefined) throw new Error('unexpected connect');
      if (o === 'hang') { await new Promise<void>((r) => { pending = r; }); return; }
      if (o !== 'ok') throw o;
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
    const f = fakeSession(geo, ['hang']);
    const c = makeConnector(f.session, f.tls, describeAs);
    const first = c.attempt(parseGuiArgs(['-insecure', '-model', '3278-2-E', 'vm']));
    expect(await c.attempt(parseGuiArgs(['-insecure', '-model', '3278-2-E', 'vm'])))
      .toEqual({ ok: false, error: 'already connecting', modelLocked: false });
    // The refusal never touched the session: only the first attempt's connect() ran.
    expect(f.log.filter((l) => l.startsWith('connect'))).toHaveLength(1);
    f.release();
    expect(await first).toEqual({ ok: true });
  });

  it('turns a setGeometry refusal into an answer, not a throw, worded for THIS attempt\'s TLS', async () => {
    const f = fakeSession(geo, ['ok']);
    f.session.setGeometry = () => { throw new Error('auto needs an -E model'); };
    const r = await makeConnector(f.session, f.tls, describeAs)
      .attempt(parseGuiArgs(['-insecure', '-model', '3278-2', 'vm']));
    // `-insecure` makes THIS attempt's choice plaintext, while `f.tls.current` is still the
    // fake's initial TLS default (the write never ran: setGeometry threw first) -- so "plain"
    // here can only come from this attempt's own args, not from `tls.current`.
    expect(r).toEqual({ ok: false, error: 'plain vm:23 auto needs an -E model', modelLocked: false });
  });

  // THE TLS TRAP (core `session.ts`'s `reconnect()`): a new TLS choice may be written only
  // immediately before a `connect()` to the target it belongs to, after anything that can throw
  // first -- so when `setGeometry` throws, `tls.current` must be left UNCHANGED.
  it('leaves the previous TLS choice in force when setGeometry throws before the write', async () => {
    const f = fakeSession(geo, []);
    f.tls.current = { kind: 'plaintext' };
    f.session.setGeometry = () => { throw new Error('auto needs an -E model'); };
    // No -insecure: this attempt's own choice is TLS, but it must never reach tls.current.
    const r = await makeConnector(f.session, f.tls, describeAs)
      .attempt(parseGuiArgs(['-model', '3278-2-E', 'vm']));
    expect(r.ok).toBe(false);
    expect(f.tls.current).toEqual({ kind: 'plaintext' });
    expect(f.log.some((l) => l.startsWith('connect'))).toBe(false);
  });
});
