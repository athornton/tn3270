/** Types for `tls-proxy.mjs`, so the tests that import it are typechecked too. */
export interface TlsProxyOptions {
  cert?: string | Buffer;
  key?: string | Buffer;
  certPath?: string;
  keyPath?: string;
  target: { host: string; port: number };
  listenHost?: string;
  listenPort?: number;
  onError?: (err: Error) => void;
}
export function startTlsProxy(
  opts: TlsProxyOptions,
): Promise<{ port: number; host: string; close: () => Promise<void> }>;
