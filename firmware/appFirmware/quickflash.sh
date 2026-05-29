#!/bin/bash
PYTHON=/Users/kenogollner/.espressif/python_env/idf5.3_py3.13_env/bin/python
ESPTOOL=/Users/kenogollner/esp/esp-idf/components/esptool_py/esptool/esptool.py
BUILD=/Users/kenogollner/Buddlys-Mistral-Setup/firmware/esp32-espidf-buddly/buddly_client/build

echo "Watching for device — unplug and replug the USB-C cable..."

BEFORE=$(ls /dev/cu.usb* 2>/dev/null | sort)
PORT=""
while [ -z "$PORT" ]; do
    AFTER=$(ls /dev/cu.usb* 2>/dev/null | sort)
    NEW=$(comm -13 <(echo "$BEFORE") <(echo "$AFTER") 2>/dev/null | head -1)
    if [ -n "$NEW" ]; then PORT=$NEW; fi
    sleep 0.05
done

echo "Device found: $PORT"
echo "Step 1: Erasing flash (fast)..."
$PYTHON $ESPTOOL --chip esp32s3 -p "$PORT" -b 921600 erase_flash

echo ""
echo "Step 2: Writing firmware..."
$PYTHON $ESPTOOL \
  --chip esp32s3 \
  -p "$PORT" \
  -b 921600 \
  --before default_reset \
  --after hard_reset \
  write_flash \
  --flash_mode dio \
  --flash_size 2MB \
  --flash_freq 80m \
  0x0     $BUILD/bootloader/bootloader.bin \
  0x8000  $BUILD/partition_table/partition-table.bin \
  0x10000 $BUILD/buddly_client.bin

echo "Done!"
