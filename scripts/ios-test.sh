#!/usr/bin/env bash
# The iOS sync engine's tests.
#
# Not part of `npm run check`: they need the Swift toolchain, and only people
# who build the phone app need that — the same line the Rust tests are on.
#
# The scratch path is the point of this script. Building inside
# ~/Desktop fails at the code-signing step with "resource fork, Finder
# information, or similar detritus not allowed", because files under Desktop
# carry extended attributes that codesign refuses. Building outside it is the
# fix; `xattr -cr` does not stick.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${TMPDIR:-/tmp}/soloops-swift-build"

cd "$here/apps/ios/SoloopsKit"
exec swift test --scratch-path "$scratch" "$@"
