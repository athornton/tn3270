import { describe, it, expect, vi } from 'vitest';
import { createBlinker, hasBlink, BLINK_MS } from '../src/blinker.js';

const list = (blink: boolean) => ({ width: 1, height: 1, cells: [{ blink } as never] }) as never;

describe('blinker: x3270 text_blink_it (x3270/screen.c:1411-1435)', () => {
  it('is 500 ms, and finds blinking cells in the screen or the OIA', () => {
    expect(BLINK_MS).toBe(500);
    expect(hasBlink(list(true))).toBe(true);
    expect(hasBlink(list(false))).toBe(false);
  });

  it('starts only when a frame has blinkers, flips the phase each tick and repaints', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const b = createBlinker({ repaint });
    b.frame(list(false));
    vi.advanceTimersByTime(2000);
    expect(repaint).not.toHaveBeenCalled();
    expect(b.off).toBe(false);
    b.frame(list(true));
    vi.advanceTimersByTime(500);
    expect(b.off).toBe(true);
    vi.advanceTimersByTime(500);
    expect(b.off).toBe(false);
    expect(repaint).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a new frame keeps the phase and does not restart the timer; no blinkers stops it, phase on', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const b = createBlinker({ repaint });
    b.frame(list(true));
    vi.advanceTimersByTime(400);
    b.frame(list(true));                  // a host repaint mid-period
    vi.advanceTimersByTime(100);
    expect(b.off).toBe(true);             // ticked at 500 from the FIRST frame, not 900
    b.frame(list(false));
    expect(b.off).toBe(false);            // no blinkers: back to on, so nothing stays blanked
    vi.advanceTimersByTime(5000);
    expect(repaint).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
