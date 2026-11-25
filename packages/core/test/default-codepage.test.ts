import { describe, it, expect } from 'vitest';
import { Screen, type ScreenSnapshot } from '../src/screen.js';
import { Keyboard } from '../src/keyboard.js';
import { Oia } from '../src/oia.js';
import { Session } from '../src/session.js';
import { resolve } from '../src/render.js';
import { cp037 } from '../src/codepage.js';
import { FA } from '../src/constants.js';
import { Color } from '../src/palette.js';

// x3270's default code page is 'bracket' (Common/codepage.c:358): [ and ] are 0xAD/0xBD there,
// 0xBA/0xBB in cp037. Each default site is tested on its own, so reverting any one fails here.

function field(s: Screen): Screen {
  s.setFieldAttribute(0, 0x00);
  s.setFieldAttribute(10, FA.PROTECT);
  s.cursor = 1;
  return s;
}

describe('the default code page is bracket', () => {
  it('Keyboard on its own types [ ] as 0xAD 0xBD', () => {
    // A cp037 Screen, so only the Keyboard's own default is under test.
    const s = field(new Screen({ codePage: cp037 }));
    const k = new Keyboard(s, new Oia());
    k.type('[');
    k.type(']');
    expect([s.cellAt(1).ebcdic, s.cellAt(2).ebcdic]).toEqual([0xad, 0xbd]);
  });

  it('a Keyboard given cp037 types [ ] as 0xBA 0xBB', () => {
    const s = field(new Screen({ codePage: cp037 }));
    const k = new Keyboard(s, new Oia(), cp037);
    k.type('[');
    k.type(']');
    expect([s.cellAt(1).ebcdic, s.cellAt(2).ebcdic]).toEqual([0xba, 0xbb]);
  });

  it('Screen on its own decodes 0xAD 0xBD as [ ]', () => {
    const s = new Screen();
    s.setChar(0, 0xad);
    s.setChar(1, 0xbd);
    expect(s.rowText(1).slice(0, 2)).toBe('[]');
  });

  it('a default Session types [ ] as 0xAD 0xBD, into a bracket screen', () => {
    const session = new Session({ connect: () => { throw new Error('no connect'); } });
    field(session.screen);
    session.keyboard.type('[');
    session.keyboard.type(']');
    expect([session.screen.cellAt(1).ebcdic, session.screen.cellAt(2).ebcdic]).toEqual([0xad, 0xbd]);
    expect(session.screen.snapshot().codePage).toBe('bracket');
  });

  it('a cp037 Session types [ ] as 0xBA 0xBB and its snapshot says cp037', () => {
    const session = new Session({ connect: () => { throw new Error('no connect'); }, codePage: cp037 });
    field(session.screen);
    session.keyboard.type('[');
    session.keyboard.type(']');
    expect([session.screen.cellAt(1).ebcdic, session.screen.cellAt(2).ebcdic]).toEqual([0xba, 0xbb]);
    expect(session.screen.snapshot().codePage).toBe('cp037');
  });
});

describe('resolve() decodes with the snapshot\'s page', () => {
  it('a default screen: 0xAD is [', () => {
    const s = new Screen();
    s.setChar(0, 0xad);
    expect(resolve(s.snapshot())[0]!.text).toBe('[');
  });

  it('a cp037 screen: 0xBA is [, with no codePage passed to resolve', () => {
    const s = new Screen({ codePage: cp037 });
    s.setChar(0, 0xba);
    expect(resolve(s.snapshot())[0]!.text).toBe('[');
  });

  it('a snapshot without codePage (a hand-built fixture) decodes with the default', () => {
    const s = new Screen({ codePage: cp037 });
    s.setChar(0, 0xad);
    const { codePage: _omit, ...bare } = s.snapshot();
    const snap: ScreenSnapshot = bare;
    expect(resolve(snap)[0]!.text).toBe('[');
  });
});

describe('the session\'s color mode (x3270 mode3279), carried by the snapshot', () => {
  const geo = (model?: string) => ({ ...(model !== undefined ? { model } : {}), oversize: { kind: 'none' as const } });
  const mk = (geometry: ReturnType<typeof geo> | undefined, mono?: boolean) => new Session({
    connect: () => { throw new Error('no connect'); },
    ...(geometry !== undefined ? { geometry } : {}),
    ...(mono !== undefined ? { mono } : {}),
  });
  it('color by default, for 3279 and bare names; mono for 3278 and with -mono', () => {
    expect([mk(geo()).colorMode(), mk(geo('3279-4-E')).colorMode(), mk(geo('4')).colorMode(),
      mk(geo('3278-4-E')).colorMode(), mk(geo('3279-4-E'), true).colorMode(), mk(undefined).colorMode(),
      mk(undefined, true).colorMode()]).toEqual([true, true, true, false, false, true, false]);
  });
  it('the snapshot carries it', () => {
    expect(mk(geo('3278-2-E')).screen.snapshot().mode3279).toBe(false);
    expect(mk(geo('3279-2-E')).screen.snapshot().mode3279).toBe(true);
  });
  it('a model change (the Model menu) updates it', () => {
    const s = mk(geo('3279-2-E'));
    s.setGeometry(geo('3278-2-E'));
    expect(s.screen.snapshot().mode3279).toBe(false);
  });
  it('-mono survives a model change', () => {
    const s = mk(geo('3279-2-E'), true);
    s.setGeometry(geo('3279-4-E'));
    expect(s.colorMode()).toBe(false);
  });
  it('-mono advertises 3278', () => {
    const s = mk(geo('3279-2-E'), true);
    expect(s.connectionInfo().terminalType).toBe('IBM-3278-2-E');
  });
  it('resolve() draws a mono snapshot green with no options, and a bare snapshot in color', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT | 0x08);   // intensified protected: red in 3279, green in 3278
    s.setChar(1, 0xc1);
    s.mode3279 = false;
    expect(resolve(s.snapshot())[1]!.fg).toBe(Color.GREEN);
    const { mode3279: _m, ...bare } = s.snapshot();
    expect(resolve(bare)[1]!.fg).not.toBe(Color.GREEN);
  });
});
