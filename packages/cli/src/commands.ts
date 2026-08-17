/**
 * Parse one line of the s3270 command protocol.
 *
 * s3270 accepts both `Verb(arg,arg)` and `Verb arg arg`. Quoted strings keep
 * their spaces and commas, which matters for things like
 * String("LOGON APPLID(TSO),DATA").
 */

export interface Command {
  name: string;
  args: string[];
}

/** Canonical spelling of every command stage 1 implements. */
export const COMMAND_NAMES = [
  'Connect', 'Disconnect', 'String', 'Enter', 'Clear', 'PF', 'PA', 'Tab',
  'BackTab', 'Home', 'Newline', 'EraseEOF', 'EraseInput', 'Reset',
  'MoveCursor', 'Ascii', 'Snap', 'Wait', 'Quit', 'Trace', 'Attn',
  'ScreenText', 'ScreenJson', 'TraceText', 'Replay', 'Left', 'Right', 'Up', 'Down',
  'BackSpace', 'Delete', 'Insert',
] as const;

const CANONICAL = new Map(COMMAND_NAMES.map((n) => [n.toLowerCase(), n]));

export function parseCommand(line: string): Command | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  const parenAt = trimmed.indexOf('(');
  let verb: string;
  let rest: string;

  if (parenAt >= 0 && trimmed.endsWith(')')) {
    verb = trimmed.slice(0, parenAt).trim();
    rest = trimmed.slice(parenAt + 1, -1);
  } else {
    const sp = trimmed.indexOf(' ');
    verb = sp < 0 ? trimmed : trimmed.slice(0, sp);
    rest = sp < 0 ? '' : trimmed.slice(sp + 1).trim();
  }

  const name = CANONICAL.get(verb.toLowerCase());
  if (name === undefined) throw new Error(`unknown command: ${verb}`);

  return { name, args: splitArgs(rest) };
}

/** Split on commas or spaces, honouring double quotes and backslash escapes. */
function splitArgs(rest: string): string[] {
  if (rest.trim() === '') return [];
  const args: string[] = [];
  let cur = '';
  let quoted = false;
  let any = false;

  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quoted) {
      if (c === '\\' && i + 1 < rest.length) {
        cur += rest[++i]!;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; any = true; continue; }
    if (c === ',' || c === ' ') {
      if (cur !== '' || any) { args.push(cur); cur = ''; any = false; }
      continue;
    }
    cur += c;
  }
  if (cur !== '' || any) args.push(cur);
  return args;
}
