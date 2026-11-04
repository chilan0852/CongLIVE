'use strict';

/**
 * CongLive Windows portable client (Electron main process).
 *
 * Responsibilities:
 *  - launcher window on first run (server address → config.json in userData);
 *  - main window loads the configured CongLive web deployment (default https://xinglan.work);
 *  - camera / microphone / display-capture permission plumbing (incl. a screen-source picker);
 *  - PC adaptations injected into the page (desktop class, mobile-only hints hidden);
 *  - Windows-friendly keyboard / mouse shortcuts and app menu;
 *  - packaging and smoke-test hooks used by the build scripts.
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} = require('electron');
const {
  DEFAULT_SERVER,
  normalizeServerUrl,
  loadConfig,
  saveConfig,
} = require('./config');

const APP_TITLE = '葱直播 CongLive';
const APP_ID = 'com.conglive.pc';
const IS_WIN = process.platform === 'win32';
const PRODUCT_VERSION = app.getVersion();
const USER_DATA_DIR = process.env.CONGLIVE_PC_USER_DATA
  ? path.resolve(process.env.CONGLIVE_PC_USER_DATA)
  : null;
if (USER_DATA_DIR) app.setPath('userData', USER_DATA_DIR);

// Keep app.getName()/userData ASCII and stable: package.json productName is
// "CongLive", so config lives in %APPDATA%\\CongLive on Windows.

/* ------------------------------------------------------------------ *
 * Tiny CLI parsing (used by `--server=` and the smoke-test harness)
 * ------------------------------------------------------------------ */

function cliArgs() {
  return process.argv.slice(1);
}

function cliValue(name) {
  const prefix = `--${name}=`;
  for (const arg of cliArgs()) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

function cliFlag(name) {
  return cliArgs().some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

const SMOKE_MODE = cliValue('smoke-test') || (cliFlag('smoke-test') ? 'launcher' : '');
const SMOKE_OUT = cliValue('smoke-out');
const SMOKE_SERVER = cliValue('smoke-server');

/* ------------------------------------------------------------------ *
 * Localisation for native UI (follows Windows display language)
 * ------------------------------------------------------------------ */

const ZH_STR = {
    file: '文件',
    settings: '服务器设置…',
    exit: '退出',
    page: '页面',
    back: '返回',
    forward: '前进',
    refresh: '刷新',
    forceRefresh: '强制刷新',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    zoomIn: '放大',
    zoomOut: '缩小',
    resetZoom: '实际大小',
    fullscreen: '全屏',
    devtools: '开发者工具',
    help: '帮助',
    visitWebsite: '打开官网',
    about: '关于 CongLive PC 客户端',
    aboutDetail: `版本 ${PRODUCT_VERSION}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n服务器：{server}\n\nWindows 10/11 x64 便携客户端`,
    quitConfirm: '退出',
    screenShareTitle: '选择共享内容',
    loadErrorTitle: '无法加载直播页面',
    loadErrorRetry: '重试',
    loadErrorSettings: '修改服务器地址',
    loadErrorQuit: '退出',
    crashTitle: '页面无响应',
    crashDetail: '直播页面渲染进程已退出，是否重新加载？',
    crashReload: '重新加载',
    crashQuit: '退出',
    unresponsiveDetail: '直播页面暂时无响应，可以继续等待或重新加载。',
    wait: '继续等待',
    aboutOk: '确定',
};

const EN_STR = {
    file: 'File',
    settings: 'Server settings…',
    exit: 'Exit',
    page: 'Page',
    back: 'Back',
    forward: 'Forward',
    refresh: 'Refresh',
    forceRefresh: 'Force reload',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select all',
    view: 'View',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetZoom: 'Actual size',
    fullscreen: 'Full screen',
    devtools: 'Developer tools',
    help: 'Help',
    visitWebsite: 'Open website',
    about: 'About CongLive PC',
    aboutDetail: `Version ${PRODUCT_VERSION}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\nServer: {server}\n\nPortable client for Windows 10/11 x64`,
    quitConfirm: 'Exit',
    screenShareTitle: 'Choose what to share',
    loadErrorTitle: 'Could not load the live app',
    loadErrorRetry: 'Retry',
    loadErrorSettings: 'Change server address',
    loadErrorQuit: 'Exit',
    crashTitle: 'Page became unresponsive',
    crashDetail: 'The renderer of the live page has gone away. Reload it?',
    crashReload: 'Reload',
    crashQuit: 'Exit',
    unresponsiveDetail: 'The live page is temporarily unresponsive. You can wait or reload.',
    wait: 'Keep waiting',
    aboutOk: 'OK',
};

/**
 * Native UI strings are resolved lazily: app.getLocale() is only reliable after
 * Electron is ready, and these strings are first used when the menu is built.
 */
let STR_CACHE = null;
function strings() {
  if (!STR_CACHE) {
    STR_CACHE = String(app.getLocale() || '').toLowerCase().startsWith('zh') ? ZH_STR : EN_STR;
  }
  return STR_CACHE;
}
const STR = new Proxy({}, { get: (_target, prop) => strings()[prop] });

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

let mainWindow = null;
let launcherWindow = null;
let config = { serverUrl: '', windowBounds: null, maximized: false, updatedAt: '' };
let loadErrorDialogOpen = false;

/** Screen-share picker coordination (one at a time). */
let screenPicker = null; // { win, sources, callback, request, timer }
let displayRequestCallback = null;

/* ------------------------------------------------------------------ *
 * Paths / icons
 * ------------------------------------------------------------------ */

function appIcon() {
  const files = IS_WIN
    ? [path.join(__dirname, 'assets', 'icon.ico'), path.join(__dirname, 'assets', 'icon.png')]
    : [path.join(__dirname, 'assets', 'icon.png')];
  for (const file of files) {
    try {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Main window
 * ------------------------------------------------------------------ */

function trustedOriginFor(serverUrl) {
  try {
    const url = new URL(serverUrl || DEFAULT_SERVER);
    return url.origin;
  } catch {
    return DEFAULT_SERVER;
  }
}

function isTrustedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === trustedOriginFor(config.serverUrl);
  } catch {
    return false;
  }
}

function safeWindowBounds() {
  const bounds = config.windowBounds;
  if (!bounds || !bounds.width || !bounds.height) return {};
  const result = { width: Math.max(1100, Math.round(bounds.width)), height: Math.max(720, Math.round(bounds.height)) };
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    try {
      const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: result.width, height: result.height });
      const area = display.workArea;
      const visible = bounds.x < area.x + area.width - 80
        && bounds.y < area.y + area.height - 80
        && bounds.x + result.width > area.x + 80
        && bounds.y + result.height > area.y + 80;
      if (visible) {
        result.x = Math.round(bounds.x);
        result.y = Math.round(bounds.y);
      }
    } catch {
      // Keep it centered when the saved position cannot be validated.
    }
  }
  return result;
}

function createMainWindow(serverUrl) {
  const normalized = normalizeServerUrl(serverUrl || DEFAULT_SERVER);
  const target = normalized.ok ? normalized.url : DEFAULT_SERVER;
  config.serverUrl = target;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(target).catch(() => undefined);
    mainWindow.show();
    return mainWindow;
  }

  const bounds = safeWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    width: bounds.width || 1440,
    height: bounds.height || 900,
    minWidth: 1100,
    minHeight: 720,
    title: APP_TITLE,
    icon: appIcon(),
    show: false,
    backgroundColor: '#070a13',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
      webviewTag: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (config.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('close', () => {
    persistWindowState();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  attachNavigationGuards(mainWindow);
  attachPcAdaptation(mainWindow);
  attachShortcutFallbacks(mainWindow);
  attachCrashHandlers(mainWindow);

  mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */ || SMOKE_MODE) return;
    showLoadError(url || target, code, description);
  });

  mainWindow.loadURL(target).catch(() => undefined);
  return mainWindow;
}

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    const previous = loadConfig(app.getPath('userData'));
    config = {
      serverUrl: config.serverUrl || previous.serverUrl,
      windowBounds: maximized ? previous.windowBounds : mainWindow.getBounds(),
      maximized,
      updatedAt: previous.updatedAt,
    };
    saveConfig(app.getPath('userData'), config);
  } catch {
    // Persisting window state is best effort.
  }
}

function attachNavigationGuards(win) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

function openExternalUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(parsed.href);
    }
  } catch {
    // Ignore malformed URLs.
  }
}

/* ------------------------------------------------------------------ *
 * PC adaptation injection (does not modify the web app sources)
 * ------------------------------------------------------------------ */

const PC_CLASS_JS = `(() => {
  try {
    const root = document.documentElement;
    if (!root) return;
    root.classList.add('pc-client');
    root.classList.add('desktop');
    root.setAttribute('data-conglive-client', 'pc');
    root.setAttribute('data-conglive-pc-version', ${JSON.stringify(PRODUCT_VERSION)});
    if (document.body) {
      document.body.classList.add('pc-client');
      document.body.classList.add('desktop');
    }
    window.dispatchEvent(new Event('conglive:pc-ready'));
  } catch (error) {
    // Never break the page for an enhancement.
  }
})();`;

const PC_CSS = `
/* CongLive PC client adaptations. These selectors are no-ops on the current web
   build; they only hide mobile-only affordances if such markers are present. */
html.pc-client { scrollbar-gutter: stable; }
html.pc-client body { overscroll-behavior-y: none; }
.mobile-only,
[data-mobile-only],
.mobile-hint,
.mobile-tip,
.show-on-mobile { display: none !important; }
`;

function applyPcAdaptation(win) {
  const wc = win.webContents;
  if (wc.isDestroyed()) return;
  wc.insertCSS(PC_CSS).catch(() => undefined);
  wc.executeJavaScript(PC_CLASS_JS, true).catch(() => undefined);
}

function attachPcAdaptation(win) {
  const wc = win.webContents;
  const run = () => {
    if (isTrustedUrl(wc.getURL())) applyPcAdaptation(win);
  };
  wc.on('dom-ready', run);
  wc.on('did-finish-load', run);
}

/* ------------------------------------------------------------------ *
 * Menu + shortcuts
 * ------------------------------------------------------------------ */

function withMainWindow(action) {
  return () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win) action(win);
  };
}

function buildMenu() {
  const template = [
    {
      label: STR.file,
      submenu: [
        { label: STR.settings, accelerator: 'CmdOrCtrl+Shift+S', click: () => openLauncher() },
        { type: 'separator' },
        { label: STR.exit, role: 'quit', accelerator: IS_WIN ? 'Alt+F4' : 'Cmd+Q' },
      ],
    },
    {
      label: STR.page,
      submenu: [
        {
          label: STR.back,
          accelerator: 'Alt+Left',
          click: withMainWindow((win) => { if (win.webContents.canGoBack()) win.webContents.goBack(); }),
        },
        {
          label: STR.forward,
          accelerator: 'Alt+Right',
          click: withMainWindow((win) => { if (win.webContents.canGoForward()) win.webContents.goForward(); }),
        },
        { type: 'separator' },
        { label: STR.refresh, accelerator: 'F5', click: withMainWindow((win) => win.webContents.reload()) },
        {
          label: STR.forceRefresh,
          accelerator: 'CmdOrCtrl+Shift+R',
          click: withMainWindow((win) => win.webContents.reloadIgnoringCache()),
        },
        { type: 'separator' },
        { label: STR.copy, role: 'copy' },
        { label: STR.paste, role: 'paste' },
        { label: STR.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: STR.view,
      submenu: [
        { label: STR.zoomIn, role: 'zoomIn' },
        { label: STR.zoomOut, role: 'zoomOut' },
        { label: STR.resetZoom, role: 'resetZoom' },
        { type: 'separator' },
        { label: STR.fullscreen, role: 'togglefullscreen', accelerator: 'F11' },
        {
          label: STR.devtools,
          accelerator: IS_WIN ? 'F12' : 'Alt+Cmd+I',
          click: withMainWindow((win) => win.webContents.toggleDevTools()),
        },
      ],
    },
    {
      label: STR.help,
      submenu: [
        { label: STR.visitWebsite, click: () => openExternalUrl(config.serverUrl || DEFAULT_SERVER) },
        { label: STR.about, click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function attachShortcutFallbacks(win) {
  // Mouse "back/forward" buttons on Windows keyboards/mice.
  win.on('app-command', (event, command) => {
    if (command === 'browser-backward') {
      event.preventDefault();
      if (win.webContents.canGoBack()) win.webContents.goBack();
    } else if (command === 'browser-forward') {
      event.preventDefault();
      if (win.webContents.canGoForward()) win.webContents.goForward();
    }
  });
  // Escape leaves full screen even if the page swallows the key.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' && win.isFullScreen()) {
      event.preventDefault();
      win.setFullScreen(false);
    }
  });
}

function showAbout() {
  const detail = STR.aboutDetail.replace('{server}', config.serverUrl || DEFAULT_SERVER);
  void dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'info',
    title: APP_TITLE,
    message: APP_TITLE,
    detail,
    buttons: [STR.aboutOk],
    noLink: true,
  });
}

/* ------------------------------------------------------------------ *
 * Load failure / crash recovery
 * ------------------------------------------------------------------ */

function showLoadError(url, code, description) {
  if (loadErrorDialogOpen) return;
  loadErrorDialogOpen = true;
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  dialog.showMessageBox(parent, {
    type: 'error',
    title: STR.loadErrorTitle,
    message: STR.loadErrorTitle,
    detail: `${url}\n(${code} ${description})`,
    buttons: [STR.loadErrorRetry, STR.loadErrorSettings, STR.loadErrorQuit],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }).then(({ response }) => {
    loadErrorDialogOpen = false;
    if (response === 0) {
      const target = config.serverUrl || DEFAULT_SERVER;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(target).catch(() => undefined);
      else createMainWindow(target);
    } else if (response === 1) {
      openLauncher();
    } else {
      app.quit();
    }
  }).catch(() => { loadErrorDialogOpen = false; });
}

function attachCrashHandlers(win) {
  win.webContents.on('render-process-gone', (event, details) => {
    if (SMOKE_MODE || details.reason === 'clean-exit') return;
    const parent = win && !win.isDestroyed() ? win : undefined;
    dialog.showMessageBox(parent, {
      type: 'error',
      title: STR.crashTitle,
      message: STR.crashTitle,
      detail: STR.crashDetail,
      buttons: [STR.crashReload, STR.crashQuit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0 && win && !win.isDestroyed()) win.webContents.reload();
      else app.quit();
    }).catch(() => undefined);
  });
  win.on('unresponsive', () => {
    if (SMOKE_MODE) return;
    const parent = win && !win.isDestroyed() ? win : undefined;
    dialog.showMessageBox(parent, {
      type: 'warning',
      title: STR.crashTitle,
      message: STR.crashTitle,
      detail: STR.unresponsiveDetail,
      buttons: [STR.wait, STR.crashReload],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response === 1 && win && !win.isDestroyed()) win.webContents.reload();
    }).catch(() => undefined);
  });
}

/* ------------------------------------------------------------------ *
 * Launcher window
 * ------------------------------------------------------------------ */

function openLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
    return launcherWindow;
  }
  launcherWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 640,
    minHeight: 560,
    maximizable: false,
    fullscreenable: false,
    title: APP_TITLE,
    icon: appIcon(),
    show: false,
    backgroundColor: '#070a13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.once('ready-to-show', () => {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    launcherWindow.show();
    launcherWindow.focus();
  });
  launcherWindow.on('closed', () => { launcherWindow = null; });
  launcherWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      launcherWindow.close();
    }
  });
  launcherWindow.loadFile(path.join(__dirname, 'launcher.html')).catch(() => undefined);
  return launcherWindow;
}

/* ------------------------------------------------------------------ *
 * Session: permissions + display-capture (screen sharing)
 * ------------------------------------------------------------------ */

function isTrustedRequestOrigin(origin) {
  try {
    const url = new URL(String(origin || ''));
    return url.origin === trustedOriginFor(config.serverUrl);
  } catch {
    return false;
  }
}

function installSessionHandlers() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = (details && details.requestingUrl) || (webContents && webContents.getURL()) || '';
    const ok = allowed.has(permission) && isTrustedRequestOrigin(requestingUrl);
    callback(ok);
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return allowed.has(permission) && isTrustedRequestOrigin(requestingOrigin);
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (displayRequestCallback) {
      // A previous getDisplayMedia() is still waiting; deny the stale request.
      callback();
      return;
    }
    const origin = (request && request.securityOrigin) || (request && request.frame && request.frame.url) || '';
    if (!isTrustedRequestOrigin(origin)) {
      callback();
      return;
    }
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 360, height: 200 },
        fetchWindowIcons: false,
      });
    } catch {
      callback();
      return;
    }
    if (!sources.length) {
      callback();
      return;
    }
    if (sources.length === 1) {
      callback({ video: sources[0] });
      return;
    }
    displayRequestCallback = callback;
    openScreenPicker(sources, request);
  }, { useSystemPicker: false });
}

function openScreenPicker(sources, request) {
  closeScreenPicker(null);
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const win = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    parent,
    modal: Boolean(parent),
    maximizable: false,
    fullscreenable: false,
    title: STR.screenShareTitle,
    icon: appIcon(),
    show: false,
    backgroundColor: '#070a13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  const timer = setTimeout(() => closeScreenPicker(null), 5 * 60 * 1000);
  screenPicker = { win, sources, request, timer };
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
  win.on('closed', () => {
    if (screenPicker && screenPicker.win === win) closeScreenPicker(null);
  });
  win.loadFile(path.join(__dirname, 'picker.html')).catch(() => undefined);
}

function closeScreenPicker(selection) {
  const callback = displayRequestCallback;
  displayRequestCallback = null;
  const picker = screenPicker;
  screenPicker = null;
  if (picker) {
    clearTimeout(picker.timer);
    if (picker.win && !picker.win.isDestroyed()) {
      picker.win.destroy();
    }
  }
  if (!callback) return;
  if (selection && selection.video) {
    callback({ video: selection.video, audio: selection.audio });
  } else {
    callback();
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function isLocalSender(event) {
  try {
    const url = new URL(event.senderFrame ? event.senderFrame.url : '');
    return url.protocol === 'file:';
  } catch {
    return false;
  }
}

function appInfo() {
  return {
    appName: APP_TITLE,
    version: PRODUCT_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    defaultServer: DEFAULT_SERVER,
    currentServer: config.serverUrl || '',
    userData: app.getPath('userData'),
  };
}

function registerIpc() {
  ipcMain.handle('app:info', (event) => (isLocalSender(event) ? appInfo() : { isPcClient: true, version: PRODUCT_VERSION }));

  ipcMain.on('app:open-settings', (event) => {
    if (!isLocalSender(event) && !isTrustedUrl(event.senderFrame ? event.senderFrame.url : '')) return;
    openLauncher();
  });

  ipcMain.handle('launcher:get-state', (event) => {
    if (!isLocalSender(event)) return { ok: false, error: 'forbidden' };
    return { ok: true, currentServer: config.serverUrl || '', defaultServer: DEFAULT_SERVER, info: appInfo() };
  });

  ipcMain.handle('launcher:preview', (event, raw) => {
    if (!isLocalSender(event)) return { ok: false, url: '', error: 'forbidden' };
    return normalizeServerUrl(typeof raw === 'string' ? raw : '');
  });

  ipcMain.handle('launcher:default-server', (event) => {
    if (!isLocalSender(event)) return { ok: false, url: '' };
    return { ok: true, url: DEFAULT_SERVER };
  });

  ipcMain.handle('launcher:save-server', (event, raw) => {
    if (!isLocalSender(event)) return { ok: false, url: '', error: 'forbidden' };
    const result = normalizeServerUrl(typeof raw === 'string' ? raw : '');
    if (!result.ok) return result;
    const previous = loadConfig(app.getPath('userData'));
    const saved = saveConfig(app.getPath('userData'), {
      ...previous,
      serverUrl: result.url,
    });
    config = { ...previous, ...saved, serverUrl: result.url };
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.close();
    createMainWindow(result.url);
    return { ok: true, url: result.url };
  });

  ipcMain.on('launcher:close', (event) => {
    if (!isLocalSender(event)) return;
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.close();
  });

  ipcMain.handle('picker:list', (event) => {
    if (!isLocalSender(event)) return { ok: false, sources: [] };
    if (!screenPicker) return { ok: false, sources: [] };
    const sources = screenPicker.sources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id || '',
      type: String(source.id).startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '',
    }));
    return {
      ok: true,
      sources,
      platform: process.platform,
      systemAudio: IS_WIN,
    };
  });

  ipcMain.handle('picker:select', (event, rawId, rawOptions) => {
    if (!isLocalSender(event)) return { ok: false };
    if (!screenPicker) return { ok: false };
    const id = typeof rawId === 'string' ? rawId : '';
    const source = screenPicker.sources.find((item) => item.id === id) || null;
    if (!source) return { ok: false };
    const includeAudio = Boolean(rawOptions && rawOptions.audio) && IS_WIN;
    closeScreenPicker({ video: source, audio: includeAudio ? 'loopback' : undefined });
    return { ok: true };
  });

  ipcMain.on('picker:cancel', (event) => {
    if (!isLocalSender(event)) return;
    closeScreenPicker(null);
  });
}

/* ------------------------------------------------------------------ *
 * Smoke test (verification hook for non-Windows CI / build machines)
 * ------------------------------------------------------------------ */

function smokeSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function smokeWaitForLoad(win, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || !win.webContents.isLoading()) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      try {
        win.webContents.removeListener('did-finish-load', finish);
        win.webContents.removeListener('did-fail-load', finish);
      } catch { /* window already gone */ }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    win.webContents.on('did-finish-load', finish);
    win.webContents.on('did-fail-load', finish);
  });
}

function smokeScreenshot(win, out) {
  return win.webContents.capturePage().then((image) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    return { screenshot: out, screenshotBytes: fs.statSync(out).size };
  });
}

/** Smoke mode: open the screen-source picker with synthetic sources. */
async function runPickerSmokeTest() {
  const out = SMOKE_OUT || path.join(app.getPath('temp'), 'conglive-pc-smoke-picker.png');
  const result = {
    ok: false,
    mode: 'picker',
    version: PRODUCT_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
  };
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    const fakeSources = [
      { id: 'screen:0:0', name: 'Screen 1', display_id: '0', thumbnail: icon, appIcon: null },
      { id: 'window:11:0', name: 'CongLive', display_id: '', thumbnail: icon, appIcon: null },
    ];
    openScreenPicker(fakeSources, {});
    await smokeSleep(800);
    const win = screenPicker && screenPicker.win;
    if (!win || win.isDestroyed()) throw new Error('screen picker window was not created');
    await smokeWaitForLoad(win);
    let sourceCount = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && sourceCount < 2) {
      await smokeSleep(250);
      sourceCount = await win.webContents.executeJavaScript("document.querySelectorAll('.source').length").catch(() => 0);
    }
    result.visible = win.isVisible();
    result.sourceCount = sourceCount;
    result.titleText = await win.webContents.executeJavaScript("(document.querySelector('.head h1') || {}).textContent || ''");
    Object.assign(result, await smokeScreenshot(win, out));
    // Selecting a source resolves the pending getDisplayMedia request and closes the
    // picker; the renderer frame can be disposed while this script is still running,
    // so fire it without awaiting the result.
    win.webContents.executeJavaScript(
      "document.querySelectorAll('.source')[1] && document.querySelectorAll('.source')[1].click();"
      + "document.querySelector('#share') && document.querySelector('#share').click();",
    ).catch(() => undefined);
    const closeDeadline = Date.now() + 5000;
    while (Date.now() < closeDeadline && screenPicker !== null) await smokeSleep(150);
    result.closedAfterSelect = screenPicker === null;
    result.ok = result.visible === true && result.sourceCount >= 2 && result.closedAfterSelect === true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (screenPicker && screenPicker.win && !screenPicker.win.isDestroyed()) screenPicker.win.destroy();
    screenPicker = null;
    displayRequestCallback = null;
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    app.exit(result.ok ? 0 : 1);
  }
}

/** Smoke mode: launcher → save server → main window loads it. */
async function runFlowSmokeTest() {
  const out = SMOKE_OUT || path.join(app.getPath('temp'), 'conglive-pc-smoke-flow.png');
  const result = {
    ok: false,
    mode: 'flow',
    version: PRODUCT_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
  };
  try {
    const target = normalizeServerUrl(SMOKE_SERVER).ok ? normalizeServerUrl(SMOKE_SERVER).url : DEFAULT_SERVER;
    saveConfig(app.getPath('userData'), { serverUrl: '', windowBounds: null, maximized: false });
    config = loadConfig(app.getPath('userData'));
    const launcher = openLauncher();
    await smokeWaitForLoad(launcher);
    await smokeSleep(600);
    result.launcherForm = await launcher.webContents.executeJavaScript(
      "Boolean(document.querySelector('#server-input'))",
    );
    Object.assign(result, await smokeScreenshot(launcher, out.replace(/\.png$/, '-launcher.png')));
    launcher.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#server-input');
      if (!input) return false;
      input.value = ${JSON.stringify(target)};
      const form = document.querySelector('#server-form');
      if (!form) return false;
      form.requestSubmit();
      return true;
    })()`).catch(() => undefined);

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !(mainWindow && !mainWindow.isDestroyed())) await smokeSleep(150);
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('main window was not created after saving the launcher form');
    await smokeWaitForLoad(mainWindow);
    await smokeSleep(2500);
    result.url = mainWindow.webContents.getURL();
    result.title = mainWindow.webContents.getTitle();
    result.savedServer = loadConfig(app.getPath('userData')).serverUrl;
    try {
      result.pcClass = await mainWindow.webContents.executeJavaScript(
        "document.documentElement.classList.contains('pc-client') && document.documentElement.classList.contains('desktop')",
      );
      result.preloadApi = await mainWindow.webContents.executeJavaScript(
        "typeof window.conglivePC === 'object' && window.conglivePC !== null && window.conglivePC.isPcClient === true",
      );
      result.mobileHintsHidden = await mainWindow.webContents.executeJavaScript(`(() => {
        const el = document.createElement('div');
        el.className = 'mobile-only';
        document.body.appendChild(el);
        const hidden = getComputedStyle(el).display === 'none';
        el.remove();
        return hidden;
      })()`);
    } catch {
      result.pcClass = false;
      result.preloadApi = false;
      result.mobileHintsHidden = false;
    }
    Object.assign(result, await smokeScreenshot(mainWindow, out));
    result.ok = result.savedServer === target
      && result.url.startsWith(target)
      && result.pcClass === true
      && result.preloadApi === true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.destroy();
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    app.exit(result.ok ? 0 : 1);
  }
}

async function runSmokeTest() {
  const mode = ['launcher', 'server', 'flow', 'picker'].includes(SMOKE_MODE) ? SMOKE_MODE : 'launcher';
  if (mode === 'picker') {
    await runPickerSmokeTest();
    return;
  }
  if (mode === 'flow') {
    await runFlowSmokeTest();
    return;
  }
  const out = SMOKE_OUT || path.join(app.getPath('temp'), `conglive-pc-smoke-${mode}.png`);
  const result = {
    ok: false,
    mode,
    version: PRODUCT_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
  };
  const target = mode === 'server'
    ? (normalizeServerUrl(SMOKE_SERVER).ok ? normalizeServerUrl(SMOKE_SERVER).url : (config.serverUrl || DEFAULT_SERVER))
    : '';
  if (target) config.serverUrl = target;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    title: APP_TITLE,
    backgroundColor: '#070a13',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Exercise the same PC-adaptation injection path as the real main window.
  if (target) attachPcAdaptation(win);
  try {
    if (target) await win.loadURL(target);
    else await win.loadFile(path.join(__dirname, 'launcher.html'));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    result.url = win.webContents.getURL();
    result.title = win.webContents.getTitle();
    try {
      result.pcClass = await win.webContents.executeJavaScript(
        "document.documentElement.classList.contains('pc-client') && document.documentElement.classList.contains('desktop')",
      );
    } catch { result.pcClass = false; }
    try {
      result.preloadApi = await win.webContents.executeJavaScript(
        "typeof window.conglivePC === 'object' && window.conglivePC !== null && window.conglivePC.isPcClient === true",
      );
    } catch { result.preloadApi = false; }
    try {
      result.mobileHintsHidden = await win.webContents.executeJavaScript(`(() => {
        const el = document.createElement('div');
        el.className = 'mobile-only';
        el.textContent = 'pc-smoke';
        document.body.appendChild(el);
        const hidden = getComputedStyle(el).display === 'none';
        el.remove();
        return hidden;
      })()`);
    } catch { result.mobileHintsHidden = false; }
    try {
      result.launcherForm = await win.webContents.executeJavaScript(
        "Boolean(document.querySelector('#server-form') && document.querySelector('#server-input'))",
      );
    } catch { result.launcherForm = false; }
    if (result.launcherForm) {
      try {
        result.launcherI18n = await win.webContents.executeJavaScript(`(async () => {
          const heading = () => (document.querySelector('.card h2') || {}).textContent || '';
          const before = heading();
          document.querySelector('[data-lang="zh"]').click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const zh = heading();
          document.querySelector('[data-lang="en"]').click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { before, zh, en: heading() };
        })()`);
      } catch { result.launcherI18n = null; }
      try {
        result.launcherPreview = await win.webContents.executeJavaScript(`(async () => {
          const input = document.querySelector('#server-input');
          input.value = 'xinglan.work';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 700));
          return (document.querySelector('#preview') || {}).textContent || '';
        })()`);
      } catch { result.launcherPreview = ''; }
    }
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    result.screenshot = out;
    result.screenshotBytes = fs.statSync(out).size;
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
  app.exit(result.ok ? 0 : 1);
}

/* ------------------------------------------------------------------ *
 * App lifecycle
 * ------------------------------------------------------------------ */

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : launcherWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (IS_WIN) app.setAppUserModelId(APP_ID);
    config = loadConfig(app.getPath('userData'));
    registerIpc();
    if (SMOKE_MODE) {
      installSessionHandlers();
      buildMenu();
      void runSmokeTest();
      return;
    }
    installSessionHandlers();
    buildMenu();
    const forced = normalizeServerUrl(cliValue('server'));
    if (forced.ok) {
      createMainWindow(forced.url);
      return;
    }
    if (config.serverUrl) createMainWindow(config.serverUrl);
    else openLauncher();
  }).catch((error) => {
    dialog.showErrorBox(APP_TITLE, error instanceof Error ? error.message : String(error));
    app.quit();
  });

  app.on('window-all-closed', () => {
    // The smoke-test harness destroys its windows on purpose; it exits explicitly.
    if (SMOKE_MODE) return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    if (config.serverUrl) createMainWindow(config.serverUrl);
    else openLauncher();
  });
}
