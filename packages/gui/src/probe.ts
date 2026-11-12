/**
 * The store probe's view from INSIDE the process (store-probe spec, section 2):
 *  - APP_SANDBOX_CONTAINER_ID: macOS sets it in every App-Sandboxed process;
 *  - process.windowsStore: Electron sets it true inside an AppX/MSIX package.
 * Printed only under TN3270_GUI_PROBE=1, as one stdout line scripts/store-probe.mjs judges.
 */
export function probeLine(
  env: Record<string, string | undefined>,
  proc: { windowsStore: boolean | undefined; mas: boolean | undefined },
): string {
  const id = env.APP_SANDBOX_CONTAINER_ID;
  return `probe: sandbox=${id ? id : 'none'} windowsStore=${proc.windowsStore === true}`;
}
