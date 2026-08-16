/**
 * Operator Information Area state.
 *
 * Deliberately STATE, not rendered text: stage 1 has no GUI but still needs
 * somewhere to record a program check, and stage 2's renderer formats this same
 * object into the status line. toText() exists for the CLI and for tests, and
 * follows x3270's wording so the two are comparable.
 */

export enum KeyboardState {
  Unlocked = 'unlocked',
  ProtectedField = 'protected',
  Numeric = 'numeric',
  Overflow = 'overflow',
  ProgramCheck = 'progcheck',
  SystemWait = 'systemwait',
  MinusFunction = 'minusfunction',
}

export class Oia {
  connected = false;
  tn3270Mode = false;
  waitingForHost = false;
  insertMode = false;
  keyboard: KeyboardState = KeyboardState.Unlocked;
  /** Set alongside KeyboardState.ProgramCheck. */
  programCheckCode: number | undefined;
  /** Host asked for the alarm on the last write. */
  alarm = false;

  inhibit(state: KeyboardState): void {
    this.keyboard = state;
  }

  programCheck(code: number): void {
    this.keyboard = KeyboardState.ProgramCheck;
    this.programCheckCode = code;
  }

  /** The Reset key clears an input inhibit. */
  reset(): void {
    this.keyboard = KeyboardState.Unlocked;
    this.programCheckCode = undefined;
  }

  /** True when the operator may not type. */
  isInhibited(): boolean {
    return this.keyboard !== KeyboardState.Unlocked;
  }

  /** x3270-style single-line rendering. */
  toText(): string {
    const parts: string[] = [];
    if (!this.connected) {
      parts.push('X Disconnected');
    } else if (this.tn3270Mode) {
      parts.push('4 A');
    } else {
      parts.push('4');
    }

    switch (this.keyboard) {
      case KeyboardState.ProgramCheck:
        parts.push(`X PROG${this.programCheckCode ?? 0}`);
        break;
      case KeyboardState.ProtectedField:
        parts.push('X Protected');
        break;
      case KeyboardState.Numeric:
        parts.push('X Numeric');
        break;
      case KeyboardState.Overflow:
        parts.push('X Overflow');
        break;
      case KeyboardState.MinusFunction:
        parts.push('X -f');
        break;
      case KeyboardState.SystemWait:
        parts.push('X SYSTEM');
        break;
      case KeyboardState.Unlocked:
        break;
    }

    if (this.waitingForHost) parts.push('X Wait');
    if (this.insertMode) parts.push('^');
    return parts.join('  ');
  }
}
