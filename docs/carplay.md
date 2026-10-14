# CarPlay

soloops has its own icon on the CarPlay home screen: a spoken briefing of the
day, today's appointments, and the follow-ups that are due — all read from the
phone's local database, because a car usually has no useful network.

## The entitlement

**A CarPlay app needs an entitlement that Apple grants per app**, and that is
not a formality: without it the CarPlay scene is never created, on a real head
unit or in Xcode's CarPlay simulator. There is no way around it.

This app is built against `com.apple.developer.carplay-audio`, declared in
`Soloops.entitlements` and named in `CarPlayConfiguration`. That category is
the one with a realistic chance of being granted, and it fits: the content
really is audio, and the lists are how you choose which part of it to hear. For
a driver that is the right way round anyway — a list you read at 80 km/h is a
list you should not have been reading.

Request it at <https://developer.apple.com/contact/carplay/>. Until it comes
through, everything except the CarPlay screen works: the phone app, and Siri,
which runs in the car without any entitlement at all.

The key therefore **ships commented out** in `Soloops.entitlements`. An
entitlement that is missing from the provisioning profile does not just disable
its feature — it fails code signing, and the app cannot be installed on a phone
at all. Uncomment the two lines when the grant arrives.

`com.apple.developer.carplay-driving-task` would describe an agenda more
literally and is granted far more narrowly, mostly to vehicle manufacturers. If
you ever get it, change the key in the entitlements file — the templates used
here are permitted in both categories.

## What it does in the car

- **Tag vorlesen** — appointments still to come and the due follow-ups, spoken,
  with the count first so the length is known in advance. Speech ducks the
  radio rather than interrupting it, and the steering-wheel controls work
  through `MPNowPlayingInfoCenter`.
- **Heute** — the day's appointments. Tapping one with an address hands it to
  whatever app is doing navigation; one without gets read aloud.
- **Wiedervorlage** — the due follow-ups, each with three one-tap choices:
  call, postpone to tomorrow, done. Anything more belongs on the phone.

## Travel time, recorded by itself

CarPlay connecting and disconnecting is a reliable signal that a journey
started and ended, and travel to a customer is work that usually goes unbilled
because nobody starts a stopwatch while parking.

The destination is inferred from the calendar: a drive ending shortly before an
appointment, or starting shortly after one, was almost certainly to or from it,
and the entry is booked against that project as "Anfahrt" or "Rückfahrt". When
nothing lines up, **the drive waits on the _Fahrten_ screen instead of being
booked against a guess** — time landing on the wrong customer is worse than
time not landing at all, because nobody goes looking for an entry they did not
expect. Drives under three minutes and over four hours are discarded; the
latter is a phone left in a parked car with the ignition on.

## Siri

Works in CarPlay with no entitlement, and is the fastest way to any of this
with both hands on the wheel: _Nächster Termin_, _Tagesbriefing_, _Fällige
Wiedervorlagen_, _Notiz an soloops_, _Zeit starten_. All of them read and write
the local database only — a phrase that needed the network would fail exactly
where it is wanted most.

## Building it

The Xcode project is generated, not committed:

```bash
brew install xcodegen
cd apps/ios && xcodegen
open Soloops.xcodeproj
```

Everything that decides how the app behaves — the scene manifest, the
entitlements, the asset catalog with its CarPlay icon slot — is in version
control next to `project.yml`.

Xcode is needed **once**: sign in under _Settings → Accounts_, open the
project and let it create the certificate, the App ID and the iCloud container
— the command line cannot do that first-time setup. Then write the team id to
`apps/ios/.team`, which is untracked and substituted into the generated
project. It goes there rather than into Xcode's signing pane because the
project is generated, and anything set in the pane is gone after the next
`xcodegen`. After that, every install is one command:

```bash
bash scripts/ios-install.sh          # the connected iPhone
bash scripts/ios-install.sh <udid>   # a specific one, if several are attached
```

The phone needs **Developer Mode** once (_Settings → Privacy & Security_), and
the build runs in a scratch path outside `~/Desktop` for the same reason
`ios-test.sh` does — see [Tooling](development.md).

The install lasts as long as the provisioning profile: **twelve months** with
a paid membership, seven days with free signing. The iCloud entitlement needs
the paid one, and the error Xcode gives for that names the team rather than
the capability — "personal development teams do not support the iCloud
capability" is what a lapsed membership looks like, not a statement about
which team you picked.

Do not edit `Info.plist` through Xcode's inspector: it rewrites the file
alphabetically and drops every comment, and the comments in there are the
reasons for the parts that look wrong.
Letting anyone else install it is a different question — that needs the App
Store, because Ad Hoc caps at 100 hand-registered devices and the Enterprise
programme requires a company with 100+ employees.
