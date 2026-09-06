// Preload de la fenêtre PRINCIPALE uniquement (jamais chargé dans la
// fenêtre TR4KER distante) : expose un pont minimal vers le main.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const fn = (_event, payload) => {
    try {
      cb(payload);
    } catch {
      /* ignore */
    }
  };
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isElectron: true,
  openTr4ker: (url) => ipcRenderer.invoke('tr4ker:open', url),
  closeTr4ker: () => ipcRenderer.invoke('tr4ker:close'),
  onTr4kerMagnet: (cb) => subscribe('tr4ker:magnet', cb),
  onTr4kerTorrentBytes: (cb) => subscribe('tr4ker:torrent-bytes', cb),
  onTr4kerTorrentUrl: (cb) => subscribe('tr4ker:torrent-url', cb),
  onTr4kerClosed: (cb) => subscribe('tr4ker:closed', cb),
  getTr4kerPreloadPath: () => ipcRenderer.invoke('tr4ker:preload-path'),
  attachTr4kerDownloads: (contentsId) => ipcRenderer.invoke('tr4ker:attach-downloads', contentsId),
  transmissionRpc: (args) => ipcRenderer.invoke('transmission:rpc', args),
});
