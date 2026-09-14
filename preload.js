'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('zb', {
  /* 应用信息 */
  info: () => invoke('app:info'),

  /* 配置 */
  settings: () => invoke('store:settings'),
  patchSettings: (p) => invoke('store:patchSettings', p),

  /* 数据 */
  loadWeek: (k) => invoke('store:loadWeek', k),
  saveWeek: (k, d) => invoke('store:saveWeek', k, d),
  listWeeks: () => invoke('store:listWeeks'),
  search: (q) => invoke('store:search', q),
  stats: () => invoke('store:stats'),
  deleteWeek: (k) => invoke('store:deleteWeek', k),
  exportMd: () => invoke('store:exportMd'),
  revealData: () => invoke('store:revealData'),
  revealFile: (p) => invoke('store:revealFile', p),

  /* 周工具 */
  describe: (k) => invoke('util:describe', k),
  currentWeek: () => invoke('util:currentWeek'),
  shiftKey: (k, d) => invoke('util:shiftKey', k, d),
  recentKeys: (n) => invoke('util:recentKeys', n),

  /* 窗口 */
  getBounds: () => invoke('win:getBounds'),
  setBounds: (b) => invoke('win:setBounds', b),
  setOpacity: (v) => invoke('win:setOpacity', v),
  setAlwaysOnTop: (v) => invoke('win:setAlwaysOnTop', v),
  isOnTop: () => invoke('win:isOnTop'),
  toggleMaximize: () => invoke('win:toggleMaximize'),
  isMaximized: () => invoke('win:isMaximized'),
  focus: () => invoke('win:focus'),
  writeClipboard: (t) => invoke('clipboard:write', t),
  minimize: () => invoke('win:minimize'),
  hide: () => invoke('win:hide'),
  close: () => invoke('win:close'),
  quit: () => invoke('win:quit'),

  /* 其它 */
  openReview: (week) => invoke('app:openReview', week),
  broadcast: (msg) => invoke('app:broadcast', msg),
  autostartState: () => invoke('app:autostartState'),
  setAutostart: (v) => invoke('app:setAutostart', v),
  diag: () => invoke('app:diag'),
  reassertTop: () => invoke('app:reassertTop'),
  topState: () => invoke('app:topState'),
  setLite: (v) => invoke('win:setLite', v),
  openExternal: (u) => invoke('app:openExternal', u),

  /* 主进程事件 */
  onBoot: (cb) => ipcRenderer.on('boot', (_e, d) => cb(d)),
  onMainEvent: (cb) => ipcRenderer.on('main:event', (_e, d) => cb(d)),
  onFocusWeek: (cb) => ipcRenderer.on('focus-week', (_e, w) => cb(w))
});
