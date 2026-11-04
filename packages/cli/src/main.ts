#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import {
  resolveTerminalType, resolveAlternateSize, resolveGeometry, OversizeError, TerminalTypeError,
  type Oversize, type Session,
} from '@tn3270/core';
import { Runner } from './runner.js';
import {
  takeTlsFlag, takeOversizeFlag, resolveTls, defaultSession,
  type TlsFlags, type TlsOptions,
} from '@tn3270/frontend';
import { nodeTransferFiles } from '@tn3270/node-files';
import { parseCommand } from './commands.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliArgs {
  model?: string;
  terminalType?: string;
  /** How the socket is made. Absent only before `resolveTls` has run. */
  tls?: TlsOptions;
  /** Offer TN3270E. Absent means the default, which is on. */
  tn3270e?: boolean;
  /** Request BIND-IMAGE. Absent means the default, which is on. */
  bindImage?: boolean;
  /**
   * Advertise Query Reply (DDM), which lets a host choose DFT file transfer
   * instead of CUT. Absent means the default, which is OFF -- unlike the other
   * capability flags here. See `SessionOptions.ddm`.
   */
  ddm?: boolean;
  /** Range-check a BIND's geometry. Absent means the default, which is on. */
  bindLimit?: boolean;
  /**
   * Device-name template for NEW-ENVIRON's DEVNAME uservar. Absent means we refuse
   * telnet option 39 entirely -- see `SessionOptions.devname`.
   */
  devname?: string;
  /**
   * `-oversize <cols>x<rows>|auto|none`. Absent means `none`: the model's own alternate
   * size, exactly as before this flag existed. A combination `resolveGeometry` would
   * refuse at connect -- `auto` (no window to measure here), `--terminal-type` together
   * with it, or a model that cannot carry it -- is refused at parse time instead; see
   * `parseArgs`'s check after the flag loop.
   */
  oversize?: Oversize;
}

/**
 * Parse the argument vector.
 *
 * `-model` matches s3270's spelling so our invocations stay legible next to it
 * in conformance runs; `--terminal-type` is the escape hatch for a raw string.
 * Single-dash `-model` and no `--model` alias is what s3270 itself accepts: it
 * compares with strcmp against OptModel, `"-model"` (glue.c:640,
 * resources.h:556).
 *
 * An unrecognized flag is an error rather than something to skip: silently
 * ignoring a flag the operator typed produces a session that negotiates
 * something nobody asked for, which is very hard to diagnose from a trace.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  const tlsFlags: TlsFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    const eaten = takeTlsFlag(tlsFlags, flag, value, (m) => new UsageError(m));
    if (eaten !== undefined) {
      i += eaten;
      continue;
    }
    const oversizeEaten = takeOversizeFlag(args, flag, value, (m) => new UsageError(m));
    if (oversizeEaten !== undefined) {
      i += oversizeEaten;
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
      case '-bind-image': {
        if (value === undefined) throw new UsageError('-bind-image needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-bind-image takes on or off, not ${JSON.stringify(value)}`);
        }
        args.bindImage = value === 'on';
        i++;
        break;
      }
      case '-ddm': {
        if (value === undefined) throw new UsageError('-ddm needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-ddm takes on or off, not ${JSON.stringify(value)}`);
        }
        args.ddm = value === 'on';
        i++;
        break;
      }
      case '-bind-limit': {
        if (value === undefined) throw new UsageError('-bind-limit needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-bind-limit takes on or off, not ${JSON.stringify(value)}`);
        }
        args.bindLimit = value === 'on';
        i++;
        break;
      }
      case '-devname':
        if (value === undefined) throw new UsageError('-devname needs a value, e.g. -devname foo===');
        args.devname = value;
        i++;
        break;
      default:
        throw new UsageError(`unrecognized argument ${JSON.stringify(flag)}`);
    }
  }
  // Refuse at PARSE time whatever `resolveGeometry` would refuse at connect time: an
  // oversize with --terminal-type, an oversize on a model that cannot carry it (too small,
  // too many cells, or not `-E`), and `-oversize auto` (the CLI has no window to measure --
  // see geometry.ts's own message). One call covers all three, because they are exactly
  // the checks `resolveGeometry` already makes; this only moves WHEN the operator hears
  // about them, from "after main() builds the session" to "before anything connects".
  if (args.oversize !== undefined) {
    try {
      resolveGeometry({
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.terminalType !== undefined ? { terminalType: args.terminalType } : {}),
        oversize: args.oversize,
      });
    } catch (e) {
      if (e instanceof OversizeError) throw new UsageError(e.message);
      throw e;
    }
  }
  args.tls = resolveTls(tlsFlags, (m) => new UsageError(m));
  return args;
}

/**
 * Builds the session `main()` runs, from a parsed `CliArgs`. Pulled out of `main()` so it
 * can be unit-tested without `main()`'s stdin loop or a real connect -- `Session`'s
 * constructor alone resolves `geometrySetting` and `screen.alternateSize`, which is
 * everything a test needs to see.
 *
 * Geometry mode is the normal path: UNLESS `--terminal-type` was given (a raw string
 * `resolveGeometry` cannot interpret as a model), the session resolves its terminal type
 * and alternate size at every connect rather than once here, which is what lets the
 * step-2 `Set(model,...)` command (Task 6) change them after connect. `-model` alone --
 * by far the common case -- goes through geometry mode too, with `oversize: none`
 * resolving to exactly the model's own alternate size, so this is not a behavior change
 * for that case; `main.test.ts`'s "buildSession: what main() actually constructs" tests
 * drive THIS function, not a copy of its expression, to keep that true.
 */
export function buildSession(args: CliArgs): Session {
  if (args.terminalType !== undefined) {
    return defaultSession(
      resolveTerminalType(args), args.tls, resolveAlternateSize(args), args.tn3270e,
      args.bindImage, args.bindLimit, args.devname, args.ddm,
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
    },
  );
}

/**
 * s3270-compatible line protocol over stdin/stdout. Deliberately thin: all
 * command semantics live in runner.ts, which is unit-tested.
 */
async function main(): Promise<void> {
  // A closed stdout is a normal way for a pipeline to end — `| head -5`, or an
  // automation harness that stops reading. Without this, the write throws an
  // unhandled EPIPE and the process dies with a stack trace instead of exiting
  // quietly, which is both ugly and easy to mistake for a crash in the client.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  // Parsed once, unconditionally, so there is exactly one path from argv to the wire. With
  // no flags, `buildSession` below takes the geometry-mode branch with no model and no
  // oversize, which resolves to the same IBM-3278-2-E the telnet layer would have defaulted
  // to before geometry mode existed -- see `main.test.ts`'s `buildSession` tests.
  const args = parseArgs(process.argv.slice(2));
  const session = buildSession(args);
  const runner = new Runner(session, {
    files: nodeTransferFiles,
    tlsEnabled: args.tls?.kind !== 'plaintext',
  });

  const rl = createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    // Replay(file) needs the file system, so it is handled here rather than in
    // the runner, which stays I/O-free for testability.
    let handled = false;
    try {
      const cmd = parseCommand(line);
      if (cmd?.name === 'Replay') {
        const path = cmd.args[0];
        if (path === undefined) throw new Error('Replay needs a file name');
        process.stdout.write(await runner.runReplayText(readFileSync(path, 'utf8')) + '\n');
        handled = true;
      }
    } catch (err) {
      // Every reply must carry a status line, even one that failed before
      // reaching the runner (a missing file name, or readFileSync's ENOENT).
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(runner.errorReply(msg) + '\n');
      handled = true;
    }

    if (!handled) {
      process.stdout.write(await runner.run(line) + '\n');
    }
    if (runner.shouldQuit) break;
  }

  session.disconnect();
}

main().catch((err: unknown) => {
  // A bad command line is the operator's mistake, not a crash: print the
  // message alone. A stack trace here buries the one line that says what to
  // type instead. Exit 2 is the conventional usage-error status and keeps it
  // distinguishable from a real failure's 1.
  if (err instanceof UsageError || err instanceof TerminalTypeError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
