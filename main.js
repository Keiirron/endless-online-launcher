'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const site = require('./src/site');
const up = require('./src/updater');

const fetchFn = (url, opts) => net.fetch(url, opts); // honours the system proxy
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let win; let busy = false;

function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }

async function status() {
  const s = loadSettings();
  if (!s.installDir) {
    const found = await up.detectInstalls();
    s.installDir = found[0] || up.defaultInstallDir();
    saveSettings(s);
  }
  const installed = await up.isGameDir(s.installDir);
  const state = installed ? await up.readState(s.installDir) : null;
  const writable = installed ? await up.isWritable(s.installDir) : true;
  return { installDir: s.installDir, installed, writable, version: state && state.version, updatedAt: state && state.updatedAt, suggestedDir: up.defaultInstallDir() };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060, height: 820, minWidth: 900, minHeight: 640, backgroundColor: '#1a120b', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url); });
}

function openExternal(url) {
  try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ }
}

ipcMain.handle('status', status);
ipcMain.handle('release', () => site.getLatestRelease(fetchFn));
ipcMain.handle('devposts', () => site.getDevPosts(fetchFn));
ipcMain.handle('devpost', (_e, url) => site.getDevPostHtml(fetchFn, url));
ipcMain.handle('open', (_e, url) => openExternal(url));
ipcMain.handle('openFolder', async () => { const s = await status(); if (s.installed) shell.openPath(s.installDir); });

ipcMain.handle('chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your Endless Online folder (or an empty folder to install into)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return status();
  let dir = r.filePaths[0];
  // Picking a non-empty folder that isn't a game folder: install into a subfolder, never on top of other files.
  if (!(await up.isGameDir(dir)) && fs.readdirSync(dir).length) dir = path.join(dir, 'Endless Online');
  saveSettings({ ...loadSettings(), installDir: dir });
  return status();
});

// opts.migrate: install into the suggested per-user folder and import data from the current one
ipcMain.handle('update', async (_e, opts = {}) => {
  if (busy) throw new Error('An update is already running.');
  busy = true;
  try {
    const s = await status();
    const release = await site.getLatestRelease(fetchFn);
    let installDir = s.installDir; let importFrom = null;
    if (opts.migrate) { importFrom = s.installDir; installDir = s.suggestedDir; }
    let last = 0;
    const report = await up.runUpdate({
      fetchFn, release, installDir, importFrom, tempRoot: app.getPath('temp'),
      onProgress: (p) => { const now = Date.now(); if (now - last > 60 || p.done === p.total) { last = now; win.webContents.send('progress', p); } },
    });
    if (opts.migrate) saveSettings({ ...loadSettings(), installDir });
    return { report, status: await status() };
  } finally { busy = false; }
});

ipcMain.handle('play', async () => {
  const s = await status();
  if (!s.installed) throw new Error('Endless Online is not installed yet.');
  const child = spawn(path.join(s.installDir, 'Endless.exe'), [], { cwd: s.installDir, detached: true, stdio: 'ignore' });
  child.unref();
  return true;
});

ipcMain.handle('config', async () => {
  const s = await status();
  const exe = path.join(s.installDir, 'EConfig.exe');
  if (fs.existsSync(exe)) spawn(exe, [], { cwd: s.installDir, detached: true, stdio: 'ignore' }).unref();
});

// Launcher self-update from GitHub Releases (installed builds only).
function checkForLauncherUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', () => {});
  autoUpdater.on('update-downloaded', (info) => {
    const ask = async () => {
      if (busy) return setTimeout(ask, 5000);           // never interrupt a game update
      const r = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
        title: 'Launcher update', message: `Launcher ${info.version} is ready to install.`,
        detail: 'Restart the launcher to finish updating. If you choose Later it installs when you close the launcher.',
      });
      if (r.response === 0) autoUpdater.quitAndInstall(true, true);
    };
    ask();
  });
  autoUpdater.checkForUpdates().catch(() => {});
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); checkForLauncherUpdate(); });
  app.on('window-all-closed', () => app.quit());
}
