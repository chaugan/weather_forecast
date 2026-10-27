#!/bin/sh
# Build Glett for devices and install it over Wi-Fi or cable on the paired devices that answer now.
#   scripts/install-device.sh            # every reachable physical device
#   scripts/install-device.sh <udid>...  # just these
# Signing is manual with the development profiles "Glett Development" and "Glett Widgets Development" (the team's registered
# devices), made through the App Store Connect API and installed in ~/Library/Developer/Xcode/UserData/Provisioning
# Profiles, with the App Group group.no.glett.shared. MIN_IOS overrides the deployment target.
# The build number is yyyyMMddHHmm so the device shows which build it runs.
set -eu
cd "$(dirname "$0")/.."
DD="build/dd-device"
if [ ! -d Glett.xcodeproj ] || [ project.yml -nt Glett.xcodeproj/project.pbxproj ]; then
  xcodegen generate --quiet
fi
echo "== build"
xcodebuild -project Glett.xcodeproj -scheme Glett -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$DD" IPHONEOS_DEPLOYMENT_TARGET="${MIN_IOS:-18.0}" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Development" GLETT_APP_PROFILE="Glett Development" GLETT_WIDGETS_PROFILE="Glett Widgets Development" \
  CURRENT_PROJECT_VERSION="$(date +%Y%m%d%H%M)" build > "$DD.log" 2>&1 \
  || { grep -E "error:" "$DD.log" | sort -u | head; echo "build failed; log: $DD.log" >&2; exit 1; }
APP="$DD/Build/Products/Release-iphoneos/Glett.app"

# The state column must be exactly "available" or "connected" ("unavailable" contains "available").
if [ $# -eq 0 ]; then
  set -- $(xcrun devicectl list devices 2>/dev/null | awk '/physical/ {for (i=1;i<NF;i++) if ($i=="(UDID)" && ($(i+1)=="available" || $(i+1)=="connected")) print $(i-1)}')
fi
[ $# -gt 0 ] || { echo "no device reachable (asleep, locked or off the Wi-Fi?)" >&2; exit 1; }
for d in "$@"; do
  if xcrun devicectl device install app --device "$d" "$APP" > "$DD.install.log" 2>&1; then
    echo "ok: installed on $d"
    xcrun devicectl device process launch --device "$d" no.glett.app > /dev/null 2>&1 || echo "  (installed; open it on the device)"
  else
    echo "FAILED on $d:"; grep -E "NSLocalizedRecoverySuggestion|NSLocalizedFailureReason" "$DD.install.log" | head -3
  fi
done
