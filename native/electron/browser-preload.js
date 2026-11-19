'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'zaalis:' && location.hostname === 'home') {
  const listeners = new Set();
  ipcRenderer.on('browser-post', (_event, data) => {
    for (const callback of listeners) callback({ data });
  });
  contextBridge.exposeInMainWorld('zaalisBridge', {
    postMessage: message => ipcRenderer.send('browser-view-message', typeof message === 'string' ? message : JSON.stringify(message)),
    addEventListener: (name, callback) => {
      if (name === 'message' && typeof callback === 'function') listeners.add(callback);
    },
    removeEventListener: (name, callback) => {
      if (name === 'message') listeners.delete(callback);
    },
  });
}
