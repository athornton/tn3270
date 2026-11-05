# @tn3270/cli — the scripting client

An s3270-compatible scripting client for TN3270 hosts. It reads commands on stdin, one per
line, and writes an s3270-style status line plus `ok`/`error` after each.

```sh
npm install -g @tn3270/cli
```

```sh
printf 'Connect(127.0.0.1:3270)\nWait(3270Mode,20)\nWait(Settle,10)\nScreenText\nQuit\n' \
  | tn3270-cli -insecure
```

See the root README's *Using the CLI* section
(https://github.com/athornton/tn3270#readme) for the full command list, `Transfer`
(`IND$FILE`), `-oversize`, and `-ddm`.
