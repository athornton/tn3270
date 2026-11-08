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

  // DELIBERATE DEPARTURE FROM THE PLAN (see commit message / report): the plan's `makeConnector`
  // writes `tls.current` BEFORE `setGeometry`, so a thrown `setGeometry` leaves a NEW TLS choice
  // paired with the OLD target -- exactly what core `Session.reconnect()`'s comment (THE TLS TRAP)
  // says an owner must never do. Here the write happens only immediately before `connect()`,
  // after `setGeometry` -- so when `setGeometry` throws, `tls.current` is UNCHANGED.
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
