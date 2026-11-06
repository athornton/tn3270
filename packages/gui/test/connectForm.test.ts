import { describe, it, expect } from 'vitest';
import { dialogToArgv } from '../src/connectForm.js';
import { planStartup } from '../src/connectDialog.js';
import { buildSession, parseGuiArgs, UsageError } from '../src/args.js';

/**
 * `dialogToArgv` is the ONLY path from the connect dialog's form to a session: it builds an
 * argv and hands it to the real `parseGuiArgs`, so these tests pin the ARGV SHAPE and leave
 * every validation rule (bad host, TLS contradictions, model names) to `args.test.ts` and
 * `packages/frontend/test`. A test here that duplicated a validation rule would be the second
 * copy of it that the spec's "ONE PARSER" design exists to prevent.
 */
describe('dialogToArgv', () => {
  it('a plain host with TLS on is the model and the host, no -insecure', () => {
    expect(dialogToArgv({ host: 'vm.example:3270', model: '3278-2-E', tls: true }, []))
      .toEqual(['-model', '3278-2-E', 'vm.example:3270']);
  });

  it('TLS off adds -insecure', () => {
    expect(dialogToArgv({ host: '127.0.0.1:3271', model: '3278-4-E', tls: false }, []))
      .toEqual(['-insecure', '-model', '3278-4-E', '127.0.0.1:3271']);
  });

  it("keeps the real command line's other flags, and lets the form's model win", () => {
    expect(dialogToArgv({ host: 'h', model: '3278-2-E', tls: true }, ['-scheme', 'green', '-model', '3278-5']))
      .toEqual(['-scheme', 'green', '-model', '3278-2-E', 'h']);
  });

  it('trims the host, and passes LU and prefix specs through untouched', () => {
    const argv = dialogToArgv({ host: '  L:LUA,LUB@host:992 ', model: '3278-2-E', tls: true }, []);
    expect(argv.at(-1)).toBe('L:LUA,LUB@host:992');
    expect(parseGuiArgs(argv).lus).toEqual(['LUA', 'LUB']);
  });

  it('an empty host is refused BY parseGuiArgs, not by a second validator', () => {
    expect(() => parseGuiArgs(dialogToArgv({ host: '   ', model: '3278-2-E', tls: true }, []))).toThrow(UsageError);
  });

  it('a contradiction the parser catches surfaces as its own message', () => {
    expect(() => parseGuiArgs(dialogToArgv({ host: 'L:host', model: '3278-2-E', tls: false }, [])))
      .toThrow(/-insecure disables TLS/);
  });

  it('a command-line -insecure is dropped when the form says TLS on -- the form owns TLS', () => {
    expect(dialogToArgv({ host: 'h', model: '3278-2-E', tls: true }, ['-insecure']))
      .toEqual(['-model', '3278-2-E', 'h']);
  });

  it('a command-line -insecure does not duplicate the one the form adds when TLS is off', () => {
    const argv = dialogToArgv({ host: 'h', model: '3278-2-E', tls: false }, ['-insecure']);
    expect(argv).toEqual(['-insecure', '-model', '3278-2-E', 'h']);
    expect(parseGuiArgs(argv).tls).toEqual({ kind: 'plaintext' });
  });

  it('a command-line -cafile survives untouched with TLS on (the form does not own it)', () => {
    const argv = dialogToArgv({ host: 'h', model: '3278-2-E', tls: true }, ['-cafile', 'x.pem']);
    expect(argv).toEqual(['-cafile', 'x.pem', '-model', '3278-2-E', 'h']);
    expect(parseGuiArgs(argv).tls).toEqual({ kind: 'tls', verify: true, caFile: 'x.pem' });
  });

  it('a command-line -cafile with TLS off becomes the parser\'s own contradiction, not a new one', () => {
    const argv = dialogToArgv({ host: 'h', model: '3278-2-E', tls: false }, ['-cafile', 'x.pem']);
    expect(argv).toEqual(['-cafile', 'x.pem', '-insecure', '-model', '3278-2-E', 'h']);
    expect(() => parseGuiArgs(argv)).toThrow(/-insecure disables TLS.*cannot be combined with.*-cafile/s);
  });

  it('drops a -model/value pair wherever it falls on the command line, not just at the front', () => {
    expect(dialogToArgv({ host: 'h', model: '3278-2-E', tls: true }, ['-scheme', 'green', '-model', '3278-5', '-ddm', 'on']))
      .toEqual(['-scheme', 'green', '-ddm', 'on', '-model', '3278-2-E', 'h']);
  });

  it('a command line ending in a bare -model fails at parse time, so the dialog never sees it', () => {
    // Why dropOwned has no "dangling -model" case: parseGuiArgs refuses the flag before it looks
    // for a host, so planStartup fails the launch outright instead of opening the dialog.
    expect(() => parseGuiArgs(['-model'])).toThrow(/-model needs a value/);
    expect(planStartup(['-model'], { replay: '', shot: '', connect: '' }).kind).toBe('fail');
  });

  it('a host already on the command line is kept, so parseGuiArgs reports two hosts rather than picking one', () => {
    const argv = dialogToArgv({ host: 'h', model: '3278-2-E', tls: true }, ['oldhost']);
    expect(argv).toEqual(['oldhost', '-model', '3278-2-E', 'h']);
    expect(() => parseGuiArgs(argv)).toThrow(/more than one host given: "oldhost" and "h"/);
  });

  it('an empty form host with no other flags leaves only the usage error', () => {
    expect(() => parseGuiArgs(dialogToArgv({ host: '', model: '3278-2-E', tls: true }, [])))
      .toThrow(UsageError);
  });

  it('a command-line --terminal-type wins over the form model, in the SAME way it always has: ' +
    'buildSession ignores a model once a terminal type is given', () => {
    const argv = dialogToArgv({ host: 'h', model: '3278-4-E', tls: true }, ['--terminal-type', 'IBM-3278-2-E']);
    expect(argv).toEqual(['--terminal-type', 'IBM-3278-2-E', '-model', '3278-4-E', 'h']);
    const args = parseGuiArgs(argv);
    expect(args.model).toBe('3278-4-E');
    expect(args.terminalType).toBe('IBM-3278-2-E');
    const session = buildSession(args, () => undefined);
    // Legacy mode: no geometry setting, and the 24x80 default rather than model 4's 43x80 --
    // resolveAlternateSize declines to guess a geometry from a raw terminal-type string, exactly
    // as it does on the real command line (see args.test.ts, "legacy mode with --terminal-type").
    expect(session.geometrySetting).toBeUndefined();
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
  });
});
