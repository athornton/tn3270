import { describe, it, expect } from 'vitest';
import { probeLine } from '../src/probe.js';

describe('probeLine', () => {
  it('reports both confinement signals, unconfined', () => {
    expect(probeLine({}, { windowsStore: undefined, mas: undefined })).toBe('probe: sandbox=none windowsStore=false');
  });
  it('names the macOS sandbox container id when set', () => {
    expect(probeLine({ APP_SANDBOX_CONTAINER_ID: 'io.github.athornton.tn3270' }, { windowsStore: undefined, mas: undefined }))
      .toBe('probe: sandbox=io.github.athornton.tn3270 windowsStore=false');
  });
  it('reports windowsStore true only when Electron says exactly true', () => {
    expect(probeLine({}, { windowsStore: true, mas: undefined })).toBe('probe: sandbox=none windowsStore=true');
  });
  it('an empty container id is none, not an empty name', () => {
    expect(probeLine({ APP_SANDBOX_CONTAINER_ID: '' }, { windowsStore: undefined, mas: undefined })).toBe('probe: sandbox=none windowsStore=false');
  });
});
