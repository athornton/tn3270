import { randomBytes } from 'node:crypto';
import { resolveHostSpec, takeTlsFlag, type TlsFlags } from '@tn3270/frontend';

/**
 * The gateway's arguments.
 *
 * ## TWO TLS DIRECTIONS, DELIBERATELY DIFFERENT SPELLINGS
 *
 * `--tls-cert` and `--tls-key` are how THE BROWSER VERIFIES US. `-insecure`, `-cafile`,
 * `-noverifycert` and the `L:` prefix are `frontend`'s and are how WE VERIFY THE MAINFRAME. The
 * long `--tls-` prefix versus s3270's short flags is the whole point: a reader must not be able to
 * mistake one direction for the other. Treat any new flag that could be read either way as a
 * defect.
 *
 * ## AUTH IS OFF BY DEFAULT, AND THE LOOPBACK BIND IS WHAT MAKES THAT DEFENSIBLE
 *
 * The user's call, 2026-09-16, having previously had it the other way. The two defaults are a
 * PAIR and must be read together: the gateway binds `127.0.0.1`, so out of the box only a process
 * on this machine can reach it, and requiring a token from a local operator against their own
 * emulator is friction that buys nothing. `--auth on` generates a token, prints it once in the
 * startup URL, and thereafter carries it in an `HttpOnly` cookie.
 *
 * **THE DANGEROUS COMBINATION IS `--bind` OFF LOOPBACK WITH AUTH OFF**, and that is not a warning
 * about a flag someone typed -- it is now the DEFAULT half of it. `main.ts` therefore warns on
 * exactly that pair rather than on `--auth off` alone, which would otherwise print on every single
 * run and be learned as noise. Note also what a token is and is not: `--tls-cert` protects the
 * traffic, the token protects ACCESS, and neither substitutes for the other.
 *
 * ## `hostTls` IS RAW, NOT RESOLVED
 *
 * `takeTlsFlag` only records what was typed (`-insecure`, `-cafile FILE`, ...); it does not
 * decide anything. Turning that into an actual `TlsOptions` is `resolveTls`'s job, and it is
 * deliberately left to whichever later task opens the connection to the mainframe -- this file
 * is argument parsing only, per the plan for this task.
 *
 * ## `--allow-origin` EXISTS BECAUSE THE COMMON PROXY DEFAULT BREAKS THE HOST COMPARISON
 *
 * It is REPEATABLE and it is NOT redundant with `handshake.ts`'s Origin-versus-Host check.
 * MEASURED: nginx's default `proxy_set_header Host $proxy_host` and Apache's default
 * `ProxyPreserveHost Off` rewrite Host to the upstream address, so a browser at `https://gw.example`
 * reaches us as `Host: 127.0.0.1:8270` and no legitimate browser can ever match. Exact strings
 * only -- see the note in `handshake.ts` for why no wildcard form is accepted.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface WebArgs {
  readonly host: string;
  readonly port: number;
  readonly bind: string;
  readonly listen: number;
  readonly auth: boolean;
  readonly token: string;
  readonly graceMs: number;
  readonly maxSessions: number;
  /** Extra Origins the upgrade check accepts verbatim, in the order given. Empty by default. */
  readonly allowOrigins: readonly string[];
  readonly tls?: { cert: string; key: string; chain?: string };
  readonly replay?: string;
  /**
   * Print every action applied, for `browser-keys.mjs`.
   *
   * REFUSED WITHOUT `--replay`, and that is a privacy control rather than tidiness. A `type`
   * action carries the text typed, so on a live gateway this would put an operator's PASSWORD on
   * stdout -- and unlike the GUI's equivalent seam, a gateway is a long-lived server whose stdout
   * is routinely a log file. Replay can reach no host, which is what makes a logged keystroke safe.
   * The GUI gates its own action log the same way (`gui/src/main.ts`, `logActions`).
   */
  readonly logActions: boolean;
  readonly hostTls: TlsFlags;
  readonly model?: string;
  readonly scheme?: string;
}

/** One flag that takes a value, or throw naming the flag rather than the index. */
function value(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`${flag} needs a value`);
  return v;
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} needs a positive integer`);
  return n;
}

/**
 * Like `positiveInt`, but for `--listen` only: 0 is a real value there, not a typo. Port 0 means
 * "let the OS pick an ephemeral port", which the integration and TLS harnesses rely on to avoid
 * colliding on a fixed port. `--grace 0` and `--max-sessions 0` are still nonsense -- a zero-length
 * grace window and a zero-session cap describe a gateway that can do nothing -- so they keep using
 * `positiveInt` and must keep throwing.
 */
function nonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} needs a non-negative integer`);
  return n;
}

export function parseWebArgs(argv: readonly string[]): WebArgs {
  const rest: string[] = [];
  const hostTls: TlsFlags = {};
  // Repeatable, so it accumulates rather than being overwritten by the last occurrence.
  const allowOrigins: string[] = [];
  let bind = '127.0.0.1';
  let listen = 8270;
  // OFF by default; see the note above on why the loopback bind is the other half of this.
  let auth = false;
  let token: string | undefined;
  let graceMs = 60_000;
  let maxSessions = 16;
  let cert: string | undefined;
  let key: string | undefined;
  let chain: string | undefined;
  let logActions = false;
  let replay: string | undefined;
  let model: string | undefined;
  let scheme: string | undefined;

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    // The host-side TLS flags belong to frontend; it consumes what it recognises and
    // reports, via `eaten`, how many EXTRA argv entries (beyond the flag itself) it ate --
    // 0 for a bare flag like `-insecure`, 1 for one that takes a value like `-cafile FILE`.
    // `undefined` means "not one of mine", so the switch below still gets a turn.
    const eaten = takeTlsFlag(hostTls, a, args[i + 1], (m) => new UsageError(m));
    if (eaten !== undefined) { i += eaten; continue; }
    switch (a) {
      case '--bind': bind = value(args, i, a); i += 1; continue;
      case '--listen': listen = nonNegativeInt(value(args, i, a), a); i += 1; continue;
      case '--token': token = value(args, i, a); i += 1; continue;
      case '--auth': {
        const v = value(args, i, a); i += 1;
        if (v !== 'on' && v !== 'off') throw new UsageError('--auth takes on or off');
        auth = v === 'on';
        continue;
      }
      case '--allow-origin': allowOrigins.push(value(args, i, a)); i += 1; continue;
      case '--grace': graceMs = positiveInt(value(args, i, a), a) * 1000; i += 1; continue;
      case '--max-sessions': maxSessions = positiveInt(value(args, i, a), a); i += 1; continue;
      case '--tls-cert': cert = value(args, i, a); i += 1; continue;
      case '--tls-key': key = value(args, i, a); i += 1; continue;
      case '--tls-chain': chain = value(args, i, a); i += 1; continue;
      case '--replay': replay = value(args, i, a); i += 1; continue;
      case '--log-actions': logActions = true; continue;
      case '-model': model = value(args, i, a); i += 1; continue;
      case '-scheme': scheme = value(args, i, a); i += 1; continue;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown flag ${a}`);
        rest.push(a);
    }
  }

  if (rest.length === 0) throw new UsageError('a host is required, as HOST:PORT');
  if (rest.length > 1) throw new UsageError(`unexpected argument ${rest[1]}`);
  // One TLS half without the other would otherwise start a PLAINTEXT gateway that the operator
  // believes is encrypted, which is worse than refusing.
  if (cert !== undefined && key === undefined) throw new UsageError('--tls-cert needs --tls-key');
  if (key !== undefined && cert === undefined) throw new UsageError('--tls-key needs --tls-cert');

  // `resolveHostSpec` takes the raw argument and an error constructor -- not the TLS flags,
  // which it never consults -- and returns the LU list and TN3270E preference alongside host
  // and port. Only host/port are surfaced here; threading LUs and TN3270E through is for
  // whichever later task actually opens the mainframe connection.
  // See `WebArgs.logActions`: the log carries typed text, so it is refused unless the session can
  // reach no host at all.
  if (logActions && replay === undefined) {
    throw new UsageError('--log-actions needs --replay: it prints typed text, including passwords');
  }

  const resolved = resolveHostSpec(rest[0]!, (m) => new UsageError(m));

  /**
   * WHAT THIS GATEWAY CANNOT HONOUR IN A HOST ARGUMENT, REFUSED BY NAME.
   *
   * `resolveHostSpec` parses the full `[prefix:][LU,LU@]host[:port]` shape, and this file used only
   * `host` and `port` from it — so an LU list and `N:` were accepted and SILENTLY IGNORED. Measured:
   * `LUA,LUB@127.0.0.1:3270` started the gateway and served happily, having quietly dropped the LU
   * selection an operator had asked for. That is exactly the defect stage 2b's Task 12 fixed for the
   * CLI and TUI, reintroduced here, and it breaks this project's own stated rule: a prefix that
   * changes what goes on the wire but is not implemented is refused by name rather than ignored.
   *
   * Both are per-CONNECTION properties, and this gateway opens one connection per session from a
   * single command line, so honouring them would mean deciding what an LU list even means across
   * sixteen concurrent sessions. Refusing is honest until that question has an answer.
   *
   * `L:` is NOT refused: it asks for TLS to the host, which is already this client's default. It is
   * refused only alongside `-insecure`, where obeying one means disobeying the other — the same
   * silent-downgrade reasoning as `runner.ts`.
   */
  if (resolved.lus.length > 0) {
    throw new UsageError(
      'an LU list is not supported by the gateway: an LU is a property of one connection, and this '
      + 'serves many sessions from one command line',
    );
  }
  if (resolved.tn3270e === false) {
    throw new UsageError('the N: host prefix is not supported by the gateway');
  }
  if (resolved.tlsRequested && hostTls.insecure === true) {
    throw new UsageError(
      'the L: host prefix asks for TLS to the host, but -insecure disables it; connecting in the '
      + 'clear would be a silent downgrade',
    );
  }

  return {
    host: resolved.host,
    port: resolved.port,
    bind, listen, auth,
    token: token ?? randomBytes(16).toString('hex'),
    graceMs, maxSessions, allowOrigins,
    ...(cert !== undefined && key !== undefined
      ? { tls: { cert, key, ...(chain !== undefined ? { chain } : {}) } } : {}),
    ...(replay !== undefined ? { replay } : {}),
    logActions,
    hostTls,
    ...(model !== undefined ? { model } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
  };
}
