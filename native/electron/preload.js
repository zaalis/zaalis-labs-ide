'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaalisNative', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});

const nativeListeners = new Set();
ipcRenderer.on('ide-native-event', (_event, data) => { for (const callback of nativeListeners) callback({ data }); });
contextBridge.exposeInMainWorld('chrome', { webview: {
  postMessage: message => ipcRenderer.send('ide-native-message', message),
  addEventListener: (name, callback) => { if (name === 'message' && typeof callback === 'function') nativeListeners.add(callback); },
  removeEventListener: (name, callback) => { if (name === 'message') nativeListeners.delete(callback); },
} });
ipcRenderer.invoke('ide-native-capabilities').then(data => { for (const callback of nativeListeners) callback({ data }); });
