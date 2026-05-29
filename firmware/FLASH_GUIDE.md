# How to update WiFi / server IP and reflash

## 1. Find your laptop's LAN IP

```bash
ipconfig getifaddr en0
```

That prints something like `192.168.2.84`. Use this as `SERVER_HOST` below.  
If you're on Ethernet instead of WiFi, try `en1`.

---

## 2. Edit the credentials

Open `firmware/stableFirmware/main/settings.h` and change lines 5, 6, and 8:

```c
#define WIFI_SSID           "YourNetworkName"
#define WIFI_PASSWORD       "YourPassword"

#define SERVER_HOST         "192.168.x.x"   // your laptop's LAN IP from step 1
#define SERVER_PORT         3001             // leave this alone
```

Save the file.

---

## 3. Plug in the board and find the USB port

Plug in the Buddly via USB-C, wait 2 seconds, then run:

```bash
ls /dev/cu.usb*
``` 

You'll see something like `/dev/cu.usbmodem14201`.

> **If nothing shows up:** the board isn't being detected. Try a different cable
> (must be a data cable, not a charge-only cable), or try the other USB-C port on
> the board. Unplug and replug, then run `ls /dev/cu.usb*` again.

---

## 4. Build and flash

**Important: the command must be run from inside the firmware folder.**  
Copy this block exactly — the `cd` is included:

```bash
cd /Users/kenogollner/Buddlys-Mistral-Setup/firmware/stableFirmware && \
source ~/esp/esp-idf/export.sh && \
idf.py -p /dev/cu.usbmodem14201 -b 921600 flash
```

Replace `/dev/cu.usbmodem14201` with whatever you got in step 3.

The build takes ~2 minutes the first time, under 10 seconds on subsequent flashes
(only `main.c` recompiles when you change `settings.h`).

---

## 5. Confirm it worked

After flashing, run this from the same folder:

```bash
idf.py -p /dev/cu.usbmodem14201 monitor
```

You should see `WiFi connected, IP=...` and then `WS connected` within a few seconds.  
Press `Ctrl+]` to exit the monitor.

---

## Quick reference (all-in-one)

```bash
# 1. Get your laptop's IP
ipconfig getifaddr en0

# 2. Edit credentials (use the IP from above as SERVER_HOST)
open /Users/kenogollner/Buddlys-Mistral-Setup/firmware/stableFirmware/main/settings.h

# 3. Check the board is detected
ls /dev/cu.usb*

# 4. Flash (replace the port with what you saw in step 3)
cd /Users/kenogollner/Buddlys-Mistral-Setup/firmware/stableFirmware && \
source ~/esp/esp-idf/export.sh && \
idf.py -p /dev/cu.usbmodem14201 -b 921600 flash
```
