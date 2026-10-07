import Testing

@testable import SoloopsKit

/// The clock, and above all its agreement with the API's.
///
/// The fixtures below were produced by `apps/api/src/services/hlc.ts`. They
/// are hard-coded on purpose: a test that generates both sides from the same
/// code cannot catch the thing that actually goes wrong here, which is the two
/// implementations drifting apart.
@Suite("HLC")
struct HlcTests {
    let phone = "phone"
    let mac = "mac"

    func stamp(_ millis: Int64, _ counter: Int, _ device: String) -> String {
        Hlc.format(Hlc.State(millis: millis, counter: counter), deviceId: device)
    }

    @Test("der Stempel sieht aus wie der vom Server")
    func formatMatchesTheServer() {
        // Produced by format({ millis: 1759497600000, counter: 7 }, 'phone')
        #expect(stamp(1_759_497_600_000, 7, phone) == "000001759497600000:00007:phone")
        #expect(stamp(0, 0, mac) == "000000000000000000:00000:mac")
    }

    @Test("ein Stempel laesst sich wieder auseinandernehmen")
    func roundTrip() {
        let parsed = Hlc.parse(stamp(1_759_497_600_000, 7, phone))
        #expect(parsed?.millis == 1_759_497_600_000)
        #expect(parsed?.counter == 7)
        #expect(parsed?.deviceId == phone)
    }

    @Test("Unsinn ist kein Stempel")
    func rejectsNonsense() {
        #expect(Hlc.parse("irgendwas") == nil)
        #expect(Hlc.parse("") == nil)
        // Right shape, wrong widths — would sort wrongly, so it is not a stamp.
        #expect(Hlc.parse("123:00000:phone") == nil)
        #expect(Hlc.parse("000001759497600000:7:phone") == nil)
        #expect(Hlc.parse("000001759497600000:00007:") == nil)
    }

    @Test("Textsortierung ist Zeitsortierung")
    func textOrderIsTimeOrder() {
        #expect(stamp(2, 0, phone) > stamp(1, 99999, phone))
        #expect(stamp(1, 2, phone) > stamp(1, 1, phone))
        // Even the carry at the counter's ceiling keeps the order.
        #expect(stamp(1, 0, phone) > stamp(0, 99999, phone))
    }

    @Test("zwei Geraete erzeugen nie denselben Stempel")
    func devicesNeverTie() {
        #expect(stamp(1, 1, phone) != stamp(1, 1, mac))
    }

    @Test("die Uhr laeuft mit der Wanduhr")
    func followsTheWallClock() {
        #expect(Hlc.tick(Hlc.State(millis: 10, counter: 5), now: 20) == Hlc.State(millis: 20, counter: 0))
    }

    @Test("stillstehende Wanduhr: der Zaehler laeuft weiter")
    func counterMovesWhenTheClockDoesNot() {
        #expect(
            Hlc.tick(Hlc.State(millis: 20, counter: 0), now: 20) == Hlc.State(millis: 20, counter: 1)
        )
    }

    /// The case the whole clock exists for.
    @Test("rueckwaerts laufende Wanduhr schiebt den Stempel nicht zurueck")
    func neverGoesBackwards() {
        #expect(
            Hlc.tick(Hlc.State(millis: 1000, counter: 0), now: 900)
                == Hlc.State(millis: 1000, counter: 1)
        )
    }

    @Test("am Zaehlerende springt die Millisekunde")
    func carriesAtTheCeiling() {
        #expect(
            Hlc.tick(Hlc.State(millis: 1000, counter: Hlc.maxCounter), now: 900)
                == Hlc.State(millis: 1001, counter: 0)
        )
    }

    @Test("ein fremder Stempel zieht die eigene Uhr hinter sich")
    func observePullsForward() {
        #expect(
            Hlc.observe(Hlc.State(millis: 100, counter: 0), remote: stamp(5000, 3, mac), now: 100)
                == Hlc.State(millis: 5000, counter: 4)
        )
    }

    @Test("nach dem Beobachten sortiert der eigene naechste Stempel spaeter")
    func ownNextStampWins() {
        let remote = stamp(5000, 3, mac)
        let pulled = Hlc.observe(Hlc.State(millis: 100, counter: 0), remote: remote, now: 100)
        #expect(Hlc.format(pulled, deviceId: phone) > remote)
    }

    @Test("eine gesunde Wanduhr vor beiden setzt den Zaehler zurueck")
    func healthyClockResets() {
        #expect(
            Hlc.observe(Hlc.State(millis: 100, counter: 9), remote: stamp(200, 4, mac), now: 300)
                == Hlc.State(millis: 300, counter: 0)
        )
    }

    @Test("die Uhr meldet jede Aenderung, damit sie ueberlebt")
    func clockPersists() {
        var saved: [Hlc.State] = []
        let clock = HlcClock(
            deviceId: phone,
            initial: Hlc.State(millis: 1000, counter: 0),
            onChange: { saved.append($0) }
        )
        _ = clock.next(now: 2000)
        clock.witness(stamp(9000, 1, mac), now: 2000)
        #expect(saved.count == 2)
        #expect(saved.last == Hlc.State(millis: 9000, counter: 2))
    }

    @Test("eine wiederhergestellte Uhr mintet keinen alten Stempel mehr")
    func restoredClockDoesNotRegress() {
        let last = stamp(5_000_000, 12, phone)
        let clock = HlcClock(deviceId: phone, restoringFrom: last)
        // The wall clock is far behind the restored state — a relaunch after
        // sleep, or a phone whose clock was corrected backwards.
        #expect(clock.next(now: 1000) > last)
    }
}
