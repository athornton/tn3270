import { describe, it, expect } from 'vitest';
import { parseHostSpec } from '../src/hostspec.js';

/**
 * s3270's documented host shape is `[prefix:][LUname@]hostname[:port]`, with prefixes
 * stacked one colon each and multiple LUs comma-separated, tried in order as
 * rejections come back (telnet.c setup_lus/next_lu).
 */
describe('parseHostSpec', () => {
  it('parses a bare host', () => {
    expect(parseHostSpec('mvs.example.com')).toEqual({
      host: 'mvs.example.com', lus: [], prefixes: [], portText: undefined,
    });
  });

  it('parses host and port', () => {
    expect(parseHostSpec('127.0.0.1:3271')).toEqual({
      host: '127.0.0.1', lus: [], prefixes: [], portText: '3271',
    });
  });

  it('parses one LU', () => {
    expect(parseHostSpec('TESTLU01@host:23')).toEqual({
      host: 'host', lus: ['TESTLU01'], prefixes: [], portText: '23',
    });
  });

  it('parses a comma-separated LU list, preserving order', () => {
    // The order is MEANINGFUL -- s3270 tries them in sequence as REJECTs come back --
    // so it must not be sorted or de-duplicated.
    expect(parseHostSpec('LUA,LUB,LUC@host').lus).toEqual(['LUA', 'LUB', 'LUC']);
  });

  it('keeps a duplicated LU rather than collapsing it', () => {
    // Asking for the same resource twice is legal and might succeed the second time,
    // once whatever held it has gone.
    expect(parseHostSpec('LUA,LUA@host').lus).toEqual(['LUA', 'LUA']);
  });

  it('collects prefixes and strips them, case-insensitively', () => {
    expect(parseHostSpec('N:L:host:992')).toEqual({
      host: 'host', lus: [], prefixes: ['N', 'L'], portText: '992',
    });
    expect(parseHostSpec('n:host').prefixes).toEqual(['N']);
  });

  it('does NOT read two letters written together as two prefixes', () => {
    // s3270 requires a colon per prefix and calls `SC:host` a syntax error
    // ("double ':'"). Accepting it here would silently apply prefixes the operator
    // did not get from s3270, and it is also what keeps a one-character hostname
    // from being eaten as a prefix.
    expect(parseHostSpec('SC:host').prefixes).toEqual([]);
    expect(parseHostSpec('SC:host').host).toBe('SC');
    expect(parseHostSpec('SC:host').portText).toBe('host');
  });

  it('does not mistake an IPv6 literal for prefixes', () => {
    // A bracketed literal owns its colons. Getting this wrong turns ::1 into several
    // unknown prefixes and an empty host.
    expect(parseHostSpec('[::1]:3271')).toEqual({
      host: '::1', lus: [], prefixes: [], portText: '3271',
    });
  });

  it('parses an IPv6 literal with no port', () => {
    expect(parseHostSpec('[fe80::1]')).toEqual({
      host: 'fe80::1', lus: [], prefixes: [], portText: undefined,
    });
  });

  it('parses an LU and a prefix alongside an IPv6 literal', () => {
    expect(parseHostSpec('N:LUA@[::1]:992')).toEqual({
      host: '::1', lus: ['LUA'], prefixes: ['N'], portText: '992',
    });
  });

  it('keeps the LU list when a prefix is also present', () => {
    expect(parseHostSpec('N:LUA,LUB@host:23')).toEqual({
      host: 'host', lus: ['LUA', 'LUB'], prefixes: ['N'], portText: '23',
    });
  });

  it('splits on the LAST @, so an LU name cannot swallow the host', () => {
    expect(parseHostSpec('LUA@LUB@host').lus).toEqual(['LUA@LUB']);
    expect(parseHostSpec('LUA@LUB@host').host).toBe('host');
  });

  it('rejects an empty LU in the list rather than requesting a nameless one', () => {
    expect(() => parseHostSpec('LUA,,LUB@host')).toThrow(/empty LU name/i);
  });

  it('rejects an empty host', () => {
    expect(() => parseHostSpec('LUA@')).toThrow(/no host/i);
    expect(() => parseHostSpec(':3271')).toThrow(/no host/i);
  });

  it('rejects an unterminated bracket', () => {
    expect(() => parseHostSpec('[::1:3271')).toThrow(/unterminated/i);
  });
});
