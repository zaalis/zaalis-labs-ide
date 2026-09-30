'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('chrome', { webview: {
  postMessage: message => ipcRenderer.send('browser-view-message', typeof message === 'string' ? message : JSON.stringify(message)),
  addEventListener: (name, callback) => {
    if (name === 'message' && typeof callback === 'function') ipcRenderer.on('browser-post', (_event, data) => callback({ data }));
  },
} });
