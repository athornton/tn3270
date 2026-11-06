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
