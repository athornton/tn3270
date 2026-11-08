import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalTypeError } from '@tn3270/core';
import { resolveScheme } from '@tn3270/frontend';
import { promptConnect } from '../src/connectPrompt.js';
import type { TuiArgs } from '../src/args.js';

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
    const h = harness(['vm', '9999', '3278-3-E', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toMatch(/unknown model "9999".*3278-2-E/s);
    expect(h.tried[0]!.model).toBe('3278-3-E');
  });

  it('accepts a model the command line accepts: any case, with or without IBM-', async () => {
    const h = harness(['vm', 'ibm-3278-4-e', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).not.toContain('unknown model');
    expect(h.tried[0]!.model).toBe('ibm-3278-4-e');
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
    expect(h.transcript()).toBe('Host: \n');     // the newline: the shell prompt starts clean
  });

  it('command-line flags are kept, and seed the defaults', async () => {
    const h = harness(['vm', '', ''], ['ok']);
    await promptConnect(['-insecure', '-model', '3278-4-E', '-scheme', 'green'], h, h.attempt);
    expect(h.transcript()).toContain('Model [3278-4-E]: ');
    expect(h.transcript()).toContain('TLS [y/N]: ');
    expect(h.tried[0]!.model).toBe('3278-4-E');
    expect(h.tried[0]!.tls).toEqual({ kind: 'plaintext' });
    expect(h.tried[0]!.scheme).toEqual(resolveScheme('green'));
  });

  it('a host the parser refuses is its own words, and the round restarts', async () => {
    const h = harness(['vm:99999', '', '', 'vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toContain('port 99999 in "vm:99999" is outside 1-65535');
    expect(h.transcript()).toContain('\nHost: ');   // no default: the refused host is not offered
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.host).toBe('vm');
  });

  it('round 2 defaults to round 1 answers: model and TLS carried, not reset', async () => {
    const h = harness(['vm', '3278-4-E', 'n', '', '', ''], [tlsError('ECONNREFUSED'), 'ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toContain('Model [3278-4-E]: ');
    expect(h.transcript()).toContain('TLS [y/N]: ');
    expect(h.tried[1]!.model).toBe('3278-4-E');
    expect(h.tried[1]!.tls).toEqual({ kind: 'plaintext' });
  });

  it('a host that starts with - is refused as a host, not parsed as a flag, and never attempted', async () => {
    const h = harness(['-insecure', '', '', 'vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toContain('not a host: "-insecure"');
    expect(h.transcript()).not.toContain('Connecting to undefined');
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.host).toBe('vm');
  });

  it('refuses a dash-led host right after the Host question, before Model or TLS are asked', async () => {
    const h = harness(['-insecure', 'vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    const t = h.transcript();
    const refused = t.indexOf('not a host: "-insecure"');
    expect(refused).toBeGreaterThan(-1);
    // Nothing between the refusal and the next Host prompt: Model/TLS were never reached for the
    // refused round, which is the whole point of refusing this early.
    expect(t.slice(refused, t.indexOf('Host: ', refused))).not.toMatch(/Model|TLS/);
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.host).toBe('vm');
  });

  it('a parse failure not about the host keeps the host as the default', async () => {
    // -noverifycert on the command line, TLS answered n: resolveTls's contradiction.
    const h = harness(['vm', '', 'n', '', '', 'y'], ['ok']);
    await promptConnect(['-noverifycert'], h, h.attempt);
    expect(h.transcript()).toMatch(/-insecure disables TLS/);
    expect(h.transcript()).toContain('Host [vm]: ');
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.tls).toEqual({ kind: 'tls', verify: false });
  });

  it('an error with no .code is not a connect failure: rethrown, not retried', async () => {
    const h = harness(['vm', '', ''], [new TypeError('a bug')]);
    await expect(promptConnect([], h, h.attempt)).rejects.toThrow(TypeError);
    expect(h.transcript()).not.toContain('a bug');
  });

  it('a TerminalTypeError from the attempt is rethrown too (exit 2, as with a host)', async () => {
    const h = harness(['vm', '', ''], [new TerminalTypeError('terminal type must not be empty')]);
    await expect(promptConnect([], h, h.attempt)).rejects.toThrow(TerminalTypeError);
  });

  it('an unknown -model on the command line is refused before anything is asked', async () => {
    const h = harness(['vm', '', ''], ['ok']);
    await expect(promptConnect(['-model', '9999'], h, h.attempt)).rejects.toThrow(TerminalTypeError);
    expect(h.transcript()).toBe('');
    expect(h.tried).toHaveLength(0);
  });

  it('...but not when --terminal-type wins, as buildSession would not look the model up', async () => {
    const h = harness(['vm', '3278-2-E', ''], ['ok']);
    await promptConnect(['--terminal-type', 'IBM-DYNAMIC', '-model', '9999'], h, h.attempt);
    expect(h.tried).toHaveLength(1);
  });

  it('hands off a closed interface: no readline listener left on the input', async () => {
    const h = harness(['vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.input.listenerCount('data')).toBe(0);
    expect(h.input.listenerCount('end')).toBe(0);
    expect(h.input.listenerCount('keypress')).toBe(0);
  });

  it('EOF while connecting: a later success is disconnected and the prompt quits', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    const answers = ['vm', '', ''];
    let release!: () => void;
    let disconnected = 0;
    output.on('data', (b: Buffer) => {
      transcript += b.toString();
      if (/: $/.test(transcript) && answers.length > 0) input.write(`${answers.shift()!}\n`);
    });
    const attempt = () => new Promise<never>((resolve) => {
      input.end();                                  // the user quits while it is in flight
      release = () => resolve({ disconnect: () => { disconnected++; } } as never);
    });
    const p = promptConnect([], { input, output }, attempt);
    await new Promise((r) => setTimeout(r, 20));
    expect(transcript).toContain('cancelled; waiting for the connection attempt to end');
    release();
    expect(await p).toBeUndefined();
    expect(disconnected).toBe(1);
    expect(transcript.endsWith('\n')).toBe(true);
  });

  it('EOF while connecting: a later failure is reported, then the prompt quits', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    const answers = ['vm', '', 'n'];
    output.on('data', (b: Buffer) => {
      transcript += b.toString();
      if (/: $/.test(transcript) && answers.length > 0) input.write(`${answers.shift()!}\n`);
    });
    let tries = 0;
    const attempt = async () => {
      tries++;
      input.end();
      await new Promise((r) => setTimeout(r, 10));
      throw tlsError('ECONNREFUSED');
    };
    expect(await promptConnect([], { input, output }, attempt)).toBeUndefined();
    expect(tries).toBe(1);
    expect(transcript).toContain('cannot connect to vm:23: connection refused');
    expect(transcript).not.toContain('Host [vm]');
  });
});

/** Thrown by `until` below on its own timeout, named so a hang reads as itself and not as a bare
 * failed `expect`. */
class UntilTimeout extends Error {
  override name = 'UntilTimeout';
}

/**
 * Terminal mode, as at a real TTY: readline decodes keypresses, echoes, and turns Ctrl-C into
 * 'SIGINT' on the interface. A PassThrough has no setRawMode, which readline skips.
 */
describe('promptConnect in terminal mode', () => {
  const plain = (t: string): string => t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

  function tty() {
    const input = new PassThrough();
    const output = new PassThrough();
    let raw = '';
    output.on('data', (b: Buffer) => { raw += b.toString(); });
    /** Resolves once the transcript, escapes stripped, ends with `text`; ~2 s, not ~400 ms, since
     * a loaded CI runner's event loop can starve this poll for well over 400 ms without the
     * promise chain under test having actually stalled. */
    const until = async (text: string): Promise<void> => {
      for (let i = 0; i < 1000 && !plain(raw).endsWith(text); i++) await new Promise((r) => setTimeout(r, 2));
      if (!plain(raw).endsWith(text)) {
        throw new UntilTimeout(`timed out waiting for ${JSON.stringify(text)}; got ${JSON.stringify(plain(raw))}`);
      }
    };
    return { input, output, terminal: true, until, transcript: () => plain(raw) };
  }

  it('Ctrl-C at a prompt quits (readline\'s SIGINT)', async () => {
    const t = tty();
    const p = promptConnect([], t, async () => { throw new Error('not reached'); });
    await t.until('Host: ');
    t.input.write('\x03');
    expect(await p).toBeUndefined();
  });

  it('keys typed while connecting are neither echoed nor the next answer', async () => {
    const t = tty();
    const tried: TuiArgs[] = [];
    let fail!: () => void;
    const attempt = (a: TuiArgs) => new Promise<never>((resolve, reject) => {
      tried.push(a);
      if (tried.length === 1) fail = () => reject(tlsError('HANDSHAKE_TIMEOUT'));
      else resolve({} as never);
    });
    const p = promptConnect([], t, attempt);
    await t.until('Host: '); t.input.write('vm\r');
    await t.until('Model [3278-2-E]: '); t.input.write('\r');
    await t.until('TLS [Y/n]: '); t.input.write('\r');
    await t.until('Connecting to vm:23...\n');
    t.input.write('xyz');
    await new Promise((r) => setTimeout(r, 10));
    fail();
    await t.until('Host [vm]: ');
    t.input.write('\r');
    await t.until('Model [3278-2-E]: '); t.input.write('\r');
    await t.until('TLS [Y/n]: '); t.input.write('n\r');
    expect(await p).toBeDefined();
    expect(t.transcript()).not.toContain('xyz');
    expect(tried[1]!.host).toBe('vm');
    expect(t.input.listenerCount('keypress')).toBe(0);
  });

  it('Ctrl-C while connecting says so, swallows later keys, and disconnects a late success', async () => {
    const t = tty();
    let release!: () => void;
    let disconnected = 0;
    const attempt = () => new Promise<never>((resolve) => {
      release = () => resolve({ disconnect: () => { disconnected++; } } as never);
    });
    const p = promptConnect([], t, attempt);
    await t.until('Host: '); t.input.write('vm\r');
    await t.until('Model [3278-2-E]: '); t.input.write('\r');
    await t.until('TLS [Y/n]: '); t.input.write('\r');
    await t.until('Connecting to vm:23...\n');
    t.input.write('\x03');
    await t.until('cancelled; waiting for the connection attempt to end\n');
    t.input.write('abc');
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await p).toBeUndefined();
    expect(disconnected).toBe(1);
    expect(t.transcript()).not.toContain('abc');
  });

  it('Ctrl-C while connecting, then a failure: the failure is said, and nothing is asked again', async () => {
    const t = tty();
    let fail!: () => void;
    const attempt = () => new Promise<never>((_resolve, reject) => {
      fail = () => reject(tlsError('HANDSHAKE_TIMEOUT'));
    });
    const p = promptConnect([], t, attempt);
    await t.until('Host: '); t.input.write('vm\r');
    await t.until('Model [3278-2-E]: '); t.input.write('\r');
    await t.until('TLS [Y/n]: '); t.input.write('\r');
    await t.until('Connecting to vm:23...\n');
    t.input.write('\x03');
    await t.until('cancelled; waiting for the connection attempt to end\n');
    fail();
    expect(await p).toBeUndefined();
    expect(t.transcript()).toContain('Answer n to TLS: vm:23');
    expect(t.transcript()).not.toContain('Host [vm]');
  });
});
