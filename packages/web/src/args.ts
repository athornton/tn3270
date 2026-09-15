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
 * ## AUTH IS ON BY DEFAULT
 *
 * This process types at a mainframe on behalf of whoever reaches it. A token is generated when
 * none is given and printed at startup; `--auth off` exists for a fronting proxy that
 * authenticates, and main.ts warns loudly when it is used.
 *
 * ## `hostTls` IS RAW, NOT RESOLVED
 *
 * `takeTlsFlag` only records what was typed (`-insecure`, `-cafile FILE`, ...); it does not
 * decide anything. Turning that into an actual `TlsOptions` is `resolveTls`'s job, and it is
 * deliberately left to whichever later task opens the connection to the mainframe -- this file
 * is argument parsing only, per the plan for this task.
 */
export class UsageError extends Error {}

export interface WebArgs {
  readonly host: string;
  readonly port: number;
  readonly bind: string;
  readonly listen: number;
  readonly auth: boolean;
  readonly token: string;
  readonly graceMs: number;
  readonly maxSessions: number;
  readonly tls?: { cert: string; key: string; chain?: string };
  readonly replay?: string;
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

export function parseWebArgs(argv: readonly string[]): WebArgs {
  const rest: string[] = [];
  const hostTls: TlsFlags = {};
  let bind = '127.0.0.1';
  let listen = 8270;
  let auth = true;
  let token: string | undefined;
  let graceMs = 60_000;
  let maxSessions = 16;
  let cert: string | undefined;
  let key: string | undefined;
  let chain: string | undefined;
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
      case '--listen': listen = positiveInt(value(args, i, a), a); i += 1; continue;
      case '--token': token = value(args, i, a); i += 1; continue;
      case '--auth': {
        const v = value(args, i, a); i += 1;
        if (v !== 'on' && v !== 'off') throw new UsageError('--auth takes on or off');
        auth = v === 'on';
        continue;
      }
      case '--grace': graceMs = positiveInt(value(args, i, a), a) * 1000; i += 1; continue;
      case '--max-sessions': maxSessions = positiveInt(value(args, i, a), a); i += 1; continue;
      case '--tls-cert': cert = value(args, i, a); i += 1; continue;
      case '--tls-key': key = value(args, i, a); i += 1; continue;
      case '--tls-chain': chain = value(args, i, a); i += 1; continue;
      case '--replay': replay = value(args, i, a); i += 1; continue;
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
  const resolved = resolveHostSpec(rest[0]!, (m) => new UsageError(m));

  return {
    host: resolved.host,
    port: resolved.port,
    bind, listen, auth,
    token: token ?? randomBytes(16).toString('hex'),
    graceMs, maxSessions,
    ...(cert !== undefined && key !== undefined
      ? { tls: { cert, key, ...(chain !== undefined ? { chain } : {}) } } : {}),
    ...(replay !== undefined ? { replay } : {}),
    hostTls,
    ...(model !== undefined ? { model } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
  };
}
