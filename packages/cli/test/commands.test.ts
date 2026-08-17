import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/commands.js';

describe('parseCommand', () => {
  it('parses a bare verb', () => {
    expect(parseCommand('Enter')).toEqual({ name: 'Enter', args: [] });
  });

  it('is case-insensitive on the verb', () => {
    expect(parseCommand('enter')!.name).toBe('Enter');
    expect(parseCommand('ENTER')!.name).toBe('Enter');
  });

  it('parses parenthesised arguments', () => {
    expect(parseCommand('PF(3)')).toEqual({ name: 'PF', args: ['3'] });
    expect(parseCommand('MoveCursor(2,10)')).toEqual({ name: 'MoveCursor', args: ['2', '10'] });
  });

  it('parses a quoted string argument, preserving spaces and commas', () => {
    expect(parseCommand('String("LOGON APPLID(TSO),X")'))
      .toEqual({ name: 'String', args: ['LOGON APPLID(TSO),X'] });
  });

  it('handles escaped quotes inside a string', () => {
    expect(parseCommand('String("say \\"hi\\"")')).toEqual({ name: 'String', args: ['say "hi"'] });
  });

  it('accepts space-separated arguments as s3270 does', () => {
    expect(parseCommand('Connect localhost:3270'))
      .toEqual({ name: 'Connect', args: ['localhost:3270'] });
  });

  it('returns null for a blank line', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  it('treats a # comment as a no-op, like a blank line', () => {
    // Recording scripts are meant to be self-documenting; rejecting comments
    // produced 15 spurious errors in a real live-host run.
    expect(parseCommand('# a comment')).toBeNull();
    expect(parseCommand('   # indented comment')).toBeNull();
    expect(parseCommand('#')).toBeNull();
  });

  it('does not treat a # inside a quoted string as a comment', () => {
    expect(parseCommand('String("value # 3")')).toEqual({ name: 'String', args: ['value # 3'] });
  });

  it('rejects an unknown verb', () => {
    expect(() => parseCommand('Frobnicate')).toThrow(/unknown command/i);
  });

  it('knows every stage 1 command', () => {
    const names = [
      'Connect', 'Disconnect', 'String', 'Enter', 'Clear', 'PF', 'PA', 'Tab',
      'BackTab', 'Home', 'Newline', 'EraseEOF', 'EraseInput', 'Reset',
      'MoveCursor', 'Ascii', 'Snap', 'Wait', 'Quit', 'Trace', 'Attn',
      'ScreenText', 'ScreenJson', 'Replay', 'Left', 'Right', 'Up', 'Down',
      'BackSpace', 'Delete', 'Insert',
    ];
    for (const n of names) {
      expect(parseCommand(n)!.name).toBe(n);
    }
  });
});
