const { app, Tray, Menu, BrowserWindow, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

let tray = null;
let win  = null;
let child = null;
let quitting = false;

app.on('before-quit', () => {
  // prevent relaunch on exit and ensure helper is terminated
  quitting = true;
  try {
    if (child && !child.killed) {
      child.kill(); // terminate sensor.js
    }
  } catch (e) {
    console.error('kill child failed:', e);
  }
});

// headset state
const state = { found: false, battery: null, charging: null, muted: null, power: null };
// auto-start (login) state
let autoLaunchEnabled = false;

function readAutoLaunch() {
  try {
    const s = app.getLoginItemSettings();
    autoLaunchEnabled = !!s.openAtLogin;
  } catch (e) {
    autoLaunchEnabled = false;
  }
}

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // on Windows, using the current executable is sufficient
      path: process.execPath,
      args: []
    });
    autoLaunchEnabled = enabled;
  } catch (e) {
    console.error('setAutoLaunch error:', e);
  }
}

function formatTooltip() {
  if (!state.found) return 'HyperX: waiting for headphone';
  const b = state.battery != null ? `${state.battery}%` : '—';
  const m = state.muted   != null ? (state.muted ? 'on' : 'off') : '—';
  const c = state.charging!= null ? (state.charging ? 'true' : 'false') : '—';
  return `Battery: ${b}\nMuted: ${m}\nCharging: ${c}`;
}

function updateUI() {
  if (tray) {
    tray.setToolTip(formatTooltip());
    const menu = Menu.buildFromTemplate([
      { label: state.found ? 'Status: connected' : 'Status: waiting for headphone', enabled: false },
      { type: 'separator' },
      { label: `Battery: ${state.battery != null ? state.battery + '%' : '—'}`, enabled: false },
      { label: `Muted: ${state.muted != null ? (state.muted ? 'on' : 'off') : '—'}`, enabled: false },
      { label: `Charging: ${state.charging != null ? (state.charging ? 'true' : 'false') : '—'}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: autoLaunchEnabled,
        click: (item) => {
          setAutoLaunch(item.checked);
          // rebuild menu to reflect new state (optional; the checkbox already reflects it)
          updateUI();
        }
      },
      { type: 'separator' },
      { label: 'Exit', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('state:update', {
      found: state.found, battery: state.battery, muted: state.muted, charging: state.charging
    });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 220, height: 120, show: false, frame: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'tray.html'));
  win.on('blur', () => { if (win.isVisible()) win.hide(); });
}

function getWindowPosition() {
  const trayBounds = tray.getBounds();
  const { width, height } = win.getBounds();
  const y = trayBounds.y > screen.getPrimaryDisplay().workArea.height / 2
    ? Math.round(trayBounds.y - height - 8)
    : Math.round(trayBounds.y + trayBounds.height + 8);
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  return { x, y };
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) return win.hide();
  const pos = getWindowPosition();
  win.setPosition(pos.x, pos.y, false);
  win.show(); win.focus();
}

function startTray() {
  const appBase = app.isPackaged ? app.getAppPath() : __dirname;
  const ico = nativeImage.createFromPath(path.join(appBase, 'icon.ico'));
  tray = new Tray(ico.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, 'icon.ico')) : ico);
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu());
  tray.on('mouse-enter', () => tray.setToolTip(formatTooltip()));
  updateUI();
  console.log('[main] tray started');
}

function startHelper() {
  const appBase = app.isPackaged ? app.getAppPath() : __dirname;
  const sensorPath = path.join(appBase, 'sensor.js');

  const candidates = [
    process.env.NVM_SYMLINK && path.join(process.env.NVM_SYMLINK, 'node.exe'),
    'C:\\nvm4w\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    'node'
  ].filter(Boolean);

  let buf = '';
  let idx = 0;

  const launch = () => {
    const exe = candidates[idx] || 'node';
    console.log('[helper] launching:', exe, sensorPath, 'cwd=', appBase);

    child = spawn(exe, [sensorPath], {
      cwd: appBase,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          switch (msg.event) {
            case 'status':   state.found   = !!msg.found; break;
            case 'battery':  state.battery = msg.battery; break;
            case 'muted':    state.muted   = !!msg.muted; break;
            case 'charging': state.charging= !!msg.charging; break;
            case 'power':    state.power   = msg.power; state.found = msg.power === 'on'; break;
            case 'error':    console.error('[sensor error]', msg.error); break;
          }
          updateUI();
        } catch (e) {
          console.error('[parse]', e, line);
        }
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => {
      console.error('[helper] spawn error:', e);
      idx = (idx + 1) % candidates.length;
      setTimeout(launch, 1000);
    });

    child.on('exit', (code, sig) => {
      console.warn('[helper] exited:', code, sig);
      state.found = false; state.battery = null; state.muted = null; state.charging = null;
      updateUI();
      if (!quitting) setTimeout(launch, 5000); // do not relaunch while quitting
    });
  };

  launch();
}

// avoid duplicate instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    console.log('[main] ready. packaged=', app.isPackaged, 'appPath=', app.getAppPath());
    readAutoLaunch();   // read current auto-start state
    createWindow();
    startTray();
    startHelper();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // keep tray alive when all windows are closed
  app.on('window-all-closed', (e) => { e.preventDefault(); });
}
