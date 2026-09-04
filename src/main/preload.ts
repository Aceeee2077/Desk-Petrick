// ============================================================================
// Preload script: exposes a controlled API (window.api) to the renderer via contextBridge
// sandbox: true + contextIsolation: true, so the renderer cannot access Node directly.
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron';

const api: PetApi = {
  moveWindow: (dx, dy) => ipcRenderer.send('window:move', dx, dy),
  moveWindowTo: (x, y) => ipcRenderer.send('window:move-to', x, y),
  dragBegin: () => ipcRenderer.send('window:drag-begin'),
  dragMove: () => ipcRenderer.send('window:drag-move'),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  getWindowPosition: () => ipcRenderer.invoke('window:position'),
  resetPosition: () => ipcRenderer.send('window:reset'),
  setClickThrough: (enabled) => ipcRenderer.send('window:set-click-through', enabled),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  openSettings: () => ipcRenderer.send('settings:open'),
  quitApp: () => ipcRenderer.send('app:quit'),
  showContextMenu: () => ipcRenderer.send('menu:context'),
  aiChat: (messages) => ipcRenderer.invoke('ai:chat', messages),
  autoLaunchGet: () => ipcRenderer.invoke('autolaunch:get'),
  autoLaunchSet: (enabled) => ipcRenderer.invoke('autolaunch:set', enabled),
  onConfigChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, cfg: AppConfig) => cb(cfg);
    ipcRenderer.on('config-changed', listener);
    return () => {
      ipcRenderer.removeListener('config-changed', listener);
    };
  },
  openChat: () => ipcRenderer.send('chat:open'),
  closeChatWindow: () => ipcRenderer.send('chat:close'),
  chatsGetState: () => ipcRenderer.invoke('chats:state'),
  chatsCreate: () => ipcRenderer.invoke('chats:create'),
  chatsDelete: (id) => ipcRenderer.invoke('chats:delete', id),
  chatsArchive: (id) => ipcRenderer.invoke('chats:archive', id),
  chatsRename: (id, title) => ipcRenderer.invoke('chats:rename', id, title),
  setActiveChat: (id) => ipcRenderer.send('chats:set-active', id),
  chatsSend: (id, text) => ipcRenderer.invoke('chats:send', id, text),
  chatsImportLegacy: (payload) => ipcRenderer.invoke('chats:import-legacy', payload),
  onChatsChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, state: ChatState) => cb(state);
    ipcRenderer.on('chats-changed', listener);
    return () => {
      ipcRenderer.removeListener('chats-changed', listener);
    };
  },
  onChatReward: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('pet:chat-reward', listener);
    return () => {
      ipcRenderer.removeListener('pet:chat-reward', listener);
    };
  },
  getCustomImage: () => ipcRenderer.invoke('custom:get'),
  pickCustomImage: () => ipcRenderer.invoke('custom:pick'),
  clearCustomImage: () => ipcRenderer.invoke('custom:clear'),
  getI18n: () => ipcRenderer.invoke('i18n:get'),
  getWeather: () => ipcRenderer.invoke('weather:get'),
  autoMoveStart: (dir, speed) => ipcRenderer.send('auto:move-start', dir, speed),
  autoMoveStop: () => ipcRenderer.send('auto:move-stop'),
  autoJump: (height, duration) => ipcRenderer.send('auto:jump', height, duration),
  centerHere: () => ipcRenderer.send('window:center-here'),
};

contextBridge.exposeInMainWorld('api', api);
