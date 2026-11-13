import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootTransfer } from '../src/transferBoot.js';

/**
 * `bootTransfer` driven end to end through a FAKE DOCUMENT, for the two decisions only it makes.
 *
 * `endTransfer` (`transferBridge.test.ts`) owns every choice about the download, but two inputs
 * to it are made HERE, in the one file that had no unit test: the `browserReceive`
 * option handed to `createTransferUi`, and the `saveName` handed to `endTransfer`. MEASURED
 * 2026-11-12: deleting the option, or passing `saveName: 'download.bin'`, left all 3644 tests
 * green. The real-browser harness would catch both, but it is run by hand.
 *
 * THE FAKE IS AS SMALL AS THIS FILE'S DOM USE: `vitest.config.ts` sets `environment: 'node'` and
 * jsdom is not a dependency. `HTMLInputElement` and `HTMLSelectElement` are stubbed as globals,
 * because `transferBoot.ts`'s focus memo tests `instanceof` against them, and the download is
 * observed where it really happens: an anchor's `click()`, with its `download` name, and the bytes
 * of the `Blob` handed to `URL.createObjectURL`.
 */

type Listener = () => void;

class FakeEl {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly listeners = new Map<string, Listener[]>();
  id = '';
  value = '';
  textContent: string | null = '';
  hidden = false;
  disabled = false;
  selected = false;
  href = '';
  download = '';
  type = '';
  htmlFor = '';
  clicks = 0;
  oncancel: Listener | null = null;
  onchange: Listener | null = null;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  constructor(readonly tagName: string) {}
  append(...els: FakeEl[]): void { this.children.push(...els); }
  replaceChildren(): void { this.children.length = 0; }
  addEventListener(kind: string, fn: Listener): void {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), fn]);
  }
  fire(kind: string): void { for (const fn of this.listeners.get(kind) ?? []) fn(); }
  click(): void { this.clicks += 1; this.fire('click'); }
  focus(): void {}
  setSelectionRange(): void {}
  /** Every descendant, depth first. */
  all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel: string): FakeEl | null {
    // Only the shape `restoreFocus` asks: `[data-field="x"][data-role="y"]`.
    const want = [...sel.matchAll(/\[data-(\w+)="([^"]*)"\]/g)].map((m) => [m[1]!, m[2]!]);
    return this.all().find((e) => want.every(([k, v]) => e.dataset[k!] === v)) ?? null;
  }
  querySelectorAll(_sel: string): FakeEl[] {
    return this.all().filter((e) => e.tagName === 'input' || e.tagName === 'select');
  }
}
class FakeInput extends FakeEl {}
class FakeSelect extends FakeEl {}

function harness(): {
  sent: { kind: string; keywords?: string[] }[];
  anchors: FakeEl[];
  blobs: Blob[];
  status: FakeEl;
  boot: ReturnType<typeof bootTransfer>;
  field: (id: string) => FakeEl | undefined;
  start: () => Promise<void>;
} {
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLSelectElement', FakeSelect);
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    blobs.push(b as Blob);
    return `blob:fake/${blobs.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const byId = new Map<string, FakeEl>();
  for (const id of [
    'transfer-file', 'transfer-status', 'transfer-fields',
    'transfer-start', 'transfer-browse', 'transfer-cancel',
  ]) byId.set(id, new FakeEl(id === 'transfer-file' ? 'input' : 'div'));
  const anchors: FakeEl[] = [];
  const doc = {
    activeElement: null,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => {
      const el = tag === 'input' ? new FakeInput(tag) : tag === 'select' ? new FakeSelect(tag) : new FakeEl(tag);
      if (tag === 'a') anchors.push(el);
      return el;
    },
  };
  const sent: { kind: string; keywords?: string[] }[] = [];
  const boot = bootTransfer(doc as unknown as Document, (t) => { sent.push(JSON.parse(t)); });
  const fields = byId.get('transfer-fields')!;
  const field = (id: string): FakeEl | undefined =>
    fields.children.find((e) => e.dataset['field'] === id && e.dataset['role'] === 'value');
  const start = async (): Promise<void> => {
    byId.get('transfer-start')!.fire('click');
    // `ui.start()` awaits `submit`, which resolves at once for a receive.
    await new Promise((r) => { setTimeout(r, 0); });
  };
  return { sent, anchors, blobs, status: byId.get('transfer-status')!, boot, field, start };
}

/** Set the form up for a VM receive of `NAP H A2`, through the elements the operator uses. */
function receiveNapH(h: ReturnType<typeof harness>): void {
  const direction = h.field('direction')!;
  if (direction.value !== 'receive') { direction.value = 'receive'; direction.fire('change'); }
  const host = h.field('host')!;
  host.value = 'vm';
  host.fire('change');
  const hostFile = h.field('hostFile')!;
  hostFile.value = 'NAP H A2';
  hostFile.fire('input');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bootTransfer: a browser receive', () => {
  it('has no Local file field, and submits the name derived from the host file', async () => {
    const h = harness();
    receiveNapH(h);
    expect(h.field('localFile'), 'a receive draws no Local file field').toBeUndefined();
    await h.start();
    const start = h.sent.find((m) => m.kind === 'transferStart');
    expect(start?.keywords).toContain('LocalFile=nap.h');
  });

  it('downloads ONCE on completion, under the derived name, with the bytes received', async () => {
    const h = harness();
    receiveNapH(h);
    await h.start();
    h.boot.onMessage({ kind: 'transferData', seq: 0, total: 3, bytes: new Uint8Array([0x4e, 0x41, 0x50]) });
    expect(h.anchors, 'nothing downloads before transferDone').toHaveLength(0);
    h.boot.onMessage({ kind: 'transferDone', ok: true, bytes: 3 });
    expect(h.anchors.map((a) => [a.download, a.clicks])).toEqual([['nap.h', 1]]);
    expect(h.blobs).toHaveLength(1);
    expect(new Uint8Array(await h.blobs[0]!.arrayBuffer())).toEqual(new Uint8Array([0x4e, 0x41, 0x50]));
    expect(h.status.textContent).toBe('received 3 bytes; downloaded as nap.h');
    expect(h.boot.hasUnsaved(), 'nothing left for the close guard to ask about').toBe(false);
  });

  it('downloads NOTHING when the gateway reports failure', async () => {
    const h = harness();
    receiveNapH(h);
    await h.start();
    h.boot.onMessage({ kind: 'transferData', seq: 0, total: 1, bytes: new Uint8Array([1]) });
    h.boot.onMessage({ kind: 'transferDone', ok: false, error: 'host said no' });
    expect(h.anchors).toHaveLength(0);
    expect(h.status.textContent).toMatch(/host said no/);
  });
});
