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
 *
 * WINDOWS SIGNING IS NOT WIRED IN CI (spec amendment 2026-11-11). The win32 branch below (Azure
 * Artifact Signing) is kept, unit-tested, but nothing sets TN3270_SIGN=1 on Windows: there is no
 * Azure subscription, package.yml has no azure/login and passes no AZURE_SIGNING_* variable, and
 * windows-latest verifies its installer `unsigned` on every run. Windows is planned to ship signed
 * through the Microsoft Store as an MSIX (Microsoft signs it), a separate design.
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
