#!/bin/bash
. ~/esp/esp-idf/export.sh 2>/dev/null
python3 -m serial.tools.miniterm /dev/cu.usbmodem14201 115200
