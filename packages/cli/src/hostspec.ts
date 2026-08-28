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
 * PREFIX RECOGNITION IS RESTRICTED TO SINGLE LETTERS FROM s3270'S OWN SET,
 * deliberately. s3270 requires a colon per prefix and treats `SC:host` as a syntax
 * error ("double ':'"). Matching that keeps us from silently applying prefixes an
 * operator could not have got from s3270, and it is also what stops a one-character
 * hostname being eaten as a prefix.
 */

/**
 * The prefix letters s3270 accepts, and nothing else: `pfxstr` is
 * `"AaCcLlNnPpSsBbYyTt"` at Common/split_host.c:38, and the meanings are the
 * `host_flags_t` enum in include/split_host.h.
 *
 * A broader class was wrong in both directions. `Z:host` became prefix `Z` plus host
 * `host`, where s3270 treats the whole thing as a host and then fails on the port —
 * so a typo silently changed the target instead of being reported.
 */
const PREFIX_LETTERS = 'ACLNPSBYT';
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
    const letter = m[1]!.toUpperCase();
    if (!PREFIX_LETTERS.includes(letter)) break;
    prefixes.push(letter);
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

/** A host argument with every prefix applied and the port resolved. */
export interface ResolvedHost {
  readonly host: string;
  readonly port: number;
  readonly lus: readonly string[];
  /**
   * `false` from an `N:` prefix; `undefined` when the argument said nothing, so a
   * `-tn3270e` flag or the session default still decides. Not defaulted to `true`
   * here: "the operator asked for TN3270E" and "the operator said nothing" have to
   * stay distinguishable, or the contradiction check below cannot fire.
   */
  readonly tn3270e: boolean | undefined;
  /** `L:` was given. TLS is already our default, so this only matters against `-insecure`. */
  readonly tlsRequested: boolean;
}

/**
 * What each prefix we do not implement would do in s3270, and the flag to reach the
 * nearest thing we have.
 *
 * REFUSED RATHER THAN IGNORED, every one. Each changes what s3270 puts on the wire, so
 * dropping one silently hands the operator a session they did not ask for and cannot
 * see in the trace — the same reasoning that makes `L:` alongside `-insecure` an error
 * rather than a downgrade. `B:` is absent from this table because it is "now a no-op"
 * in s3270 itself (split_host.h), so accepting and ignoring it matches its behaviour
 * exactly.
 */
const UNIMPLEMENTED_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  A: 'means an NVT/ANSI session rather than 3270 (ANSI_HOST). This client is 3270-only.',
  C: 'suppresses the login wait (NO_LOGIN_HOST). We never wait for a login, so the '
    + 'prefix would be a no-op here -- but it is refused rather than ignored, because '
    + 'a script that relies on it is relying on s3270 behaviour we have not verified.',
  P: 'connects through a telnet passthru proxy (PASSTHRU_HOST), which is not implemented.',
  S: 'asks for the standard data stream, not the extended one (STD_DS_HOST). Use a '
    + 'terminal type without the -E suffix instead, e.g. -model 3278-2.',
  T: 'disables telnet negotiation entirely (NO_TELNET_HOST), which is not implemented.',
  Y: 'skips certificate verification (NO_VERIFY_CERT_HOST). Use -noverifycert.',
});

/**
 * Apply the prefixes and resolve the port.
 *
 * ONE function rather than a rule mirrored into each front end. The two arg parsers
 * already diverged once over `-insecure` — the fix is pinned by
 * `packages/tui/test/harness-flags.test.ts` — and a prefix that disabled TN3270E in
 * the TUI but not the CLI would be that bug again. The TUI calls this from its arg
 * parser and the CLI's runner calls it from `Connect()`.
 *
 * The error constructor is injected so each front end raises its own type: the TUI's
 * `UsageError` prints a usage line, while the runner's plain `Error` becomes an
 * s3270 `error` reply.
 */
export function resolveHostSpec(
  raw: string,
  mkError: (message: string) => Error,
): ResolvedHost {
  let spec: HostSpec;
  try {
    spec = parseHostSpec(raw);
  } catch (e) {
    // Re-raised through the caller's constructor so a malformed host argument is
    // reported the same way as an unsupported prefix, rather than as an internal fault.
    throw mkError(e instanceof Error ? e.message : String(e));
  }

  for (const p of spec.prefixes) {
    const why = UNIMPLEMENTED_PREFIXES[p];
    if (why !== undefined) throw mkError(`the ${p}: host prefix ${why}`);
  }

  return {
    host: spec.host,
    port: resolvePort(spec.portText, raw, mkError),
    lus: spec.lus,
    // Only ever false or undefined: there is no prefix that turns TN3270E on.
    tn3270e: spec.prefixes.includes('N') ? false : undefined,
    tlsRequested: spec.prefixes.includes('L'),
  };
}

/**
 * The port, defaulting to 23.
 *
 * VALIDATED, unlike the `Number()` in the `splitTarget` this replaces: that turned
 * `host:abc` into port `NaN` and handed it to `net.connect`, which reports something
 * about an invalid option rather than about the argument the operator typed. A strict
 * digits-only test rather than `Number()`, because `Number` accepts `' 23 '`, `0x17`,
 * `1e3` and `''` — none of which s3270 would take, and the last of which is what
 * `host:` produces.
 *
 * 23 even for `L:`, matching s3270. Redirecting to 992 would open a connection
 * somewhere the operator did not type.
 */
function resolvePort(
  portText: string | undefined,
  raw: string,
  mkError: (message: string) => Error,
): number {
  if (portText === undefined) return 23;
  if (!/^\d+$/.test(portText)) {
    throw mkError(
      `${JSON.stringify(raw)} has no usable port: ${JSON.stringify(portText)} is not a number. `
      + 'The shape is [prefix:][LU,LU@]host[:port].');
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) {
    throw mkError(`port ${port} in ${JSON.stringify(raw)} is outside 1-65535`);
  }
  return port;
}
