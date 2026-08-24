#!/usr/bin/env node
/**
 * c3270-style terminal front end.
 *
 * Argument parsing and process wiring only; the screen lives in app.ts. See
 * docs/superpowers/specs/2026-08-19-tui-and-colour-design.md.
 */

export function main(argv: readonly string[]): number {
  void argv;
  process.stderr.write('tn3270 TUI: not implemented yet\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
