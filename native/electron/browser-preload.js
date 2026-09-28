'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Browser pages may send commands to the embedded browser. Ordinary websites
// never receive this bridge.
if (location.protocol === 'zaalis:') {
  const listeners = new Set();
  ipcRenderer.on('zaalis-browser-message', (_event, data) => {
    for (const listener of listeners) listener({ data });
  });
  contextBridge.exposeInMainWorld('zaalisBridge', Object.freeze({
    postMessage(message) {
      const value = typeof message === 'string' ? message : JSON.stringify(message);
      ipcRenderer.send('zaalis-browser-post', value);
    },
    addEventListener(name, listener) {
      if (name === 'message' && typeof listener === 'function') listeners.add(listener);
    },
    removeEventListener(name, listener) {
      if (name === 'message') listeners.delete(listener);
    },
  }));
}
