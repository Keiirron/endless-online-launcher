'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('eo', {
  status: call('status'), release: call('release'), devposts: call('devposts'), devpost: call('devpost'),
  open: call('open'), openFolder: call('openFolder'), chooseDir: call('chooseDir'),
  update: call('update'), play: call('play'), config: call('config'),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
});
