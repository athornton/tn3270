import type { ConnectionInfo } from '@tn3270/core';

/** What the About window's Configuration section shows. Gathered in main from what it holds. */
export interface AboutConfig {
  readonly model: string;
  readonly colorMode: string;
  readonly codePage: { readonly name: string; readonly cgcsgid: number };
  readonly font: string;
  readonly scheme: string;
  readonly keymap: string;
}

/**
 * The About window's whole text: version, configuration, connection. ONE FUNCTION FOR BOTH what
 * the window shows and what Copy copies, so a pasted bug report is exactly what was on screen.
 * `tls` is the front end's, since core never sees it (`ConnectionInfo`'s comment).
 */
export function aboutText(
  version: string, config: AboutConfig, info: ConnectionInfo, tls: string,
): string {
  const lines = [
    version,
    '',
    'Configuration',
    `  Model: ${config.model}`,
    `  Terminal type: ${info.terminalType ?? '(not known)'}`,
    `  Color mode: ${config.colorMode}`,
    `  Code page: ${config.codePage.name} (CGCSGID ${config.codePage.cgcsgid})`,
    `  Font: ${config.font}`,
    `  Color scheme: ${config.scheme}`,
    `  Keymap: ${config.keymap}`,
    '',
    'Connection',
  ];
  if (!info.connected) {
    lines.push('  not connected');
  } else {
    lines.push(
      `  Host: ${info.host ?? '?'}:${info.port ?? '?'}`,
      `  LU: ${info.lu ?? '(none)'}`,
      `  TLS: ${tls}`,
      `  TN3270E: ${info.tn3270e ? 'yes' : 'no'}`,
      `  Connected since: ${info.since?.toISOString() ?? '?'}`,
      `  Bytes in/out: ${info.bytesIn} / ${info.bytesOut}`,
      `  Host records: ${info.recordsIn}`,
    );
  }
  return lines.join('\n');
}
