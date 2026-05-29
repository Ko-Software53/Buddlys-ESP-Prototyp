#!/bin/bash
set -e
. /Users/kenogollner/esp/esp-idf/export.sh
cd /Users/kenogollner/Buddlys-Mistral-Setup/firmware/appFirmware
idf.py -p /dev/cu.usbmodem14201 -b 921600 flash monitor
