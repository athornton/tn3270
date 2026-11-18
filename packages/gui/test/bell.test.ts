import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

describe('the GUI rings the host alarm (core emits it; x3270 ring_bell, screen.c:5457)', () => {
  it('main beeps, or sends flash with -visualbell', () => {
    const main = read('../src/main.ts');
    expect(main).toMatch(/session\.on\('alarm'[\s\S]{0,400}shell\.beep\(\)/);
    expect(main).toMatch(/session\.on\('alarm'[\s\S]{0,400}webContents\.send\('flash'\)/);
  });
  it('the preload exposes onFlash, and the renderer subscribes it to flash()', () => {
    expect(read('../src/preload.cts')).toMatch(/onFlash[\s\S]{0,200}ipcRenderer\.on\('flash'/);
    expect(read('../../canvas/src/renderer.ts')).toMatch(/onFlash\?\.\(\s*\(\)\s*=>\s*\{?\s*flash\(\)/);
  });
});
