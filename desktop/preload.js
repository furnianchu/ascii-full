'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('af', {
  info:          () => ipcRenderer.invoke('app:info'),
  pickVideo:     () => ipcRenderer.invoke('dialog:pick-video'),
  pickDir:       () => ipcRenderer.invoke('dialog:pick-dir'),
  saveStandalone:() => ipcRenderer.invoke('standalone:save'),
  start:         o  => ipcRenderer.invoke('run:transcode', o),
  cancel:        () => ipcRenderer.invoke('run:cancel'),
  openPlayer:    d  => ipcRenderer.invoke('player:open', d),
  onLog:      cb => ipcRenderer.on('log:line', (_e, s) => cb(s)),
  onDone:     cb => ipcRenderer.on('run:done', (_e, r) => cb(r)),
});
