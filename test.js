// Example: read events from the headset in the console
const hyperxCloudFlight = require('./')({
  debug: false,
  // at most one identical battery emission per minute if the value doesn't change
  batteryMinIntervalMs: 60_000,
});

hyperxCloudFlight.on('power',    (power)     => console.log(`power: ${power}`));
hyperxCloudFlight.on('muted',    (status)    => console.log(`muted: ${status}`));
hyperxCloudFlight.on('volume',   (direction) => console.log(`volume: ${direction}`));
hyperxCloudFlight.on('charging', (charging)  => console.log(`charging: ${charging}`));
hyperxCloudFlight.on('battery',  (pct)       => console.log(`current battery: ${pct}%`));
hyperxCloudFlight.on('unknown',  (data)      => console.log('unknown', data));
hyperxCloudFlight.on('error',    (err)       => console.error('error', err));
