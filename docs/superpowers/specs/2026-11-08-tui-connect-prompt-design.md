# TUI: prompt for a host instead of a usage error — design

2026-11-08. Approved in conversation (option A, line prompts; a full-screen panel was option B and
was declined). The user's goal, in their words: "if you invoke the program with no command-line
arguments, you get offered a way to connect rather than an error/usage message." The TUI's
counterpart of `2026-11-08-connect-dialog-retry-design.md`, with the same retry behaviour.

## Today

`tn3270` with no host throws a `UsageError` carrying the full usage line, and exits 2
(`packages/tui/src/main.ts`, `run()`).

## The behaviour

When no host is given AND stdin and stdout are both terminals:

```
$ tn3270
Host: hercules:3270
Model [3278-2-E]:
TLS [Y/n]:
Connecting to hercules:3270...
<the failure message, prompt wording>
Host [hercules:3270]:
Model [3278-2-E]:
TLS [Y/n]: n
Connecting to hercules:3270...
```

and then the full-screen terminal starts exactly as it does for `tn3270 host`.

- **Defaults are the last answers.** The first round's defaults are the command line's (`-model`,
  and TLS on unless `-insecure` was given) or the product defaults; every later round's are what
  was typed in the round before, so a retry is Enter until the field that needs changing.
- **Host has no default on the first round**; an empty answer there re-asks rather than failing.
- **Model** accepts any name in `KNOWN_MODELS`; anything else is answered with the known names and
  re-asked. **TLS** accepts y/yes/n/no in any case, and Enter for the default.
- **Ctrl-D (EOF) or Ctrl-C at any prompt quits**, exit status 1 (nothing was connected), with a
  newline so the shell prompt starts clean.
- **A failed connect** prints the failure message and starts a new round. The TLS plaintext-host
  messages get a third wording, `'prompt'`, whose remedy is `answer n to TLS` (alongside today's
  `'flag'` → `-insecure` and `'dialog'` → `Untick TLS in the Connect dialog`).
- **Other flags still apply.** `tn3270 -scheme green --colors 16` prompts too, and those flags are
  used for the session.

When stdin or stdout is NOT a terminal (a script, a pipe), nothing changes: no host is the usage
error with exit 2, as today. A script never meets a prompt.

## Design

### Shared form-to-argv (`frontend`)

`packages/gui/src/connectForm.ts` (`ConnectForm`, `dialogToArgv`) moves to `packages/frontend`
unchanged, since it is pure; the GUI imports it from there. The TUI turns its answers into a
`ConnectForm` and runs the result through its own `parseArgs`, so the prompt cannot accept a host
the command line refuses, or refuse one it accepts — the rule the GUI dialog already follows.

### `describeTlsError` gains `'prompt'` (`frontend/src/tls.ts`)

`TlsRemedy = 'flag' | 'dialog' | 'prompt'`. Only the two plaintext-host cases change wording, as
for `'dialog'`; the certificate cases keep naming flags.

### The prompt loop (`tui/src/connectPrompt.ts`, new)

    async function promptConnect(
      commandLine: readonly string[],
      io: { input: Readable; output: Writable },
      attempt: (args: TuiArgs) => Promise<Session>,   // connectFirst, in production
    ): Promise<Session | undefined>                    // undefined: the user quit

It uses `node:readline/promises` on `io` for line editing. Each round: ask the three questions,
build `dialogToArgv(form, commandLine)`, `parseArgs` it (a `UsageError` is printed and the round
restarts), then `attempt`. A rejected `attempt` prints `explain`-style text built with
`describeTlsError(..., 'prompt')` / `describeConnectError` from the target just tried, and loops.
The readline interface is closed before returning a session, so raw mode and the alternate screen
start on a clean stdin.

A failed attempt's session is discarded, and the next round builds a new one: nothing in the TUI is
wired before the first connect, so the GUI design's connect-time TLS choice is not needed here.

### `run()` (`tui/src/main.ts`)

`parseArgs` is unchanged. If it yields no host: when `process.stdin.isTTY && process.stdout.isTTY`,
`promptConnect(argv, process, a => connectFirst(a, host.stderr))`, quitting with status 1 on
`undefined`; otherwise the usage error, as now. Everything after the first connect is today's code.

## Testing

- **Unit, `promptConnect`**, with in-memory streams and a fake `attempt`: one round to success;
  defaults carried from round 1 to round 2; empty host re-asked; unknown model re-asked with the
  list; TLS answers y/n/Enter; EOF quits with `undefined`; a parse error re-asks; a rejected attempt
  prints the `'prompt'` wording and the second round's args carry `tls: plaintext`.
- **`describeTlsError('prompt')`**: both plaintext-host cases say `answer n to TLS`; the
  certificate cases are unchanged.
- **`run()` with no host and no TTY** still throws the usage error (the script case).
- **End to end in a pseudo-terminal** (`packages/tui/scripts`): a Hercules-like server that opens
  with `IAC DO TERMINAL-TYPE`; answer TLS `Y`, see the prompt-wording failure and a new round;
  answer `n`, and the server must see `IAC WILL TERMINAL-TYPE` and the full screen must start.
- **The GUI** keeps passing its own suites after `connectForm` moves (import path only).
- **Live, by the user**: `tn3270` with no arguments against the Hercules host, TLS ticked then not.

## Documentation

README (the TUI section and *Installing*), `packages/tui/README.md`, HANDOFF. Release as 0.1.1 with
the GUI Connect-dialog retry and the Node 20.19 floor.
