#!/usr/bin/env node
/**
 * Fail-closed signature check of the finished GUI installers (code signing spec, section 3).
 *
 *     node scripts/verify-signatures.mjs --expect signed|unsigned [artifacts/gui]
 *
 * `signed` needs APPLE_TEAM_ID (macOS) or AZURE_SIGNING_PUBLISHER (Windows). `unsigned` runs on
 * every non-release push, so the checks are shown to REJECT an unsigned build continuously.
 */

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
