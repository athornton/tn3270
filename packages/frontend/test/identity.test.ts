import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { infoFlag, versionText, windowTitle, COPYRIGHT } from '../src/identity.js';

describe('infoFlag', () => {
  it.each([['--help', 'help'], ['-?', 'help'], ['--version', 'version'], ['-v', 'version']])(
    'a lone %s is %s', (a, want) => { expect(infoFlag([a])).toBe(want); });
  it('mixed with anything else, it is not an info flag (x3270.c:497-506)', () => {
    expect(infoFlag(['--help', 'vm'])).toBeUndefined();
    expect(infoFlag(['vm', '--version'])).toBeUndefined();
    expect(infoFlag([])).toBeUndefined();
  });
});

describe('versionText', () => {
  const t = versionText('cli', { node: 'v22.1.0', openssl: '3.0.13' });
  it('names the front end and version first', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string };
    expect(t.split('\n')[0]).toBe(`tn3270-cli ${pkg.version}`);
  });
  it('lists the code pages from core, default first', () => {
    expect(t).toContain('Code pages: bracket (default), cp037');
  });
  it('has Node and TLS, and Electron only when given', () => {
    expect(t).toContain('Node v22.1.0');
    expect(t).toContain('TLS: OpenSSL 3.0.13');
    expect(t).not.toContain('Electron');
    expect(versionText('gui', { node: 'v22.1.0', openssl: '3', electron: '44.3.0' }))
      .toContain('Electron v44.3.0');
  });
  it('ends with the copyright and licence', () => {
    expect(t.split('\n').at(-1)).toBe(COPYRIGHT);
  });
  it('the copyright line matches LICENSE', () => {
    const lic = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'LICENSE'), 'utf8');
    expect(COPYRIGHT.startsWith(lic.split('\n')[2]!)).toBe(true);
    expect(lic.split('\n')[0]).toBe('MIT License');
  });
});

describe('windowTitle', () => {
  it('connected: host first', () => {
    expect(windowTitle({ connected: true, host: 'vm.example', port: 3270, lu: undefined, terminalType: 'IBM-3278-2-E' }))
      .toBe('vm.example:3270 — TN3270 3278-2-E');
  });
  it('with an LU', () => {
    expect(windowTitle({ connected: true, host: 'h', port: 23, lu: 'LU01', terminalType: 'IBM-3279-4-E' }))
      .toBe('h:23 [LU01] — TN3270 3279-4-E');
  });
  it('no terminal type: no model', () => {
    expect(windowTitle({ connected: true, host: 'h', port: 23, lu: undefined, terminalType: undefined }))
      .toBe('h:23 — TN3270');
  });
  it('not connected', () => {
    expect(windowTitle({ connected: false, host: 'h', port: 23, lu: undefined, terminalType: undefined }))
      .toBe('TN3270 — not connected');
  });
});
