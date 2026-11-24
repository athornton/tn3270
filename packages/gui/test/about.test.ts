import { describe, it, expect } from 'vitest';
import type { ConnectionInfo } from '@tn3270/core';
import { aboutText, type AboutConfig } from '../src/about.js';

const config: AboutConfig = {
  model: '3278-2-E', colorMode: '3279 color', codePage: { name: 'bracket', cgcsgid: 37 },
  font: '3270 font (built in)', scheme: 'default', keymap: 'built in',
};
const on: ConnectionInfo = {
  connected: true, host: 'vm.example', port: 3270, lu: 'LU01', tn3270e: true,
  terminalType: 'IBM-3278-2-E', since: new Date('2026-11-24T21:00:00Z'),
  bytesIn: 1234, bytesOut: 56, recordsIn: 7,
};

describe('aboutText', () => {
  const t = aboutText('tn3270-gui 0.1.4', config, on, 'on (certificate verified)');
  it('starts with the version block', () => { expect(t.startsWith('tn3270-gui 0.1.4\n')).toBe(true); });
  it('has the configuration, with the code page and its CGCSGID', () => {
    expect(t).toContain('Configuration');
    expect(t).toContain('Code page: bracket (CGCSGID 37)');
    expect(t).toContain('Terminal type: IBM-3278-2-E');
  });
  it('has the connection: host, port, LU, TLS, TN3270E and the counters', () => {
    for (const s of ['Host: vm.example:3270', 'LU: LU01', 'TLS: on (certificate verified)', 'TN3270E: yes',
      'Connected since: 2026-11-24T21:00:00.000Z', 'Bytes in/out: 1234 / 56', 'Host records: 7']) {
      expect(t).toContain(s);
    }
  });
  it('disconnected: says so, and shows no counters', () => {
    const d = aboutText('v', config, { ...on, connected: false }, 'off');
    expect(d).toContain('not connected');
    expect(d).not.toContain('Bytes in/out');
    expect(d).not.toContain('LU01');
  });
});
