### Bug fixes

- `Mode=ascii` file transfers now convert line ends locally, as x3270 does, in every front end
  (GUI, TUI, CLI and web gateway): a receive drops every CR and `^Z` wherever they appear, and a
  send puts a CR before each LF that does not already follow one. `Cr=keep` turns both off; the
  `Cr` names are not directional. A received text file now gets LF line ends and no trailing `^Z`;
  an LF-only file is now sent with CRLF.
