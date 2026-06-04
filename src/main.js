const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { autoUpdater } = require('electron-updater');

// electron-updater behavior
autoUpdater.autoDownload = true;            // download in background as soon as found
autoUpdater.autoInstallOnAppQuit = true;    // apply silently on next quit if user didn't restart
autoUpdater.allowPrerelease = false;

// Stable AppUserModelID across versions — required for Windows to keep the
// taskbar pin alive after uninstall/reinstall cycles during an upgrade.
// Must be set before any windows are created; matches build.appId.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.graphiccomponents.markdown-viewer');
}

const windows = new Set();
let lastFocusedWindow = null;
let pendingFilePath = null;
const TAB_BAR_HEIGHT_PX = 36; // must match #tab-bar height in styles.css

// Tab registry: which window has which files open. Renderers push their
// current file-path list via 'tab-list-changed' whenever it changes.
// Keyed by BrowserWindow; values are Sets of normalized (lowercased on Win) paths.
const tabRegistry = new Map();

function normalizePath(p) {
  if (!p) return '';
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function findWindowWithFile(filePath) {
  const target = normalizePath(filePath);
  if (!target) return null;
  for (const [win, paths] of tabRegistry) {
    if (paths.has(target)) return win;
  }
  return null;
}

const MD_EXT = /\.(md|markdown|mdx|mdown|txt)$/i;

function getFileFromArgs(argv) {
  const start = app.isPackaged ? 1 : 2;
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg.startsWith('-')) continue;
    try {
      if (fsSync.existsSync(arg) && fsSync.statSync(arg).isFile()) {
        return path.resolve(arg);
      }
    } catch (_e) {}
  }
  return null;
}

function focusedWindow() {
  // Prefer the OS-focused window; fall back to whichever of our windows had
  // focus most recently (important when the user double-clicks a .md file in
  // Explorer — Explorer has focus, not the app).
  return BrowserWindow.getFocusedWindow() || lastFocusedWindow || [...windows][0] || null;
}

// Returns the window whose tab bar contains the given screen-coords point,
// or null if the point isn't over any window's tab bar.
function windowAtScreenPoint(screenX, screenY) {
  for (const win of windows) {
    const cb = win.getContentBounds(); // content area, excludes title bar
    if (screenX >= cb.x && screenX < cb.x + cb.width &&
        screenY >= cb.y && screenY < cb.y + TAB_BAR_HEIGHT_PX) {
      return win;
    }
  }
  return null;
}

async function sendFileToWindow(win, filePath) {
  if (!win || !filePath) return;
  // Cross-window dedup: if this file is already open in some window's tab,
  // just focus that window and tell it to switch to the existing tab.
  const existingWin = findWindowWithFile(filePath);
  if (existingWin) {
    if (existingWin.isMinimized()) existingWin.restore();
    existingWin.focus();
    existingWin.webContents.send('focus-tab', filePath);
    return;
  }
  try {
    const content = await fs.readFile(filePath, 'utf8');
    win.webContents.send('file-loaded', { filePath, content });
  } catch (e) {
    dialog.showErrorBox('Failed to open file', `${filePath}\n\n${e.message}`);
  }
}

// Creates a new window. opts:
//   filePath: load this file as a tab once the renderer is ready
//   initialTabs: array of { filePath, content, isModified } to seed tabs
//   bounds: { x, y, width, height } position the window
function createWindow(opts = {}) {
  const win = new BrowserWindow({
    width: opts.bounds?.width || 1280,
    height: opts.bounds?.height || 800,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.add(win);
  win.on('focus', () => { lastFocusedWindow = win; });
  win.on('closed', () => {
    windows.delete(win);
    tabRegistry.delete(win);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.once('did-finish-load', () => {
    if (opts.initialTabs && opts.initialTabs.length > 0) {
      win.webContents.send('init-tabs', opts.initialTabs);
    } else if (opts.filePath) {
      sendFileToWindow(win, opts.filePath);
    }
  });

  return win;
}

// =========================================================================
// MENU
// =========================================================================

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Tab',     accelerator: 'CmdOrCtrl+T',       click: () => focusedWindow()?.webContents.send('menu-new-tab') },
        { label: 'New Window',  accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open...',     accelerator: 'CmdOrCtrl+O',       click: openFile },
        { type: 'separator' },
        { label: 'Save',        accelerator: 'CmdOrCtrl+S',       click: () => focusedWindow()?.webContents.send('menu-save') },
        { label: 'Save As...',  accelerator: 'CmdOrCtrl+Shift+S', click: () => focusedWindow()?.webContents.send('menu-save-as') },
        { type: 'separator' },
        { label: 'Close Tab',   accelerator: 'CmdOrCtrl+W',       click: () => focusedWindow()?.webContents.send('menu-close-tab') },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Find...',    accelerator: 'CmdOrCtrl+F', click: () => focusedWindow()?.webContents.send('menu-find') },
        { label: 'Replace...', accelerator: 'CmdOrCtrl+H', click: () => focusedWindow()?.webContents.send('menu-replace') },
        { type: 'separator' },
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Editor', accelerator: 'CmdOrCtrl+E', click: () => focusedWindow()?.webContents.send('toggle-editor') },
        { label: 'Next Tab',     accelerator: 'CmdOrCtrl+Tab',       click: () => focusedWindow()?.webContents.send('menu-next-tab') },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => focusedWindow()?.webContents.send('menu-prev-tab') },
        { label: 'Check for Updates...', click: () => { safeCheckForUpdates(); focusedWindow()?.webContents.send('update-check-requested'); } },
        {
          label: 'Toolbar Position',
          submenu: [
            { label: 'Top (horizontal)', type: 'radio', checked: true,
              click: () => focusedWindow()?.webContents.send('menu-toolbar-position', 'top') },
            { label: 'Left (vertical)',  type: 'radio',
              click: () => focusedWindow()?.webContents.send('menu-toolbar-position', 'left') },
          ],
        },
        {
          label: 'Load Sample on Startup',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => focusedWindow()?.webContents.send('menu-load-sample', menuItem.checked),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]);
}

async function openFile() {
  const win = focusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdown'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await sendFileToWindow(win, result.filePaths[0]);
}

// =========================================================================
// IPC HANDLERS
// =========================================================================

ipcMain.handle('save-file', async (_event, { filePath, content }) => {
  await fs.writeFile(filePath, content, 'utf8');
});

ipcMain.on('tab-list-changed', (event, paths) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  tabRegistry.set(win, new Set((paths || []).map(normalizePath)));
});

ipcMain.handle('save-as-dialog', async (event, { suggestedName } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName || 'Untitled.md',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdown'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  return result.filePath;
});

ipcMain.handle('confirm-discard', async (event, { title } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Discard unsaved changes in "${title || 'this tab'}"?`,
    detail: 'Your changes will be lost.',
  });
  return result.response === 0;
});

ipcMain.handle('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.handle('detach-tab', (event, { tab, screenX, screenY }) => {
  const sourceWin = BrowserWindow.fromWebContents(event.sender);

  // If the cursor was over another window's tab bar, append the tab there
  // instead of opening a new window.
  const targetWin = windowAtScreenPoint(screenX, screenY);
  if (targetWin && targetWin !== sourceWin) {
    targetWin.webContents.send('add-tab', tab);
    targetWin.focus();
    return true;
  }

  // Otherwise spawn a new window centered on the cursor.
  const width = 1280;
  const height = 800;
  const x = Math.max(0, Math.round(screenX - width / 2));
  const y = Math.max(0, Math.round(screenY - 18));
  createWindow({
    initialTabs: [tab],
    bounds: { x, y, width, height },
  });
  return true;
});

ipcMain.handle('pick-image', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// =========================================================================
// APP LIFECYCLE
// =========================================================================

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = getFileFromArgs(argv);
    const win = focusedWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (filePath) sendFileToWindow(win, filePath);
    } else if (filePath) {
      createWindow({ filePath });
    } else {
      createWindow();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const win = focusedWindow();
    if (win) {
      sendFileToWindow(win, filePath);
    } else {
      pendingFilePath = filePath;
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    pendingFilePath = getFileFromArgs(process.argv);
    createWindow({ filePath: pendingFilePath });
    pendingFilePath = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// =========================================================================
// AUTO UPDATE
// =========================================================================
// Polls the configured `publish` provider (GitHub Releases here) for newer
// versions. On launch + every 4 hours. On success the renderer is told via
// IPC and shows a status-bar indicator with an Install button.

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function broadcastToAllWindows(channel, payload) {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function safeCheckForUpdates() {
  // Skip in dev (no installed version to update against; would log spurious errors).
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((err) => {
    // Network failures, GitHub rate limits, etc. — never propagate to the user.
    console.error('Update check failed:', err && err.message ? err.message : err);
  });
}

autoUpdater.on('checking-for-update', () => {
  broadcastToAllWindows('update-status', { state: 'checking' });
});
autoUpdater.on('update-available', (info) => {
  broadcastToAllWindows('update-status', { state: 'available', version: info.version });
});
autoUpdater.on('update-not-available', () => {
  broadcastToAllWindows('update-status', { state: 'none' });
});
autoUpdater.on('download-progress', (progress) => {
  broadcastToAllWindows('update-status', {
    state: 'downloading',
    percent: Math.round(progress.percent || 0),
  });
});
autoUpdater.on('update-downloaded', (info) => {
  broadcastToAllWindows('update-status', { state: 'ready', version: info.version });
});
autoUpdater.on('error', (err) => {
  console.error('autoUpdater error:', err && err.message ? err.message : err);
  broadcastToAllWindows('update-status', { state: 'error', message: err && err.message });
});

ipcMain.handle('update-check-now', () => {
  safeCheckForUpdates();
});

ipcMain.handle('update-install-now', () => {
  // Quits all windows, runs the downloaded installer in silent mode, relaunches.
  // Notable: in some installations the relaunch can take a few seconds.
  autoUpdater.quitAndInstall();
});

ipcMain.handle('update-open-release-notes', (_e, version) => {
  shell.openExternal(`https://github.com/austin-youngblood/markdown-viewer/releases/tag/v${version}`);
});

// Kick off polling once the app is ready and a window exists.
app.whenReady().then(() => {
  // Slight delay so the window's renderer is ready to receive the first event.
  setTimeout(safeCheckForUpdates, 4000);
  setInterval(safeCheckForUpdates, UPDATE_CHECK_INTERVAL_MS);
});
