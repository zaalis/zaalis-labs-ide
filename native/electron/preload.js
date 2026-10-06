'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaalisNative', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  speech: {
    supported: () => ipcRenderer.invoke('mac-speech-supported'),
    start: (language) => ipcRenderer.invoke('mac-speech-start', language),
    stop: () => ipcRenderer.invoke('mac-speech-stop'),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('mac-speech-event', listener);
      return () => ipcRenderer.removeListener('mac-speech-event', listener);
    },
  },
  computer: {
    status: () => ipcRenderer.invoke('mac-computer-status'),
    requestPermissions: () => ipcRenderer.invoke('mac-computer-request-permissions'),
    stop: () => ipcRenderer.invoke('computer-dock-stop'),
  },
});

const nativeListeners = new Set();
ipcRenderer.on('ide-native-event', (_event, data) => { for (const callback of nativeListeners) callback({ data }); });
contextBridge.exposeInMainWorld('chrome', { webview: {
  postMessage: message => ipcRenderer.send('ide-native-message', message),
  addEventListener: (name, callback) => { if (name === 'message' && typeof callback === 'function') nativeListeners.add(callback); },
  removeEventListener: (name, callback) => { if (name === 'message') nativeListeners.delete(callback); },
} });
ipcRenderer.invoke('ide-native-capabilities').then(data => { for (const callback of nativeListeners) callback({ data }); });
