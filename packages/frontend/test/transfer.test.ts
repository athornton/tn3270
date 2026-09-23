import { describe, it, expect } from 'vitest';
import { cp037, AID, AckAid } from '@tn3270/core';

import {
  IND_FILE,
  TSO_DIALECT,
  VM_DIALECT,
  TransferOptionError,
  dialectFor,
  parseTransferKeywords,
  transferCommand,
} from '../src/transfer.js';

/**
 * `Transfer()` keyword parsing and IND$FILE command construction.
 *
 * References cited by line throughout:
 *  - x3270 4.5 `Common/ft.c` — `parse_ft_keywords` (:829-1000) for the keyword
 *    table and its validation, `ft_go` (:683-772) for the command builder.
 *  - The live TK5 IND$FILE usage text, captured 2026-08-18 and recorded in the
 *    design doc's "MVS/TSO HOST FOUND" section:
 *
 *        Usage: IND$FILE {GET|PUT} 'dataset.name' options
 *        options: ASCII CRLF APPEND TRACE DEBUG
 *                 RECFM(F|V|U) LRECL(nn) BLKSIZE(nn) TRACKS|CYLS SPACE(n,n)
 *
 *    which is an INDEPENDENT confirmation of the TSO half: parenthesised DCB
 *    keywords, `ASCII` opt-in, binary by default.
 *
 * Every command assertion is an EXACT string. A `toContain` would pass on a
 * command with a stray `(`, a missing space, or an option in the wrong place —
 * and each of those is a command the host rejects for reasons that read like a
 * protocol fault.
 */

/**
 * The two required keywords, so each test can name only what it is about.
 *
 * Supplied only where the test does not name them itself — a duplicate keyword is
 * a rejection (see the "given more than once" test), so the helper must not add
 * one behind the test's back.
 */
const REQUIRED = ['LocalFile=/tmp/x', 'HostFile=FOO'];

function withRequired(extra: readonly string[]): string[] {
  const named = new Set(extra.map((a) => a.split('=')[0]!.toLowerCase()));
  return [...REQUIRED.filter((r) => !named.has(r.split('=')[0]!.toLowerCase())), ...extra];
}

function req(...extra: string[]) {
  return parseTransferKeywords(withRequired(extra));
}

function cmd(...extra: string[]): string {
  return transferCommand(withRequired(extra)).command;
}

// ---------------------------------------------------------------------------
// The $
// ---------------------------------------------------------------------------

describe('the $ in IND$FILE', () => {
  /**
   * The design doc's dialect seam item 3: "x3270 emits `IND\e005BFILE` — the `$`
   * as EBCDIC `0x5B`. We must verify the byte we actually put on the wire is
   * `0x5B` rather than trusting a character round-trip through cp037."
   *
   * x3270 never types a literal `$`: `\e005B` is its EBCDIC-code-point escape
   * (kybd.c:4180, the `EBC` lexer state), so it writes the byte directly. Our
   * `String()`/`Transfer()` path goes through `cp037.fromUnicode`, so the byte is
   * a property of the table rather than of the source text — hence this test.
   */
  it('encodes to EBCDIC 0x5b through the cp037 encoder', () => {
    const bytes = cp037.encode(IND_FILE);
    expect(Array.from(bytes)).toEqual([
      0xc9, 0xd5, 0xc4, // IND
      0x5b, //            $  <- the byte that matters
      0xc6, 0xc9, 0xd3, 0xc5, // FILE
    ]);
    expect(bytes[3]).toBe(0x5b);
  });

  it('is the only cp037 byte that decodes to $, so the reverse map cannot pick another', () => {
    // The encoder's reverse map is built high byte to low so the LOWEST EBCDIC
    // byte wins for a character with several encodings (codepage.ts:30-35). That
    // tie-break never comes into play here, and this test is what says so.
    const candidates: number[] = [];
    for (let b = 0; b < 256; b++) {
      if (cp037.toUnicode(b) === '$') candidates.push(b);
    }
    expect(candidates).toEqual([0x5b]);
  });

  it('keeps the byte through a whole built command', () => {
    // End to end over the string the runner actually types: the position of the
    // `$` moves with the verb and file name, so assert on the encoded bytes
    // rather than on index 3.
    const encoded = Array.from(cp037.encode(cmd()));
    expect(encoded).toContain(0x5b);
    // ...and exactly once, i.e. nothing else in the command produced a 0x5b.
    expect(encoded.filter((b) => b === 0x5b)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('keyword defaults', () => {
  it('applies every default, with BINARY as the mode', () => {
    // The one default that is deliberately NOT x3270's: it sets ascii_flag true
    // (ft.c:321). The design doc's scope item 3 reverses it, because a wrong
    // default silently corrupts a MODULE while a wrong explicit choice is visible
    // in the command. The live TK5 IND$FILE also defaults to binary.
    expect(req()).toEqual({
      direction: 'receive', // ft.c:319, receive_flag defaults true
      localFile: '/tmp/x',
      hostFile: 'FOO',
      host: 'tso', // ft.c:320
      mode: 'binary', // OURS, not x3270's
      cr: 'auto', // ft.c:322
      exist: 'keep', // ft.c:324-325
      // no recfm, lrecl or blksize: ft.c:326-329
    });
  });

  it('omits recfm, lrecl and blksize entirely when unspecified', () => {
    // Absence, not a sentinel: x3270's DEFAULT_RECFM (ft_private.h:44) means
    // "emit nothing and let the host choose", and `exactOptionalPropertyTypes`
    // makes the distinction between absent and `undefined` a real one.
    const r = req();
    expect('recfm' in r).toBe(false);
    expect('lrecl' in r).toBe(false);
    expect('blksize' in r).toBe(false);
  });
});

describe('keyword parsing', () => {
  it('accepts every supported keyword at once', () => {
    expect(parseTransferKeywords([
      'Direction=send',
      'LocalFile=/tmp/mod.bin',
      'HostFile=USER.LOAD(MOD)',
      'Host=tso',
      'Mode=ascii',
      'Cr=remove',
      'Exist=append',
      'Recfm=fixed',
      'Lrecl=80',
      'Blksize=3120',
    ])).toEqual({
      direction: 'send',
      localFile: '/tmp/mod.bin',
      hostFile: 'USER.LOAD(MOD)',
      host: 'tso',
      mode: 'ascii',
      cr: 'remove',
      exist: 'append',
      recfm: 'fixed',
      lrecl: 80,
      blksize: 3120,
    });
  });

  it('is case-insensitive in both keyword and value', () => {
    // `strncasecmp` on both sides (ft.c:879-882).
    expect(parseTransferKeywords([
      'DIRECTION=SEND', 'localfile=/tmp/x', 'HoStFiLe=FOO', 'MODE=Ascii', 'ExIsT=REPLACE',
    ])).toMatchObject({
      direction: 'send', mode: 'ascii', exist: 'replace',
    });
  });

  it('keeps values verbatim, including case and spaces in file names', () => {
    // A CMS host file is three tokens. `commands.ts` splits on spaces, so an
    // operator must quote it — `Transfer(HostFile="PROFILE EXEC A",...)` — and by
    // the time it reaches here it is one argument whose spaces must survive.
    const r = parseTransferKeywords([
      'HostFile=PROFILE EXEC A', 'LocalFile=/tmp/Profile.Exec', 'Host=vm',
    ]);
    expect(r.hostFile).toBe('PROFILE EXEC A');
    expect(r.localFile).toBe('/tmp/Profile.Exec');
  });

  it('accepts Recfm=default as "unspecified", the way x3270 spells it', () => {
    // ft.c:152 lists `default` among Recfm's keywords and DEFAULT_RECFM means
    // "emit nothing" (ft.c:704). Accepted so an s3270 script that says so runs.
    const r = req('Direction=send', 'Recfm=default');
    expect('recfm' in r).toBe(false);
    expect(cmd('Direction=send', 'Recfm=default')).toBe(`${IND_FILE} PUT FOO`);
  });

  it('ignores an empty argument, which is what a trailing comma produces', () => {
    expect(parseTransferKeywords(['LocalFile=/tmp/x', 'HostFile=FOO', '']))
      .toMatchObject({ hostFile: 'FOO' });
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe('keyword rejection', () => {
  it('rejects an unknown keyword rather than ignoring it', () => {
    // The task's rule and x3270's (ft.c:917-919): silently dropping a keyword the
    // operator typed produces a transfer that does something they did not ask
    // for. The message lists the accepted set, because the next move is to retype.
    expect(() => req('Frobnicate=1')).toThrow(TransferOptionError);
    expect(() => req('Frobnicate=1')).toThrow(/unknown option 'Frobnicate'/);
    expect(() => req('Frobnicate=1')).toThrow(/accepted: direction, localfile/);
  });

  it('rejects a keyword x3270 has but we deliberately do not', () => {
    // Remap, OtherOptions and the space keywords are absent LOUDLY: each governs
    // behaviour we have not built or command syntax nobody has tested against a
    // host, and accepting them would produce a transfer whose options went
    // nowhere.
    for (const k of ['Remap=yes', 'OtherOptions=TRACE', 'Allocation=tracks', 'BufferSize=4096']) {
      expect(() => req(k)).toThrow(/unknown option/);
    }
  });

  it('rejects a missing LocalFile and a missing HostFile', () => {
    // ft.c:993-1000, LocalFile reported first as x3270 does.
    expect(() => parseTransferKeywords(['HostFile=FOO'])).toThrow(/missing 'LocalFile'/);
    expect(() => parseTransferKeywords(['LocalFile=/tmp/x'])).toThrow(/missing 'HostFile'/);
    expect(() => parseTransferKeywords([])).toThrow(/missing 'LocalFile'/);
  });

  it('rejects a bare token, naming the syntax to use instead', () => {
    // s3270 also accepts `keyword,value` as two arguments (ft.c:865-877). We
    // cannot: commands.ts splits on commas AND spaces, so `Transfer(Direction,
    // send)` and `Transfer(Direction=send, Mode=ascii)` arrive as
    // indistinguishable token lists.
    expect(() => req('Direction', 'send')).toThrow(/needs a value, as keyword=value/);
  });

  it('rejects an empty keyword or an empty value', () => {
    // ft.c:858-863, `if (eq == argv[j] || !*(eq + 1))`.
    expect(() => req('=send')).toThrow(/has no keyword/);
    expect(() => req('Mode=')).toThrow(/has no value/);
  });

  it('rejects an invalid enumerated value, naming the alternatives', () => {
    expect(() => req('Direction=sideways')).toThrow(/invalid Direction value 'sideways'/);
    expect(() => req('Mode=ebcdic')).toThrow(/expected binary, ascii/);
    expect(() => req('Host=cics')).toThrow(/expected tso, vm/);
    expect(() => req('Exist=clobber')).toThrow(/expected keep, replace, append/);
  });

  it('rejects an ABBREVIATED value that s3270 would prefix-match', () => {
    // WHERE WE ARE STRICTER THAN s3270, ON PURPOSE. x3270 prefix-matches values
    // (`strncasecmp(value, keyword[k], strlen(value))`, ft.c:880-882), so `Mode=a`
    // silently means ascii and `Cr=a` silently means `auto` — `add` never gets a
    // chance because `auto` comes first in the list. A one-letter abbreviation
    // resolving to the wrong option is exactly the failure that separates a good
    // MODULE from a corrupt one.
    expect(() => req('Mode=a')).toThrow(/invalid Mode value 'a'/);
    expect(() => req('Mode=b')).toThrow(/invalid Mode value 'b'/);
    expect(() => req('Direction=s')).toThrow(/invalid Direction value 's'/);
  });

  it('rejects a repeated keyword rather than letting the last one win', () => {
    // x3270 overwrites silently (ft.c:911), so `Mode=ascii,Mode=binary` transfers
    // in binary with no hint the first was discarded.
    expect(() => req('Mode=ascii', 'Mode=binary')).toThrow(/given more than once/);
  });

  it('rejects a non-integer or non-positive Lrecl and Blksize', () => {
    // ft.c:894-900: `l <= 0 || ptr == value || *ptr` is an error. `Number()`
    // alone would accept every one of these.
    for (const bad of ['0', '-80', '80.5', '0x50', '1e3', ' 80', '80 ', 'eighty', '']) {
      expect(() => req('Direction=send', 'Recfm=fixed', `Lrecl=${bad}`)).toThrow(TransferOptionError);
    }
    expect(() => req('Direction=send', 'Recfm=fixed', 'Lrecl=80.5'))
      .toThrow(/Lrecl must be a positive integer/);
  });

  it('rejects an explicit Cr in binary mode, but not Cr=auto', () => {
    // ft.c:944-947. An explicit Cr in binary mode is a contradiction: CRLF
    // translation only exists in ascii mode. `auto` means "follow the mode",
    // which binary mode answers, so it stays legal.
    expect(() => req('Cr=remove')).toThrow(/needs Mode=ascii/);
    expect(() => req('Cr=keep')).toThrow(/needs Mode=ascii/);
    expect(req('Cr=auto').cr).toBe('auto');
    expect(req('Mode=ascii', 'Cr=remove').cr).toBe('remove');
  });

  it('rejects the DCB keywords on a receive, where x3270 silently drops them', () => {
    // The whole DCB block is inside `if (!p->receive_flag)` (ft.c:702), so on a
    // GET x3270 accepts `Recfm=fixed` and emits nothing. The visible symptom of
    // that drop is a dataset with attributes nobody chose.
    expect(() => req('Recfm=fixed')).toThrow(/Recfm applies to Direction=send only/);
    expect(() => req('Recfm=fixed', 'Lrecl=80')).toThrow(/applies to Direction=send only/);
  });

  it('rejects Lrecl or Blksize without Recfm', () => {
    // Both are nested inside `if (p->recfm != DEFAULT_RECFM)` (ft.c:704, :721-726),
    // so `Lrecl=80` alone emits nothing at all.
    expect(() => req('Direction=send', 'Lrecl=80')).toThrow(/need Recfm as well/);
    expect(() => req('Direction=send', 'Blksize=3120')).toThrow(/need Recfm as well/);
  });

  it('rejects Blksize and Recfm=undefined on VM, which its command syntax cannot express', () => {
    // ft.c:749-766: the VM branch has no blksize case, and its recfm switch has
    // only F and V — an undefined recfm there would emit the bare word `RECFM`
    // with no letter, i.e. a malformed command rather than a default.
    expect(() => req('Host=vm', 'Direction=send', 'Recfm=fixed', 'Blksize=800'))
      .toThrow(/Blksize is a TSO option/);
    expect(() => req('Host=vm', 'Direction=send', 'Recfm=undefined'))
      .toThrow(/Recfm=undefined is a TSO option/);
    // ...and both are fine on TSO, which is what makes those two rules about the
    // dialect rather than about the keywords.
    expect(req('Direction=send', 'Recfm=fixed', 'Blksize=800').blksize).toBe(800);
    expect(req('Direction=send', 'Recfm=undefined').recfm).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// TSO command construction
// ---------------------------------------------------------------------------

describe('TSO command construction', () => {
  it('builds a bare GET with a quoted dataset name and NO ( separator', () => {
    // ft.c:685-688: the third substitution is `(p->host_type != HT_TSO)? "(": ""`,
    // so TSO gets nothing there. Matches the live usage text,
    // `IND$FILE {GET|PUT} 'dataset.name' options`.
    expect(cmd("HostFile='SYS1.PARMLIB(IEASYS00)'"))
      .toBe(`${IND_FILE} GET 'SYS1.PARMLIB(IEASYS00)'`);
  });

  it('builds a bare PUT', () => {
    expect(cmd('Direction=send', "HostFile='HERC02.TEST.DATA'"))
      .toBe(`${IND_FILE} PUT 'HERC02.TEST.DATA'`);
  });

  it('emits nothing for binary mode: BINARY is the absence of ASCII', () => {
    // x3270 emits an explicit `BINARY` only for CICS (ft.c:691-692), and the live
    // TK5 usage text lists only `ASCII` among its options.
    expect(cmd('Mode=binary')).toBe(`${IND_FILE} GET FOO`);
    expect(cmd('Mode=binary')).not.toContain('BINARY');
  });

  it('emits ASCII CRLF for ascii mode, since Cr defaults to auto', () => {
    // ft.c:689-695 plus ft.c:940-942: `auto` sets cr_flag from ascii_flag, so
    // ascii mode alone asks for CRLF. This is the exact command the design doc's
    // live capture used: `IND$FILE GET 'SYS1.PARMLIB(IEASYS00)' ASCII CRLF`.
    expect(cmd('Mode=ascii')).toBe(`${IND_FILE} GET FOO ASCII CRLF`);
    expect(cmd("HostFile='SYS1.PARMLIB(IEASYS00)'", 'Mode=ascii'))
      .toBe(`${IND_FILE} GET 'SYS1.PARMLIB(IEASYS00)' ASCII CRLF`);
  });

  it('emits ASCII without CRLF for Cr=keep', () => {
    // `p->cr_flag = !strcasecmp(..., "remove") || !strcasecmp(..., "add")`
    // (ft.c:949-950): `keep` is the one value that leaves it false.
    expect(cmd('Mode=ascii', 'Cr=keep')).toBe(`${IND_FILE} GET FOO ASCII`);
  });

  it('treats Cr=remove and Cr=add identically, because the direction decides', () => {
    // Both set cr_flag (ft.c:949-950) and both emit CRLF. CRLF means "the other
    // side uses CRLF line ends" — a GET removes them, a PUT adds them — so the
    // verb already carries the difference.
    expect(cmd('Mode=ascii', 'Cr=remove')).toBe(cmd('Mode=ascii', 'Cr=add'));
  });

  it('emits APPEND on a PUT only', () => {
    // `if (p->append_flag && !p->receive_flag)` (ft.c:699-701). On a GET,
    // Exist=append is a LOCAL instruction and must not reach the host.
    expect(cmd('Direction=send', 'Exist=append')).toBe(`${IND_FILE} PUT FOO APPEND`);
    expect(cmd('Direction=receive', 'Exist=append')).toBe(`${IND_FILE} GET FOO`);
  });

  it('emits nothing for Exist=keep or Exist=replace: both are local-only', () => {
    // ft.c:957-958 maps them to append_flag/allow_overwrite, and only
    // append_flag reaches the command.
    expect(cmd('Exist=keep')).toBe(`${IND_FILE} GET FOO`);
    expect(cmd('Direction=send', 'Exist=replace')).toBe(`${IND_FILE} PUT FOO`);
  });

  it('parenthesises RECFM, LRECL and BLKSIZE', () => {
    // ft.c:704-726, and independently the live usage text's
    // `RECFM(F|V|U) LRECL(nn) BLKSIZE(nn)`.
    expect(cmd('Direction=send', 'Recfm=fixed', 'Lrecl=80', 'Blksize=3120'))
      .toBe(`${IND_FILE} PUT FOO RECFM(F) LRECL(80) BLKSIZE(3120)`);
  });

  it('spells all three recfm letters', () => {
    // ft.c:707-719.
    expect(cmd('Direction=send', 'Recfm=fixed')).toBe(`${IND_FILE} PUT FOO RECFM(F)`);
    expect(cmd('Direction=send', 'Recfm=variable')).toBe(`${IND_FILE} PUT FOO RECFM(V)`);
    expect(cmd('Direction=send', 'Recfm=undefined')).toBe(`${IND_FILE} PUT FOO RECFM(U)`);
  });

  it('builds the full option list in x3270 order', () => {
    // ASCII, CRLF, APPEND, then the DCB group — the order of the appends in
    // ft_go (ft.c:689-726). Order matters to nothing we know of, and matching it
    // is free.
    expect(cmd(
      'Direction=send', "HostFile='HERC02.SRC(THING)'", 'Mode=ascii', 'Cr=add',
      'Exist=append', 'Recfm=variable', 'Lrecl=255', 'Blksize=6233',
    )).toBe(`${IND_FILE} PUT 'HERC02.SRC(THING)' ASCII CRLF APPEND RECFM(V) LRECL(255) BLKSIZE(6233)`);
  });

  it('leaves no trailing space when there are no options', () => {
    // THE ONE COSMETIC DIVERGENCE. x3270's third substitution is the empty string
    // for TSO, so its line is `"IND$FILE GET 'A.B' "` with a trailing blank. We
    // trim: it is invisible, every host command parser discards it, and it would
    // cost a cell of the input field that the runner's capacity pre-flight then
    // has to allow for.
    expect(cmd()).toBe(`${IND_FILE} GET FOO`);
    expect(cmd().endsWith(' ')).toBe(false);
  });

  it('accepts the dd:ddname host-file form verbatim', () => {
    // The live usage text's second form, `IND$FILE {GET|PUT} dd:ddname options`.
    // Nothing here interprets the host file name, which is what makes all three
    // forms work without a case for each.
    expect(cmd('HostFile=dd:INFILE')).toBe(`${IND_FILE} GET dd:INFILE`);
  });
});

// ---------------------------------------------------------------------------
// VM/CMS command construction
// ---------------------------------------------------------------------------

describe('VM/CMS command construction', () => {
  it('emits the ( separator before the options', () => {
    // ft.c:688: `(p->host_type != HT_TSO)? "(": ""`. This is the dialect
    // difference the design doc's seam exists for.
    expect(cmd('Host=vm', 'HostFile=PROFILE EXEC A'))
      .toBe(`${IND_FILE} GET PROFILE EXEC A (`);
  });

  it('appends the first option straight onto the ( with no space', () => {
    // x3270 substitutes the `(` and then appends `"ASCII"` with no leading space
    // (ft.c:685-690), giving `(ASCII`. Reproduced rather than tidied: this is the
    // string decades of CMS hosts have parsed.
    expect(cmd('Host=vm', 'Mode=ascii')).toBe(`${IND_FILE} GET FOO (ASCII CRLF`);
  });

  it('uses BARE recfm and lrecl keywords, with no parens', () => {
    // ft.c:750-765: `" RECFM "` then the letter, then `" LRECL %d"`. The
    // contrast with the TSO form is the whole point of the seam.
    expect(cmd('Host=vm', 'Direction=send', 'Recfm=variable', 'Lrecl=80'))
      .toBe(`${IND_FILE} PUT FOO (RECFM V LRECL 80`);
    expect(cmd('Host=vm', 'Direction=send', 'Recfm=fixed', 'Lrecl=80'))
      .toBe(`${IND_FILE} PUT FOO (RECFM F LRECL 80`);
  });

  it('builds the full VM option list', () => {
    expect(cmd(
      'Host=vm', 'Direction=send', 'HostFile=X MODULE A', 'Mode=ascii', 'Cr=add',
      'Exist=append', 'Recfm=fixed', 'Lrecl=80',
    )).toBe(`${IND_FILE} PUT X MODULE A (ASCII CRLF APPEND RECFM F LRECL 80`);
  });

  it('differs from TSO for the same request, and only in the documented ways', () => {
    // The seam, asserted directly: one request, two dialects, and the two
    // differences are the `(` and the parens.
    const args = ['LocalFile=/tmp/x', 'HostFile=FOO', 'Direction=send', 'Recfm=fixed', 'Lrecl=80'];
    const tsoReq = parseTransferKeywords([...args, 'Host=tso']);
    const vmReq = parseTransferKeywords([...args, 'Host=vm']);
    expect(TSO_DIALECT.buildCommand(tsoReq)).toBe(`${IND_FILE} PUT FOO RECFM(F) LRECL(80)`);
    expect(VM_DIALECT.buildCommand(vmReq)).toBe(`${IND_FILE} PUT FOO (RECFM F LRECL 80`);
  });
});

// ---------------------------------------------------------------------------
// The rest of the seam
// ---------------------------------------------------------------------------

describe('dialect selection and resync AID', () => {
  it('selects by host type', () => {
    expect(dialectFor('tso')).toBe(TSO_DIALECT);
    expect(dialectFor('vm')).toBe(VM_DIALECT);
    expect(TSO_DIALECT.name).toBe('tso');
    expect(VM_DIALECT.name).toBe('vm');
  });

  it('carries the per-dialect resync AID', () => {
    // ft_cut_ds.h:71-72: `ACK_RESYNC_VM` is Clear, `ACK_RESYNC_TSO` is PA2. The
    // second of the design doc's three dialect-dependent things. Nothing sends
    // these yet — x3270 does not either, `grep -rn ACK_RESYNC` over the 4.5 tree
    // returns only the two #defines — but the values must not have to be
    // rediscovered.
    expect(TSO_DIALECT.resyncAid).toBe(AckAid.RESYNC_TSO);
    expect(TSO_DIALECT.resyncAid).toBe(AID.PA2);
    expect(VM_DIALECT.resyncAid).toBe(AckAid.RESYNC_VM);
    expect(VM_DIALECT.resyncAid).toBe(AID.CLEAR);
  });
});
