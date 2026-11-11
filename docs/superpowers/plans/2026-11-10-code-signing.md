# Code Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag and signing-dispatch runs ship a signed, notarized, stapled macOS app and a signed
Windows installer and app. Every other build stays unsigned, and a verifier proves which kind each
build is on every run.

**Architecture:** A pure `signingOptions(env, platform)` in `packages/gui/signing.cjs` decides
between unsigned mode (today's config) and signing mode (env-supplied credentials,
`forceCodeSigning`). `electron-builder.cjs` spreads the result in. CI turns on `TN3270_SIGN=1`, the
`signing` environment and the credentials only on `v*` tags or a dispatch with `sign: true`.
`scripts/verify-signatures.mjs --expect signed|unsigned` checks the finished artifacts on the mac
and Windows jobs on every run.

**Tech Stack:** electron-builder 26.18.0 (built-in osx-sign + @electron/notarize, Azure
`TrustedSigning` PowerShell module), GitHub Actions, `azure/login` v3.1.0, vitest, plain Node ESM
scripts (no dependencies).

**Spec:** `docs/superpowers/specs/2026-11-10-code-signing-design.md`. **Branch:** `signing` (cut
from `origin/main` at `d2d9486`).

**THE SOURCE BEATS THIS PLAN.** The code below is a draft. Before each task, re-read the files it
touches, and where they disagree with this text, follow the repository and record the
difference in the task's commit message. Run every shell step as one command with a timeout. Do
not chain long compound commands.

## Facts already measured in `node_modules/app-builder-lib/out` (26.18.0)

- `mac/MacTargetHelper.js` `getNotarizeOptions`: notarization runs only if `APPLE_API_KEY` (a
  file PATH), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are all set. With none set it is skipped
  silently; a partial set throws.
- `macPackager.js` `sign()`: `identity === null` → `handleNullIdentity()`, which throws if
  `forceCodeSigning` is set, otherwise logs "skipped". `notarizeIfProvided(appPath)` runs right
  after `doSign`, on the `.app`, before the dmg and zip targets are built.
- `codeSign/macCodeSign.js` `findIdentity`: with no `identity`/`CSC_NAME` **and**
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, it returns null: **unsigned, silently** (unless
  `forceCodeSigning` is set). So signing mode must set `CSC_IDENTITY_AUTO_DISCOVERY=true`.
- `winPackager.js:129`: an unsigned file with `forceCodeSigning` throws.
- `codeSign/windowsSignAzureManager.js`: `Install-Module TrustedSigning`, then
  `Invoke-TrustedSigning -Endpoint -CertificateProfileName -CodeSigningAccountName
  -TimestampRfc3161 -TimestampDigest -FileDigest -Files` for each file.
- `dmg.sign` defaults to `false`; the dmg stays unsigned.

## File structure

| File | Responsibility |
|---|---|
| `packages/gui/signing.cjs` (new) | `signingOptions(env, platform, exists)`: mode decision, missing-variable errors, the mac/win fragments |
| `packages/gui/electron-builder.cjs` (modify) | spread `signingOptions(process.env, process.platform)` into `mac` and `win` |
| `packages/gui/test/signing.test.ts` (new) | unit tests for `signing.cjs`, plus the loaded config in unsigned mode |
| `scripts/verify-signatures.mjs` (new) | parsers, judges, mac/win drivers, `main(argv, io)` |
| `scripts/verify-signatures.d.mts` (new) | types, so the tests are typechecked (the `release-notes.d.mts` pattern) |
| `packages/core/test/verifySignatures.test.ts` (new) | parser/judge/main tests (the root-script tests live in core/test, as releaseNotes.test.ts does) |
| `packages/core/test/fixtures/signatures/` (new) | captured `codesign`/`spctl`/Authenticode output |
| `.github/workflows/package.yml` (modify) | `sign` matrix flag, dispatch input, environment, credential steps, verify step |
| `packages/core/test/workflow.test.ts` (modify) | pin the signing wiring |
| `docs/releasing.md`, `README.md`, `docs/HANDOFF.md`, `changelog.d/<new>.md` | docs |

## The one expression

Several workflow lines need "this run signs". Here is the text, used **verbatim** everywhere
(workflow.test.ts pins that every occurrence is identical):

```
matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign))
```

The verify step deliberately does **not** use it. Its mode depends on the ref and the dispatch
input alone (Task 5), so a broken `matrix.sign` cannot turn a tag run's check into
`--expect unsigned`.

---

### Task 1: `signingOptions` in `packages/gui/signing.cjs`

**Files:**
- Create: `packages/gui/signing.cjs`
- Test: `packages/gui/test/signing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
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
```

- [ ] **Step 2: Run it and check that it fails**

Run: `npx vitest run packages/gui/test/signing.test.ts`
Expected: FAIL, `Cannot find module '.../packages/gui/signing.cjs'`.

- [ ] **Step 3: Write `packages/gui/signing.cjs`**

```js
'use strict';
/**
 * Signing mode for electron-builder.cjs (code signing spec, 2026-11-10, section 1).
 *
 * `TN3270_SIGN=1` -- exactly that -- is signing mode; anything else is the unsigned config every
 * local build and every non-release CI run uses. In signing mode every credential electron-builder
 * would otherwise skip over SILENTLY is required here, by name, before the build starts:
 *  - notarization is skipped with no error when APPLE_API_KEY/_ID/ISSUER are all absent
 *    (app-builder-lib 26.18.0 mac/MacTargetHelper.js getNotarizeOptions);
 *  - with no identity and CSC_IDENTITY_AUTO_DISCOVERY=false the app is left unsigned with no error
 *    (codeSign/macCodeSign.js findIdentity). `forceCodeSigning` turns that, and its Windows
 *    equivalent (winPackager.js), into a failure.
 */
const fs = require('node:fs');

const MAC_VARS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const WIN_VARS = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'AZURE_SIGNING_PUBLISHER'];

// `identity: null` skips mac signing outright (scheme.json); `notarize: false` keeps a stray
// APPLE_* variable from starting notarization of an unsigned app.
const UNSIGNED_MAC = { identity: null, notarize: false };

function signingOptions(env, platform, exists = fs.existsSync) {
  if (env.TN3270_SIGN !== '1') return { mac: { ...UNSIGNED_MAC }, win: {} };
  const vars = platform === 'darwin' ? MAC_VARS : platform === 'win32' ? WIN_VARS : null;
  if (vars === null) throw new Error(`TN3270_SIGN=1 on ${platform}: only macOS and Windows builds are signed`);
  const missing = vars.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`TN3270_SIGN=1 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`);
  }
  if (platform === 'darwin') {
    if (!exists(env.APPLE_API_KEY)) {
      throw new Error(`APPLE_API_KEY must be the path to the .p8 key file; ${env.APPLE_API_KEY} does not exist`);
    }
    return { mac: { forceCodeSigning: true }, win: {} };
  }
  return {
    mac: { ...UNSIGNED_MAC },
    win: {
      forceCodeSigning: true,
      azureSignOptions: {
        endpoint: env.AZURE_SIGNING_ENDPOINT,
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
        certificateProfileName: env.AZURE_SIGNING_PROFILE,
        publisherName: env.AZURE_SIGNING_PUBLISHER,
      },
    },
  };
}

module.exports = { signingOptions, MAC_VARS, WIN_VARS };
```

- [ ] **Step 4: Run it and check that it passes**

Run: `npx vitest run packages/gui/test/signing.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Mutation check (record the results in the commit message)**

Change these one at a time, run the test file after each, and revert:
- `!== '1'` → `!env.TN3270_SIGN`. The unsigned-mode test should fail on `'true'`.
- `missing.join(', ')` → `missing[0]`. The every-missing test should fail.
- Delete the `exists` check. The `.p8` test should fail.

Each must FAIL. If one passes, the test it targets checks nothing; fix the test.

- [ ] **Step 6: Commit**

```bash
git add packages/gui/signing.cjs packages/gui/test/signing.test.ts
git commit -m "gui: signingOptions -- unsigned by default, signing mode names every missing credential"
```

### Task 2: wire it into `electron-builder.cjs`

**Files:**
- Modify: `packages/gui/electron-builder.cjs` (the header comment at line 3, `mac.identity` at
  lines 76-80, `win` at about line 123)
- Test: `packages/gui/test/signing.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `signing.test.ts`)

```ts
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
    expect(cfg.win.target).toEqual([{ target: 'nsis', arch: 'x64' }]); // the spread kept the rest
  });

  it('spreads signingOptions into mac and win rather than retyping either', () => {
    const src = readFileSync(join(gui, 'electron-builder.cjs'), 'utf8');
    expect(src).toMatch(/require\('\.\/signing\.cjs'\)\.signingOptions\(process\.env, process\.platform\)/);
    expect(src).toMatch(/\.\.\.signing\.mac\b/);
    expect(src).toMatch(/\.\.\.signing\.win\b/);
    expect(src).not.toMatch(/identity:\s*null/);
  });
});
```

Add `import { readFileSync } from 'node:fs';` to the imports.

- [ ] **Step 2: Run it and check that it fails**

Run: `npx vitest run packages/gui/test/signing.test.ts`
Expected: FAIL. `notarize` is undefined, and the source does not mention `signing.cjs`.

- [ ] **Step 3: Edit `electron-builder.cjs`**

- Header line 3: replace `Unsigned this milestone.` with
  `Unsigned unless TN3270_SIGN=1 (signing.cjs; code signing spec 2026-11-10).`
- Before `module.exports`, add:

```js
// Signing mode or not, decided once from the environment (signing.cjs explains both modes).
// process.platform, not a target flag: each OS is built (and signed) on its own runner.
const signing = require('./signing.cjs').signingOptions(process.env, process.platform);
```

- In `mac`, replace the `identity: null` line and its 4-line comment with:

```js
    // identity/notarize/forceCodeSigning come from signing.cjs: unsigned mode skips signing with a
    // null identity and turns notarization off; signing mode leaves identity to the CSC_LINK keychain.
    ...signing.mac,
```

- Replace `win: { target: [{ target: 'nsis', arch: 'x64' }] },` with:

```js
  win: {
    target: [{ target: 'nsis', arch: 'x64' }],
    // Signing mode only: azureSignOptions (Azure Artifact Signing) and forceCodeSigning. Present at
    // all, azureSignOptions signs every Windows build, which is why it lives behind the switch.
    ...signing.win,
  },
```

- [ ] **Step 4: Run the gui tests and check that they pass**

Run: `npx vitest run packages/gui/test/signing.test.ts packages/gui/test/icon.test.ts`
Expected: PASS.

- [ ] **Step 5: Check that an unsigned local package still builds**

Run: `npm run build && npm run package:gui -- --linux --x64` (timeout 15 min)
Expected: exit 0, AppImage and deb in `artifacts/gui/`, with no error from signing.cjs.
Then run `TN3270_SIGN=1 npm run package:gui -- --linux --x64`.
Expected: it fails with `TN3270_SIGN=1 on linux: only macOS and Windows builds are signed`.

- [ ] **Step 6: Commit**

```bash
git add packages/gui/electron-builder.cjs packages/gui/test/signing.test.ts
git commit -m "gui: electron-builder.cjs takes its signing keys from signing.cjs"
```

### Task 3: verifier parsers and judges (pure)

**Files:**
- Create: `scripts/verify-signatures.mjs` (pure part)
- Create: `scripts/verify-signatures.d.mts`
- Create: `packages/core/test/fixtures/signatures/{codesign-dv-signed.txt,codesign-dv-adhoc.txt,spctl-notarized.txt,spctl-rejected.txt,authenticode-valid.json,authenticode-notsigned.json}`
- Test: `packages/core/test/verifySignatures.test.ts`

The fixtures start out **hand-written in the documented formats** below. Task 8 replaces each one
with output captured from real CI runs. Until then, each fixture's first line is a comment marking
it as provisional: `# PROVISIONAL: hand-written; replace with a capture (plan Task 8)`. The parsers
skip lines that start with `#`.

- [ ] **Step 1: Write the fixtures**

`codesign-dv-signed.txt` (`codesign -dv --verbose=4` writes this to **stderr**):
```
# PROVISIONAL: hand-written; replace with a capture (plan Task 8)
Executable=/private/tmp/x/TN3270.app/Contents/MacOS/TN3270
Identifier=io.github.athornton.tn3270
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Adam Thornton (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=10 Nov 2026 at 12:00:00
Notarization Ticket=stapled
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=40
Internal requirements count=1 size=200
```
`codesign-dv-adhoc.txt`:
```
# PROVISIONAL: hand-written; replace with a capture (plan Task 8)
Executable=/private/tmp/x/TN3270.app/Contents/MacOS/TN3270
Identifier=io.github.athornton.tn3270
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=28+0 location=embedded
Signature=adhoc
Info.plist entries=30
TeamIdentifier=not set
Sealed Resources=none
```
`spctl-notarized.txt`:
```
# PROVISIONAL: hand-written; replace with a capture (plan Task 8)
/private/tmp/x/TN3270.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Adam Thornton (ABCDE12345)
```
`spctl-rejected.txt`:
```
# PROVISIONAL: hand-written; replace with a capture (plan Task 8)
/private/tmp/x/TN3270.app: rejected
```
`authenticode-valid.json` (the verifier's own `pwsh` projection, Task 4):
```
{"Status":"Valid","Subject":"CN=Adam Thornton, O=Adam Thornton, L=Somewhere, S=Arizona, C=US"}
```
`authenticode-notsigned.json`:
```
{"Status":"NotSigned","Subject":""}
```
(JSON has no comments. In Task 8 the two `.json` files are replaced by captures, and the test
names say "provisional" until then.)

- [ ] **Step 2: Write the failing test**

```ts
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

describe('parseCodesignDisplay', () => {
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

describe('judgeMacApp', () => {
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
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', 'Adam').join('\n')).toMatch(/CN=Adam\b/);
    expect(judgeWinFile({ status: 'HashMismatch', subject: 'CN=Adam Thornton' }, 'signed', 'Adam Thornton').join('\n')).toMatch(/HashMismatch/);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'signed', undefined).join('\n')).toMatch(/AZURE_SIGNING_PUBLISHER/);
  });
  it('unsigned: anything but Valid passes; Valid fails', () => {
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-notsigned.json')), 'unsigned', undefined)).toEqual([]);
    expect(judgeWinFile({ status: 'HashMismatch', subject: '' }, 'unsigned', undefined)).toEqual([]);
    expect(judgeWinFile(parseAuthenticode(fx('authenticode-valid.json')), 'unsigned', undefined).join('\n')).toMatch(/Valid/);
  });
  it('refuses output that is not the projection', () => {
    expect(() => parseAuthenticode('Get-AuthenticodeSignature: not found')).toThrow(/Authenticode/);
  });
});
```

- [ ] **Step 3: Run it and check that it fails**

Run: `npx vitest run packages/core/test/verifySignatures.test.ts`
Expected: FAIL, because the module `scripts/verify-signatures.mjs` does not exist.

- [ ] **Step 4: Write the pure part of `scripts/verify-signatures.mjs`**

```js
#!/usr/bin/env node
/**
 * Fail-closed signature check of the finished GUI installers (code signing spec, section 3).
 *
 *     node scripts/verify-signatures.mjs --expect signed|unsigned [artifacts/gui]
 *
 * `signed` needs APPLE_TEAM_ID (macOS) or AZURE_SIGNING_PUBLISHER (Windows). `unsigned` runs on
 * every non-release push, so the checks are shown to REJECT an unsigned build continuously.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_ID = 'Developer ID Application:';

/** Non-comment lines; fixtures mark themselves provisional with a leading `#`. */
const lines = (text) => text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'));

/** `codesign -dv --verbose=4` (stderr) -> what judgeMacApp needs. */
export function parseCodesignDisplay(text) {
  const ls = lines(text);
  const authorities = ls.filter((l) => l.startsWith('Authority=')).map((l) => l.slice('Authority='.length));
  const team = ls.find((l) => l.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length);
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(ls.find((l) => l.startsWith('CodeDirectory')) ?? '')?.[1]?.split(',') ?? [];
  return {
    authorities,
    teamId: team === undefined || team === 'not set' ? undefined : team,
    runtime: flags.includes('runtime'),
    adhoc: flags.includes('adhoc') || ls.includes('Signature=adhoc'),
  };
}

/** One .app's four command results -> problems (empty = as expected). */
export function judgeMacApp(r, expect, teamId) {
  const d = parseCodesignDisplay(r.display.text);
  const leaf = d.authorities[0];
  if (expect === 'unsigned') {
    return leaf?.startsWith(DEV_ID) ? [`signed by ${leaf}; expected unsigned`] : [];
  }
  const p = [];
  if (teamId === undefined || teamId === '') p.push('APPLE_TEAM_ID is not set; nothing to check the signature against');
  if (r.verify.status !== 0) p.push(`codesign --verify --deep --strict failed: ${r.verify.text.trim()}`);
  if (!leaf?.startsWith(DEV_ID)) p.push(`leaf authority is ${leaf ?? '(none)'}, not ${DEV_ID}`);
  else if (teamId && (d.teamId !== teamId || !leaf.endsWith(`(${teamId})`))) p.push(`signed by ${leaf}, team ${d.teamId}; expected team ${teamId}`);
  if (!d.runtime) p.push('no hardened runtime flag (notarization requires it)');
  if (r.spctl.status !== 0) p.push(`spctl rejected it: ${r.spctl.text.trim()}`);
  else if (!lines(r.spctl.text).includes('source=Notarized Developer ID')) p.push(`spctl source is not Notarized Developer ID: ${r.spctl.text.trim()}`);
  if (r.stapler.status !== 0) p.push(`xcrun stapler validate failed: ${r.stapler.text.trim()}`);
  return p;
}

/** The verifier's own pwsh projection, `{"Status":..,"Subject":..}`. */
export function parseAuthenticode(text) {
  let o;
  try { o = JSON.parse(text.trim()); } catch { o = undefined; }
  if (typeof o?.Status !== 'string' || typeof o?.Subject !== 'string') {
    throw new Error(`not an Authenticode projection: ${text.trim().slice(0, 200)}`);
  }
  return { status: o.Status, subject: o.Subject };
}

/** One file's signature -> problems. The CN must EQUAL the publisher, not contain it. */
export function judgeWinFile(sig, expect, publisher) {
  if (expect === 'unsigned') return sig.status === 'Valid' ? [`has a Valid signature (${sig.subject}); expected unsigned`] : [];
  const p = [];
  if (publisher === undefined || publisher === '') p.push('AZURE_SIGNING_PUBLISHER is not set; nothing to check the signer against');
  if (sig.status !== 'Valid') p.push(`signature status ${sig.status}, not Valid`);
  const cn = sig.subject.split(/,\s*/).find((part) => part.startsWith('CN='));
  if (publisher && cn !== `CN=${publisher}`) p.push(`signer ${cn ?? '(no CN)'}; expected CN=${publisher}`);
  return p;
}
```

Write `scripts/verify-signatures.d.mts`:

```ts
/** Types for `verify-signatures.mjs`, so the tests that import it are typechecked too. */
export type Expect = 'signed' | 'unsigned';
/** A command's exit status and its stdout+stderr together (codesign and spctl report on stderr). */
export interface Ran { status: number; text: string }
export function parseCodesignDisplay(text: string): { authorities: string[]; teamId: string | undefined; runtime: boolean; adhoc: boolean };
export function judgeMacApp(r: { verify: Ran; display: Ran; spctl: Ran; stapler: Ran }, expect: Expect, teamId: string | undefined): string[];
export function parseAuthenticode(text: string): { status: string; subject: string };
export function judgeWinFile(sig: { status: string; subject: string }, expect: Expect, publisher: string | undefined): string[];
export type Run = (cmd: string, args: string[], opts?: { verbatim?: boolean }) => Ran;
export function main(argv: string[], io: {
  env: Record<string, string | undefined>; run: Run; log: (line: string) => void; platform: string;
  /** Lists a directory; injectable so main() is testable without artifacts. */
  list?: (dir: string) => string[];
  /** Makes a scratch directory; injectable for the same reason. */
  scratch?: () => string;
  /** existsSync, injectable for the installed-file check on Windows. */
  exists?: (path: string) => boolean;
}): number;
export const runCommand: Run;
```

- [ ] **Step 5: Run it and check that it passes**

Run: `npx vitest run packages/core/test/verifySignatures.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation check (record in the commit)**

One at a time, run the tests, then revert each:
- In `judgeWinFile`, `cn !== \`CN=${publisher}\`` → `!sig.subject.includes(publisher)`. The `'Adam'` case should fail.
- In `judgeMacApp` unsigned mode, `return []`. The Developer-ID-in-unsigned case should fail.
- Drop the `source=Notarized` check. The notarized-source case should fail.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-signatures.mjs scripts/verify-signatures.d.mts packages/core/test/verifySignatures.test.ts packages/core/test/fixtures/signatures
git commit -m "scripts: verify-signatures parsers and judges (provisional fixtures)"
```

### Task 4: verifier drivers and `main`

**Files:**
- Modify: `scripts/verify-signatures.mjs` (append)
- Test: `packages/core/test/verifySignatures.test.ts` (append)

How it works:
- **macOS:** find exactly one `TN3270-*-mac-universal.zip` and one `.dmg`. Unpack the zip with
  `ditto -x -k <zip> <scratch>/zip` (package-smoke uses the same tool, which keeps symlinks). Mount
  the dmg with `hdiutil attach -readonly -nobrowse -mountpoint <scratch>/dmg <dmg>`, and always run
  `hdiutil detach <scratch>/dmg` in a `finally`. For each `TN3270.app`, run:
  `codesign --verify --deep --strict --verbose=2 <app>`, `codesign -dv --verbose=4 <app>`,
  `spctl -a -t exec -vv <app>` and `xcrun stapler validate <app>`.
- **Windows:** find exactly one `TN3270-*-win-x64.exe` and check its signature. Then
  **silent-install** it with `/S /D=<scratch>\install` (verbatim arguments, exactly like
  `scripts/package-smoke.mjs` lines 366-371; read them first). Check
  `<dir>\TN3270.exe` and `<dir>\Uninstall TN3270.exe`, then uninstall with
  `"Uninstall TN3270.exe" /S`, best effort. This replaces the spec's "extract app-64.7z with 7zz",
  because 7zip-bin is not a dependency here and the installed files are what users actually run.
  **Record this difference in the commit message.**
  The signature command is
  `pwsh -NoProfile -NonInteractive -Command "Get-AuthenticodeSignature -LiteralPath '<p>' | Select-Object @{n='Status';e={$_.Status.ToString()}}, @{n='Subject';e={if ($_.SignerCertificate) { $_.SignerCertificate.Subject } else { '' }}} | ConvertTo-Json -Compress"`,
  where `<p>` has every `'` doubled.
- **Exit codes:** 0 when every problem list is empty. 1 when there are problems (each printed as
  `FAIL <artifact>: <problem>`). 2 for usage errors: a bad or missing `--expect`, an unsupported
  platform, or a missing or duplicate artifact. Each passing artifact prints `ok <artifact>: <mode>`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { main } from '../../../scripts/verify-signatures.mjs';

/** A fake `run` that answers by command name and records every call. */
function fakeRun(answers: Record<string, Ran | ((args: string[]) => Ran)>) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const key = cmd === 'codesign' ? `codesign ${args[0]}` : cmd === 'xcrun' ? 'stapler' : cmd.endsWith('.exe') ? 'exe' : cmd;
    const a = answers[key];
    if (a === undefined) return ok();
    return typeof a === 'function' ? a(args) : a;
  };
  return { run, calls };
}
const MAC_FILES = ['TN3270-0.1.5-mac-universal.dmg', 'TN3270-0.1.5-mac-universal.zip', 'TN3270-0.1.5-mac-universal.dmg.blockmap'];

describe('main', () => {
  const base = (over: Partial<Parameters<typeof main>[1]> = {}) => {
    const out: string[] = [];
    return { out, io: { env: {}, run: fakeRun({}).run, log: (l: string) => out.push(l), platform: 'darwin', list: () => MAC_FILES, scratch: () => '/scratch', ...over } };
  };

  it('is a usage error without --expect signed|unsigned, and on linux', () => {
    expect(main([], base().io)).toBe(2);
    expect(main(['--expect', 'maybe'], base().io)).toBe(2);
    expect(main(['--expect', 'unsigned'], base({ platform: 'linux' }).io)).toBe(2);
  });

  it('macOS signed: checks the app in BOTH the zip and the dmg, and always detaches', () => {
    const f = fakeRun({
      'codesign -dv': ok(fx('codesign-dv-signed.txt')), spctl: ok(fx('spctl-notarized.txt')),
    });
    const { io, out } = base({ run: f.run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(main(['--expect', 'signed', '/a'], io)).toBe(0);
    const apps = f.calls.filter((c) => c[0] === 'codesign' && c[1] === '--verify').map((c) => c.at(-1));
    expect(apps).toEqual(['/scratch/zip/TN3270.app', '/scratch/dmg/TN3270.app']);
    expect(f.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toBe(true);
    expect(out.filter((l) => l.startsWith('ok '))).toHaveLength(2);
  });

  it('macOS: detaches the dmg even when a check throws', () => {
    const f = fakeRun({ spctl: () => { throw new Error('boom'); } });
    const { io } = base({ run: f.run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(() => main(['--expect', 'signed', '/a'], io)).toThrow(/boom/);
    expect(f.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toBe(true);
  });

  it('macOS unsigned: an ad-hoc build passes; the same build with --expect signed fails (exit 1)', () => {
    const answers = { 'codesign -dv': ok(fx('codesign-dv-adhoc.txt')), spctl: no(fx('spctl-rejected.txt')), 'codesign --verify': no('invalid'), stapler: no('no ticket') };
    expect(main(['--expect', 'unsigned', '/a'], base({ run: fakeRun(answers).run }).io)).toBe(0);
    const { io, out } = base({ run: fakeRun(answers).run, env: { APPLE_TEAM_ID: 'ABCDE12345' } });
    expect(main(['--expect', 'signed', '/a'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/FAIL TN3270-0\.1\.5-mac-universal\.zip:/);
  });

  it('a missing or duplicated artifact is exit 2, naming what IS there', () => {
    const { io, out } = base({ list: () => ['TN3270-0.1.5-mac-universal.dmg'] });
    expect(main(['--expect', 'unsigned', '/a'], io)).toBe(2);
    expect(out.join('\n')).toMatch(/mac-universal\.zip.*TN3270-0\.1\.5-mac-universal\.dmg/s);
  });

  it('Windows signed: checks the installer, then the installed app and uninstaller', () => {
    const valid = ok(fx('authenticode-valid.json'));
    const f = fakeRun({ pwsh: valid });
    const { io } = base({ platform: 'win32', run: f.run, list: () => ['TN3270-0.1.5-win-x64.exe'], env: { AZURE_SIGNING_PUBLISHER: 'Adam Thornton' } });
    expect(main(['--expect', 'signed', 'C:\\a'], io)).toBe(0);
    const checked = f.calls.filter((c) => c[0] === 'pwsh').map((c) => /LiteralPath '([^']*(?:''[^']*)*)'/.exec(c.at(-1)!)?.[1]);
    expect(checked.map((p) => p!.split(/[\\/]/).at(-1))).toEqual(['TN3270-0.1.5-win-x64.exe', 'TN3270.exe', 'Uninstall TN3270.exe']);
  });
});
```

The installed-file check goes through `io.exists` (default `existsSync`), mirroring `list`. A
missing installed file is reported as `FAIL`, naming the `.exe` files that ARE in the install
directory (through `io.list`). Add one more test for that:

```ts
  it('Windows: a missing installed TN3270.exe is a FAIL naming what was installed', () => {
    const f = fakeRun({ pwsh: ok(fx('authenticode-valid.json')) });
    const { io, out } = base({
      platform: 'win32', run: f.run, env: { AZURE_SIGNING_PUBLISHER: 'Adam Thornton' },
      list: (d: string) => (d.endsWith('install') ? ['Other.exe'] : ['TN3270-0.1.5-win-x64.exe']),
      exists: (p: string) => !p.endsWith('TN3270.exe') || p.endsWith('win-x64.exe'),
    });
    expect(main(['--expect', 'signed', 'C:\\a'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/TN3270\.exe.*Other\.exe/s);
  });

  it('VERIFY_SIGNATURES_ECHO=1 logs each command and its raw text (for capturing fixtures)', () => {
    const f = fakeRun({ 'codesign -dv': ok(fx('codesign-dv-adhoc.txt')), spctl: no('rejected-raw') });
    const { io, out } = base({ run: f.run, env: { VERIFY_SIGNATURES_ECHO: '1' } });
    main(['--expect', 'unsigned', '/a'], io);
    expect(out.join('\n')).toMatch(/\$ spctl -a -t exec -vv \/scratch\/zip\/TN3270\.app[\s\S]*rejected-raw/);
  });
```

Pass `exists: () => true` in the `base()` defaults. The echo format is `$ <cmd> <args...>`
followed by the raw text, logged only when `io.env.VERIFY_SIGNATURES_ECHO === '1'`.

- [ ] **Step 2: Run it and check that it fails**

Run: `npx vitest run packages/core/test/verifySignatures.test.ts`
Expected: FAIL, because `main` is not exported.

- [ ] **Step 3: Implement `runCommand`, the drivers and `main`, then the main-check**

Write them from the outline above. These are the required behaviours the tests pin:
- Pass `cwd` to nothing. `runCommand` uses `spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000 })`.
  With `{ verbatim: true }` it also passes `windowsVerbatimArguments: true` and
  `argv0: \`"${cmd}"\``, as package-smoke does. It returns `{ status: r.status ?? 1, text: (r.stdout ?? '') + (r.stderr ?? '') }`,
  and it **throws** if `r.error` is set (a missing tool is a usage problem, not "unsigned").
- `main` ends with the repository's main-check idiom, copied from `scripts/release-notes.mjs:487`:

```js
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), {
    env: process.env, run: runCommand, log: (l) => console.log(l), platform: process.platform,
  });
}
```

- Defaults: `list = readdirSync`, `scratch = () => mkdtempSync(join(tmpdir(), 'tn3270-sig-'))`.
  Remove the scratch directory (`rmSync(..., { recursive: true, force: true })`) only when `scratch`
  was **not** injected.

- [ ] **Step 4: Run all the verifier tests, then typecheck**

Run: `npx vitest run packages/core/test/verifySignatures.test.ts && npm run typecheck`
Expected: PASS, and typecheck exits 0.

- [ ] **Step 5: Mutation check (record in the commit)**

- Move the `hdiutil detach` out of the `finally`. The throws-test should fail.
- Check only the zip's app. The both-apps test should fail.
- Have the Windows driver skip the installed `TN3270.exe`. The Windows test should fail.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-signatures.mjs scripts/verify-signatures.d.mts packages/core/test/verifySignatures.test.ts
git commit -m "scripts: verify-signatures drivers -- zip and dmg apps on mac, installer and installed files on Windows"
```

### Task 5: CI wiring

**Files:**
- Modify: `.github/workflows/package.yml`
- Test: `packages/core/test/workflow.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe`)

```ts
  const SIGNS = "matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign))";

  it('marks exactly macos-latest and windows-latest as signing runners', () => {
    const entries = jobBlock('package').split(/\n          - (?:os|name): /).slice(1);
    const signing = entries.filter((e) => /\n\s+sign: true\b/.test(e)).map((e) => e.split('\n')[0]!.trim());
    expect(signing.sort()).toEqual(['macos-latest', 'windows-latest']);
  });

  it('has a boolean sign input on workflow_dispatch, default false', () => {
    expect(wf).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+sign:\s*\n(?:\s+\S.*\n)*?\s+type: boolean/);
    expect(wf).toMatch(/\n\s+sign:\s*\n(?:\s+\S.*\n)*?\s+default: false/);
  });

  it('every "this run signs" expression is the one expression, verbatim', () => {
    const block = jobBlock('package');
    // Up to the first `))`, which is where SIGNS ends; a lazy match to ` &&` would stop inside it.
    const uses = [...block.matchAll(/\$\{\{ (matrix\.sign && \(.*?\)\)) && /g)].map((m) => m[1]);
    expect(uses.length).toBe(5); // environment, the .p8 step, azure/login, TN3270_SIGN, auto-discovery
    for (const u of uses) expect(u).toBe(SIGNS);
    expect(block).toMatch(new RegExp(`environment: \\$\\{\\{ ${SIGNS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && 'signing' \\|\\| '' \\}\\}`));
  });

  it('the verify step decides its mode from the ref and the input alone, never matrix.sign', () => {
    const step = jobBlock('package').split(/\n      - /).find((s) => s.includes('verify-signatures.mjs'));
    expect(step, 'no verify-signatures step').toBeDefined();
    const run = /run: (.*verify-signatures\.mjs.*)/.exec(step!)![1]!;
    expect(run).toMatch(/startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(run).not.toMatch(/matrix\.sign/);
    expect(run).toMatch(/&& 'signed' \|\| 'unsigned'/);
  });

  it('the verify step runs after package:gui and before package-smoke', () => {
    const steps = jobBlock('package').split(/\n      - /);
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
    expect(at(/package:gui/)).toBeLessThan(at(/verify-signatures/));
    expect(at(/verify-signatures/)).toBeLessThan(at(/package-smoke/));
  });

  it('the package job may mint an OIDC token, and reads contents', () => {
    expect(jobBlock('package')).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/);
  });

  it('pins azure/login by full commit SHA', () => {
    expect(wf).toMatch(/uses: azure\/login@[0-9a-f]{40} # v3\.1\.0/);
  });
```

- [ ] **Step 2: Run it and check that it fails**

Run: `npx vitest run packages/core/test/workflow.test.ts`
Expected: the seven new tests FAIL, and the old ones still pass.

- [ ] **Step 3: Edit `package.yml`**

Read lines 1-60 first. The header comment lists the jobs and the pinned action versions. Add
`azure/login` v3.1.0 to that list, with the date checked (2026-11-10, SHA
`053f7285eb20bf5469ef084617b0b24d3cec53fc`). **Before writing it, re-check the SHA:**
`/usr/bin/gh api repos/Azure/login/git/ref/tags/v3.1.0 --jq .object.sha`.

1. Under `on:`, replace `workflow_dispatch:` with:

```yaml
  workflow_dispatch:
    inputs:
      sign:
        description: 'Sign and notarize the macOS and Windows installers (uses environment signing)'
        type: boolean
        default: false
```

2. Replace the global `env:` comment so it reads: unsigned unless a signing run, which overrides
   this per step (`CSC_IDENTITY_AUTO_DISCOVERY` false + no identity = silently unsigned;
   macCodeSign.js findIdentity). Keep the value `'false'`.
3. In the matrix, add `sign: true` to `macos-latest` and `windows-latest`, each with a one-line
   comment (macos-26-intel stays unsigned: never uploaded, it only launches the x64 slice).
4. In the `package` job, after `runs-on:`:

```yaml
    # Signing runs only (code signing spec, section 2): v* tags, or a dispatch with sign ticked,
    # on the two runners that build mac/Windows installers. '' = no environment (MEASURED in Task 6).
    environment: ${{ matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign)) && 'signing' || '' }}
    # id-token: azure/login's OIDC exchange. The federated credential trusts only
    # repo:athornton/tn3270:environment:signing, so a token from any other job is refused.
    permissions:
      contents: read
      id-token: write
```

5. Immediately before `- if: matrix.builder` / `run: npm run package:gui ...`, add:

```yaml
      - if: ${{ matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign)) && runner.os == 'macOS' }}
        name: notarization key (.p8) into RUNNER_TEMP; APPLE_API_KEY is its PATH
        run: |
          printf '%s\n' "$APPLE_API_KEY_P8" > "$RUNNER_TEMP/AuthKey.p8"
          echo "APPLE_API_KEY=$RUNNER_TEMP/AuthKey.p8" >> "$GITHUB_ENV"
        env:
          APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}
      - if: ${{ matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign)) && runner.os == 'Windows' }}
        name: Azure login (OIDC) for Artifact Signing
        uses: azure/login@053f7285eb20bf5469ef084617b0b24d3cec53fc # v3.1.0
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
```

6. Give the existing `npm run package:gui` step an `env:`:

```yaml
        env:
          TN3270_SIGN: ${{ matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign)) && '1' || '' }}
          CSC_IDENTITY_AUTO_DISCOVERY: ${{ matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign)) && 'true' || 'false' }}
          # Empty outside environment signing; signing.cjs refuses signing mode without them.
          CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_API_KEY_ID: ${{ vars.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ vars.APPLE_API_ISSUER }}
          AZURE_SIGNING_ENDPOINT: ${{ vars.AZURE_SIGNING_ENDPOINT }}
          AZURE_SIGNING_ACCOUNT: ${{ vars.AZURE_SIGNING_ACCOUNT }}
          AZURE_SIGNING_PROFILE: ${{ vars.AZURE_SIGNING_PROFILE }}
          AZURE_SIGNING_PUBLISHER: ${{ vars.AZURE_SIGNING_PUBLISHER }}
```

7. Immediately after it, before `scripts/package-smoke.mjs`:

```yaml
      # Fail-closed both ways (spec section 3). The MODE comes from the ref and the input alone, not
      # matrix.sign, so a broken signing expression fails a tag run rather than passing it unsigned.
      - if: matrix.sign
        name: verify signatures
        run: node scripts/verify-signatures.mjs --expect ${{ (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign)) && 'signed' || 'unsigned' }} artifacts/gui
        env:
          APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID }}
          AZURE_SIGNING_PUBLISHER: ${{ vars.AZURE_SIGNING_PUBLISHER }}
          # Raw codesign/spctl/Authenticode text in the log: what a failure is diagnosed from,
          # and where the test fixtures are captured from (Tasks 6 and 8).
          VERIFY_SIGNATURES_ECHO: '1'
```

The verify step's `if: matrix.sign` is fine: the *mode* is what must not depend on `matrix.sign`.
A tag run with `sign` removed from the matrix is caught by Task 5's "exactly macos-latest and
windows-latest" test.

- [ ] **Step 4: Run the workflow tests and the full suite**

Run: `npx vitest run packages/core/test/workflow.test.ts`, then `npm test` (timeout 20 min).
Expected: PASS. Record the total test count.

- [ ] **Step 5: Mutation check (record in the commit)**

- Change one `TN3270_SIGN` expression's `inputs.sign` to `inputs.signed`. The verbatim test should fail.
- Put `matrix.sign &&` in front of the verify mode. The ref-alone test should fail.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/package.yml packages/core/test/workflow.test.ts
git commit -m "ci: sign mac and Windows installers on tags and signing dispatches; verify on every run"
```

### Task 6: push, then measure unsigned CI (needs the user's OK to push)

- [ ] **Step 1: Ask the user before pushing.** Then run `git push -u origin signing`.
- [ ] **Step 2: Watch the run** (`/usr/bin/gh run list --branch signing --limit 1`, then
  `/usr/bin/gh run watch <id> --exit-status`). The push is not a tag and not a signing dispatch,
  so every job must be green, and the mac and Windows jobs must log
  `ok ...: unsigned` for each artifact.
- [ ] **Step 3: Measure the empty-environment claim.** Run
  `/usr/bin/gh api repos/athornton/tn3270/deployments --jq '[.[] | select(.environment=="signing")] | length'`.
  It must be `0`, and the run's jobs must show no environment. **If GitHub rejected `''` or
  created a deployment**, switch to the spec's fallback: two jobs, `package` (unsigned matrix) and
  `package-signed` (the two signing runners, `if:` the expression, `environment: signing`), sharing
  steps through a composite action in `.github/actions/package-steps/action.yml`. Update Task 5's
  tests to match. Write that fallback as its own task before doing it, and ask the user.
- [ ] **Step 4: Capture real unsigned outputs** from the mac and Windows job logs (the verify
  step sets `VERIFY_SIGNATURES_ECHO: '1'`, so the raw text is in the log). Replace
  `codesign-dv-adhoc.txt`, `spctl-rejected.txt` and `authenticode-notsigned.json` with them,
  removing the PROVISIONAL line. Re-run the tests, then commit:
  `test: real unsigned codesign/spctl/Authenticode captures`.

### Task 7: credentials (the user, with the walkthrough from Task 9 drafted first)

Write the setup section of `docs/releasing.md` (Task 9, Step 1) **before** this task, so the user
can follow it. The user does the clicking. I do the `gh` parts once they say go:

- [ ] **Step 1: Create the environment and its branch policy** (I do this after the user's OK):

```bash
/usr/bin/gh api -X PUT repos/athornton/tn3270/environments/signing \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
/usr/bin/gh api -X POST repos/athornton/tn3270/environments/signing/deployment-branch-policies -f name='v*.*.*' -f type=tag
/usr/bin/gh api -X POST repos/athornton/tn3270/environments/signing/deployment-branch-policies -f name=main -f type=branch
/usr/bin/gh api -X POST repos/athornton/tn3270/environments/signing/deployment-branch-policies -f name=signing -f type=branch   # TEMPORARY; removed in Task 10
```

- [ ] **Step 2: The user sets the secrets** (I never see their values):
  `/usr/bin/gh secret set MAC_CERT_P12_BASE64 --env signing < <(base64 -i cert.p12)`,
  `MAC_CERT_PASSWORD`, and `APPLE_API_KEY_P8 --env signing < AuthKey_XXXX.p8`.
- [ ] **Step 3: The variables are set** (not secret; the user tells me the values, or sets them):
  `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`,
  `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER`, via `/usr/bin/gh variable set NAME --env signing --body VALUE`.
- [ ] **Step 4: Check the names only:** `/usr/bin/gh secret list --env signing` and
  `/usr/bin/gh variable list --env signing` must list exactly the 3 secrets and 10 variables above.

### Task 8: the signed proof run

- [ ] **Step 1: Run** `/usr/bin/gh workflow run package.yml --ref signing -f sign=true`, then watch it.
- [ ] **Step 2: Expected:** mac and Windows are green, the verifier prints `ok ...: signed` for the
  zip app, the dmg app, the installer, `TN3270.exe` and `Uninstall TN3270.exe`, and package-smoke
  passes on the signed artifacts. **If Windows fails in `Invoke-TrustedSigning` on credentials**,
  the Azure CLI login was not picked up. Fall back to `AZURE_CLIENT_SECRET` through
  `EnvironmentCredential`: the user creates a client secret and stores it as a `signing` secret,
  the package:gui step gets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, and
  the azure/login step goes. Write that up as a task and ask before doing it.
- [ ] **Step 3: Capture** (with `VERIFY_SIGNATURES_ECHO=1`) the signed `codesign -dv`, `spctl` and
  Authenticode outputs. Replace the provisional fixtures and remove "provisional" from the test
  names. Run the tests. If a real output breaks a parser, fix the parser: the capture is the
  truth. Commit: `test: real signed codesign/spctl/Authenticode captures`.
- [ ] **Step 4: Count the Windows signatures** in the log (each `Invoke-TrustedSigning` call), and
  note the count in the commit and in releasing.md.
- [ ] **Step 5: Mutation, once:** temporarily `/usr/bin/gh variable delete APPLE_API_ISSUER --env signing`,
  dispatch again, and confirm the mac job fails at package:gui with
  `TN3270_SIGN=1 but APPLE_API_ISSUER is not set`. Restore it (`gh variable set ...`). Also confirm
  that a plain push on `signing` still prints `ok ...: unsigned`. Record both run IDs.

### Task 9: docs

**Files:** `docs/releasing.md`, `README.md`, `docs/HANDOFF.md`, `changelog.d/<scriv-new>.md`

- [ ] **Step 1: `docs/releasing.md`, new section "Code signing (release installers)".** It has
  four parts. Each step says where to click, what to copy, and where the value goes (secret or
  variable name):
  - **Apple.**
    1. Keychain Access → Certificate Assistant → *Request a Certificate From a Certificate
       Authority*, saved to disk.
    2. developer.apple.com → Certificates → **+** → *Developer ID Application* (the G2 Sub-CA),
       upload the CSR, download it, and double-click it into the login keychain.
    3. In Keychain, under *My Certificates*, export it as `.p12` with a password. That gives
       `MAC_CERT_P12_BASE64` (`base64 -i`) and `MAC_CERT_PASSWORD`.
    4. The team ID is the parenthesised part of the certificate's name: `APPLE_TEAM_ID`.
    5. App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys →
       **+**, role *Developer*. Download the `.p8` (only once possible) for `APPLE_API_KEY_P8`.
       The Key ID goes in `APPLE_API_KEY_ID` and the Issuer ID in `APPLE_API_ISSUER`.
  - **Azure.**
    1. In the Artifact Signing account, check that the identity validation shows *Completed*.
    2. Certificate profiles → **+** → *Public Trust*, choosing that validation. The profile name
       goes in `AZURE_SIGNING_PROFILE`, the account name in `AZURE_SIGNING_ACCOUNT`, and the
       account's *Account URI* in `AZURE_SIGNING_ENDPOINT`.
    3. The publisher is the validation's CN, exactly as written, for `AZURE_SIGNING_PUBLISHER`.
    4. Entra ID → App registrations → New (`tn3270-signing`). Its client and tenant IDs go in
       `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, and the subscription ID in
       `AZURE_SUBSCRIPTION_ID`.
    5. Certificates & secrets → Federated credentials → *GitHub Actions deploying Azure
       resources*: org `athornton`, repo `tn3270`, entity *Environment*, `signing`.
    6. On the **certificate profile** (not the subscription), Access control → Add role
       assignment → *Artifact Signing Certificate Profile Signer* → that app.
    7. **Check the role's current name in the portal.** It was *Trusted Signing Certificate
       Profile Signer* before the rename, and the walkthrough should give whichever name the
       user actually saw.
  - **GitHub:** the environment and the commands from Task 7, and a table with each secret and
    variable, what reads it (the file and step), and whether it is secret.
  - **Rotation and revocation:** the Developer ID certificate lasts 5 years (export a new
    `.p12`; revoke at developer.apple.com). Revoke the API key in App Store Connect. On Azure,
    delete the federated credential or remove the role assignment.

  Rewrite **"Unsigned-app notes"** (around line 293): release installers are signed; CI artifacts
  from main, PRs and unsigned dispatches are not, and the existing workarounds still apply to
  those. The dmg itself is unsigned by design, and the app inside is notarized and stapled. Also
  update the release walkthrough line about "the unsigned-app workarounds" (around line 125).

- [ ] **Step 2: README.** Lines 28, 42 and 71-75: release installers are signed and notarized
  from the version that ships this (write "from the next release" until it ships, and Task 10
  fixes that up). Fix the stale "currently 0.1.3" on line 42: 0.1.4 is out
  (`/usr/bin/gh release view --json tagName` to check it is still the latest).
- [ ] **Step 3: HANDOFF.** Update the title line, line 130 ("unsigned this milestone"), and lines
  221-228 (the Gatekeeper path is now for CI artifacts only). Add the signing branch to *START
  HERE*.
- [ ] **Step 4: Changelog fragment.** Run `scriv create`, then fill in *New features*: "Release
  installers are signed: the macOS app with a Developer ID and notarized, the Windows installer
  and app through Azure Artifact Signing." Delete the empty sections.
- [ ] **Step 5: Run** `npm test` (the docs tests, if any, and the release-notes dry run),
  `node scripts/release-notes.mjs --dry-run artifacts/gui` if there are artifacts, and
  `grep -n -i unsigned README.md docs/releasing.md docs/HANDOFF.md`. Read every hit and confirm it
  is now scoped to CI artifacts or the dmg.
- [ ] **Step 6: Commit:** `docs: code signing setup, secrets table, unsigned notes scoped to CI artifacts`.

### Task 10: merge gate (the user's call)

- [ ] **Step 1:** Full gate on the branch head: `npm ci && npm run build && npm run typecheck && npm test`
  (each one step, with a timeout). Record the count. Push. CI must be green, with
  `ok ...: unsigned` on mac and Windows.
- [ ] **Step 2:** Ask the user to merge (`--no-ff`, as before). After the merge:
  `/usr/bin/gh api -X DELETE repos/athornton/tn3270/environments/signing/deployment-branch-policies/<id of the 'signing' rule>`.
  Check that only `v*.*.*` and `main` remain. Delete the branch, locally and remotely, after
  checking it is contained in main.
- [ ] **Step 3:** The next release (0.1.5) is the real proof. On it, check the GitHub release's
  dmg, zip and exe with the verifier on downloaded copies, plus the user's live checks: no
  Gatekeeper prompt on a real Mac after downloading through a browser, and the SmartScreen
  result on Windows 11 recorded as seen. Then fix up the README's "from the next release".
