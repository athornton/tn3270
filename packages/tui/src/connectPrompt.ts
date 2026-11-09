import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { resolveTerminalType, TerminalTypeError, KNOWN_MODELS, TERMINAL_TYPE, type Session } from '@tn3270/core';
import { describeConnectError, describeTlsError, dialogToArgv, resolveHostSpec } from '@tn3270/frontend';
import { parseArgs, UsageError, type TuiArgs } from './args.js';

/** The terminal the prompt runs on. `terminal` overrides readline's `output.isTTY` test (tests only). */
export interface PromptIo {
  input: Readable;
  output: Writable;
  terminal?: boolean;
}

/**
 * `tn3270` with no host, at a terminal: ask for one, connect, and on failure ask again with the
 * last answers as defaults. Spec docs/superpowers/specs/2026-11-08-tui-connect-prompt-design.md.
 *
 * ONE PARSER: the answers become the argv the user would have typed (`dialogToArgv`, the GUI
 * dialog's own step) and go through `parseArgs`, so the prompt cannot accept a host the command
 * line refuses. A failed round's session is discarded: nothing in the TUI is wired before its
 * first connect, so the next round simply builds a new one.
 *
 * Only a CONNECT failure -- an error carrying a `.code`, i.e. socket, DNS or TLS -- is reported and
 * retried. Anything else `attempt` throws (a bug, a `TerminalTypeError`) is rethrown, so it ends
 * the program exactly as it would have with the host on the command line.
 *
 * Resolves the connected session, or `undefined` when the user quit (EOF or Ctrl-C) -- after
 * writing a newline, so the shell prompt that follows does not start after `Host: `. A quit while
 * a connect is in flight waits for it to end (there is no way to abort one), says so, and
 * disconnects the session if it succeeded anyway.
 *
 * Throws `TerminalTypeError` before asking anything if the command line's `-model` is unknown:
 * the error it would have been with a host, rather than a default no answer can get past.
 */
export async function promptConnect(
  commandLine: readonly string[],
  io: PromptIo,
  attempt: (args: TuiArgs) => Promise<Session>,
): Promise<Session | undefined> {
  const seed = parseArgs(commandLine);              // flags only: run() found no host in them
  // The check `buildSession` makes with a host: a model is looked up unless --terminal-type wins.
  if (seed.model !== undefined && seed.terminalType === undefined) resolveTerminalType({ model: seed.model });
  let host = '';
  // The product default is core's TERMINAL_TYPE ('IBM-3278-2-E'); the model is the part after IBM-.
  let model = seed.model ?? TERMINAL_TYPE.replace(/^IBM-/, '');
  let tls = seed.tls?.kind !== 'plaintext';
  const rl = createInterface({
    input: io.input, output: io.output, ...(io.terminal !== undefined ? { terminal: io.terminal } : {}),
  });
  let closed = false;
  let connecting = false;
  /** Quit asked for while connecting: honoured when the attempt ends. */
  let cancelled = false;
  const say = (text: string): void => { io.output.write(`${text}\n`); };
  /**
   * The attempt cannot be aborted, and a TLS handshake can take its full timeout to give up: say
   * why nothing happens yet, rather than appear to ignore the Ctrl-C.
   */
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    say('cancelled; waiting for the connection attempt to end');
  };
  rl.on('close', () => {
    closed = true;
    if (connecting) cancel();
  });
  // Ctrl-C at a prompt quits, as EOF does. readline emits 'SIGINT' on the interface only in
  // terminal mode (it has put a TTY in raw mode, so the kernel raises no signal). Explicit, though
  // readline also closes on Ctrl-C when nothing listens -- removing this line was measured to
  // change nothing; it says what is meant rather than relying on that default. Covered end to end
  // in a real pty by pty-smoke.py --prompt.
  rl.on('SIGINT', () => { rl.close(); });
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
  /**
   * Runs `attempt` with readline DEAF. In terminal mode readline would echo keys typed while
   * connecting into the messages that follow, and keep them as the start of the next answer; so
   * its keypress listeners are taken off the input for the duration, and only Ctrl-C and Ctrl-D
   * are heard -- as a quit. (Pausing the input instead only delays the same keys to the next
   * question.) The interface stays OPEN until the attempt ends, even after a quit: closing it
   * would take the TTY out of raw mode, and the kernel would echo whatever is typed next into the
   * failure message. Outside terminal mode there are no keypress listeners, and a line typed with
   * no question pending is dropped by readline itself; EOF still closes the interface.
   */
  const connect = async (args: TuiArgs): Promise<Session> => {
    const held = io.input.listeners('keypress') as Array<(...a: unknown[]) => void>;
    for (const l of held) io.input.off('keypress', l);
    const onKey = (_s: unknown, key?: { ctrl?: boolean; name?: string }): void => {
      if (key?.ctrl === true && (key.name === 'c' || key.name === 'd')) cancel();
    };
    io.input.on('keypress', onKey);
    connecting = true;
    try {
      return await attempt(args);
    } finally {
      connecting = false;
      io.input.off('keypress', onKey);
      // A closed interface has removed its own listener already; re-adding it would leave a dead
      // one on stdin for the App to inherit.
      if (!closed) for (const l of held) io.input.on('keypress', l);
    }
  };
  try {
    for (;;) {
      const h = await ask(host === '' ? 'Host: ' : `Host [${host}]: `);
      if (h === undefined) return quit();
      if (h !== '') host = h;
      if (host === '') continue;
      // Refused HERE, before Model or TLS are asked: no host-spec form starts with `-`, and there
      // is no reason to ask two more questions about an answer already known to be wrong. This is
      // the ONLY dash check now -- `host` is never reassigned between here and `dialogToArgv`
      // below, so a second copy there would be unreachable dead code, not a second layer; the
      // `args.host === undefined` check further down guards a DIFFERENT case (parseArgs yielding
      // no host at all) and stays for that reason.
      if (host.startsWith('-')) { say(`not a host: ${JSON.stringify(host)}`); host = ''; continue; }
      // `--terminal-type` on the command line fixes the terminal type for the session's life:
      // `dialogToArgv` still appends `-model model` below, but `resolveTerminalType` sends
      // `seed.terminalType` verbatim and never looks at it (args.ts's check just above this
      // function, and the GUI's own Model control is disabled for the same reason, spec's
      // "Scope -- what does not change"). Asking would accept an answer that changes nothing.
      if (seed.terminalType === undefined) {
        // Re-asked IN PLACE, like TLS below: restarting the round would read the next answer as
        // a host.
        for (;;) {
          const m = await ask(`Model [${model}]: `);
          if (m === undefined) return quit();
          if (m === '') break;
          if (knownModel(m)) { model = m; break; }
          say(`unknown model ${JSON.stringify(m)}: one of ${Object.keys(KNOWN_MODELS).join(', ')}`);
        }
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
        if (!(err instanceof UsageError)) throw err;
        say(err.message);
        // Forget the host only when it is what was refused (a bad port, say). Otherwise -- e.g.
        // TLS answered n against a -noverifycert on the command line -- every answer stays the
        // default, and the message names what has to change.
        if (!hostParses(host)) host = '';
        continue;
      }
      if (args.host === undefined) { say(`not a host: ${JSON.stringify(host)}`); host = ''; continue; }
      const port = args.port ?? 23;
      // Only now: every check that can refuse the answers has passed.
      say(`Connecting to ${args.host}:${port}...`);
      let session: Session;
      try {
        session = await connect(args);
      } catch (err) {
        const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
        if (typeof code !== 'string') throw err;   // not a connect failure: a bug, or fatal anyway
        say(args.tls?.kind === 'tls'
          ? describeTlsError(code, args.host, port, 'prompt')
          : describeConnectError(code, args.host, port, (err as Error).message));
        if (cancelled) return quit();
        continue;
      }
      if (cancelled) { session.disconnect(); return quit(); }   // quit while it was connecting
      return session;
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

/** Whether the host answer is a host spec the parser accepts on its own (`resolveHostSpec`'s rules). */
function hostParses(host: string): boolean {
  try {
    resolveHostSpec(host, (m) => new UsageError(m));
    return true;
  } catch (err) {
    if (err instanceof UsageError) return false;
    throw err;
  }
}
