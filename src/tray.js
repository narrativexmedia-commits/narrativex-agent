const { Tray, Menu, app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');

let tray = null;

function createFallbackIcon() {
  const image = nativeImage.createEmpty();
  const size = { width: 16, height: 16 };
  const buffer = Buffer.alloc(size.width * size.height * 4);
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 79;     // R
    buffer[i+1] = 70;   // G
    buffer[i+2] = 229;  // B
    buffer[i+3] = 255;  // A
  }
  return nativeImage.createFromBuffer(buffer, size);
}

function initTray(mainWindow) {
  const icon = createFallbackIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Tracker',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'View Flags',
      click: () => openFlagsWindow(),
    },
    { type: 'separator' },
    {
  label: 'Quit',
  click: () => {
    app.isQuitting = true;
    app.quit();
  },
},
  ]);

  tray.setToolTip('NarrativeX Agent');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function openFlagsWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/flags.html'));
  win.setMenuBarVisibility(false);
}

module.exports = { initTray };
