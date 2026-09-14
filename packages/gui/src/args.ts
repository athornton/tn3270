import {
  resolveHostSpec, takeTlsFlag, resolveTls, TLS_USAGE,
  type TlsFlags, type TlsOptions,
} from '@tn3270/frontend';

/**
 * Parse the GUI's argument vector.
 *
 * THE FLAGS ARE THE TUI'S, AND NOT BY COPYING THEM. Every rule here comes from
 * `@tn3270/frontend` -- `takeTlsFlag`, `resolveTls`, `resolveHostSpec` -- which is the
 * whole reason that package exists. Re-implementing them would be the third copy of one
 * rule, and the two defects fixed on 2026-08-28 were both exactly that.
 *
 * Deliberately NOT the same as the TUI in one respect: there is no `--colors`. A canvas has
 * no terminfo depth to detect; it draws 24-bit RGB from the 3279 palette.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface GuiArgs {
  model?: string;
  terminalType?: string;
  /** The bare hostname: prefixes and the LU list are stripped by `resolveHostSpec`. */
  host?: string;
  /** Resolved and range-checked. Absent only when no host was given at all. */
  port?: number;
  /** LU names from the host argument, in the order written. Empty if none. */
  lus?: readonly string[];
  /** How the socket is made. Absent only before `resolveTls` has run. */
  tls?: TlsOptions;
  /** Offer TN3270E. Absent means the default, which is on. */
  tn3270e?: boolean;
}

export const USAGE =
  `usage: tn3270-gui [-model M] [--terminal-type T] [-tn3270e on|off] `
  + `${TLS_USAGE} [prefix:][LU,LU@]host[:port]`;

export function parseGuiArgs(argv: readonly string[]): GuiArgs {
  const args: GuiArgs = {};
  const tlsFlags: TlsFlags = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    const eaten = takeTlsFlag(tlsFlags, flag, value, (m) => new UsageError(m));
    if (eaten !== undefined) {
      i += eaten;
      continue;
    }
    switch (flag) {
      case '-tn3270e': {
        if (value === undefined) throw new UsageError('-tn3270e needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-tn3270e takes on or off, not ${JSON.stringify(value)}`);
        }
        args.tn3270e = value === 'on';
        i++;
        break;
      }
      case '-model':
        if (value === undefined) throw new UsageError('-model needs a value, e.g. -model 3278-2-E');
        args.model = value;
        i++;
        break;
      case '--terminal-type':
        if (value === undefined) {
          throw new UsageError('--terminal-type needs a value, e.g. --terminal-type IBM-DYNAMIC');
        }
        args.terminalType = value;
        i++;
        break;
      default:
        if (flag.startsWith('-')) {
          throw new UsageError(`unrecognised argument ${JSON.stringify(flag)}`);
        }
        if (args.host !== undefined) {
          throw new UsageError(
            `more than one host given: ${JSON.stringify(args.host)} and ${JSON.stringify(flag)}`);
        }
        args.host = flag;
        break;
    }
  }

  args.tls = resolveTls(tlsFlags, (m) => new UsageError(m));

  if (args.host === undefined) throw new UsageError(USAGE);

  const raw = args.host;
  const spec = resolveHostSpec(raw, (m) => new UsageError(m));
  args.host = spec.host;
  args.port = spec.port;
  args.lus = spec.lus;

  // Both the host and the flags are in argv here, so these contradictions are caught before
  // a socket is opened -- the same checks the TUI makes, for the same reasons.
  if (spec.tlsRequested && args.tls.kind === 'plaintext') {
    throw new UsageError(`${raw} asks for TLS with the L: prefix, but -insecure disables TLS`);
  }
  if (spec.tn3270e === false) {
    if (args.tn3270e === true) {
      throw new UsageError(
        `${raw} has the N: prefix, which means no TN3270E, but -tn3270e on asks for it. `
        + 'Drop one of them rather than leaving it ambiguous.');
    }
    args.tn3270e = false;
  }
  return args;
}
