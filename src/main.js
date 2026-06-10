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

// Autosave / crash-recovery backups land here. Each dirty tab gets a JSON
// file keyed by a UUID the renderer generates; the file is deleted when the
// tab is saved or the user discards it. On launch we scan this dir and any
// survivors are re-opened as recovered tabs.
// Lazy because `app.getPath('userData')` is only guaranteed once `app` is
// ready, and this module runs at process start.
function backupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}
async function ensureBackupsDir() {
  await fs.mkdir(backupsDir(), { recursive: true });
}
function safeBackupName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json';
}

// =========================================================================
// SETTINGS — persisted per-user UI prefs + recent files + favorites
// =========================================================================
// Lazily loaded on first access, written debounced. Everything has a default
// so a fresh install never blocks on file IO.

const SETTINGS_DEFAULTS = {
  viewMode: 'both',         // 'editor' | 'both' | 'preview'
  readingMode: false,
  scrollSync: false,
  lineNumbers: false,
  recents: [],              // [{ path, openedAt }]
  favorites: [],            // [{ path, addedAt }]
};
const RECENTS_MAX = 10;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

let cachedSettings = null;
let settingsWriteTimer = null;

async function loadSettings() {
  if (cachedSettings) return cachedSettings;
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    cachedSettings = { ...SETTINGS_DEFAULTS, ...parsed };
    // Defensive: ensure arrays are arrays even if file was corrupted.
    if (!Array.isArray(cachedSettings.recents)) cachedSettings.recents = [];
    if (!Array.isArray(cachedSettings.favorites)) cachedSettings.favorites = [];
  } catch (_e) {
    cachedSettings = { ...SETTINGS_DEFAULTS };
  }
  return cachedSettings;
}

function scheduleSettingsWrite() {
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(async () => {
    settingsWriteTimer = null;
    try {
      await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
      await fs.writeFile(settingsFile(), JSON.stringify(cachedSettings, null, 2), 'utf8');
    } catch (e) {
      console.error('settings write failed:', e && e.message);
    }
  }, 200);
}

function normalizePathForCompare(p) {
  if (!p) return '';
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

async function addRecent(filePath) {
  if (!filePath) return;
  const s = await loadSettings();
  const key = normalizePathForCompare(filePath);
  s.recents = s.recents.filter(r => normalizePathForCompare(r.path) !== key);
  s.recents.unshift({ path: filePath, openedAt: Date.now() });
  if (s.recents.length > RECENTS_MAX) s.recents.length = RECENTS_MAX;
  scheduleSettingsWrite();
  rebuildMenu();
  refreshJumpList();
  broadcastToAllWindows('settings-changed', { recents: s.recents, favorites: s.favorites });
}

async function removeRecent(filePath) {
  const s = await loadSettings();
  const key = normalizePathForCompare(filePath);
  const before = s.recents.length;
  s.recents = s.recents.filter(r => normalizePathForCompare(r.path) !== key);
  if (s.recents.length !== before) {
    scheduleSettingsWrite();
    rebuildMenu();
    refreshJumpList();
    broadcastToAllWindows('settings-changed', { recents: s.recents, favorites: s.favorites });
  }
}

async function clearRecents() {
  const s = await loadSettings();
  if (s.recents.length === 0) return;
  s.recents = [];
  scheduleSettingsWrite();
  rebuildMenu();
  refreshJumpList();
  broadcastToAllWindows('settings-changed', { recents: s.recents, favorites: s.favorites });
}

async function addFavorite(filePath) {
  if (!filePath) return;
  const s = await loadSettings();
  const key = normalizePathForCompare(filePath);
  if (s.favorites.some(f => normalizePathForCompare(f.path) === key)) return;
  s.favorites.unshift({ path: filePath, addedAt: Date.now() });
  scheduleSettingsWrite();
  rebuildMenu();
  refreshJumpList();
  broadcastToAllWindows('settings-changed', { recents: s.recents, favorites: s.favorites });
}

async function removeFavorite(filePath) {
  const s = await loadSettings();
  const key = normalizePathForCompare(filePath);
  const before = s.favorites.length;
  s.favorites = s.favorites.filter(f => normalizePathForCompare(f.path) !== key);
  if (s.favorites.length !== before) {
    scheduleSettingsWrite();
    rebuildMenu();
    refreshJumpList();
    broadcastToAllWindows('settings-changed', { recents: s.recents, favorites: s.favorites });
  }
}

async function setViewSetting(key, value) {
  const s = await loadSettings();
  if (s[key] === value) return;
  s[key] = value;
  scheduleSettingsWrite();
  rebuildMenu();
  broadcastToAllWindows('view-setting-changed', { key, value });
}

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
    await addRecent(filePath);
    return;
  }
  try {
    const content = await fs.readFile(filePath, 'utf8');
    win.webContents.send('file-loaded', { filePath, content });
    await addRecent(filePath);
  } catch (e) {
    // ENOENT here means a stale entry was clicked from Recent / Favorites /
    // JumpList. Remove it from both lists silently and let the renderer show
    // the error in the status bar rather than a modal.
    if (e && e.code === 'ENOENT') {
      await removeRecent(filePath);
      await removeFavorite(filePath);
      win.webContents.send('file-open-failed', { filePath, reason: 'missing' });
    } else {
      dialog.showErrorBox('Failed to open file', `${filePath}\n\n${e.message}`);
    }
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

  // Intercept close to give the renderer a chance to prompt save / discard
  // / cancel for each dirty tab. Once the renderer signals OK we set
  // _allowClose and re-trigger close().
  win.on('close', (e) => {
    if (win._allowClose) return;
    e.preventDefault();
    win.webContents.send('attempt-window-close');
  });

  win.on('closed', () => {
    windows.delete(win);
    tabRegistry.delete(win);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.once('did-finish-load', () => {
    if (opts.initialTabs && opts.initialTabs.length > 0) {
      win.webContents.send('init-tabs', opts.initialTabs);
      // If a file was also passed in (e.g. user double-clicked a .md while
      // recovered tabs are being restored), open it as an additional tab.
      if (opts.filePath) sendFileToWindow(win, opts.filePath);
    } else if (opts.filePath) {
      sendFileToWindow(win, opts.filePath);
    }
  });

  return win;
}

// =========================================================================
// MENU
// =========================================================================

function buildRecentSubmenu(recents) {
  if (!recents || recents.length === 0) {
    return [{ label: 'No recent documents', enabled: false }];
  }
  const items = recents.map(r => ({
    label: r.path,
    click: () => {
      const win = focusedWindow() || createWindow();
      sendFileToWindow(win, r.path);
    },
  }));
  items.push({ type: 'separator' });
  items.push({ label: 'Clear Recent', click: () => { clearRecents(); } });
  return items;
}

function buildFavoritesSubmenu(favorites) {
  if (!favorites || favorites.length === 0) {
    return [{ label: 'No favorites', enabled: false }];
  }
  return favorites.map(f => ({
    label: f.path,
    click: () => {
      const win = focusedWindow() || createWindow();
      sendFileToWindow(win, f.path);
    },
  }));
}

function buildMenu(settings) {
  const s = settings || cachedSettings || SETTINGS_DEFAULTS;
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Tab',     accelerator: 'CmdOrCtrl+T',       click: () => focusedWindow()?.webContents.send('menu-new-tab') },
        { label: 'New Window',  accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open...',     accelerator: 'CmdOrCtrl+O',       click: openFile },
        { label: 'Open Recent', submenu: buildRecentSubmenu(s.recents) },
        { label: 'Favorites',   submenu: buildFavoritesSubmenu(s.favorites) },
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
        { label: 'Editor Only',   accelerator: 'CmdOrCtrl+1', type: 'radio',
          checked: s.viewMode === 'editor',
          click: () => setViewSetting('viewMode', 'editor') },
        { label: 'Editor + Preview', accelerator: 'CmdOrCtrl+2', type: 'radio',
          checked: s.viewMode === 'both',
          click: () => setViewSetting('viewMode', 'both') },
        { label: 'Preview Only',  accelerator: 'CmdOrCtrl+3', type: 'radio',
          checked: s.viewMode === 'preview',
          click: () => setViewSetting('viewMode', 'preview') },
        { type: 'separator' },
        { label: 'Reading Mode (hide + buttons & click-to-edit)', accelerator: 'CmdOrCtrl+Shift+R', type: 'checkbox',
          checked: !!s.readingMode,
          click: (mi) => setViewSetting('readingMode', mi.checked) },
        { label: 'Sync Scroll Between Panes', type: 'checkbox',
          checked: !!s.scrollSync,
          click: (mi) => setViewSetting('scrollSync', mi.checked) },
        { label: 'Show Line Numbers', type: 'checkbox',
          checked: !!s.lineNumbers,
          click: (mi) => setViewSetting('lineNumbers', mi.checked) },
        { type: 'separator' },
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

function rebuildMenu() {
  Menu.setApplicationMenu(buildMenu(cachedSettings));
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
  await addRecent(filePath);
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

// Three-way prompt used during window close for each dirty tab.
// Returns 'save' | 'discard' | 'cancel'.
ipcMain.handle('confirm-save-discard-cancel', async (event, { title } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved Changes',
    message: `Save changes to "${title || 'this tab'}" before closing?`,
    detail: 'If you don\'t save, your changes will be lost.',
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][result.response];
});

// Renderer's verdict after walking every dirty tab. `true` means proceed.
ipcMain.on('window-close-decision', (event, ok) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (ok) {
    win._allowClose = true;
    win.close();
  }
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

ipcMain.handle('backup-write', async (_e, { id, filePath, content, title }) => {
  if (!id) return;
  await ensureBackupsDir();
  const file = path.join(backupsDir(), safeBackupName(id));
  const payload = JSON.stringify({ id, filePath, content, title, savedAt: Date.now() });
  await fs.writeFile(file, payload, 'utf8');
});

ipcMain.handle('backup-delete', async (_e, { id }) => {
  if (!id) return;
  try {
    await fs.unlink(path.join(backupsDir(), safeBackupName(id)));
  } catch (_e) {}
});

async function loadOrphanBackups() {
  try {
    await ensureBackupsDir();
    const dir = backupsDir();
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data.content === 'string') out.push(data);
      } catch (_e) {}
    }
    out.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    return out;
  } catch (_e) {
    return [];
  }
}

async function purgeOrphanBackups() {
  try {
    const dir = backupsDir();
    const files = await fs.readdir(dir);
    await Promise.all(files
      .filter(f => f.endsWith('.json'))
      .map(f => fs.unlink(path.join(dir, f)).catch(() => {})));
  } catch (_e) {}
}

ipcMain.handle('settings-get', async () => {
  return await loadSettings();
});

ipcMain.handle('settings-set-view', async (_e, { key, value }) => {
  await setViewSetting(key, value);
});

ipcMain.handle('recents-add', async (_e, filePath) => addRecent(filePath));
ipcMain.handle('recents-remove', async (_e, filePath) => removeRecent(filePath));
ipcMain.handle('favorites-add', async (_e, filePath) => addFavorite(filePath));
ipcMain.handle('favorites-remove', async (_e, filePath) => removeFavorite(filePath));

ipcMain.handle('open-path', async (event, filePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  await sendFileToWindow(win, filePath);
});

ipcMain.handle('show-open-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdown'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  await sendFileToWindow(win, result.filePaths[0]);
  return result.filePaths[0];
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
// WINDOWS JUMPLIST
// =========================================================================
// Lists Favorites (custom category) + the OS-managed "Recent" category on
// taskbar right-click. Each task launches the app with the file path as argv,
// caught by the single-instance second-instance handler.

function refreshJumpList() {
  if (process.platform !== 'win32') return;
  const s = cachedSettings || SETTINGS_DEFAULTS;
  const exe = process.execPath;
  try {
    const favTasks = (s.favorites || []).slice(0, 10).map(f => ({
      type: 'task',
      title: path.basename(f.path),
      description: f.path,
      program: exe,
      args: `"${f.path}"`,
      iconPath: exe,
      iconIndex: 0,
    }));
    const recentTasks = (s.recents || []).slice(0, 10).map(r => ({
      type: 'task',
      title: path.basename(r.path),
      description: r.path,
      program: exe,
      args: `"${r.path}"`,
      iconPath: exe,
      iconIndex: 0,
    }));
    const categories = [];
    if (favTasks.length) categories.push({ name: 'Favorites', items: favTasks });
    if (recentTasks.length) categories.push({ name: 'Recent', items: recentTasks });
    if (categories.length === 0) {
      app.setJumpList(null);
    } else {
      app.setJumpList(categories);
    }
  } catch (e) {
    // setJumpList can throw if the JumpList is being modified by the user
    // (e.g. they removed items themselves). Non-fatal.
    console.error('setJumpList failed:', e && e.message);
  }
}

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

  app.whenReady().then(async () => {
    await loadSettings();
    rebuildMenu();
    refreshJumpList();
    pendingFilePath = getFileFromArgs(process.argv);
    const orphans = await loadOrphanBackups();
    let initialTabs = null;
    if (orphans.length > 0) {
      // Build a preview list of the dropped documents for the dialog body.
      const preview = orphans.slice(0, 8)
        .map(o => '• ' + (o.title || (o.filePath ? path.basename(o.filePath) : 'Untitled')))
        .join('\n');
      const extra = orphans.length > 8 ? `\n…and ${orphans.length - 8} more` : '';
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Recover', 'Discard'],
        defaultId: 0,
        cancelId: 1,
        title: 'Recover Unsaved Documents',
        message: `${orphans.length} unsaved document${orphans.length === 1 ? '' : 's'} from your previous session.`,
        detail: `${preview}${extra}\n\nRecover them as tabs, or discard the backups?`,
        noLink: true,
      });
      if (response === 0) {
        initialTabs = orphans.map(o => ({
          backupId: o.id,
          filePath: o.filePath || null,
          content: o.content || '',
          title: o.title || 'Recovered',
          isModified: true,
          recovered: true,
        }));
      } else {
        await purgeOrphanBackups();
      }
    }
    if (initialTabs) {
      createWindow({ initialTabs, filePath: pendingFilePath });
    } else {
      createWindow({ filePath: pendingFilePath });
    }
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
