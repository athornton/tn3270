#!/usr/bin/env node
/**
 * c3270-style terminal front end.
 *
 * Process wiring only: the command line is parsed in args.ts, the screen lives in app.ts. See
 * docs/superpowers/specs/2026-08-19-tui-and-color-design.md.
 */

import {
  resolveTerminalType, resolveAlternateSize, TerminalTypeError, type Session,
} from '@tn3270/core';
import { defaultSession, OVERSIZE_USAGE, TLS_USAGE } from '@tn3270/frontend';
import { nodeTransferFiles, isMain } from '@tn3270/node-files';
import { App, type HostProcess } from './app.js';
import { layout, measureTerminal, type Geometry } from './render.js';
import { parseArgs, UsageError, type TuiArgs } from './args.js';

// The command line lives in args.ts (so the no-host prompt can parse without a cycle through this
// file); re-exported so callers that import it from here keep working.
export { parseArgs, UsageError } from './args.js';
export type { TuiArgs } from './args.js';

/**
 * The banner. It has to say how to get out: Ctrl-C is the Clear AID here, which is
 * what a 3270 user needs but also exactly what everyone reaches for to quit -- so
 * an undocumented Ctrl-] would strand a first-time user in a terminal that ignores
 * every instinct they have.
 *
 * Shown one of TWO ways, never both. Given a spare row the renderer draws it above
 * the screen, where it STAYS; the user asked for that because the transient line
 * "goes by too quickly to see". With no spare row it is printed here instead,
 * before raw mode and before the alternate screen buffer, which is the only way a
 * short terminal learns Ctrl-] at all.
 */
export const BANNER = 'tn3270: Ctrl-] quits, Ctrl-C is Clear, Ctrl-R is Reset';

/** The real terminal's size, read when called -- never captured. 0 for an unknown dimension. */
function processTerminal(): Geometry {
  return { rows: process.stdout.rows ?? 0, cols: process.stdout.columns ?? 0 };
}

/**
 * Builds the session `run()` connects, from a parsed `TuiArgs` -- the CLI's `buildSession`,
 * extracted for the same reason: so a test drives this code rather than a copy of it.
 *
 * Geometry mode unless `--terminal-type` was given (a raw string `resolveGeometry` cannot
 * interpret as a model). The `auto` measure reads the terminal AT CALL TIME, through
 * `terminal`, which `Session` calls at every connect and reconnect: a resize between them is
 * what the next connect sees. `terminal` is injected only so a test can resize a terminal that
 * is not the test runner's.
 */
export function buildSession(args: TuiArgs, terminal: () => Geometry = processTerminal): Session {
  if (args.terminalType !== undefined) {
    // Built once and passed to both resolvers, so the ttype string and the geometry
    // can never come from different readings of the same arguments.
    const typeOpts = {
      ...(args.model !== undefined ? { model: args.model } : {}),
      terminalType: args.terminalType,
    };
    return defaultSession(
      resolveTerminalType(typeOpts), args.tls, resolveAlternateSize(typeOpts),
      args.tn3270e, args.bindImage, args.bindLimit, args.devname, args.ddm,
    );
  }
  return defaultSession(
    undefined, args.tls, undefined, args.tn3270e, args.bindImage, args.bindLimit,
    args.devname, args.ddm,
    {
      setting: {
        ...(args.model !== undefined ? { model: args.model } : {}),
        oversize: args.oversize ?? { kind: 'none' },
      },
      measure: () => measureTerminal(terminal()),
    },
  );
}

/**
 * Build the session and make the FIRST connect, saying any geometry notice on `stderr` -- split
 * out of `run()` so a test can see that write happen, with an injected stream, rather than trust
 * it. Requires `args.host`.
 *
 * The notice (an `auto` that fell back to the model) is written HERE, before `App.start()` opens
 * the alternate screen, so it stays in the normal buffer -- there on quitting and in scrollback.
 * The App flashes it on screen too, and handles every later reconnect's itself.
 */
export async function connectFirst(
  args: TuiArgs, stderr: { write(text: string): unknown }, terminal: () => Geometry = processTerminal,
): Promise<Session> {
  if (args.host === undefined) throw new UsageError('connectFirst needs a host');
  const session = buildSession(args, terminal);
  // The LU list travels with the CONNECTION, not the session: it came from the host
  // argument, and `ConnectOptions` is where a per-host setting belongs. `tn3270e` went
  // to the constructor because it is a process-wide flag here — the TUI takes
  // one host for its lifetime, so the two routes cannot disagree.
  await session.connect(args.host, args.port ?? 23,
    args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {});
  if (session.lastGeometryNotice !== undefined) {
    stderr.write(`${session.lastGeometryNotice}\n`);
  }
  return session;
}

export async function run(argv: readonly string[], host: HostProcess): Promise<number> {
  const args = parseArgs(argv);
  if (args.host === undefined) {
    throw new UsageError(
      `usage: tn3270 [-model M] [--terminal-type T] [--colors N] [-scheme S] `
      + `[-tn3270e on|off] [-bind-image on|off] [-bind-limit on|off] [-ddm on|off] [-devname NAME] `
      + `${OVERSIZE_USAGE} ${TLS_USAGE} [prefix:][LU,LU@]host[:port]`,
    );
  }

  const session = await connectFirst(args, host.stderr);

  // Printed here ONLY when the persistent hint has nowhere to go. The transient
  // line exists because the message used to vanish the instant the alternate
  // screen buffer opened; where the terminal has a spare row, the renderer now
  // keeps it on screen and printing it as well would just scroll the shell.
  //
  // Computed AFTER connect deliberately: the host can hand us an alternate screen
  // size, so the screen geometry is only final once negotiation has finished, and
  // asking a row too early could print the banner for a layout that has room.
  const screen = { rows: session.screen.rows, cols: session.screen.cols };
  const place = layout(
    { rows: process.stdout.rows ?? 0, cols: process.stdout.columns ?? 0 },
    screen,
  );
  if (place.hintRow === undefined) process.stdout.write(`${BANNER}\n`);

  const app = new App({
    session,
    stdin: process.stdin,
    stdout: process.stdout,
    host,
    hint: BANNER,
    // The real filesystem, injected exactly as the CLI's Runner takes it: `app.ts` imports no
    // `node:fs`, so a test supplies an in-memory `TransferFiles` instead.
    files: nodeTransferFiles,
    ...(args.colors !== undefined ? { depth: args.colors } : {}),
    ...(args.scheme !== undefined ? { scheme: args.scheme } : {}),
  });
  app.start();
  return 0;
}

/** The real process, adapted to the narrow interface `App` asks for. */
const realHost: HostProcess = {
  on: (event, listener) => { process.on(event as NodeJS.Signals, () => listener()); },
  exit: (code) => process.exit(code),
  stderr: process.stderr,
};

// `isMain`, not `import.meta.url === \`file://${process.argv[1]}\``: npm installs this bin as a
// POSIX symlink (or a Windows `.cmd` shim), so `argv[1]` names the link, not this file, and the
// old string comparison was FALSE for every installed copy -- the program exited 0 having done
// nothing. Measured 2026-11-05 through a symlink. `isMain` compares real paths instead.
if (isMain(import.meta.url)) {
  run(process.argv.slice(2), realHost).catch((err: unknown) => {
    // A bad command line is the operator's mistake, not a crash: print the
    // message alone. Exit 2 is the conventional usage-error status, matching the
    // CLI, and keeps it distinguishable from a real failure's 1.
    if (err instanceof UsageError || err instanceof TerminalTypeError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
