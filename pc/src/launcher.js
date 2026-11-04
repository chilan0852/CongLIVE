'use strict';

/**
 * Launcher renderer: collects the CongLive server address, shows a live
 * normalisation preview and asks the main process to save + open it.
 *
 * The actual normalisation/validation lives in the main process (config.js) and
 * is reached through the preload bridge, so there is exactly one implementation.
 */

const DICT = {
  zh: {
    appName: '葱直播 CongLive',
    appSub: 'Windows 便携客户端',
    serverTitle: '服务器地址',
    serverHint: '支持域名、IP 或完整 http(s) 地址，例如 live.example.com、192.168.1.10:8081。',
    serverLabel: '直播服务器',
    connect: '进入直播',
    connecting: '正在进入…',
    reset: '恢复默认',
    tipNormalize: '输入 xinglan.work 会自动补全为 https；局域网 IP 默认使用 http。',
    tipSettings: '进入后可在「文件 → 服务器设置」中随时修改，配置保存在本机。',
    tipPermissions: '摄像头、麦克风与屏幕共享在进入后按网页提示授权。',
    footerHint: '当前地址会保存到本机，下次启动直接进入直播。',
    current: '当前保存的服务器：',
    previewLabel: '将连接到',
    previewDefault: '未保存服务器，将使用默认地址。',
    errorPrefix: '无法使用该地址：',
    errors: {
      empty: '请输入服务器地址（留空会使用默认服务器）。',
      length: '地址过长，请检查后重试。',
      invalid: '地址格式不正确，请填写域名或 IP，例如 xinglan.work 或 192.168.1.10:8081。',
      protocol: '仅支持 http:// 或 https:// 地址。',
      host: '地址缺少主机名。',
      credentials: '地址不能包含用户名或密码。',
      forbidden: '当前页面无权保存服务器地址。',
      bridge: '启动参数异常：请通过 CongLive 客户端打开本页面。',
    },
  },
  en: {
    appName: 'CongLive',
    appSub: 'Windows portable client',
    serverTitle: 'Server address',
    serverHint: 'A domain, IP or full http(s) address works, e.g. live.example.com or 192.168.1.10:8081.',
    serverLabel: 'Live server',
    connect: 'Open CongLive',
    connecting: 'Opening…',
    reset: 'Use default',
    tipNormalize: 'xinglan.work is completed to https automatically; LAN IPs default to http.',
    tipSettings: 'You can change it later from File → Server settings; the address is saved on this PC.',
    tipPermissions: 'Camera, microphone and screen sharing are requested by the web app after it opens.',
    footerHint: 'The address is saved locally; the next launch opens the live app directly.',
    current: 'Saved server: ',
    previewLabel: 'Will connect to',
    previewDefault: 'No saved server yet; the default address will be used.',
    errorPrefix: 'Cannot use this address: ',
    errors: {
      empty: 'Enter a server address (leave empty to use the default).',
      length: 'The address is too long. Check it and try again.',
      invalid: 'Invalid address. Use a domain or IP, e.g. xinglan.work or 192.168.1.10:8081.',
      protocol: 'Only http:// or https:// addresses are supported.',
      host: 'The address has no host name.',
      credentials: 'The address must not contain a username or password.',
      forbidden: 'This page is not allowed to save a server address.',
      bridge: 'The client bridge is unavailable. Start this page from the CongLive desktop app.',
    },
  },
};

const $ = (selector) => document.querySelector(selector);
const state = {
  lang: localStorage.getItem('conglive.pc.lang') || (String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'),
  busy: false,
  info: null,
  currentServer: '',
  defaultServer: 'https://xinglan.work',
  lastPreview: null,
  previewSeq: 0,
};

function t(key) {
  const dict = DICT[state.lang] || DICT.zh;
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : DICT.zh[key];
}

function errorText(code) {
  const dict = DICT[state.lang] || DICT.zh;
  return (dict.errors && dict.errors[code]) || dict.errors.invalid;
}

function setStatus(text, tone) {
  const error = $('#error');
  if (!text) {
    error.hidden = true;
    error.textContent = '';
    error.className = 'error';
    return;
  }
  error.hidden = false;
  error.textContent = text;
  error.className = `error ${tone || ''}`.trim();
}

function applyLanguage() {
  state.lang = state.lang === 'zh' ? 'zh' : 'en';
  localStorage.setItem('conglive.pc.lang', state.lang);
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-lang]').forEach((node) => {
    const active = node.dataset.lang === state.lang;
    node.classList.toggle('active', active);
    node.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const button = $('#connect');
  button.textContent = state.busy ? t('connecting') : t('connect');
  renderCurrentServer();
  void refreshPreview();
}

function renderCurrentServer() {
  const node = $('#current');
  if (!state.currentServer) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.textContent = `${t('current')}${state.currentServer}`;
}

function renderPreview(result) {
  const node = $('#preview');
  if (!result) {
    node.textContent = '';
    return;
  }
  if (result.ok && result.url) {
    node.textContent = `${t('previewLabel')} ${result.url}`;
    node.className = 'preview ok';
    return;
  }
  node.textContent = t('previewDefault');
  node.className = 'preview';
}

async function refreshPreview() {
  const input = $('#server-input');
  const raw = input.value;
  if (!raw.trim()) {
    renderPreview(null);
    return;
  }
  const seq = ++state.previewSeq;
  try {
    const result = await window.conglivePC.launcher.preview(raw);
    if (seq !== state.previewSeq) return;
    state.lastPreview = result;
    renderPreview(result);
  } catch {
    renderPreview(null);
  }
}

function setBusy(busy) {
  state.busy = busy;
  const button = $('#connect');
  const input = $('#server-input');
  const reset = $('#reset');
  button.disabled = busy;
  reset.disabled = busy;
  input.disabled = busy;
  button.textContent = busy ? t('connecting') : t('connect');
}

async function submit(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!window.conglivePC || !window.conglivePC.launcher) {
    setStatus(errorText('bridge'));
    return;
  }
  const raw = $('#server-input').value;
  setBusy(true);
  setStatus('');
  try {
    const result = await window.conglivePC.launcher.saveServer(raw);
    if (!result || result.ok !== true) {
      setBusy(false);
      setStatus(`${t('errorPrefix')}${errorText(result && result.error)}`);
      $('#server-input').focus();
      return;
    }
    setStatus('');
    // The main process closes this window and opens the live app.
  } catch (error) {
    setBusy(false);
    setStatus(`${t('errorPrefix')}${error && error.message ? error.message : errorText('invalid')}`);
  }
}

function resetDefault() {
  const input = $('#server-input');
  input.value = state.defaultServer;
  setStatus('');
  void refreshPreview();
  input.focus();
  input.select();
}

async function init() {
  applyLanguage();
  document.querySelectorAll('[data-lang]').forEach((node) => {
    node.addEventListener('click', () => {
      state.lang = node.dataset.lang === 'en' ? 'en' : 'zh';
      applyLanguage();
    });
  });
  $('#server-form').addEventListener('submit', submit);
  $('#reset').addEventListener('click', resetDefault);
  let debounce = 0;
  $('#server-input').addEventListener('input', () => {
    window.clearTimeout(debounce);
    setStatus('');
    debounce = window.setTimeout(() => { void refreshPreview(); }, 140);
  });

  if (!window.conglivePC || !window.conglivePC.launcher) {
    setStatus(errorText('bridge'));
    return;
  }
  try {
    const result = await window.conglivePC.launcher.getState();
    if (result && result.ok) {
      state.currentServer = result.currentServer || '';
      state.defaultServer = result.defaultServer || state.defaultServer;
      state.info = result.info || null;
      const input = $('#server-input');
      input.value = state.currentServer || state.defaultServer;
      input.placeholder = state.defaultServer;
      $('#server-input').setAttribute('aria-label', t('serverLabel'));
      if (state.info) {
        $('#footer-version').textContent = `v${state.info.version}`;
      }
      renderCurrentServer();
      void refreshPreview();
      input.focus();
      input.select();
    }
  } catch {
    setStatus(errorText('bridge'));
  }
}

init().catch(() => {
  setStatus('Unexpected launcher error');
});
