#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { Runner, defaultSession } from './runner.js';
import { parseCommand } from './commands.js';

/**
 * s3270-compatible line protocol over stdin/stdout. Deliberately thin: all
 * command semantics live in runner.ts, which is unit-tested.
 */
async function main(): Promise<void> {
  const session = defaultSession();
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
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
