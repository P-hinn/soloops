#!/usr/bin/env bash
# Build the phone app and put it on the connected iPhone.
#
# Everything after the first run is this one command — Xcode is only needed
# once, to sign in with the Apple ID; the team id goes into apps/ios/.team.
#
#   bash scripts/ios-install.sh            # the only connected device
#   bash scripts/ios-install.sh <udid>     # a specific one
#
# The build goes to a scratch path outside ~/Desktop for the same reason
# ios-test.sh does: files under Desktop carry extended attributes that
# codesign refuses, and `xattr -cr` does not stick because iCloud puts them
# back. Here it matters more than in the tests — signing is the whole point.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ios="$here/apps/ios"
scratch="${TMPDIR:-/tmp}/soloops-ios-build"

if ! command -v xcodegen >/dev/null; then
  echo "xcodegen fehlt:  brew install xcodegen" >&2
  exit 1
fi

# The team id is substituted into the generated project from here, so that
# the tracked spec carries no account identifier. An .xcconfig cannot do this
# one key: XcodeGen writes DEVELOPMENT_TEAM into the target's own build
# settings, and those override any base configuration.
team="$(tr -d '[:space:]' <"$ios/.team" 2>/dev/null || true)"
if [ -z "$team" ]; then
  echo "Keine Team-ID in apps/ios/.team." >&2
  echo "Xcode -> Settings -> Accounts zeigt sie hinter dem Teamnamen, dann:" >&2
  echo "  echo DEINETEAMID > apps/ios/.team" >&2
  exit 1
fi
export SOLOOPS_TEAM="$team"

# The project is generated, so regenerate before building — otherwise a change
# to project.yml silently does not apply.
(cd "$ios" && xcodegen >/dev/null)

udid="${1:-}"
if [ -z "$udid" ]; then
  # Read the JSON rather than the table: the columns are for people and have
  # no promised order, the keys do. Picking one of several devices silently is
  # how a build lands on the wrong phone and costs ten minutes of confusion.
  devices="${TMPDIR:-/tmp}/soloops-devices.json"
  xcrun devicectl list devices --json-output "$devices" >/dev/null 2>&1 || true

  mapfile -t found < <(python3 - "$devices" <<'PY'
import json, sys

try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except (OSError, KeyError, ValueError):
    sys.exit(0)

for device in devices:
    hardware = device.get("hardwareProperties", {})
    connection = device.get("connectionProperties", {})

    # Filter only on what is actually there. A schema that gains or renames a
    # key should cost a wrong guess at worst, not an empty list.
    platform = str(hardware.get("platform", "iOS"))
    if "iOS" not in platform and "iPadOS" not in platform:
        continue
    state = str(connection.get("tunnelState", "connected")).lower()
    if state in {"unavailable", "disconnected"}:
        continue

    identifier = device.get("identifier") or hardware.get("udid")
    if identifier:
        name = device.get("deviceProperties", {}).get("name", "?")
        print(f"{identifier}\t{name}")
PY
  )

  case ${#found[@]} in
    0)
      echo "Kein iPhone gefunden. Kabel, entsperren, Vertrauen bestaetigen." >&2
      echo "Und einmalig am Telefon: Einstellungen -> Datenschutz & Sicherheit" >&2
      echo "-> Entwicklermodus einschalten." >&2
      echo >&2
      echo "Falls doch eins haengt, UDID direkt uebergeben:" >&2
      xcrun devicectl list devices >&2
      exit 1
      ;;
    1)
      udid="${found[0]%%$'\t'*}"
      echo "Geraet: ${found[0]#*$'\t'}"
      ;;
    *)
      echo "Mehrere Geraete. Eins als Argument uebergeben:" >&2
      printf '  %s\n' "${found[@]}" >&2
      exit 1
      ;;
  esac
fi

echo "Baue fuer $udid …"
xcodebuild \
  -project "$ios/Soloops.xcodeproj" \
  -scheme Soloops \
  -configuration Debug \
  -destination "id=$udid" \
  -derivedDataPath "$scratch" \
  -allowProvisioningUpdates \
  build

app="$scratch/Build/Products/Debug-iphoneos/soloops.app"
[ -d "$app" ] || {
  echo "Gebaute App nicht gefunden: $app" >&2
  exit 1
}

echo "Installiere …"
xcrun devicectl device install app --device "$udid" "$app"
echo "Fertig. soloops liegt auf dem Telefon."
