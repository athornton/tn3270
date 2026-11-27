import { describe, it, expect } from 'vitest';
import { maxScale, currentScale, stepScale, targetScale } from '../src/viewScale.js';

// Chosen so the full work area and Fit's 80% of it give DIFFERENT scales, worked by hand:
// whole area 1920/640 = 3, 1080/300 = 3.6 -> 3; 80% is 1536x864, 1536/640 = 2.4, 864/300 = 2.88 -> 2.
const list = { width: 640, height: 300 };
const area = { width: 1920, height: 1080 };

describe('viewScale', () => {
  it('maxScale is the largest scale that fits the WHOLE work area, not Fit\'s 80%', () => {
    expect(maxScale(list, area)).toBe(3);
  });
  it('currentScale reads the window back, floored, never below 1', () => {
    expect(currentScale(list, { width: 1500, height: 900 })).toBe(2);
    expect(currentScale(list, { width: 10, height: 10 })).toBe(1);
  });
  it('stepScale moves one step and clamps to 1..max', () => {
    expect(stepScale(1, -1, 3)).toBe(1);
    expect(stepScale(1, +1, 3)).toBe(2);
    expect(stepScale(2, -1, 3)).toBe(1);
    expect(stepScale(3, +1, 3)).toBe(3);
    // Above max only when the display shrank: Smaller goes one below the largest that fits.
    expect(stepScale(5, -1, 3)).toBe(2);
    expect(stepScale(5, +1, 3)).toBe(3);
  });
  it('targetScale: undefined is Fit (80%), a choice is clamped to the whole area', () => {
    expect(targetScale(undefined, list, area)).toBe(2);
    expect(targetScale(1, list, area)).toBe(1);
    expect(targetScale(3, list, area)).toBe(3);
    expect(targetScale(9, list, area)).toBe(3);
  });
});
