import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
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
    expect(h.tried[0]!.scheme).toBeDefined();
  });

  it('a host the parser refuses is its own words, and the round restarts', async () => {
    const h = harness(['vm:99999', '', '', 'vm', '', ''], ['ok']);
    await promptConnect([], h, h.attempt);
    expect(h.transcript()).toContain('port 99999 in "vm:99999" is outside 1-65535');
    expect(h.transcript()).toContain('\nHost: ');   // no default: the refused host is not offered
    expect(h.tried).toHaveLength(1);
    expect(h.tried[0]!.host).toBe('vm');
  });
});
