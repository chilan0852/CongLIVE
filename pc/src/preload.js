'use strict';

/**
 * Preload script for every window of the PC client.
 *
 * Exposes a tiny, context-isolated API to the page:
 *  - `window.conglivePC` lets the web app detect and query the desktop shell;
 *  - `launcher` / `picker` groups are used by the two local HTML windows;
 *  - the main process validates every IPC sender, so a remote page cannot use
 *    the launcher/picker channels.
 *
 * It also marks the document as a PC client (the main process additionally
 * injects CSS that hides mobile-only hints).
 */

const { contextBridge, ipcRenderer } = require('electron');

function markPcClient() {
  try {
    const add = (el) => {
      if (!el) return;
      el.classList.add('pc-client');
      el.classList.add('desktop');
    };
    add(document.documentElement);
    add(document.body);
    document.documentElement.setAttribute('data-conglive-client', 'pc');
    window.dispatchEvent(new Event('conglive:pc-ready'));
  } catch {
    // Enhancement only.
  }
}

try {
  markPcClient();
} catch {
  // Ignore.
}
window.addEventListener('DOMContentLoaded', markPcClient, { once: true });

contextBridge.exposeInMainWorld('conglivePC', {
  isPcClient: true,
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('app:info'),
  openServerSettings: () => ipcRenderer.send('app:open-settings'),
  launcher: {
    getState: () => ipcRenderer.invoke('launcher:get-state'),
    preview: (url) => ipcRenderer.invoke('launcher:preview', typeof url === 'string' ? url : ''),
    defaultServer: () => ipcRenderer.invoke('launcher:default-server'),
    saveServer: (url) => ipcRenderer.invoke('launcher:save-server', typeof url === 'string' ? url : ''),
    close: () => ipcRenderer.send('launcher:close'),
  },
  picker: {
    list: () => ipcRenderer.invoke('picker:list'),
    select: (id, options) => ipcRenderer.invoke('picker:select', typeof id === 'string' ? id : '', options || {}),
    cancel: () => ipcRenderer.send('picker:cancel'),
  },
});
