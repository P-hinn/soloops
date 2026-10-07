import Foundation

/// Hybrid logical clocks, the phone's half.
///
/// This is a deliberate line-by-line counterpart of `apps/api/src/services/
/// hlc.ts`. The two have to produce byte-identical stamps and order them the
/// same way, because the merge compares them as plain strings on both sides.
/// A widths mismatch here would not throw anywhere — it would just make every
/// comparison across the pair wrong, in a way that looks like random data
/// loss weeks later. If you change a constant below, change it there too.
public enum Hlc {
    /// Fixed widths. Changing these invalidates every stamp ever written.
    static let millisWidth = 18
    static let counterWidth = 5
    static let maxCounter = 99_999

    /// The zero stamp. Sorts before everything, so it works as a fresh cursor.
    public static let zero = ""

    public struct State: Equatable, Sendable {
        public var millis: Int64
        public var counter: Int

        public init(millis: Int64 = 0, counter: Int = 0) {
            self.millis = millis
            self.counter = counter
        }
    }

    public struct Parsed: Equatable, Sendable {
        public let millis: Int64
        public let counter: Int
        public let deviceId: String
    }

    public static func format(_ state: State, deviceId: String) -> String {
        let millis = pad(String(state.millis), to: millisWidth)
        let counter = pad(String(state.counter), to: counterWidth)
        return "\(millis):\(counter):\(deviceId)"
    }

    /// Nil for anything that is not a stamp — an empty cursor, for instance.
    public static func parse(_ stamp: String) -> Parsed? {
        let parts = stamp.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let millisRaw = parts[0]
        let counterRaw = parts[1]
        let deviceId = String(parts[2])
        guard millisRaw.count == millisWidth, counterRaw.count == counterWidth,
            !deviceId.isEmpty,
            let millis = Int64(millisRaw), let counter = Int(counterRaw)
        else { return nil }
        return Parsed(millis: millis, counter: counter, deviceId: deviceId)
    }

    /// String order is the real order — see the note on `format`.
    public static func isNewer(_ a: String, than b: String) -> Bool {
        a > b
    }

    public static func later(_ a: String, _ b: String) -> String {
        a > b ? a : b
    }

    /// The next stamp for a local change.
    ///
    /// `now` is a parameter so the tests can drive the clock, and so one batch
    /// of ops can be stamped from a single reading.
    public static func tick(_ state: State, now: Int64) -> State {
        if now > state.millis { return State(millis: now, counter: 0) }
        // The wall clock stood still or went backwards. The logical part keeps
        // moving so two changes in one millisecond stay distinguishable.
        if state.counter >= maxCounter { return State(millis: state.millis + 1, counter: 0) }
        return State(millis: state.millis, counter: state.counter + 1)
    }

    /// Fold a stamp seen from the Mac into this device's clock.
    ///
    /// This is what makes the order shared. A phone whose clock is behind the
    /// Mac's still mints a stamp that sorts after anything it has received,
    /// so an edit made on the phone after reading the Mac's cannot lose to it.
    public static func observe(_ state: State, remote: String, now: Int64) -> State {
        guard let parsed = parse(remote) else { return tick(state, now: now) }

        let millis = max(state.millis, parsed.millis, now)

        if millis == state.millis && millis == parsed.millis {
            return State(millis: millis, counter: max(state.counter, parsed.counter) + 1)
        }
        if millis == state.millis { return tick(state, now: now) }
        if millis == parsed.millis { return State(millis: millis, counter: parsed.counter + 1) }
        // `now` is ahead of both — the common case once clocks are healthy.
        return State(millis: millis, counter: 0)
    }

    private static func pad(_ text: String, to width: Int) -> String {
        text.count >= width
            ? text : String(repeating: "0", count: width - text.count) + text
    }
}

/// A clock that remembers where it got to.
///
/// Persistence matters as much here as on the Mac: a relaunched app that
/// minted a stamp behind one it had already pushed would see its own next
/// edit rejected as stale.
public final class HlcClock {
    public let deviceId: String
    private var state: Hlc.State
    private let onChange: ((Hlc.State) -> Void)?
    private let lock = NSLock()

    public init(
        deviceId: String,
        initial: Hlc.State = Hlc.State(),
        onChange: ((Hlc.State) -> Void)? = nil
    ) {
        self.deviceId = deviceId
        self.state = initial
        self.onChange = onChange
    }

    /// Restore from a stamp, e.g. the newest op in the local log.
    public convenience init(
        deviceId: String,
        restoringFrom stamp: String,
        onChange: ((Hlc.State) -> Void)? = nil
    ) {
        let parsed = Hlc.parse(stamp)
        self.init(
            deviceId: deviceId,
            initial: parsed.map { Hlc.State(millis: $0.millis, counter: $0.counter) }
                ?? Hlc.State(),
            onChange: onChange
        )
    }

    public var current: Hlc.State {
        lock.lock()
        defer { lock.unlock() }
        return state
    }

    public func next(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
        lock.lock()
        state = Hlc.tick(state, now: now)
        let stamp = Hlc.format(state, deviceId: deviceId)
        let snapshot = state
        lock.unlock()
        onChange?(snapshot)
        return stamp
    }

    /// Pull the clock past a remote stamp without minting one of our own.
    public func witness(_ remote: String, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000))
    {
        lock.lock()
        state = Hlc.observe(state, remote: remote, now: now)
        let snapshot = state
        lock.unlock()
        onChange?(snapshot)
    }
}
