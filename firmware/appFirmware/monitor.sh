#!/bin/bash
set -euo pipefail

export PATH="/usr/local/opt/python@3.12/libexec/bin:$PATH"
. "$HOME/esp/esp-idf/export.sh" >/dev/null

PORT="${1:-}"
if [ -z "$PORT" ]; then
  for candidate in /dev/cu.usbmodem* /dev/cu.usbserial*; do
    [ -e "$candidate" ] || continue
    PORT="$candidate"
    break
  done
fi

if [ -z "$PORT" ]; then
  echo "No ESP serial port found. Plug in the board and try again."
  exit 1
fi

python3 -m serial.tools.miniterm "$PORT" 115200
