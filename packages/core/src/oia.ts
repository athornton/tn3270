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
  /**
   * Connected but the host has not written yet, so there is nothing to type
   * into. x3270 calls this KL_AWAITING_FIRST and sets it both on connect and on
   * entering 3270 mode, with the comment "Wait for any output or a
   * WCC(restore) from the host" (kybd.c:584, :613). Without it, a script that
   * connects and immediately types races the host's first screen — verified
   * against a live VM/370: String() was refused because the keyboard was busy,
   * while Wait(Unlock) had already returned because nothing was pending.
   */
  AwaitingFirstWrite = 'awaitingfirst',
  /**
   * We answered a Read Partition (Query) and the host has not written since.
   *
   * GA23-0059 p. 5-53 lists this as step 1 of Read Partition processing
   * (pages.txt:6413): "1. The enter-inhibit condition is raised." The host has
   * asked a question about the device and considers the screen frozen until it
   * writes again, so the operator must not type into it.
   *
   * x3270 calls this KL_ENTER_INHIBIT, "Awaiting unlock after QueryReply"
   * (include/kybd.h:45), raised by kybd_inhibit(true) (Common/kybd.c:528) from
   * query_reply_end() (Common/sf.c:926-930).
   *
   * NOTE THE DIVERGENCE FROM THE MANUAL'S LETTER, which we take deliberately.
   * p. 3-22 (pages.txt:2562-2564) says: "Any enter action, including a trigger
   * action, sets the enter-inhibit condition for the device (logical
   * terminal). The enter-inhibit condition allows keystroking but does / not
   * allow an enter action." — i.e. a device-wide condition that blocks only AID
   * generation, and it adds "There is no / indicator associated with the
   * enter-inhibit condition" (pages.txt:2569-2570). We instead refuse
   * keystroking outright and show an indicator, as x3270 does.
   *
   * That is right for a device with no explicit partitions, by the manual's own
   * reasoning two lines later (pages.txt:2565-2567): "The enter-inhibit
   * condition has significance only for the partitions other than INPID /
   * because the input-inhibit conditions associated with INPID (for example,
   * TWAIT, / PWAIT or System Lock) override the enter-inhibit condition." The
   * weak reading exists so an operator can "jump from INPID to one of the
   * other partitions and enter data in that partition" (pages.txt:2568-2569).
   * We support only the implicit partition 0, so the partition being read IS
   * INPID, and the manual's own rule is that the stronger inhibit governs
   * there. x3270 implements no partitions either, which is presumably why it
   * made the same call.
   */
  EnterInhibit = 'enterinhibit',
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

  /**
   * Raise the enter-inhibit condition, without demoting a stronger inhibit.
   *
   * Step 1 of Read Partition processing, GA23-0059 p. 5-53 (pages.txt:6413):
   * "1. The enter-inhibit condition is raised."
   *
   * WHY IT YIELDS TO AN EXISTING INHIBIT. x3270 keeps every lock reason as its
   * own bit in one word, so kybd_inhibit(true) — `kybdlock_set(KL_ENTER_INHIBIT,
   * "kybd_inhibit")` (Common/kybd.c:528) — cannot possibly erase another
   * reason. We hold a single state, so the equivalent has to be written down,
   * and "weakest loses" is the faithful translation: the operator stays
   * refused either way (isInhibited covers both), while the state that survives
   * is the one whose release rule is broader.
   *
   * Concretely this matters twice, and in both cases keeping the incumbent is
   * the right answer:
   *
   *  - AwaitingFirstWrite, the case TSO actually produces, since it queries
   *    before writing anything. Enter-inhibit is released by the next Erase/
   *    Write, EWA, EAU or Write; AwaitingFirstWrite is released by those AND by
   *    a WCC keyboard-restore, so it is released by a strictly larger set of
   *    records and must not be dropped in favour of the narrower rule. It is
   *    also the truer description — there is no screen yet at all, rather than
   *    a screen that is merely frozen. x3270 orders its status line the same
   *    way, testing KL_AWAITING_FIRST before KL_ENTER_INHIBIT in all four
   *    renderers (c3270/screen.c:2383-2386).
   *
   *  - ProgramCheck, which the operator must clear with Reset and which
   *    reports a real protocol fault. Letting a routine query overwrite it
   *    would hide that fault behind an ordinary wait.
   */
  enterInhibit(): void {
    if (this.isInhibited()) return;
    this.keyboard = KeyboardState.EnterInhibit;
  }

  /**
   * Release the enter-inhibit condition and nothing else.
   *
   * x3270 clears the one bit — `kybdlock_clr(KL_ENTER_INHIBIT, "kybd_inhibit")`
   * (Common/kybd.c:533) — so this must not be reset(), which would also clear a
   * program check the host never acknowledged. Narrow by construction: it does
   * nothing unless enter-inhibit is the state we are actually in, which is also
   * what makes it safe to call on every write.
   */
  releaseEnterInhibit(): void {
    if (this.keyboard !== KeyboardState.EnterInhibit) return;
    this.keyboard = KeyboardState.Unlocked;
  }

  /**
   * True for the inhibits the OPERATOR caused, as opposed to the host.
   *
   * x3270 groups exactly these behind one mask, `KL_OERR_MASK` (0x000f), whose
   * declaration is commented "Operator errors:" and whose four members are
   * KL_OERR_PROTECTED, KL_OERR_NUMERIC, KL_OERR_OVERFLOW and KL_OERR_DBCS
   * (include/kybd.h:35-39). We have no DBCS, so three.
   *
   * The distinction is load-bearing for input: an operator error is cleared by
   * the operator's own next sensible keystroke, while a host-imposed lock is
   * cleared only by the host. See Keyboard.type.
   */
  isOperatorError(): boolean {
    return this.keyboard === KeyboardState.ProtectedField
      || this.keyboard === KeyboardState.Numeric
      || this.keyboard === KeyboardState.Overflow;
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
      case KeyboardState.AwaitingFirstWrite:
        parts.push('X Wait');
        break;
      // "X Wait", the same text as AwaitingFirstWrite, because that is exactly
      // what x3270 shows. Three of its four status renderers spell it out
      // literally — `} else if (kybdlock & (KL_ENTER_INHIBIT | KL_BID)) {
      // other_msg = "X Wait";` at c3270/screen.c:2385-2386, identically at
      // wc3270/screen.c:3122-3123 and Common/vstatus.c:279-280 (voia_msg). The
      // fourth routes through a message table, `do_msg(TWAIT)`
      // (x3270/status.c:643-645), whose enumerator is declared `TWAIT, /* X
      // Wait */` (x3270/status.c:212). b3270 agrees over the wire, mapping the
      // bit to OiaLockTwait — `#define OiaLockTwait "twait"`
      // (include/b3270proto.h:194) — with the note "OiaLockInhibit is now
      // deprecated, we use OiaLockTwait instead" (Common/b3270/status.c:199).
      //
      // So there IS a sensible equivalent and we match it rather than invent
      // one. The two remain distinct KeyboardStates despite rendering alike,
      // because they are released by different records; the operator cannot
      // act on the difference, but the protocol does.
      case KeyboardState.EnterInhibit:
        parts.push('X Wait');
        break;
      case KeyboardState.Unlocked:
        break;
    }

    if (this.waitingForHost) parts.push('X Wait');
    if (this.insertMode) parts.push('^');
    return parts.join('  ');
  }
}
