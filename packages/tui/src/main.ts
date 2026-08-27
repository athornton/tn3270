#!/usr/bin/env node
/**
 * c3270-style terminal front end.
 *
 * Argument parsing and process wiring only; the screen lives in app.ts. See
 * docs/superpowers/specs/2026-08-19-tui-and-colour-design.md.
 */

import { resolveTerminalType, resolveAlternateSize, TerminalTypeError } from '@tn3270/core';
import {
  defaultSession, splitTarget, takeTlsFlag, resolveTls, TLS_USAGE,
  type TlsFlags, type TlsOptions,
} from '@tn3270/cli';
import { App, type HostProcess } from './app.js';
import { layout } from './render.js';
import type { Depth } from './colours.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface TuiArgs {
  model?: string;
  terminalType?: string;
  /** Absent means detect from terminfo. */
  colors?: Depth;
  host?: string;
  /** How the socket is made. Absent only before `resolveTls` has run. */
  tls?: TlsOptions;
  /** Offer TN3270E. Absent means the default, which is on. */
  tn3270e?: boolean;
}

/**
 * `--colors` accepts what a user would think to type, including `16m`.
 *
 * `auto` is spelled out rather than being only the default, so a keymap or shell
 * alias can pass it explicitly and get detection back.
 */
const COLOUR_WORDS: Readonly<Record<string, Depth>> = Object.freeze({
  '0': 0, 'none': 0, 'mono': 0,
  '8': 8,
  '16': 16,
  '256': 256,
  '16m': 16777216, 'truecolor': 16777216, '24bit': 16777216, '16777216': 16777216,
});

/**
 * Parse the argument vector.
 *
 * The flag spellings match the CLI's (`-model`, `--terminal-type`) so the two
 * front ends stay legible side by side, and an unrecognised flag is an error for
 * the same reason it is there: silently ignoring one produces a session that
 * negotiates something nobody asked for.
 *
 * The one difference is that a bare argument is the HOST here, since a TUI with
 * no host has nothing to draw.
 */
export function parseArgs(argv: readonly string[]): TuiArgs {
  const args: TuiArgs = {};
  const tlsFlags: TlsFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    const eaten = takeTlsFlag(tlsFlags, flag, value, (m) => new UsageError(m));
    if (eaten !== undefined) {
      i += eaten;
      continue;
    }
    switch (flag) {
      case '-tn3270e': {
        // Positive form on the user's call. TN3270E is ON by default, matching x3270,
        // and safe because the negotiation backs off to traditional tn3270 on a
        // reject. Against the two Hercules hosts the code never fires -- neither
        // offers option 40 -- so `off` exists for a host that mishandles it rather
        // than for them.
        if (value === undefined) throw new UsageError('-tn3270e needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-tn3270e takes on or off, not ${JSON.stringify(value)}`);
        }
        args.tn3270e = value === 'on';
        i++;
        break;
      }
      case '-model':
        if (value === undefined) throw new UsageError('-model needs a value, e.g. -model 3278-2-E');
        args.model = value;
        i++;
        break;
      case '--terminal-type':
        if (value === undefined) throw new UsageError('--terminal-type needs a value, e.g. --terminal-type IBM-DYNAMIC');
        args.terminalType = value;
        i++;
        break;
      case '--colors': {
        if (value === undefined) {
          throw new UsageError('--colors needs a value: 0, 8, 16, 256, 16m or auto');
        }
        i++;
        if (value.toLowerCase() === 'auto') break;   // leave it undefined: detect
        const depth = COLOUR_WORDS[value.toLowerCase()];
        if (depth === undefined) {
          throw new UsageError(`--colors does not understand ${JSON.stringify(value)}; use 0, 8, 16, 256, 16m or auto`);
        }
        args.colors = depth;
        break;
      }
      default:
        if (flag.startsWith('-')) {
          throw new UsageError(`unrecognised argument ${JSON.stringify(flag)}`);
        }
        if (args.host !== undefined) {
          throw new UsageError(`more than one host given: ${JSON.stringify(args.host)} and ${JSON.stringify(flag)}`);
        }
        args.host = flag;
        break;
    }
  }
  args.tls = resolveTls(tlsFlags, (m) => new UsageError(m));
  // Both the host and the flags are in argv here, so this contradiction can be
  // caught before a socket is opened — unlike the CLI, whose host arrives later
  // via `Connect()` and which therefore checks the same thing in the runner.
  if (args.tls.kind === 'plaintext' && /^[Ll]:/.test(args.host ?? '')) {
    throw new UsageError(
      `${args.host!} asks for TLS with the L: prefix, but -insecure disables TLS`,
    );
  }
  return args;
}

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

export async function run(argv: readonly string[], host: HostProcess): Promise<number> {
  const args = parseArgs(argv);
  if (args.host === undefined) {
    throw new UsageError(
      `usage: tn3270 [-model M] [--terminal-type T] [--colors N] ${TLS_USAGE} host[:port]`,
    );
  }

  // Built once and passed to both resolvers, so the ttype string and the geometry
  // can never come from different readings of the same arguments.
  const typeOpts = {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.terminalType !== undefined ? { terminalType: args.terminalType } : {}),
  };
  const session = defaultSession(
    resolveTerminalType(typeOpts), args.tls, resolveAlternateSize(typeOpts),
    args.tn3270e,
  );

  const [hostname, port] = splitTarget(args.host);
  await session.connect(hostname, port);

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
    ...(args.colors !== undefined ? { depth: args.colors } : {}),
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
