#!/bin/sh
# Run GlettKit's tests on the host. Usage: scripts/test.sh [scratch-path]
set -eu
cd "$(dirname "$0")/../GlettKit"
swift test --scratch-path "${1:-.build}"
