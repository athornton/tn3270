import { describe, it, expect } from 'vitest';
import { TelnetOpt, EnvironGroup, EnvironQual } from '../src/constants.js';
import { parseEnvironSend, buildEnvironIs } from '../src/newenviron.js';

/** ASCII to bytes, for building request bodies. */
const a = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/**
 * RFC 1572's codes, taken from x3270's include/arpa_telnet.h:122-125 rather than from
 * the RFC text, because that header is what the traces we drive were produced against.
 */
describe('NEW-ENVIRON constants', () => {
  it('is telnet option 39', () => {
    expect(TelnetOpt.NEW_ENVIRON).toBe(39);
  });

  it('has RFC 1572 s four group codes', () => {
    expect(EnvironGroup.VAR).toBe(0);
    expect(EnvironGroup.VALUE).toBe(1);
    expect(EnvironGroup.ESC).toBe(2);
    expect(EnvironGroup.USERVAR).toBe(3);
  });

  it('has its OWN IS and SEND, not TERMINAL-TYPE s', () => {
    // IS=0 and SEND=1 are the same VALUES that TelnetSubopt already defines for
    // TERMINAL-TYPE (RFC 1091). That is a coincidence of encoding, not a shared
    // meaning, and this project has been bitten by exactly that confusion before --
    // see constants.ts's note on XAH.DEFAULT versus XA.RESET, both 0x00 and unrelated.
    // Asserting the values here is what lets a reader see they are deliberate.
    expect(EnvironQual.IS).toBe(0);
    expect(EnvironQual.SEND).toBe(1);
    expect(EnvironQual.INFO).toBe(2);
  });
});

describe('parseEnvironSend', () => {
  it('parses the three-uservar request from devname_success.trc', () => {
    // The real bytes, from that trace's line 87:
    //   fffa27 01 03 "IBMELF" 03 "IBMAPPLID" 03 "DEVNAME" fff0
    // The body handed to us excludes the option byte and the SEND qualifier.
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, ...a('IBMELF'),
      EnvironGroup.USERVAR, ...a('IBMAPPLID'),
      EnvironGroup.USERVAR, ...a('DEVNAME'),
    ]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.USERVAR, name: 'IBMELF' },
      { group: EnvironGroup.USERVAR, name: 'IBMAPPLID' },
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ]);
  });

  it('parses the single-uservar request the host repeats', () => {
    const body = Uint8Array.from([EnvironGroup.USERVAR, ...a('DEVNAME')]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ]);
  });

  it('treats a group byte with NO name as "the whole group"', () => {
    const body = Uint8Array.from([EnvironGroup.VAR, EnvironGroup.USERVAR]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ]);
  });

  it('EXPANDS AN EMPTY BODY INTO BOTH GROUPS, which is "send everything"', () => {
    // x3270 checks `state == EE_BASE` after the loop and fakes one VAR and one USERVAR
    // request (telnet_new_environ.c:453-470). A client that returned an empty list here
    // would answer a host asking for everything with nothing at all -- and the reply
    // would still be well-formed, so nothing downstream would notice.
    //
    // NOT JUST THE C SOURCE -- A RECORDED HOST DOES THIS. `s3270/Test/dbcs-wrap.trc:103`
    // has the host send a bare `fffa2701fff0` (SEND, empty body); x3270's reply at :108
    // dumps every VAR and USERVAR it holds (also seen in `lu.trc`, `target.trc`,
    // `korean.trc`). A measured host outranks the reference implementation's source.
    expect(parseEnvironSend(new Uint8Array(0))).toEqual([
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ]);
  });

  it('distinguishes VAR from USERVAR', () => {
    const body = Uint8Array.from([EnvironGroup.VAR, ...a('USER')]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.VAR, name: 'USER' },
    ]);
  });

  it('un-escapes an ESC in a name', () => {
    // ESC means "the next byte is literal", so a name containing byte 0x03 arrives as
    // ESC 0x03 and must parse back to a one-character name.
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, EnvironGroup.ESC, EnvironGroup.USERVAR,
    ]);
    const got = parseEnvironSend(body)!;
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe(String.fromCharCode(EnvironGroup.USERVAR));
  });

  it('REFUSES a body that does not begin with a group byte', () => {
    // x3270's EE_BASE returns NULL for anything but VAR or USERVAR. Malformed, not
    // truncated: there is nothing to salvage.
    expect(parseEnvironSend(Uint8Array.from(a('DEVNAME')))).toBeNull();
    expect(parseEnvironSend(Uint8Array.of(EnvironGroup.VALUE))).toBeNull();
  });
});

describe('buildEnvironIs', () => {
  const uservars = new Map([
    ['IBMELF', 'YES'],
    ['IBMAPPLID', 'None'],
    ['DEVNAME', 'foo001'],
  ]);
  const vars = new Map([['USER', 'herc01']]);

  it('reproduces the reply devname_success.trc records, byte for byte', () => {
    // That trace's line 89-91:
    //   fffa27 00 03 "IBMELF" 01 "YES" 03 "IBMAPPLID" 01 "None" 03 "DEVNAME" 01 "foo001" fff0
    // We build the BODY: everything between `27` and `fff0`, starting at the qualifier.
    const requests = [
      { group: EnvironGroup.USERVAR, name: 'IBMELF' },
      { group: EnvironGroup.USERVAR, name: 'IBMAPPLID' },
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ];
    expect(Array.from(buildEnvironIs(requests, vars, uservars))).toEqual([
      EnvironQual.IS,
      EnvironGroup.USERVAR, ...a('IBMELF'), EnvironGroup.VALUE, ...a('YES'),
      EnvironGroup.USERVAR, ...a('IBMAPPLID'), EnvironGroup.VALUE, ...a('None'),
      EnvironGroup.USERVAR, ...a('DEVNAME'), EnvironGroup.VALUE, ...a('foo001'),
    ]);
  });

  it('OMITS THE VALUE BYTE ENTIRELY for a variable we do not have', () => {
    // x3270 appends VALUE only `if (value != NULL)` (telnet_new_environ.c:561). So an
    // unknown name is echoed bare. That is DIFFERENT on the wire from a known variable
    // whose value is empty, which emits name + VALUE + nothing, and a host can tell
    // them apart. Emitting an empty VALUE for an unknown name would claim we have a
    // variable we do not.
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'NOSUCH' }], vars, uservars));
    expect(got).toEqual([
      EnvironQual.IS, EnvironGroup.USERVAR, ...a('NOSUCH'),
    ]);
    expect(got).not.toContain(EnvironGroup.VALUE);
  });

  it('distinguishes an EMPTY known value from an absent one', () => {
    const withEmpty = new Map([['EMPTY', '']]);
    expect(Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'EMPTY' }], vars, withEmpty))).toEqual([
      EnvironQual.IS, EnvironGroup.USERVAR, ...a('EMPTY'), EnvironGroup.VALUE,
    ]);
  });

  it('dumps a whole group when the name is empty', () => {
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.VAR, name: '' }], vars, uservars));
    expect(got).toEqual([
      EnvironQual.IS, EnvironGroup.VAR, ...a('USER'), EnvironGroup.VALUE, ...a('herc01'),
    ]);
  });

  it('emits the group byte PER VARIABLE in a whole-group dump, and preserves insertion order', () => {
    // x3270's own whole-group branch (telnet_new_environ.c:532-537) puts `vb_appendf(&reply,
    // "%c", ereq->group)` INSIDE the `FOREACH_LLIST` over the group's variables, not once
    // before the loop -- so a three-entry group is three (group, name, VALUE, value)
    // tuples, not one group byte followed by three bare name/value pairs. A single-entry
    // `vars` map (the test above) cannot distinguish the two shapes; this one can.
    //
    // ORDER: we use a `Map`, and `for...of` over a `Map` iterates in insertion order
    // (guaranteed by the ECMAScript spec, unlike a plain object with numeric-looking
    // keys). x3270's own list is also insertion-ordered -- `add_environ` appends via
    // `llist_insert_before(&e->list, list)` and `environ_init` (:220-245) calls it
    // USER, then DEVNAME, then IBMELF, then IBMAPPLID, then CODEPAGE/CHARSET/KBDTYPE in
    // that fixed order -- so a real reply's whole-group dump has a specific, meaningful
    // order that a host may rely on. This test pins that our output tracks the map's
    // insertion order, which is the only thing guaranteeing ours matches x3270's: if
    // Task 7 populates the map in x3270's order, the wire order matches automatically.
    const manyUservars = new Map([
      ['IBMELF', 'YES'],
      ['IBMAPPLID', 'None'],
      ['DEVNAME', 'foo001'],
    ]);
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: '' }], vars, manyUservars));
    expect(got).toEqual([
      EnvironQual.IS,
      EnvironGroup.USERVAR, ...a('IBMELF'), EnvironGroup.VALUE, ...a('YES'),
      EnvironGroup.USERVAR, ...a('IBMAPPLID'), EnvironGroup.VALUE, ...a('None'),
      EnvironGroup.USERVAR, ...a('DEVNAME'), EnvironGroup.VALUE, ...a('foo001'),
    ]);
  });

  it('does not let VAR and USERVAR lookups cross', () => {
    // USER is a VAR; asking for it as a USERVAR must miss, and vice versa. x3270 picks
    // the list by group (`(ereq->group == TELOBJ_VAR)? &vars : &uservars`).
    const asUservar = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'USER' }], vars, uservars));
    expect(asUservar).not.toContain(EnvironGroup.VALUE);
    const asVar = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.VAR, name: 'DEVNAME' }], vars, uservars));
    expect(asVar).not.toContain(EnvironGroup.VALUE);
  });

  it('does NOT prefix-match a name', () => {
    // x3270's find_environ compares with `memcmp(name, e->name, namelen)` and never
    // checks that the LENGTHS match, so a request for "IBM" matches the stored
    // "IBMELF" there. That is a bug in the reference, not a rule to copy: it would
    // answer a question the host did not ask. We require equality.
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'IBM' }], vars, uservars));
    expect(got).not.toContain(EnvironGroup.VALUE);
  });
});
