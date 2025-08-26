// sensor.js (spawned by node.exe)
const createHyperX = require('hyperx-cloud-flight-wireless');

function log(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

function start() {
  let flight;
  try {
    flight = createHyperX({
      debug: false,
      // adjust if you want fewer identical emissions
      batteryMinIntervalMs: 60_000,
    });
    log({ event: 'status', found: true });
  } catch (e) {
    log({ event: 'status', found: false, error: e.message || String(e) });
    setTimeout(start, 10_000);
    return;
  }

  flight.on('power', (p) => {
    log({ event: 'power', power: p });
    if (p === 'off') log({ event: 'status', found: false });
    else log({ event: 'status', found: true });
  });

  flight.on('battery', (pct) => log({ event: 'battery', battery: pct }));
  flight.on('muted',   (m)   => log({ event: 'muted',   muted: m }));
  flight.on('charging',(c)   => log({ event: 'charging',charging: c }));
  flight.on('error',   (e)   => log({ event: 'error',   error: e.message || String(e) }));
}

start();
