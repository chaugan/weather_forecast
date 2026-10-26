#!/bin/sh
# Archive Glett and upload it to TestFlight in one go.
#   scripts/testflight-upload.sh               # archive + upload
#   scripts/testflight-upload.sh --archive-only
# Outside the repo, set up once (2026-10-26):
#   - ~/.config/glett-apple/asc.env: KEY_ID and ISSUER_ID of the team's App Store Connect API key, whose .p8 is in
#     ~/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8
#   - the App Store profile "Glett App Store" (made through the API), installed in the Provisioning Profiles folders
#   - the team's iOS distribution identity, kept in ~/Library/Keychains/scoutvr-dist.keychain-db (shared with
#     IntelMap's builds) whose password is in ~/.appstoreconnect/scoutvr-keychain.pw
#   - DEVELOPMENT_TEAM in Config/Signing.local.xcconfig
# Signs without the App Group until Xcode registers it (an API key cannot). The build number is the date and time.
set -eu
cd "$(dirname "$0")/.."
. "$HOME/.config/glett-apple/asc.env"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
KC="$HOME/Library/Keychains/scoutvr-dist.keychain-db"
KPF="$HOME/.appstoreconnect/scoutvr-keychain.pw"
TEAM_ID="$(awk -F'= *' '/^DEVELOPMENT_TEAM/{print $2}' Config/Signing.local.xcconfig)"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
OUT="build/testflight-$BUILD_NUMBER"
[ -f "$KEY" ] || { echo "missing API key" >&2; exit 1; }
[ -n "$TEAM_ID" ] || { echo "no DEVELOPMENT_TEAM in Config/Signing.local.xcconfig" >&2; exit 1; }
security unlock-keychain -p "$(cat "$KPF")" "$KC"
if [ ! -d Glett.xcodeproj ] || [ project.yml -nt Glett.xcodeproj/project.pbxproj ]; then
  xcodegen generate --quiet
fi
mkdir -p "$OUT"
echo "== archive (build $BUILD_NUMBER)"
xcodebuild -project Glett.xcodeproj -scheme Glett -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Glett.xcarchive" -derivedDataPath build/dd-release archive \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="iPhone Distribution" PROVISIONING_PROFILE_SPECIFIER="Glett App Store" \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_ENTITLEMENTS=Config/NoAppGroup.entitlements \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" > "$OUT/archive.log" 2>&1 \
  || { grep -E "error:" "$OUT/archive.log" | sort -u | head; echo "archive failed; log: $OUT/archive.log" >&2; exit 1; }
echo "ok: archived"
[ "${1:-}" = "--archive-only" ] && exit 0
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>iPhone Distribution</string>
  <key>provisioningProfiles</key><dict><key>no.glett.app</key><string>Glett App Store</string></dict>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
echo "== export + upload"
xcodebuild -exportArchive -archivePath "$OUT/Glett.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" -authenticationKeyPath "$KEY" -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID" > "$OUT/export.log" 2>&1 \
  || { grep -E "error:" "$OUT/export.log" | sort -u | head; echo "export failed; log: $OUT/export.log" >&2; exit 1; }
grep -E "Upload succeeded|Uploaded" "$OUT/export.log" | head -2
echo "ok: uploaded build $BUILD_NUMBER; Apple processes it for 10-30 min, then TestFlight shows it"
