#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="/usr/local/opt/node@22/bin:$PATH"

QUERY=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      echo "Usage: npm run ios:device -- [device-name-or-id] [--dry-run]"
      echo
      echo "Builds, installs, and launches the standalone iOS Release app on a connected iPhone."
      exit 0
      ;;
    *)
      QUERY="$arg"
      ;;
  esac
done

TEAM_ID="${DEVELOPMENT_TEAM:-R6B9B96VYG}"
SCHEME="${SCHEME:-Buddlys}"
WORKSPACE="${WORKSPACE:-ios/Buddlys.xcworkspace}"
CONFIGURATION="${CONFIGURATION:-Release}"
BUNDLE_ID="${BUNDLE_ID:-de.buddlys.app}"
APP_PATH="${APP_PATH:-$HOME/Library/Developer/Xcode/DerivedData/Buddlys-glnazgrhdqcthqalbkfpqfvgwuts/Build/Products/Release-iphoneos/Buddlys.app}"
DEVICES_JSON="$(mktemp -t buddlys-devices.XXXXXX.json)"

cleanup() {
  rm -f "$DEVICES_JSON"
}
trap cleanup EXIT

xcrun devicectl list devices --json-output "$DEVICES_JSON" --quiet

DEVICE_INFO="$(
  node - "$DEVICES_JSON" "$QUERY" <<'NODE'
const fs = require('fs');

const [, , file, query = ''] = process.argv;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const normalizedQuery = query.toLowerCase();

const devices = (data.result?.devices ?? []).filter((device) => {
  const isPhone = device.hardwareProperties?.deviceType === 'iPhone';
  const isBooted = device.deviceProperties?.bootState === 'booted';
  const isPaired = device.connectionProperties?.pairingState === 'paired';
  const hasUdid = Boolean(device.hardwareProperties?.udid);
  const matchesQuery =
    !normalizedQuery ||
    [
      device.deviceProperties?.name,
      device.identifier,
      device.hardwareProperties?.udid,
      device.connectionProperties?.transportType,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));

  return isPhone && isBooted && isPaired && hasUdid && matchesQuery;
});

if (devices.length === 0) {
  console.error(query ? `No connected iPhone matched "${query}".` : 'No connected booted iPhone found.');
  process.exit(1);
}

if (!query && devices.length > 1) {
  console.error('More than one iPhone is connected. Pass part of the device name or ID.');
  for (const device of devices) {
    console.error(`- ${device.deviceProperties?.name} (${device.hardwareProperties?.udid})`);
  }
  process.exit(1);
}

const device = devices[0];
console.log([
  device.hardwareProperties.udid,
  device.identifier,
  device.deviceProperties?.name ?? 'iPhone',
].join('\t'));
NODE
)"

BUILD_ID="$(printf '%s' "$DEVICE_INFO" | awk -F '\t' '{print $1}')"
INSTALL_ID="$(printf '%s' "$DEVICE_INFO" | awk -F '\t' '{print $2}')"
DEVICE_NAME="$(printf '%s' "$DEVICE_INFO" | awk -F '\t' '{print $3}')"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Detected $DEVICE_NAME"
  echo "Build destination: $BUILD_ID"
  echo "Install device: $INSTALL_ID"
  exit 0
fi

echo "Building $CONFIGURATION for $DEVICE_NAME ($BUILD_ID)..."
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "id=$BUILD_ID" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  -allowProvisioningUpdates \
  build

echo "Installing $APP_PATH..."
xcrun devicectl device install app --device "$INSTALL_ID" "$APP_PATH"

echo "Launching $BUNDLE_ID..."
xcrun devicectl device process launch --device "$INSTALL_ID" --terminate-existing "$BUNDLE_ID"

echo "Installed and launched $BUNDLE_ID on $DEVICE_NAME."
