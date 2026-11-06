import { describe, it, expect } from 'vitest';
import { KNOWN_MODELS } from '@tn3270/core';
import {
  CONNECT_DEFAULT_MODEL, connectModels, parseConnectSeam, planStartup, submitConnect,
} from '../src/connectDialog.js';
import { MissingHostError, parseGuiArgs, USAGE, UsageError } from '../src/args.js';

/**
 * The decidable half of the startup Connect dialog (spec 2026-11-05-packaging-design.md section 2).
 * main.ts imports `electron`, which vitest cannot load, so everything here is pulled out of it and
 * main only wires windows to these answers.
 */
describe('planStartup', () => {
  const noSeams = { replay: '', shot: '', connect: '' };

  it('a host on the command line starts the session, no dialog', () => {
    const plan = planStartup(['-insecure', 'vm:3270'], noSeams);
    expect(plan.kind).toBe('session');
    expect(plan.kind === 'session' && plan.args.host).toBe('vm');
  });

  it('no arguments at all opens the dialog', () => {
    expect(planStartup([], noSeams)).toEqual({ kind: 'dialog' });
  });

  it('flags without a host open the dialog too; they reach it through dialogToArgv', () => {
    expect(planStartup(['-scheme', 'green'], noSeams)).toEqual({ kind: 'dialog' });
  });

  it('a bad flag fails as it always has, host or no host', () => {
    const plan = planStartup(['--bogus'], noSeams);
    expect(plan.kind).toBe('fail');
    expect(plan.kind === 'fail' && plan.err).toBeInstanceOf(UsageError);
    expect(plan.kind === 'fail' && plan.err).not.toBeInstanceOf(MissingHostError);
  });

  it('a TLS contradiction, checked before the host, fails rather than opening the dialog', () => {
    expect(planStartup(['-insecure', '-cafile', 'x.pem'], noSeams).kind).toBe('fail');
  });

  it('under the replay seam a missing host fails as before, never a dialog nobody can answer', () => {
    const plan = planStartup([], { ...noSeams, replay: '/tmp/trace' });
    expect(plan.kind).toBe('fail');
    expect(plan.kind === 'fail' && plan.err).toBeInstanceOf(MissingHostError);
  });

  /**
   * a87a3fd made a startup failure under the shot seam a FAST exit. A dialog nobody fills in would
   * undo that by hanging the harness -- unless the connect seam is there to fill it.
   */
  it('under the shot seam a missing host still fails fast, unless the connect seam will answer', () => {
    expect(planStartup([], { ...noSeams, shot: '/tmp/x.png' }).kind).toBe('fail');
    expect(planStartup([], { ...noSeams, shot: '/tmp/x.png', connect: '{}' })).toEqual({ kind: 'dialog' });
  });

  it('rethrows nothing: a non-usage failure is a fail plan too', () => {
    const plan = planStartup(['vm'], noSeams, () => { throw new RangeError('boom'); });
    expect(plan).toEqual({ kind: 'fail', err: new RangeError('boom') });
  });
});

describe('submitConnect', () => {
  it('a good form is the parsed args of the argv the user would have typed', () => {
    const r = submitConnect({ host: '127.0.0.1:3270', model: '3278-4-E', tls: false }, ['-scheme', 'green']);
    expect(r.ok).toBe(true);
    expect(r.ok && r.args).toMatchObject({
      host: '127.0.0.1', port: 3270, model: '3278-4-E', tls: { kind: 'plaintext' },
    });
    // The command line's own -scheme survives the trip through the form.
    expect(r.ok && r.args.scheme).toEqual(parseGuiArgs(['-scheme', 'green', 'h']).scheme);
  });

  it('an empty host is the parser s usage line, shown in the dialog', () => {
    expect(submitConnect({ host: '  ', model: '3278-2-E', tls: true }, [])).toEqual({ ok: false, error: USAGE });
  });

  it('a host the parser refuses is the parser s own words', () => {
    const r = submitConnect({ host: 'L:host', model: '3278-2-E', tls: false }, []);
    expect(r.ok === false && r.error).toMatch(/-insecure disables TLS/);
  });

  it('a bad port is the parser s own words', () => {
    const r = submitConnect({ host: 'vm:99999', model: '3278-2-E', tls: true }, []);
    expect(r.ok).toBe(false);
  });

  /**
   * The form arrives over IPC, so its SHAPE is checked before any field is read: a renderer bug
   * that sent `tls: "false"` would otherwise be truthy and quietly dial TLS.
   */
  it.each([
    [undefined],
    [null],
    ['vm'],
    [{ host: 'vm', model: '3278-2-E' }],
    [{ host: 'vm', model: '3278-2-E', tls: 'false' }],
    [{ host: 7, model: '3278-2-E', tls: true }],
    [{ host: 'vm', model: 2, tls: true }],
  ])('refuses a malformed form %j without throwing', (form) => {
    const r = submitConnect(form, []);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/malformed/);
  });

  it('refuses a model the dialog never offered, rather than failing later in the window', () => {
    const r = submitConnect({ host: 'vm', model: '3279-9', tls: true }, []);
    expect(r.ok === false && r.error).toMatch(/unknown model "3279-9"/);
  });

  it('rethrows a failure that is not a usage error: that is a bug, not a typo', () => {
    expect(() => submitConnect({ host: 'vm', model: '3278-2-E', tls: true }, [],
      () => { throw new RangeError('boom'); })).toThrow(RangeError);
  });
});

describe('connectModels', () => {
  it('is every known model, in the table s order', () => {
    expect(connectModels().models).toEqual(Object.keys(KNOWN_MODELS));
  });

  it('defaults to 3278-2-E, which is one of them', () => {
    expect(CONNECT_DEFAULT_MODEL).toBe('3278-2-E');
    expect(connectModels()).toMatchObject({ default: '3278-2-E' });
    expect(connectModels().models).toContain(CONNECT_DEFAULT_MODEL);
  });
});

describe('parseConnectSeam', () => {
  it('empty means absent', () => {
    expect(parseConnectSeam('')).toBeUndefined();
  });

  it('reads the three fields', () => {
    expect(parseConnectSeam('{"host":"127.0.0.1:3270","model":"3278-2-E","tls":false}'))
      .toEqual({ host: '127.0.0.1:3270', model: '3278-2-E', tls: false });
  });

  it('keeps an empty host, which is a scenario: the usage error in the dialog', () => {
    expect(parseConnectSeam('{"host":"","model":"3278-2-E","tls":true}'))
      .toEqual({ host: '', model: '3278-2-E', tls: true });
  });

  it.each([
    ['not json'],
    ['[]'],
    ['{"host":"h","model":"3278-2-E"}'],
    ['{"host":"h","model":"3278-2-E","tls":"no"}'],
  ])('refuses %s by name rather than driving a half-filled form', (raw) => {
    expect(() => parseConnectSeam(raw)).toThrow(/TN3270_GUI_CONNECT/);
  });
});
