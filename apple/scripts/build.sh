#!/bin/sh
# Build the iOS app for the simulator.
# Usage: scripts/build.sh [destination] [derived-data-path]
# The project is generated from project.yml only when it is missing or older than project.yml, so parallel
# builds never rewrite it under each other. Sources are synced folders: new files need no regeneration.
set -eu
cd "$(dirname "$0")/.."
if [ ! -d Glett.xcodeproj ] || [ project.yml -nt Glett.xcodeproj/project.pbxproj ]; then
  xcodegen generate --quiet
fi
DEST="${1:-platform=iOS Simulator,id=A24048E3-2C60-44B5-AE8C-604434D3EDC7}"
DD="${2:-build/DerivedData}"
xcodebuild -project Glett.xcodeproj -scheme Glett -destination "$DEST" -derivedDataPath "$DD" build -quiet
