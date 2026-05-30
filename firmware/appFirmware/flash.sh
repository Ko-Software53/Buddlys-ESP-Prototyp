#!/usr/bin/env bash
# Quick build+flash for the Buddly firmware.
#   ./flash.sh            build + flash (auto-detect port)
#   ./flash.sh monitor    build + flash + open serial monitor
#   ./flash.sh -p PORT    force a specific port
#
# Auto-detects the ESP32-S3 USB-Serial/JTAG port and sources ESP-IDF for you.
set -euo pipefail

IDF_EXPORT="${IDF_EXPORT:-$HOME/esp/esp-idf/export.sh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PORT=""
DO_MONITOR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) PORT="$2"; shift 2 ;;
    monitor|-m|--monitor) DO_MONITOR=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Auto-detect the first usbmodem/usbserial port if none was given.
if [[ -z "$PORT" ]]; then
  PORT="$(ls /dev/cu.usbmodem* /dev/cu.usbserial* /dev/cu.wchusbserial* /dev/cu.SLAB_USBtoUART 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$PORT" ]]; then
  echo "❌ No ESP32 serial port found. Re-seat the USB cable (data cable, not charge-only)." >&2
  echo "   If it still won't appear: hold BOOT, tap RESET, release BOOT, then re-run." >&2
  exit 1
fi
echo "▶ Using port: $PORT"

# shellcheck disable=SC1090
source "$IDF_EXPORT" >/dev/null 2>&1

if [[ "$DO_MONITOR" -eq 1 ]]; then
  exec idf.py -p "$PORT" flash monitor
else
  idf.py -p "$PORT" flash
  echo "✅ Flashed. (run './flash.sh monitor' to watch serial logs)"
fi
