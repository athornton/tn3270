import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseCodesignDisplay, judgeMacApp, parseAuthenticode, judgeWinFile, type Ran,
} from '../../../scripts/verify-signatures.mjs';

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/signatures/${n}`, import.meta.url)), 'utf8');
const ok = (text = ''): Ran => ({ status: 0, text });
const no = (text = ''): Ran => ({ status: 1, text });
const SIGNED_MAC = () => ({
  verify: ok(), display: ok(fx('codesign-dv-signed.txt')), spctl: ok(fx('spctl-notarized.txt')), stapler: ok('The validate action worked!'),
});
const UNSIGNED_MAC = () => ({
  verify: no('code has no resources but signature indicates they must be present'),
  display: ok(fx('codesign-dv-adhoc.txt')), spctl: no(fx('spctl-rejected.txt')), stapler: no('does not have a ticket stapled to it'),
});

describe('parseCodesignDisplay (provisional fixtures)', () => {
  it('reads the authority chain, team and runtime flag of a Developer ID signature', () => {
    expect(parseCodesignDisplay(fx('codesign-dv-signed.txt'))).toEqual({
      authorities: ['Developer ID Application: Adam Thornton (ABCDE12345)', 'Developer ID Certification Authority', 'Apple Root CA'],
      teamId: 'ABCDE12345', runtime: true, adhoc: false,
    });
  });
  it('reads an ad-hoc signature as no authorities, no team, adhoc', () => {
    expect(parseCodesignDisplay(fx('codesign-dv-adhoc.txt'))).toEqual({ authorities: [], teamId: undefined, runtime: false, adhoc: true });
  });
});

describe('judgeMacApp (provisional fixtures)', () => {
  it('passes a signed, notarized, stapled app with --expect signed', () => {
    expect(judgeMacApp(SIGNED_MAC(), 'signed', 'ABCDE12345')).toEqual([]);
  });
  it.each([
    ['verify', { verify: no('a sealed resource is missing or invalid') }, /codesign --verify/],
    ['team', {}, /team ZZZZZ99999/],
    ['runtime', { display: ok(fx('codesign-dv-signed.txt').replace('(runtime)', '(none)')) }, /hardened runtime/],
    ['spctl', { spctl: no(fx('spctl-rejected.txt')) }, /spctl/],
    ['notarized source', { spctl: ok(fx('spctl-notarized.txt').replace('Notarized ', '')) }, /Notarized Developer ID/],
    ['stapler', { stapler: no('does not have a ticket stapled to it') }, /stapler/],
  ])('fails --expect signed on a bad %s', (_n, patch, msg) => {
    const team = _n === 'team' ? 'ZZZZZ99999' : 'ABCDE12345';
    const problems = judgeMacApp({ ...SIGNED_MAC(), ...patch }, 'signed', team);
    expect(problems.join('\n')).toMatch(msg);
  });
  it('passes an ad-hoc app with --expect unsigned, and fails a Developer ID one', () => {
    expect(judgeMacApp(UNSIGNED_MAC(), 'unsigned', undefined)).toEqual([]);
    expect(judgeMacApp(SIGNED_MAC(), 'unsigned', undefined).join('\n')).toMatch(/Developer ID Application: Adam Thornton/);
  });
  it('refuses --expect signed without a team to check against', () => {
    expect(judgeMacApp(SIGNED_MAC(), 'signed', undefined).join('\n')).toMatch(/APPLE_TEAM_ID/);
  });
});

describe('parseAuthenticode / judgeWinFile (provisional fixtures)', () => {
  it('parses status and subject', () => {
    expect(parseAuthenticode(fx('authenticode-valid.json'))).toEqual({
      status: 'Valid', subject: 'CN=Adam Thornton, O=Adam Thornton, L=Somewhere, S=Arizona, C=US',
    });
  });
  it('signed: Valid AND CN equal to the publisher; a CN that merely contains it is refused', () => {
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', 'Adam Thornton')).toEqual([]);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', 'Adam').join('\n')).toMatch(/expected CN=Adam$/m);
    expect(judgeWinFile({ status: 'HashMismatch', subject: 'CN=Adam Thornton' }, 'signed', 'Adam Thornton').join('\n')).toMatch(/HashMismatch/);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', undefined).join('\n')).toMatch(/AZURE_SIGNING_PUBLISHER/);
  });
  it('unsigned: anything but Valid passes; Valid fails', () => {
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-notsigned.json')), 'unsigned', undefined)).toEqual([]);
    expect(judgeWinFile({ status: 'HashMismatch', subject: '' }, 'unsigned', undefined)).toEqual([]);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'unsigned', undefined).join('\n')).toMatch(/Valid/);
  });
  it('refuses output that is not the projection', () => {
    expect(() => parseAuthenticode('Get-AuthenticodeSignature: not found')).toThrow(/not an Authenticode projection/);
    expect(() => parseAuthenticode('{"Status":"Valid"}')).toThrow(/not an Authenticode projection/);
  });
});
