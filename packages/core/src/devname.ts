/**
 * A device-name template that yields a fresh candidate per request.
 *
 * WHY A HOST WANTS THIS: the device name is how some hosts identify a session, and a
 * name already in use is refused -- so the client offers the next candidate. x3270's
 * `devname_success.trc` shows a host asking four times and receiving foo001 through
 * foo004; `devname_failure.trc` shows the same with a single digit, saturating at foo9
 * on the tenth and later requests.
 *
 * THE ONLY STATEFUL PIECE OF THIS FEATURE, deliberately isolated here so the reply
 * builder in `newenviron.ts` can stay pure and be tested against byte arrays.
 *
 * Ported from x3270's `devname_init` (Common/devname.c:42-69) and `devname_next`
 * (Common/devname.c:72-82).
 */
export class DeviceName {
  private readonly stem: string;
  private readonly digits: number;
  private readonly max: number;
  private current = 0;

  constructor(template: string) {
    // Count TRAILING '=' only: an '=' earlier in the name is part of the name.
    // Mirrors the backward scan in devname_init (devname.c:57-61).
    let digits = 0;
    while (digits < template.length
      && template[template.length - 1 - digits] === '=') digits++;
    this.digits = digits;
    this.stem = digits === 0 ? template : template.slice(0, template.length - digits);
    // 10^digits - 1, matching x3270's `max *= 10` per '=' and then `max - 1`
    // (devname.c:60,65). With no trailing '=', digits is 0 and max is 0, so the
    // `current < max` guard in next() is always false: a template with no '='
    // is a constant, exactly as devname_next returns the unmodified template
    // when sub_length is 0.
    //
    // Bounded to avoid Number.MAX_SAFE_INTEGER overflow on a pathological template
    // (e.g. 20 '=' characters): x3270's `unsigned long max` has the same class of
    // problem in C (silent wraparound), but here we cap at 15 digits (10^15 - 1,
    // well under 2^53) rather than let 10 ** digits silently exceed safe-integer
    // range and produce a max that Number can no longer represent exactly. A
    // template asking for more digits than that is almost certainly a typo, not
    // a real device-name scheme, so we treat additional trailing '=' beyond 15
    // as part of the stem instead of growing the counter further.
    const cappedDigits = Math.min(digits, 15);
    if (cappedDigits !== digits) {
      this.digits = cappedDigits;
      this.stem = template.slice(0, template.length - cappedDigits);
    }
    this.max = this.digits === 0 ? 0 : 10 ** this.digits - 1;
  }

  /**
   * The next candidate.
   *
   * Saturates rather than wrapping, as x3270 does (`if (d->current < d->max)`,
   * devname.c:76): re-offering a name the host already refused is the one outcome
   * this mechanism exists to prevent. A template with no '=' is a constant.
   */
  next(): string {
    if (this.digits === 0) return this.stem;
    if (this.current < this.max) this.current++;
    return this.stem + String(this.current).padStart(this.digits, '0');
  }
}
