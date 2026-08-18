import type { Session } from '@tn3270/core';
import { KeyboardState } from '@tn3270/core';

/**
 * s3270's 12-field status line, verbatim, because existing automation parses it
 * positionally. See the table in the plan for field meanings.
 */
export function formatStatus(
  session: Session,
  host: string | undefined,
  elapsedSeconds: number | undefined,
): string {
  const s = session.screen;

  const keyboard = session.oia.keyboard === KeyboardState.Unlocked
    ? 'U'
    : session.oia.keyboard === KeyboardState.ProgramCheck ? 'E' : 'L';

  const formatting = s.isFormatted() ? 'F' : 'U';

  const field = s.fieldAt(s.cursor);
  const protection = field !== null && field.protected ? 'P' : 'U';

  const connection = session.isConnected() && host !== undefined
    ? `C(${host})`
    : 'N';

  const mode = !session.isConnected()
    ? 'N'
    : session.is3270Mode() ? 'I' : 'P';

  const { row, col } = s.toRowCol(s.cursor);

  return [
    keyboard,
    formatting,
    protection,
    connection,
    mode,
    '2',
    String(s.rows),
    String(s.cols),
    String(row - 1),
    String(col - 1),
    '0x0',
    elapsedSeconds === undefined ? '-' : elapsedSeconds.toFixed(3),
  ].join(' ');
}
