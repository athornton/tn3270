import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = fileURLToPath(new URL('..', import.meta.url));
type Opts = { mac: Record<string, unknown>; win: Record<string, unknown> };
const { signingOptions, MAC_VARS, WIN_VARS } = createRequire(import.meta.url)(join(gui, 'signing.cjs')) as {
  signingOptions: (env: Record<string, string | undefined>, platform: string, exists?: (p: string) => boolean) => Opts;
  MAC_VARS: string[]; WIN_VARS: string[];
};

const MAC_ENV = {
  TN3270_SIGN: '1', CSC_LINK: 'MIIK...', CSC_KEY_PASSWORD: 'pw',
  APPLE_API_KEY: '/tmp/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID12345', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
};
const WIN_ENV = {
  TN3270_SIGN: '1', AZURE_SIGNING_ENDPOINT: 'https://wus2.codesigning.azure.net/',
  AZURE_SIGNING_ACCOUNT: 'tn3270', AZURE_SIGNING_PROFILE: 'tn3270-public', AZURE_SIGNING_PUBLISHER: 'Adam Thornton',
};
const yes = () => true;

describe('signingOptions', () => {
  it.each(['darwin', 'win32', 'linux'])('is unsigned mode on %s without TN3270_SIGN=1, even with credentials present', (p) => {
    for (const env of [{}, { ...MAC_ENV, ...WIN_ENV, TN3270_SIGN: '' }, { ...MAC_ENV, TN3270_SIGN: 'true' }]) {
      expect(signingOptions(env, p, yes)).toEqual({ mac: { identity: null, notarize: false }, win: {} });
    }
  });

  it('signs and notarizes on darwin: no identity key, no notarize key, forceCodeSigning', () => {
    const o = signingOptions(MAC_ENV, 'darwin', yes);
    expect(o).toEqual({ mac: { forceCodeSigning: true }, win: {} });
    expect('identity' in o.mac).toBe(false); // unset = the CSC_LINK keychain's identity; null would skip
    expect('notarize' in o.mac).toBe(false); // unset = notarize when APPLE_API_* are set
  });

  it('signs on win32 with azureSignOptions from the environment, and leaves mac unsigned', () => {
    expect(signingOptions(WIN_ENV, 'win32', yes)).toEqual({
      mac: { identity: null, notarize: false },
      win: {
        forceCodeSigning: true,
        azureSignOptions: {
          endpoint: 'https://wus2.codesigning.azure.net/', codeSigningAccountName: 'tn3270',
          certificateProfileName: 'tn3270-public', publisherName: 'Adam Thornton',
        },
      },
    });
  });

  it.each([['darwin', MAC_ENV], ['win32', WIN_ENV]] as const)('on %s names EVERY missing variable', (p, env) => {
    const vars = p === 'darwin' ? MAC_VARS : WIN_VARS;
    for (const k of vars) {
      expect(() => signingOptions({ ...env, [k]: '' }, p, yes)).toThrow(new RegExp(`\\b${k}\\b`));
    }
    const none = { TN3270_SIGN: '1' };
    expect(() => signingOptions(none, p, yes)).toThrow(new RegExp(vars.join(', ')));
  });

  it('refuses an APPLE_API_KEY that is not a file (it must be a path to the .p8)', () => {
    expect(() => signingOptions(MAC_ENV, 'darwin', () => false)).toThrow(/APPLE_API_KEY.*\/tmp\/AuthKey\.p8/);
  });

  it('refuses signing mode on a platform with nothing to sign', () => {
    expect(() => signingOptions({ TN3270_SIGN: '1' }, 'linux', yes)).toThrow(/linux/);
  });
});

describe('electron-builder.cjs', () => {
  it('in unsigned mode (no TN3270_SIGN in the test env) has identity null, notarize false, no azureSignOptions', () => {
    expect(process.env.TN3270_SIGN).toBeUndefined();
    const cfg = createRequire(import.meta.url)(join(gui, 'electron-builder.cjs')) as {
      mac: Record<string, unknown>; win: Record<string, unknown>;
    };
    expect(cfg.mac.identity).toBeNull();
    expect(cfg.mac.notarize).toBe(false);
    expect(cfg.mac.forceCodeSigning).toBeUndefined();
    expect(cfg.win.azureSignOptions).toBeUndefined();
    expect(cfg.win.forceCodeSigning).toBeUndefined();
    // appx x64 (store-probe plan Task 3) added alongside nsis; see storeConfig.test.ts.
    expect(cfg.win.target).toEqual([{ target: 'nsis', arch: 'x64' }, { target: 'appx', arch: 'x64' }]); // the spread kept the rest
  });

  it('spreads signingOptions into mac and win rather than retyping either', () => {
    const src = readFileSync(join(gui, 'electron-builder.cjs'), 'utf8');
    expect(src).toMatch(/require\('\.\/signing\.cjs'\)\.signingOptions\(process\.env, process\.platform\)/);
    expect(src).toMatch(/\.\.\.signing\.mac\b/);
    expect(src).toMatch(/\.\.\.signing\.win\b/);
    expect(src).not.toMatch(/identity:\s*null/);
  });
});
