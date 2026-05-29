#!/bin/bash
set -e
. /Users/kenogollner/esp/esp-idf/export.sh
cd /Users/kenogollner/Buddlys-Mistral-Setup/firmware/esp32-espidf-buddly/buddly_client
idf.py -p /dev/cu.usbmodem14101 -b 921600 flash monitor
