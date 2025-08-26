// index.js
const HID = require('node-hid');
const Emittery = require('emittery');

const VENDOR_ID = 2385; // Kingston/HyperX
// Known Cloud Flight Wireless product IDs (different dongle/firmware revisions)
const SUPPORTED_PRODUCT_IDS = new Set([5828, 5923]); // 0x16C4, 0x1723

// Observed interfaces / usage pages:
// 65472 -> power/mute (report length: 2)
// 12    -> volume up/down (report length: 5)
// 65363 OR 65424 -> status/battery (report length: 15 or 20), usage=771
const STATUS_USAGE = 771;
const STATUS_USAGEPAGES = new Set([65363, 65424]);

/**
 * Create a HyperX Cloud Flight Wireless reader that emits:
 *  - 'power'    : 'on' | 'off'
 *  - 'muted'    : boolean
 *  - 'volume'   : 'up' | 'down'
 *  - 'charging' : boolean
 *  - 'battery'  : 0..100 (estimate) | null
 *  - 'error'    : Error
 *  - 'unknown'  : Buffer (unmapped packet)
 *
 * Options:
 *  - debug                : log raw HID buffers
 *  - updateDelay          : keep-alive/“bootstrap” interval in ms
 *  - dedupe               : de-duplicate repeated events
 *  - batteryMinIntervalMs : minimum interval between identical battery events
 */
module.exports = ({
  debug = false,
  updateDelay = 5 * 1000 * 60,       // keep-alive interval (ms)
  dedupe = true,                      // enable/disable event de-duplication
  batteryMinIntervalMs = 15 * 1000,   // at most one identical battery emission per X ms
} = {}) => {
  // If you need to force libusb on Windows, uncomment the next line.
  // if (process.platform === 'win32') HID.setDriverType('libusb');

  const emitter = new Emittery();

  // --- De-dupe / throttle state ---
  let lastBattery = null;
  let lastBatteryEmitTs = 0;
  let lastCharging = null;
  let lastPower = null;
  let lastMuted = null;

  // --- Enumerate vendor devices ---
  const all = HID.devices().filter((d) => d.vendorId === VENDOR_ID);

  // 1) try known product IDs
  let devices = all.filter((d) => SUPPORTED_PRODUCT_IDS.has(d.productId));

  // 2) fallback: match by product name
  if (devices.length === 0) {
    devices = all.filter((d) =>
      (d.product || '').toLowerCase().includes('cloud flight wireless')
    );
  }

  if (devices.length === 0) {
    throw new Error(new Error('HyperX Cloud Flight Wireless was not found'));
  }

  let interval;
  let bootstrapDevice;

  function bootstrap() {
    if (!interval) {
      interval = setInterval(bootstrap, updateDelay);
    }

    if (!bootstrapDevice) {
      // Find the “status” interface
      const bootstrapDeviceInfo =
        devices.find(
          (d) => d.usage === STATUS_USAGE && STATUS_USAGEPAGES.has(d.usagePage)
        ) ||
        // Fallback: if usagePage is undefined, take the first with usage=771
        devices.find((d) => d.usage === STATUS_USAGE);

      if (!bootstrapDeviceInfo) {
        emitter.emit(
          'error',
          new Error(
            'Status interface (usage=771) not found; adjust usage/usagePage filters'
          )
        );
        return;
      }
      try {
        bootstrapDevice = new HID.HID(bootstrapDeviceInfo.path);
        bootstrapDevice.on('error', (err) => emitter.emit('error', err));
      } catch (e) {
        emitter.emit('error', e);
        return;
      }
    }

    // Keep-alive packet to “wake up” status reports
    try {
      const buffer = Buffer.from([
        0x21, 0xff, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      bootstrapDevice.write(buffer);
    } catch (e) {
      emitter.emit('error', e);
    }
  }

  bootstrap();

  // Open all detected headset interfaces
  devices.forEach((deviceInfo) => {
    let device;
    try {
      device = new HID.HID(deviceInfo.path);
    } catch (e) {
      emitter.emit('error', e);
      return;
    }

    emitter.on('close', () => {
      try { device.close(); } catch (_) {}
    });

    device.on('error', (err) => emitter.emit('error', err));

    device.on('data', (data) => {
      if (debug) {
        console.log(new Date(), data, `length: ${data.length}`);
      }

      switch (data.length) {
        case 0x02: {
          // Power / Mute
          if (data[0] === 0x64 && data[1] === 0x03) {
            // power off
            clearInterval(interval);
            interval = null;
            if (!dedupe || lastPower !== 'off') {
              emitter.emit('power', 'off');
              lastPower = 'off';
            }
            return;
          }

          if (data[0] === 0x64 && data[1] === 0x01) {
            // power on
            bootstrap();
            if (!dedupe || lastPower !== 'on') {
              emitter.emit('power', 'on');
              lastPower = 'on';
            }
            return;
          }

          const isMuted = data[0] === 0x65 && data[1] === 0x04;
          if (!dedupe || isMuted !== lastMuted) {
            emitter.emit('muted', isMuted);
            lastMuted = isMuted;
          }
          break;
        }

        case 0x05: {
          // Volume up/down
          const v = data[1];
          const dir = v === 0x01 ? 'up' : v === 0x02 ? 'down' : null;
          if (dir) emitter.emit('volume', dir);
          break;
        }

        case 0x0f:
        case 0x14: {
          // Status / Battery
          const chargeState = data[3];
          const magicValue = data[4] || chargeState;

          function calculatePercentage() {
            if (chargeState === 0x10) {
              // charging
              const isCharging = magicValue >= 20;
              if (!dedupe || isCharging !== lastCharging) {
                emitter.emit('charging', isCharging);
                lastCharging = isCharging;
              }
              if (magicValue <= 11) return 100;
            }

            if (chargeState === 0x0f) {
              if (magicValue >= 130) return 100;
              if (magicValue < 130 && magicValue >= 120) return 95;
              if (magicValue < 120 && magicValue >= 100) return 90;
              if (magicValue < 100 && magicValue >= 70)  return 85;
              if (magicValue < 70  && magicValue >= 50)  return 80;
              if (magicValue < 50  && magicValue >= 20)  return 75;
              if (magicValue < 20  && magicValue >  0)   return 70;
            }

            if (chargeState === 0x0e) {
              if (magicValue < 250 && magicValue >  240) return 65;
              if (magicValue < 240 && magicValue >= 220) return 60;
              if (magicValue < 220 && magicValue >= 208) return 55;
              if (magicValue < 208 && magicValue >= 200) return 50;
              if (magicValue < 200 && magicValue >= 190) return 45;
              if (magicValue < 190 && magicValue >= 180) return 40;
              if (magicValue < 179 && magicValue >= 169) return 35;
              if (magicValue < 169 && magicValue >= 159) return 30;
              if (magicValue < 159 && magicValue >= 148) return 25;
              if (magicValue < 148 && magicValue >= 119) return 20;
              if (magicValue < 119 && magicValue >= 90)  return 15;
              if (magicValue < 90)                        return 10;
            }

            return null;
          }

          const percentage = calculatePercentage();
          if (percentage != null) {
            const now = Date.now();
            const changed = percentage !== lastBattery;
            const timedOut = now - lastBatteryEmitTs >= batteryMinIntervalMs;

            if (!dedupe || changed || timedOut) {
              emitter.emit('battery', percentage);
              lastBattery = percentage;
              lastBatteryEmitTs = now;
            }
          }
          break;
        }

        default: {
          // Unknown / unmapped packet
          emitter.emit('unknown', data);
        }
      }
    });
  });

  return emitter;
};
