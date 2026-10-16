/**
 * Hybrid logical clocks.
 *
 * Two devices sync directly, so there is no authority to hand out an order.
 * Wall clocks alone will not do it either: phones and laptops drift, and a
 * Mac waking from sleep can briefly report a time that is behind the phone's.
 * A plain `updatedAt` comparison would then silently drop the newer edit.
 *
 * An HLC keeps the wall clock as its coarse component but never lets it go
 * backwards, and breaks ties with a counter. Reading a remote stamp pulls the
 * local clock forward, which is what makes "newer" mean the same thing on both
 * devices after they have spoken once.
 *
 * The stamp is a fixed-width string so that sorting it as text sorts it in
 * time — Postgres, SQLite and Swift then all agree on the order without any of
 * them having to parse it:
 *
 *     000001759497600000:00000:ckm1p2q3r4s5
 *     ^ millis, 18 wide    ^ counter  ^ device
 */

/** Fixed widths. Changing these invalidates every stamp ever written. */
const MILLIS_WIDTH = 18
const COUNTER_WIDTH = 5
const MAX_COUNTER = 10 ** COUNTER_WIDTH - 1

export type Hlc = string

export type HlcState = {
  millis: number
  counter: number
}

/** The zero stamp. Sorts before everything, so it works as a fresh cursor. */
export const HLC_ZERO: Hlc = ''

export function format(state: HlcState, deviceId: string): Hlc {
  const millis = String(state.millis).padStart(MILLIS_WIDTH, '0')
  const counter = String(state.counter).padStart(COUNTER_WIDTH, '0')
  return `${millis}:${counter}:${deviceId}`
}

export type ParsedHlc = HlcState & { deviceId: string }

/** Null for anything that is not a stamp — a cursor from an older client. */
export function parse(hlc: Hlc): ParsedHlc | null {
  const parts = hlc.split(':')
  if (parts.length !== 3) return null
  const millisRaw = parts[0] ?? ''
  const counterRaw = parts[1] ?? ''
  const deviceId = parts[2] ?? ''
  if (millisRaw.length !== MILLIS_WIDTH || counterRaw.length !== COUNTER_WIDTH) return null
  const millis = Number(millisRaw)
  const counter = Number(counterRaw)
  if (!Number.isInteger(millis) || !Number.isInteger(counter) || !deviceId) return null
  return { millis, counter, deviceId }
}

/**
 * String order is the real order — see the format above. Kept as a function
 * anyway so call sites read as comparisons and not as string trivia.
 */
export function compare(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function isNewer(a: Hlc, b: Hlc): boolean {
  return a > b
}

/** The later of two stamps. */
export function max(a: Hlc, b: Hlc): Hlc {
  return a > b ? a : b
}

/**
 * The next stamp for a local change.
 *
 * `now` is passed in rather than read, so the tests can drive the clock and
 * so a caller can stamp a batch of ops with one reading.
 */
export function tick(state: HlcState, now: number): HlcState {
  if (now > state.millis) return { millis: now, counter: 0 }
  // The wall clock stood still or went backwards. Keep the logical part
  // moving so two changes in the same millisecond stay distinguishable.
  if (state.counter >= MAX_COUNTER) return { millis: state.millis + 1, counter: 0 }
  return { millis: state.millis, counter: state.counter + 1 }
}

/**
 * Fold a stamp seen from another device into the local clock.
 *
 * This is the part that makes the order shared: after receiving an op from the
 * phone, the Mac's own next stamp is guaranteed to sort after it, even if the
 * Mac's wall clock is minutes behind.
 */
export function observe(state: HlcState, remote: Hlc, now: number): HlcState {
  const parsed = parse(remote)
  if (!parsed) return tick(state, now)

  const millis = Math.max(state.millis, parsed.millis, now)

  if (millis === state.millis && millis === parsed.millis) {
    return { millis, counter: Math.max(state.counter, parsed.counter) + 1 }
  }
  if (millis === state.millis) return tick(state, now)
  if (millis === parsed.millis) return { millis, counter: parsed.counter + 1 }
  // `now` is ahead of both — the common case once clocks are healthy.
  return { millis, counter: 0 }
}

/**
 * A clock that remembers where it got to.
 *
 * `load` and `save` keep it honest across restarts: without persistence a
 * restarted API could mint a stamp that sorts before an op it already sent,
 * and the phone would then reject its own next edit as stale.
 */
export class HlcClock {
  private state: HlcState

  constructor(
    readonly deviceId: string,
    initial: HlcState = { millis: 0, counter: 0 },
    private readonly onChange?: (state: HlcState) => void,
  ) {
    this.state = initial
  }

  /** Restore from a stamp, e.g. the newest op in the log. */
  static fromHlc(deviceId: string, hlc: Hlc, onChange?: (state: HlcState) => void): HlcClock {
    const parsed = parse(hlc)
    return new HlcClock(
      deviceId,
      parsed ? { millis: parsed.millis, counter: parsed.counter } : undefined,
      onChange,
    )
  }

  get current(): HlcState {
    return { ...this.state }
  }

  next(now: number = Date.now()): Hlc {
    this.state = tick(this.state, now)
    this.onChange?.(this.current)
    return format(this.state, this.deviceId)
  }

  /** Pull the clock past a remote stamp without minting one of our own. */
  witness(remote: Hlc, now: number = Date.now()): void {
    this.state = observe(this.state, remote, now)
    this.onChange?.(this.current)
  }
}
