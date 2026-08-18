#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolveTerminalType, TerminalTypeError } from '@tn3270/core';
import { Runner, defaultSession } from './runner.js';
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
 * An unrecognised flag is an error rather than something to skip: silently
 * ignoring a flag the operator typed produces a session that negotiates
 * something nobody asked for, which is very hard to diagnose from a trace.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    switch (flag) {
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
      default:
        throw new UsageError(`unrecognised argument ${JSON.stringify(flag)}`);
    }
  }
  return args;
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

  // Resolved unconditionally, so there is exactly one path from argv to the
  // wire. With no flags this returns TERMINAL_TYPE, i.e. the same IBM-3278-2
  // the telnet layer would have defaulted to on its own.
  const args = parseArgs(process.argv.slice(2));
  const session = defaultSession(resolveTerminalType(args));
  const runner = new Runner(session);

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
