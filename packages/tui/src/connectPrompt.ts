import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { resolveTerminalType, TerminalTypeError, KNOWN_MODELS, TERMINAL_TYPE, type Session } from '@tn3270/core';
import { describeConnectError, describeTlsError, dialogToArgv } from '@tn3270/frontend';
import { parseArgs, UsageError, type TuiArgs } from './args.js';

/**
 * `tn3270` with no host, at a terminal: ask for one, connect, and on failure ask again with the
 * last answers as defaults. Spec docs/superpowers/specs/2026-11-08-tui-connect-prompt-design.md.
 *
 * ONE PARSER: the answers become the argv the user would have typed (`dialogToArgv`, the GUI
 * dialog's own step) and go through `parseArgs`, so the prompt cannot accept a host the command
 * line refuses. A failed round's session is discarded: nothing in the TUI is wired before its
 * first connect, so the next round simply builds a new one.
 *
 * Resolves the connected session, or `undefined` when the user quit (EOF or Ctrl-C) -- after
 * writing a newline, so the shell prompt that follows does not start after `Host: `.
 */
export async function promptConnect(
  commandLine: readonly string[],
  io: { input: Readable; output: Writable },
  attempt: (args: TuiArgs) => Promise<Session>,
): Promise<Session | undefined> {
  const seed = parseArgs(commandLine);              // flags only: run() found no host in them
  let host = '';
  // The product default is core's TERMINAL_TYPE ('IBM-3278-2-E'); the model is the part after IBM-.
  let model = seed.model ?? TERMINAL_TYPE.replace(/^IBM-/, '');
  let tls = seed.tls?.kind !== 'plaintext';
  const rl = createInterface({ input: io.input, output: io.output });
  let closed = false;
  rl.on('close', () => { closed = true; });
  // Ctrl-C at a prompt quits, as EOF does. readline emits 'SIGINT' on the interface only when the
  // input is a TTY (it has put it in raw mode, so no real signal is raised), which is why the
  // in-memory tests cannot reach this line; the pty harness (pty-smoke.py) is what exercises it.
  rl.on('SIGINT', () => { rl.close(); });
  const say = (text: string): void => { io.output.write(`${text}\n`); };
  const quit = (): undefined => { io.output.write('\n'); return undefined; };
  /**
   * One question, trimmed; undefined once the interface has closed. The close listener is removed
   * once the question is answered, so a long run of retries does not pile listeners onto `rl`.
   */
  const ask = (q: string): Promise<string | undefined> => closed ? Promise.resolve(undefined)
    : new Promise((resolve) => {
      const onClose = (): void => resolve(undefined);
      rl.once('close', onClose);
      rl.question(q).then(
        (a) => { rl.off('close', onClose); resolve(a.trim()); },
        () => { rl.off('close', onClose); resolve(undefined); },
      );
    });
  try {
    for (;;) {
      const h = await ask(host === '' ? 'Host: ' : `Host [${host}]: `);
      if (h === undefined) return quit();
      if (h !== '') host = h;
      if (host === '') continue;
      // Re-asked IN PLACE, like TLS below: restarting the round would read the next answer as a host.
      for (;;) {
        const m = await ask(`Model [${model}]: `);
        if (m === undefined) return quit();
        if (m === '') break;
        if (knownModel(m)) { model = m; break; }
        say(`unknown model ${JSON.stringify(m)}: one of ${Object.keys(KNOWN_MODELS).join(', ')}`);
      }
      let t: string | undefined;
      for (;;) {
        t = await ask(`TLS [${tls ? 'Y/n' : 'y/N'}]: `);
        if (t === undefined) return quit();
        if (t === '' || /^(y|yes|n|no)$/i.test(t)) break;
        say('answer y or n');
      }
      if (t !== '') tls = /^y/i.test(t);

      let args: TuiArgs;
      try {
        args = parseArgs(dialogToArgv({ host, model, tls }, commandLine));
      } catch (err) {
        // The parser's own words; the refused host is not offered back as the next default.
        if (err instanceof UsageError) { say(err.message); host = ''; continue; }
        throw err;
      }
      const port = args.port ?? 23;
      say(`Connecting to ${args.host!}:${port}...`);
      try {
        return await attempt(args);
      } catch (err) {
        say(describeFailure(err, args.host!, port, args.tls?.kind === 'tls'));
      }
    }
  } finally {
    rl.close();   // before raw mode and the alternate screen take stdin
  }
}

/**
 * A model name the command line's `-model` would accept: the SAME lookup (`resolveTerminalType`,
 * which case-folds and allows `IBM-`), not an exact key match that would refuse `3278-2-e`.
 */
function knownModel(m: string): boolean {
  try {
    resolveTerminalType({ model: m });
    return true;
  } catch (err) {
    if (err instanceof TerminalTypeError) return false;
    throw err;
  }
}

/**
 * The failure in the prompt's words, from the error's `.code` -- `tcpConnect`'s MESSAGE is the
 * command-line wording (`use -insecure`), so it is re-worded here, as the GUI's `explain()` does:
 * `describeTlsError`'s `'prompt'` remedy for a TLS attempt, `describeConnectError` for plaintext.
 */
function describeFailure(err: unknown, host: string, port: number, tls: boolean): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: string }).code;
  if (code === undefined) return err.message;
  return tls ? describeTlsError(code, host, port, 'prompt') : describeConnectError(code, host, port, err.message);
}
