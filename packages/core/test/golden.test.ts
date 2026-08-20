import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Session } from '../src/session.js';
// `replayFixture` used to live here. It moved to helpers/ so render.test.ts could
// share it rather than reimplement trace parsing; see that file's header.
import { replayFixture, tracesDir, screensDir } from './helpers/trace.js';

/** Render a screen the same way tools/make-golden.mjs does. */
function render(session: Session): string {
  const cols = session.screen.cols;
  const out: string[] = [];
  out.push('# Golden screen. Regenerate with tools/make-golden.mjs; review the diff.');
  out.push(`# cursor: ${session.screen.cursor}  oia: ${session.oia.toText()}`);
  out.push('+' + '-'.repeat(cols) + '+');
  for (const l of session.screen.toText().split('\n')) out.push('|' + l + '|');
  out.push('+' + '-'.repeat(cols) + '+');
  return out.join('\n') + '\n';
}

describe('golden screens', () => {
  const traces = existsSync(tracesDir)
    ? readdirSync(tracesDir).filter((f) => f.endsWith('.trace'))
    : [];

  it('has at least one fixture', () => {
    expect(traces.length).toBeGreaterThan(0);
  });

  it('every fixture actually renders something', () => {
    // A trace missing its negotiation replays as a blank screen rather than
    // failing, and a golden generated from it would enshrine the blankness.
    // This catches that class of fixture bug for every fixture, forever.
    for (const trace of traces) {
      const session = replayFixture(trace);
      expect(session.screen.toText().trim(), `${trace} rendered a blank screen`)
        .not.toBe('');
    }
  });

  for (const trace of traces) {
    it(`replays ${trace} to its golden screen`, () => {
      const golden = join(screensDir, basename(trace, '.trace') + '.txt');
      const actual = render(replayFixture(trace));
      if (!existsSync(golden)) {
        throw new Error(
          `missing golden file ${golden}\n` +
          `generate it with:\n  node tools/make-golden.mjs ${join(tracesDir, trace)} > ${golden}\n` +
          `then READ the output before committing it. Current rendering:\n${actual}`,
        );
      }
      expect(actual).toBe(readFileSync(golden, 'utf8'));
    });
  }
});

describe('synthetic panel specifics', () => {
  it('shows the intensified heading and the input prompt', () => {
    const s = replayFixture('synthetic-ispf-like.trace');
    expect(s.screen.rowText(1)).toContain('MENU');
    expect(s.screen.rowText(2)).toContain('OPTION ===>');
  });

  it('draws the rule with the RA fill character', () => {
    const s = replayFixture('synthetic-ispf-like.trace');
    const row3 = s.screen.rowText(3);
    expect(row3.startsWith('-')).toBe(true);
    expect(row3.trimEnd().length).toBeGreaterThan(50);
  });

  it('leaves the cursor in the unprotected input field', () => {
    const s = replayFixture('synthetic-ispf-like.trace');
    const f = s.screen.fieldAt(s.screen.cursor);
    expect(f).not.toBeNull();
    expect(f!.protected).toBe(false);
  });

  it('derives the expected field structure', () => {
    const s = replayFixture('synthetic-ispf-like.trace');
    const fields = s.screen.fields();
    expect(fields.length).toBeGreaterThanOrEqual(3);
    expect(fields.filter((f) => f.protected).length).toBeGreaterThanOrEqual(2);
    expect(fields.filter((f) => !f.protected).length).toBeGreaterThanOrEqual(1);
  });
});
