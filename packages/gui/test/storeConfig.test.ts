/**
 * store-probe plan Task 3: the win.target/appx stand-in config and the three MAS entitlements
 * files. Overrides (spec Amendment 2026-11-12) BEAT the plan's original Task 3 text:
 *  - entitlements.mas.inherit.plist carries NO application-groups (variant C crashed with
 *    "GPU process isn't usable", run 43115293433);
 *  - entitlements.mas.loginhelper.plist is app-sandbox ONLY;
 *  - entitlements.mas.plist carries the team-prefixed application-groups entry;
 *  - appx.minVersion is >= 10.0.16299 (the uap5 alias element's documented minimum build).
 *
 * Plists are parsed properly (a tiny reader below), not matched as bare substrings: a comment
 * mentioning a key, or a key commented out, must not pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = fileURLToPath(new URL('..', import.meta.url));

type PlistValue = true | false | string | PlistValue[];

/**
 * A minimal reader for the flat `<dict><key>k</key><true/>...</dict>` entitlements plists this
 * repository writes: good enough to tell a real `<key>...<true/>` pair from a key mentioned only
 * in a `<!-- comment -->`, without pulling in a full plist parser.
 */
function readPlist(text: string): Record<string, PlistValue> {
  // Strip XML comments first, so a key named only in prose never counts as granted.
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  const dict: Record<string, PlistValue> = {};
  const keyRe = /<key>([^<]+)<\/key>\s*(<true\/>|<false\/>|<string>([^<]*)<\/string>|<array>([\s\S]*?)<\/array>)/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    const key = m[1];
    const whole = m[2];
    const str = m[3];
    const arr = m[4];
    if (key === undefined || whole === undefined) continue;
    if (whole === '<true/>') dict[key] = true;
    else if (whole === '<false/>') dict[key] = false;
    else if (str !== undefined) dict[key] = str;
    else if (arr !== undefined) {
      const strings: string[] = [];
      const sRe = /<string>([^<]*)<\/string>/g;
      let sm: RegExpExecArray | null;
      while ((sm = sRe.exec(arr)) !== null) strings.push(sm[1] ?? '');
      dict[key] = strings;
    }
  }
  return dict;
}

function plist(file: string): Record<string, PlistValue> {
  return readPlist(readFileSync(join(gui, 'resources', file), 'utf8'));
}

const cfg = createRequire(import.meta.url)(join(gui, 'electron-builder.cjs')) as {
  win: { target: unknown[] };
  appx: Record<string, unknown>;
};

describe('store stand-in config', () => {
  it('win builds the NSIS exe AND the appx, both x64', () => {
    expect(cfg.win.target).toEqual([{ target: 'nsis', arch: 'x64' }, { target: 'appx', arch: 'x64' }]);
  });

  it('appx identity is the NAMED placeholder until a Store name is reserved (piece 3)', () => {
    expect(cfg.appx).toMatchObject({
      identityName: 'TN3270.Probe',
      publisher: 'CN=TN3270 Store Probe',
      publisherDisplayName: 'TN3270 store probe',
    });
  });

  it('the alias file is absolute (AppxTarget resolves it against the bundle dir) and declares tn3270-gui.exe', () => {
    const p = cfg.appx.customExtensionsPath as string;
    expect(isAbsolute(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toMatch(/Alias="tn3270-gui\.exe"/);
  });

  it('minVersion is set and >= 10.0.16299 (the uap5 alias element needs build 16299+)', () => {
    const v = cfg.appx.minVersion as string;
    const parts = v.split('.').map(Number);
    expect(parts).toHaveLength(4);
    const [, , build] = parts;
    expect(build).toBeGreaterThanOrEqual(16299);
  });

  it.each(['entitlements.mas.plist', 'entitlements.mas.inherit.plist', 'entitlements.mas.loginhelper.plist'])(
    '%s grants app-sandbox',
    (f) => {
      expect(plist(f)['com.apple.security.app-sandbox']).toBe(true);
    },
  );

  it('the main entitlements grant network.client (the Connect check needs it) and no network.server', () => {
    const d = plist('entitlements.mas.plist');
    expect(d['com.apple.security.network.client']).toBe(true);
    expect(d['com.apple.security.network.server']).toBeUndefined();
  });

  it('the main entitlements carry the team-prefixed application-groups entry', () => {
    const d = plist('entitlements.mas.plist');
    expect(d['com.apple.security.application-groups']).toEqual(['H68TN685J4.io.github.athornton.tn3270']);
  });

  it('the inherit entitlements have NO application-groups (variant C crashed with it present)', () => {
    const d = plist('entitlements.mas.inherit.plist');
    expect(d['com.apple.security.application-groups']).toBeUndefined();
    expect(d['com.apple.security.inherit']).toBe(true);
  });

  it('the login-helper entitlements are app-sandbox ONLY', () => {
    const d = plist('entitlements.mas.loginhelper.plist');
    expect(Object.keys(d)).toEqual(['com.apple.security.app-sandbox']);
  });

  it('a key only mentioned in a comment does not count as granted', () => {
    const commentOnly = readPlist(
      '<plist version="1.0"><dict><!-- <key>com.apple.security.application-groups</key><array><string>x</string></array> --></dict></plist>',
    );
    expect(commentOnly['com.apple.security.application-groups']).toBeUndefined();
  });
});
