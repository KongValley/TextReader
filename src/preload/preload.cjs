/**
 * 预加载脚本（CommonJS，sandbox 环境可用）。
 * 只暴露白名单 API，渲染进程无 Node 权限。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
  openFile: (path, encoding) => ipcRenderer.invoke('file:open', path, encoding),
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (patch) => ipcRenderer.invoke('state:settings', patch),
  saveProgress: (path, progress) => ipcRenderer.send('state:progress', path, progress),
  saveBookmarks: (path, list) => ipcRenderer.invoke('state:bookmarks', path, list),
  saveHighlights: (path, list) => ipcRenderer.invoke('state:highlights', path, list),
  showContextMenu: (p) => ipcRenderer.send('context-menu', p),
  setTitleBar: (c) => ipcRenderer.send('set-titlebar', c),
  removeRecent: (path) => ipcRenderer.invoke('state:remove-recent', path),
  pickShelfDirs: () => ipcRenderer.invoke('shelf:pick'),
  scanShelf: (dir) => ipcRenderer.invoke('shelf:scan', dir),
  shelfStat: (dirs) => ipcRenderer.invoke('shelf:stat', dirs),
  clearRecent: () => ipcRenderer.invoke('state:clear-recent'),
  reveal: (path) => ipcRenderer.invoke('file:reveal', path),
  encodings: () => ipcRenderer.invoke('app:encodings'),
  listFonts: () => ipcRenderer.invoke('app:fonts'),
  droppedPath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd, payload) => cb(cmd, payload)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, payload) => cb(payload)),
});
