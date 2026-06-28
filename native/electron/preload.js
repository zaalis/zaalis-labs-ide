'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaalisNative', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
