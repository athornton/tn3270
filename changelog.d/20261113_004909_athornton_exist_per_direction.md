### Bug fixes

- On a send, the form's default `Exist=keep` did not keep anything: IND$FILE replaced the host
  file. A send now offers Replace or Append; the browser no longer shows `Exist` on a receive,
  where the browser's own download handling decides.
