# @tn3270/tui — the terminal client

A c3270-style terminal front end for TN3270 hosts.

```sh
npm install -g @tn3270/tui
```

```sh
tn3270 -insecure -model 3278-2-E 127.0.0.1:3271
```

`-insecure` is there because TLS is on by default and plaintext Hercules hosts need it
turned off; against a modern host leave it off. `Ctrl-]` quits (`Ctrl-C` is the Clear AID),
`Ctrl-K` opens the keypad list, and `Ctrl-T` opens the `IND$FILE` transfer form. See the
root README's *Using the TUI* section (https://github.com/athornton/tn3270#readme) for
every flag and chord.

### Starting with no host

Run `tn3270` with no host at a real terminal and it prompts for one — Host, Model, TLS — instead
of the usage error, and on a failed connect asks again with the last answers as defaults, so a
retry is just Enter until the field that needs fixing. `Ctrl-D` or `Ctrl-C` at any prompt quits,
exit status 1. This only happens when stdin and stdout are both terminals; a script or a pipe
still gets the usage error, exit 2, with no host, as before. See the root README's *Using the
TUI* section for the full transcript and the TLS wording.
