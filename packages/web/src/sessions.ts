import { randomUUID } from 'node:crypto';
import type { Session } from '@tn3270/core';

/**
 * Which 3270 sessions exist, who is attached, and what happens when nobody is.
 *
 * ## THE GRACE WINDOW IS NOT A CONVENIENCE
 *
 * A socket closing does not end the 3270 session. On VM/370 a logged-on session left running is
 * not "busy": the next LOGON RECONNECTS to the still-running virtual machine, past its IPL, so a
 * fixed opening sequence lands at CP READ and CP reads every later command. That trap has already
 * produced three false failures in this project. Without reattachment, every wifi handoff and
 * laptop sleep would arm it.
 *
 * ## A DETACHED SESSION STILL COSTS
 *
 * It holds a socket to the host, so it counts against `maxSessions` until it expires. Excluding
 * it would let a client cycle connections to hold unbounded host resources.
 */
export interface SessionHandle {
  readonly session: Session;
  /** Ends the 3270 connection. Called on grace expiry and on shutdown. */
  close(): void;
}

export interface RegistryOptions {
  /** Builds a live 3270 session. Injected so tests need no host and no socket. */
  readonly factory: (id: string) => SessionHandle;
  readonly graceMs: number;
  readonly maxSessions: number;
}

interface Entry {
  readonly handle: SessionHandle;
  attached: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AttachResult {
  readonly id: string;
  readonly session: Session;
  /** True when this is a NEW session, so the caller knows to send a fresh id. */
  readonly created: boolean;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: RegistryOptions) {}

  /**
   * Attach a client. An unknown or absent id yields a NEW session: a stale `sessionStorage` id
   * after a server restart is ordinary, and erroring would strand the browser with no way back.
   */
  attach(sessionId: string | undefined): AttachResult {
    if (sessionId !== undefined) {
      const found = this.entries.get(sessionId);
      // Only a DETACHED entry is reattachable. An id naming a session someone is currently using
      // falls through to a new session rather than being handed over, so a leaked id cannot become
      // a way to read or type into another operator's logged-on session.
      if (found !== undefined && !found.attached) {
        // Cancel the reaper FIRST. Leaving it armed would drop a live session seconds after a
        // successful reconnect, which reads as a host problem rather than as ours.
        this.disarm(found);
        found.attached = true;
        return { id: sessionId, session: found.handle.session, created: false };
      }
    }

    if (this.entries.size >= this.opts.maxSessions) {
      throw new Error(`too many sessions (${this.opts.maxSessions}); try again later`);
    }

    const id = randomUUID();
    const handle = this.opts.factory(id);
    this.entries.set(id, { handle, attached: true });
    return { id, session: handle.session, created: true };
  }

  /**
   * The socket closed. Keep the 3270 session alive briefly in case they come back.
   *
   * A duplicate call for an already-detached session is a no-op, not a second reaper: a socket can
   * report both `error` and `close`. Two timers for one entry would mean two `close()` calls and a
   * second `delete` landing after the id had been reused, and re-arming here would also let a
   * flapping link extend the window indefinitely.
   */
  detach(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined || !entry.attached) return;
    entry.attached = false;
    entry.timer = setTimeout(() => {
      // Only ever reached by the one outstanding timer for this entry -- `attach` disarms it
      // before flipping `attached` back, so this closure cannot be stale. Delete before closing,
      // so a throwing `close()` cannot leave a dead session occupying a slot in the cap.
      this.entries.delete(id);
      delete entry.timer;
      entry.handle.close();
    }, this.opts.graceMs);
  }

  /**
   * Shutdown: end every session, attached or not, and leave no timer behind to hold the event loop
   * open. Deleting during `for...of` over a `Map` is defined behaviour -- the iterator visits each
   * remaining entry in insertion order and simply does not revisit a deleted one.
   */
  closeAll(): void {
    for (const [id, entry] of this.entries) {
      this.disarm(entry);
      this.entries.delete(id);
      entry.handle.close();
    }
  }

  /** Drop the grace timer, if one is outstanding. Written once so no caller can forget half of it. */
  private disarm(entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      // `exactOptionalPropertyTypes` is on: `delete` is how an optional property goes back to
      // absent, since assigning `undefined` to `timer?: Timeout` is a type error.
      delete entry.timer;
    }
  }
}
