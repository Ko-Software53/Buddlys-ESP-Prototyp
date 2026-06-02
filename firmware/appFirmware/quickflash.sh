#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"

export PATH="/usr/local/opt/python@3.12/libexec/bin:$PATH"
. "$HOME/esp/esp-idf/export.sh" >/dev/null

if [ ! -f "$BUILD/buddly_client.bin" ]; then
    echo "No firmware build found at $BUILD. Run idf.py build first."
    exit 1
fi

PORT="${1:-}"
if [ -z "$PORT" ]; then
    for candidate in /dev/cu.usbmodem* /dev/cu.usbserial* /dev/cu.wchusbserial* /dev/cu.SLAB_USBtoUART; do
        [ -e "$candidate" ] || continue
        PORT="$candidate"
        break
    done
fi

if [ -z "$PORT" ]; then
    echo "No ESP serial port found. Plug in the board and try again."
    exit 1
fi

echo "Device found: $PORT"
echo "Step 1: Erasing flash (fast)..."
python -m esptool --chip esp32s3 -p "$PORT" -b 921600 erase_flash

echo ""
echo "Step 2: Writing firmware..."
python -m esptool \
  --chip esp32s3 \
  -p "$PORT" \
  -b 921600 \
  --before default_reset \
  --after hard_reset \
  write_flash \
  --flash_mode dio \
  --flash_size 8MB \
  --flash_freq 80m \
  0x0     "$BUILD/bootloader/bootloader.bin" \
  0x8000  "$BUILD/partition_table/partition-table.bin" \
  0x10000 "$BUILD/buddly_client.bin"

echo "Done!"
