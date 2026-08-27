/**
 * Split a host argument into prefixes, LU names, host and port.
 *
 * s3270's documented shape is `[prefix:][LUname@]hostname[:port]`, with prefixes
 * stacked one colon each — `S:C:host` — and multiple LUs comma-separated and tried in
 * order as rejections come back (`telnet.c` `setup_lus`/`next_lu`).
 *
 * Its own file rather than an addition to `tls.ts`, because `tls.ts` is about TLS and
 * an LU name is not. Both consume prefixes, so prefix splitting lives here and the
 * TLS-relevant letters are handed on.
 *
 * PREFIX RECOGNITION IS RESTRICTED TO SINGLE LETTERS, deliberately. s3270 requires a
 * colon per prefix and treats `SC:host` as a syntax error ("double ':'"). Matching
 * that keeps us from silently applying prefixes an operator could not have got from
 * s3270, and it is also what stops a one-character hostname being eaten as a prefix.
 */
export interface HostSpec {
  readonly host: string;
  /** LU names in the order written; not sorted, not de-duplicated. */
  readonly lus: readonly string[];
  /** Upper-cased single-letter prefixes, in the order written. */
  readonly prefixes: readonly string[];
  /** Left as text: the caller owns port validation and defaulting. */
  readonly portText: string | undefined;
}

export function parseHostSpec(raw: string): HostSpec {
  let rest = raw;
  const prefixes: string[] = [];
  for (;;) {
    const m = /^([A-Za-z]):(.*)$/.exec(rest);
    if (m === null) break;
    prefixes.push(m[1]!.toUpperCase());
    rest = m[2]!;
  }

  const lus: string[] = [];
  // The LAST @, so an LU name containing one cannot swallow the host.
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    for (const n of rest.slice(0, at).split(',')) {
      // An empty entry would become a CONNECT with no name, which is a request for a
      // nameless resource rather than for the default one.
      if (n === '') throw new Error('empty LU name in the LU list');
      lus.push(n);
    }
    rest = rest.slice(at + 1);
  }

  // A bracketed IPv6 literal owns its colons; only a colon AFTER the bracket is a port
  // separator. Without this, `[::1]:3271` parses as several unknown prefixes and an
  // empty host.
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) throw new Error('unterminated [ in the host argument');
    const host = rest.slice(1, close);
    if (host === '') throw new Error('no host in the host argument');
    const tail = rest.slice(close + 1);
    return {
      host, lus, prefixes,
      portText: tail.startsWith(':') ? tail.slice(1) : undefined,
    };
  }

  const colon = rest.lastIndexOf(':');
  const host = colon === -1 ? rest : rest.slice(0, colon);
  if (host === '') throw new Error('no host in the host argument');
  return {
    host, lus, prefixes,
    portText: colon === -1 ? undefined : rest.slice(colon + 1),
  };
}
