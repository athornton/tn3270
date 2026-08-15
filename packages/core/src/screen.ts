import { FA, MODEL_2 } from './constants.js';
import { cp037, type CodePage } from './codepage.js';

/**
 * The 3270 character buffer.
 *
 * Held as flat typed arrays, the way the hardware does it: one array of EBCDIC
 * bytes and a parallel array marking which positions are field attributes and
 * what they contain. Fields are DERIVED by scanning for attribute positions,
 * never stored as objects — a host that overwrites a field attribute mid-stream
 * (MVS and CICS both do) must change the field structure, and that falls out
 * for free when fields are computed rather than cached.
 */

/**
 * Cell content is a tagged variant. Stage 1 has exactly one case; Programmable
 * Symbol Sets (a committed stage 4 deliverable) will add
 * `{ kind: 'ps', store, index }`, and consumers must dispatch on `kind` rather
 * than assume a code page lookup.
 */
export type Cell = { kind: 'char'; ebcdic: number };

export interface Field {
  /** Address of the field attribute byte itself. */
  attrAddr: number;
  /**
   * Address of the first data cell (attrAddr + 1, wrapped). For a
   * zero-length field — one attribute immediately followed by another — this
   * IS the next attribute's address, not a data cell. Callers that park the
   * cursor here must check `length > 0` first; use `firstUnprotectedStart()`
   * or `typableFields()`, which already do.
   */
  start: number;
  /** Data cells in the field, excluding the attribute byte. */
  length: number;
  attr: number;
  protected: boolean;
  numeric: boolean;
  /** Protected + numeric means the cursor skips the field entirely. */
  autoSkip: boolean;
  intensified: boolean;
  hidden: boolean;
  modified: boolean;
}

export interface ScreenSnapshot {
  rows: number;
  cols: number;
  cursor: number;
  cells: readonly Cell[];
  fields: readonly Field[];
  formatted: boolean;
}

export interface ScreenOptions {
  rows?: number;
  cols?: number;
  codePage?: CodePage;
}

/** Marker in the attribute array meaning "this position is not an attribute". */
const NOT_ATTR = -1;

export class Screen {
  readonly rows: number;
  readonly cols: number;
  readonly size: number;
  cursor = 0;

  private readonly chars: Uint8Array;
  /** attrs[i] >= 0 means position i holds that field attribute value. */
  private readonly attrs: Int16Array;
  private readonly codePage: CodePage;

  constructor(opts: ScreenOptions = {}) {
    this.rows = opts.rows ?? MODEL_2.rows;
    this.cols = opts.cols ?? MODEL_2.cols;
    this.size = this.rows * this.cols;
    this.chars = new Uint8Array(this.size);
    this.attrs = new Int16Array(this.size).fill(NOT_ATTR);
    this.codePage = opts.codePage ?? cp037;
  }

  // ---- geometry ----

  /** Display row/column, 1-based, as the OIA and s3270 report them. */
  toRowCol(addr: number): { row: number; col: number } {
    return {
      row: Math.floor(addr / this.cols) + 1,
      col: (addr % this.cols) + 1,
    };
  }

  fromRowCol(row: number, col: number): number {
    return (row - 1) * this.cols + (col - 1);
  }

  /** Next address, wrapping at the end of the buffer. */
  inc(addr: number): number {
    return (addr + 1) % this.size;
  }

  /** Previous address, wrapping at the start of the buffer. */
  dec(addr: number): number {
    return (addr - 1 + this.size) % this.size;
  }

  // ---- cells ----

  cellAt(addr: number): Cell {
    return { kind: 'char', ebcdic: this.chars[addr]! };
  }

  /**
   * Write a character. If the position held a field attribute, that attribute
   * is destroyed — the host is allowed to do this, and the field structure
   * changes as a result.
   */
  setChar(addr: number, ebcdic: number): void {
    this.chars[addr] = ebcdic & 0xff;
    this.attrs[addr] = NOT_ATTR;
  }

  isFieldAttribute(addr: number): boolean {
    return this.attrs[addr]! >= 0;
  }

  attributeAt(addr: number): number | null {
    const a = this.attrs[addr]!;
    return a >= 0 ? a : null;
  }

  setFieldAttribute(addr: number, attr: number): void {
    this.attrs[addr] = attr & 0xff;
    // An attribute position displays as a blank and holds no character.
    this.chars[addr] = 0x00;
  }

  isFormatted(): boolean {
    for (let i = 0; i < this.size; i++) if (this.attrs[i]! >= 0) return true;
    return false;
  }

  // ---- fields (all derived) ----

  /** The field governing `addr`, found by scanning backwards for an attribute. */
  fieldAt(addr: number): Field | null {
    let a = addr;
    for (let n = 0; n < this.size; n++) {
      if (this.attrs[a]! >= 0) return this.makeField(a);
      a = this.dec(a);
    }
    return null; // unformatted
  }

  fields(): Field[] {
    const out: Field[] = [];
    for (let i = 0; i < this.size; i++) {
      if (this.attrs[i]! >= 0) out.push(this.makeField(i));
    }
    return out;
  }

  private makeField(attrAddr: number): Field {
    const attr = this.attrs[attrAddr]!;
    const start = this.inc(attrAddr);
    let length = 0;
    let a = start;
    while (a !== attrAddr && this.attrs[a]! < 0) {
      length++;
      a = this.inc(a);
    }
    const protectedField = (attr & FA.PROTECT) !== 0;
    const numeric = (attr & FA.NUMERIC) !== 0;
    const intensity = attr & FA.INTENSITY;
    return {
      attrAddr,
      start,
      length,
      attr,
      protected: protectedField,
      numeric,
      autoSkip: protectedField && numeric,
      intensified: intensity === FA.INT_HIGH_SEL,
      hidden: intensity === FA.INT_ZERO_NSEL,
      modified: (attr & FA.MODIFY) !== 0,
    };
  }

  setMDT(attrAddr: number): void {
    if (this.attrs[attrAddr]! >= 0) {
      this.attrs[attrAddr] = this.attrs[attrAddr]! | FA.MODIFY;
    }
  }

  /**
   * Reset MDT in EVERY field, protected or not. This is WCC reset-MDT: manual
   * Table 3-2 bit 7 says "all MDT bits in the device's existing character
   * buffer are reset," and x3270's handler (`ctlr.c:1545-1550`) has no
   * protection check. This matters because Read Modified filters on MDT alone
   * (`ctlr.c:921`) — a protected field left carrying MDT would otherwise leak
   * its data to the host on the next read. Erase Input is the
   * unprotected-only operation; see `clearUnprotectedMDT`.
   */
  clearAllMDT(): void {
    for (let i = 0; i < this.size; i++) {
      const a = this.attrs[i]!;
      if (a >= 0) this.attrs[i] = a & ~FA.MODIFY;
    }
  }

  /** Reset MDT in unprotected fields only (Erase Input, manual 4-14). */
  clearUnprotectedMDT(): void {
    for (let i = 0; i < this.size; i++) {
      const a = this.attrs[i]!;
      if (a >= 0 && (a & FA.PROTECT) === 0) {
        this.attrs[i] = a & ~FA.MODIFY;
      }
    }
  }

  // ---- clearing ----

  /** Erase/Write and the Clear key: everything goes, including attributes. */
  clear(): void {
    this.chars.fill(0x00);
    this.attrs.fill(NOT_ATTR);
    this.cursor = 0;
  }

  /**
   * Erase All Unprotected: null the data in unprotected fields and reset their
   * MDT. Field attributes themselves survive. On an unformatted screen there
   * are no field attributes to preserve — the whole buffer is, by definition,
   * unprotected — so this clears everything, matching x3270's
   * `else { ctlr_clear(true); }` at `ctlr.c:1443-1445`.
   */
  eraseAllUnprotected(): void {
    if (!this.isFormatted()) {
      this.clear();
      return;
    }
    for (const f of this.fields()) {
      if (f.protected) continue;
      let a = f.start;
      for (let n = 0; n < f.length; n++) {
        // Must write chars[] directly, not via setChar: setChar also clears
        // attrs[], which would destroy the very field attributes EAU is
        // required to preserve.
        this.chars[a] = 0x00;
        a = this.inc(a);
      }
      this.attrs[f.attrAddr] = f.attr & ~FA.MODIFY;
    }
  }

  /**
   * The first cell a user could type into: the start of the first
   * unprotected field, skipping zero-length fields (a zero-length field's
   * `start` IS the next attribute — landing the cursor there and typing would
   * collapse two fields). Mirrors x3270's `next_unprotected`
   * (`ctlr.c:623-638`). Returns null if there is no such field.
   */
  firstUnprotectedStart(): number | null {
    for (const f of this.fields()) {
      if (!f.protected && f.length > 0) return f.start;
    }
    return null;
  }

  /**
   * Unprotected, non-auto-skip fields with room for data — the set Tab and
   * Back Tab cycle through. Zero-length fields are excluded for the same
   * reason `firstUnprotectedStart` excludes them.
   */
  typableFields(): Field[] {
    return this.fields().filter((f) => !f.protected && !f.autoSkip && f.length > 0);
  }

  /**
   * Visit every cell from `start` up to (excluding) `stop`, wrapping as
   * needed, passing each cell's governing field (or null if unformatted) and
   * whether the cell itself is that field's attribute byte. Carries the
   * attribute forward instead of calling `fieldAt` per cell, so a full sweep
   * is O(size) rather than O(size^2) — the naive per-cell `fieldAt` scan costs
   * ~3.7M operations over a full 1920-cell buffer. Mirrors x3270's
   * `current_fa` tracking (`ctlr.c:1809-1816`).
   */
  forEachCellWithField(
    start: number,
    stop: number,
    cb: (addr: number, field: Field | null, isAttr: boolean) => void,
  ): void {
    let field = this.fieldAt(start);
    let a = start;
    do {
      const attr = this.attrs[a]!;
      const isAttr = attr >= 0;
      if (isAttr) field = this.makeField(a);
      cb(a, field, isAttr);
      a = this.inc(a);
    } while (a !== stop);
  }

  // ---- output ----

  /** Raw buffer contents, for Read Buffer and for tests. */
  readBuffer(): Uint8Array {
    return Uint8Array.from(this.chars);
  }

  /** One display row as text, 1-based. Nulls and attributes render as spaces. */
  rowText(row: number): string {
    let out = '';
    const base = (row - 1) * this.cols;
    for (let c = 0; c < this.cols; c++) {
      const addr = base + c;
      if (this.attrs[addr]! >= 0) {
        out += ' ';
        continue;
      }
      const b = this.chars[addr]!;
      out += b === 0x00 ? ' ' : this.codePage.toUnicode(b);
    }
    return out;
  }

  toText(): string {
    const lines: string[] = [];
    for (let r = 1; r <= this.rows; r++) lines.push(this.rowText(r));
    return lines.join('\n');
  }

  /** An immutable view for the UI or for assertions. */
  snapshot(): ScreenSnapshot {
    const cells: Cell[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) cells[i] = { kind: 'char', ebcdic: this.chars[i]! };
    return {
      rows: this.rows,
      cols: this.cols,
      cursor: this.cursor,
      cells,
      fields: this.fields(),
      formatted: this.isFormatted(),
    };
  }
}
