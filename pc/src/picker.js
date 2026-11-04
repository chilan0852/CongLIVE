'use strict';

/**
 * Screen-share source picker used by `setDisplayMediaRequestHandler`.
 * Lists screens/windows reported by desktopCapturer, lets the user pick one and
 * resolves the pending getDisplayMedia() request in the main process.
 */

const DICT = {
  zh: {
    title: '选择要共享的内容',
    hint: '选择整个屏幕或某个窗口。共享只会在本次开播期间进行。',
    filterAll: '全部',
    filterScreens: '屏幕',
    filterWindows: '窗口',
    empty: '没有可共享的屏幕或窗口。',
    includeAudio: '同时共享系统声音',
    cancel: '取消',
    share: '开始共享',
    screen: '屏幕',
    window: '窗口',
    loadFailed: '无法列出可共享的屏幕或窗口，请重试。',
    bridge: '无法与客户端通信，请重新打开开播页面。',
  },
  en: {
    title: 'Choose what to share',
    hint: 'Share an entire screen or a single window. Sharing stops when the broadcast ends.',
    filterAll: 'All',
    filterScreens: 'Screens',
    filterWindows: 'Windows',
    empty: 'No screen or window is available to share.',
    includeAudio: 'Share system audio too',
    cancel: 'Cancel',
    share: 'Share',
    screen: 'Screen',
    window: 'Window',
    loadFailed: 'Could not list screens or windows. Please try again.',
    bridge: 'Cannot reach the desktop client. Reopen the publish page.',
  },
};

const $ = (selector) => document.querySelector(selector);
const state = {
  lang: localStorage.getItem('conglive.pc.lang') || (String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'),
  sources: [],
  filter: 'all',
  selectedId: '',
  systemAudio: false,
  busy: false,
};

function t(key) {
  const dict = DICT[state.lang] || DICT.zh;
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : DICT.zh[key];
}

function applyLanguage() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  render();
}

function setError(text) {
  const node = $('#error');
  node.hidden = !text;
  node.textContent = text || '';
}

function visibleSources() {
  if (state.filter === 'all') return state.sources;
  return state.sources.filter((source) => source.type === state.filter);
}

function render() {
  const container = $('#sources');
  const list = visibleSources();
  container.textContent = '';
  $('#empty').hidden = state.sources.length > 0 && list.length > 0;
  for (const source of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `source${source.id === state.selectedId ? ' selected' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', source.id === state.selectedId ? 'true' : 'false');
    button.dataset.id = source.id;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (source.thumbnail) {
      const image = document.createElement('img');
      image.src = source.thumbnail;
      image.alt = '';
      image.draggable = false;
      thumb.appendChild(image);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'thumb-empty';
      placeholder.textContent = '▣';
      thumb.appendChild(placeholder);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = source.name;
    name.title = source.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = source.type === 'screen' ? t('screen') : t('window');
    meta.append(name, kind);
    if (source.type === 'screen') button.classList.add('is-screen');

    button.append(thumb, meta);
    button.addEventListener('click', () => {
      state.selectedId = source.id;
      render();
    });
    button.addEventListener('dblclick', () => selectAndShare(source.id));
    container.appendChild(button);
  }
  $('#share').disabled = state.busy || !state.selectedId;
  $('#audio-row').hidden = !state.systemAudio;
}

function selectAndShare(id) {
  state.selectedId = id;
  void share();
}

async function share() {
  if (state.busy || !state.selectedId) return;
  state.busy = true;
  $('#share').disabled = true;
  try {
    const audio = Boolean($('#audio') && $('#audio').checked);
    await window.conglivePC.picker.select(state.selectedId, { audio });
  } catch {
    state.busy = false;
    setError(t('bridge'));
  }
}

async function init() {
  applyLanguage();
  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter || 'all';
      document.querySelectorAll('.filter').forEach((node) => {
        node.classList.toggle('active', node === button);
      });
      render();
    });
  });
  $('#share').addEventListener('click', () => void share());
  $('#cancel').addEventListener('click', () => window.conglivePC.picker.cancel());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      window.conglivePC.picker.cancel();
    } else if (event.key === 'Enter' && state.selectedId) {
      event.preventDefault();
      void share();
    }
  });

  if (!window.conglivePC || !window.conglivePC.picker) {
    setError(t('bridge'));
    return;
  }
  try {
    const result = await window.conglivePC.picker.list();
    if (!result || !result.ok) {
      setError(t('loadFailed'));
      return;
    }
    state.sources = Array.isArray(result.sources) ? result.sources : [];
    state.systemAudio = result.systemAudio === true;
    if (state.sources.length === 1) state.selectedId = state.sources[0].id;
    render();
  } catch {
    setError(t('loadFailed'));
  }
}

init().catch(() => setError(DICT.zh.bridge));
