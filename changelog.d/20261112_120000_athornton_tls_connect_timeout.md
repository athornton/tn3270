### Bug fixes

- With TLS on (the default), a host that never answers the TCP connect is now reported as
  `cannot connect to HOST:PORT: no answer within 30 s (CONNECT_TIMEOUT)` after 30 s, exactly as
  with `-insecure`, instead of after 10 s as a host that "accepted the connection but never
  completed a TLS handshake". The 10-second handshake deadline now starts once the host accepts
  the connection.
