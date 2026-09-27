#!/usr/bin/env bash
# Build the fixture app as a simulator .app with a bare swiftc call, and install it on the
# booted simulator (or the one named by $1). No Xcode project: the whole build is this file.
#
#   examples/ios-sample/build.sh            # build + install on the booted device
#   examples/ios-sample/build.sh <udid>     # a specific device
#   VLMKIT_IOS_NO_INSTALL=1 build.sh        # build only
set -euo pipefail
cd "$(dirname "$0")"
DEVICE="${1:-booted}"
OUT="build/VlmkitSample.app"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
ARCH="$(uname -m)"
MIN_IOS="${VLMKIT_IOS_MIN:-17.0}"
rm -rf "$OUT" && mkdir -p "$OUT"
xcrun -sdk iphonesimulator swiftc \
  -target "${ARCH}-apple-ios${MIN_IOS}-simulator" -sdk "$SDK" \
  -module-name VlmkitSample -O \
  Sources/*.swift -o "$OUT/VlmkitSample"
cp Info.plist "$OUT/Info.plist"
echo "built $OUT"
if [ -z "${VLMKIT_IOS_NO_INSTALL:-}" ]; then
  xcrun simctl install "$DEVICE" "$OUT"
  echo "installed dev.vlmkit.sample on $DEVICE"
fi
