import { describe, it, expect } from 'vitest';
import {
  TRANSFER_FIELDS, newTransferForm, cycleField, setFieldText, applicable, formKeywords,
  type TransferFormState,
} from '../src/transferForm.js';
import { parseTransferKeywords, transferCommand } from '../src/transfer.js';

describe('TRANSFER_FIELDS', () => {
  it('lists the ten fields in tab order', () => {
    expect(TRANSFER_FIELDS.map((f) => f.id)).toEqual([
      'direction', 'host', 'localFile', 'hostFile', 'mode',
      'exist', 'cr', 'recfm', 'lrecl', 'blksize',
    ]);
  });

  it('gives every field a label no wider than the widest, so a column can be computed', () => {
    for (const f of TRANSFER_FIELDS) expect(f.label.length).toBeGreaterThan(0);
  });
});

describe('newTransferForm', () => {
  it('starts at receive, tso, binary, keep, with Cr and Recfm UNSET', () => {
    const s = newTransferForm();
    expect(s.values.direction).toBe('receive');
    expect(s.values.host).toBe('tso');
    expect(s.values.mode).toBe('binary');
    expect(s.values.exist).toBe('keep');
    // UNSET is a distinct intention from any value: it emits no keyword at all and
    // lets the host choose, which is the CLI behaviour that works on both hosts.
    expect(s.values.cr).toBe('');
    expect(s.values.recfm).toBe('');
    expect(s.values.localFile).toBe('');
    expect(s.values.hostFile).toBe('');
    expect(s.values.lrecl).toBe('');
    expect(s.values.blksize).toBe('');
  });

  it('starts with the first field selected and no error', () => {
    const s = newTransferForm();
    expect(s.selected).toBe(0);
    expect(s.error).toBeUndefined();
  });
});

describe('cycleField', () => {
  it('cycles direction both ways and WRAPS', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    expect(s.values.direction).toBe('send');
    s = cycleField(s, 'direction', 1);
    expect(s.values.direction).toBe('receive');   // wrapped
    s = cycleField(s, 'direction', -1);
    expect(s.values.direction).toBe('send');      // wraps backwards too
  });

  it('cycles Recfm through THREE states, unset included', () => {
    // Not an F/V toggle: unset emits no RECFM and lets the host choose, which is a
    // different wire command from RECFM V. Starting at unset preserves "I did not ask
    // for record attributes" as an intention.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);          // Recfm applies only on a send
    const seen: string[] = [s.values.recfm];
    for (let i = 0; i < 3; i++) { s = cycleField(s, 'recfm', 1); seen.push(s.values.recfm); }
    expect(seen).toEqual(['', 'fixed', 'variable', 'undefined']);
    s = cycleField(s, 'recfm', 1);
    expect(s.values.recfm).toBe('');            // wrapped back to unset
  });

  it("omits Recfm's U when Host is vm, because CMS has only fixed and variable", () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'host', 1);
    expect(s.values.host).toBe('vm');
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { s = cycleField(s, 'recfm', 1); seen.push(s.values.recfm); }
    expect(seen).toEqual(['fixed', 'variable', '']);   // no 'undefined'
  });

  it('is a no-op on a text field', () => {
    const s = newTransferForm();
    expect(cycleField(s, 'localFile', 1).values.localFile).toBe('');
  });
});

describe('setFieldText', () => {
  it('appends to a text field', () => {
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', 'a.bin');
    expect(s.values.localFile).toBe('a.bin');
  });

  it('is a no-op on a cycle field', () => {
    // Typing into a cycle field must not invent a value the validator has never seen:
    // the form collects strings but it does not get to make them up.
    const s = newTransferForm();
    expect(setFieldText(s, 'direction', 'sideways').values.direction).toBe('receive');
  });

  it('accepts only digits in a numeric field', () => {
    let s = newTransferForm();
    s = setFieldText(s, 'lrecl', '80');
    expect(s.values.lrecl).toBe('80');
    s = setFieldText(s, 'lrecl', '80x');
    expect(s.values.lrecl).toBe('80');   // the x is refused, not appended
  });

  it('allows Lrecl up to five digits, because TSO datasets reach 32760', () => {
    // 5 wide, not 3: positiveInt has no upper bound and a narrow field would
    // silently prevent valid transfers.
    let s = newTransferForm();
    s = setFieldText(s, 'lrecl', '32760');
    expect(s.values.lrecl).toBe('32760');
  });
});

describe('applicable', () => {
  const v = (over: Partial<TransferFormState['values']> = {}) =>
    ({ ...newTransferForm().values, ...over });

  it('hides Recfm on a receive, because the dataset already exists', () => {
    expect(applicable('recfm', v({ direction: 'receive' }))).toBe(false);
    expect(applicable('recfm', v({ direction: 'send' }))).toBe(true);
  });

  it('disables Lrecl while Recfm is unset, because it would emit nothing', () => {
    expect(applicable('lrecl', v({ direction: 'send', recfm: '' }))).toBe(false);
    expect(applicable('lrecl', v({ direction: 'send', recfm: 'fixed' }))).toBe(true);
  });

  it('KEEPS Lrecl for Recfm=V, because TSO honours it as the MAXIMUM record length', () => {
    // MEASURED LIVE ON BOTH HOSTS 2026-09-22, and they disagree. TSO: `RECFM V LRECL 80`
    // stored VB 80 against VB 255 without it. VM/CMS: both V cases stored V 80, so CMS
    // ignores it -- but disabling the field would make a real TSO attribute unexpressible
    // to satisfy a VM quirk. x3270 agrees: both its branches gate LRECL on
    // `recfm != DEFAULT_RECFM` only, with no V check (ft.c:721-726, ft.c:763-766).
    expect(applicable('lrecl', v({ direction: 'send', recfm: 'variable' }))).toBe(true);
  });

  it('hides Blksize on VM, because CMS files have no block size', () => {
    expect(applicable('blksize', v({ direction: 'send', recfm: 'fixed', host: 'vm' }))).toBe(false);
    expect(applicable('blksize', v({ direction: 'send', recfm: 'fixed', host: 'tso' }))).toBe(true);
  });

  it('hides Cr unless the mode is ascii', () => {
    expect(applicable('cr', v({ mode: 'binary' }))).toBe(false);
    expect(applicable('cr', v({ mode: 'ascii' }))).toBe(true);
  });
});

describe('clearing on transition', () => {
  it('CLEARS Lrecl when Recfm returns to unset, rather than retaining it invisibly', () => {
    // A hidden value that breaks a later submit is the worse failure: the user cannot see
    // the field and gets an error naming a keyword they never typed.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);         // send
    s = cycleField(s, 'recfm', 1);             // fixed
    s = setFieldText(s, 'lrecl', '80');
    expect(s.values.lrecl).toBe('80');
    s = cycleField(s, 'recfm', -1);            // back to unset
    expect(s.values.lrecl).toBe('');
  });

  it('CLEARS Blksize when Host flips to vm', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'recfm', 1);
    s = setFieldText(s, 'blksize', '6160');
    s = cycleField(s, 'host', 1);              // vm
    expect(s.values.blksize).toBe('');
  });

  it('REPAIRS Recfm=U when Host flips to vm, since CMS cannot express it', () => {
    // `applicable` does not catch this -- U stays legal for a send -- so it is a separate
    // repair. Without it the form would submit `Recfm=undefined` to the VM dialect.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'recfm', 3);             // undefined
    expect(s.values.recfm).toBe('undefined');
    s = cycleField(s, 'host', 1);
    expect(s.values.recfm).toBe('');
  });

  it('CLEARS Cr when the mode returns to binary', () => {
    let s = newTransferForm();
    s = cycleField(s, 'mode', 1);              // ascii
    s = cycleField(s, 'cr', 1);                // auto
    expect(s.values.cr).toBe('auto');
    s = cycleField(s, 'mode', 1);              // binary
    expect(s.values.cr).toBe('');
  });

  it('CASCADES: flipping to receive clears Recfm AND the Lrecl that depended on it', () => {
    // NOT IN THE PLAN. This case passes even single-pass, and MEASURED WHY, because the
    // reason is luck rather than design: `recfm` sits at tab index 7 and `lrecl` at 8,
    // so one pass clears `recfm` from the copy it is iterating BEFORE it tests `lrecl`.
    // Reorder the table and it breaks. The next test is the one that fails outright.
    // Left unfixed either way, a receive could submit `Lrecl=80` and meet the
    // validator's "applies to Direction=send only".
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);         // send
    s = cycleField(s, 'recfm', 1);             // fixed
    s = setFieldText(s, 'lrecl', '80');
    s = setFieldText(s, 'blksize', '6160');
    s = cycleField(s, 'direction', 1);         // back to receive
    expect(s.values.recfm).toBe('');
    expect(s.values.lrecl).toBe('');
    expect(s.values.blksize).toBe('');
    // And the whole point: what is left must be something the validator accepts.
    expect(() => parseTransferKeywords([...formKeywords(s), 'LocalFile=/tmp/a', 'HostFile=A'])).not.toThrow();
  });

  it('CASCADES the VM repair too: Recfm=U on VM clears the Lrecl it licensed', () => {
    // The `recfm = ''` repair is not `applicable`'s doing, so it must also be able to
    // cascade -- which it can only do if it runs inside the fixed-point loop.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'recfm', 3);             // undefined
    s = setFieldText(s, 'lrecl', '80');
    expect(s.values.lrecl).toBe('80');
    s = cycleField(s, 'host', 1);              // vm: U is unexpressible
    expect(s.values.recfm).toBe('');
    expect(s.values.lrecl).toBe('');
  });
});

describe('formKeywords', () => {
  it('emits nothing for an unset optional field, so the host chooses', () => {
    const s = newTransferForm();
    const kw = formKeywords(s);
    expect(kw.join(' ')).not.toMatch(/Recfm|Lrecl|Blksize|Cr=/);
  });

  it('produces keywords the validator accepts', () => {
    // The CENTRAL RULE in one assertion: whatever this form emits, the one authority on
    // what is legal must accept. If these ever disagree the validator wins.
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', '/tmp/a.bin');
    s = setFieldText(s, 'hostFile', 'A.BIN');
    expect(() => parseTransferKeywords(formKeywords(s))).not.toThrow();
  });

  it('produces a valid send with record attributes', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = setFieldText(s, 'localFile', '/tmp/a.bin');
    s = setFieldText(s, 'hostFile', 'A.BIN');
    s = cycleField(s, 'recfm', 1);
    s = setFieldText(s, 'lrecl', '80');
    const { request, command } = transferCommand(formKeywords(s));
    expect(request.direction).toBe('send');
    expect(request.recfm).toBe('fixed');
    expect(request.lrecl).toBe(80);
    expect(command).toContain('IND$FILE PUT');
  });
});
