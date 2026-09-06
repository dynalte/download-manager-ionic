// Preload MINIMAL injecté dans la <webview> TR4KER inline (contenu distant).
// N'expose qu'un seul canal à sens unique invité -> app (octets/URLs déjà
// interceptés). Aucun accès IPC général, aucun Node côté page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__tr4kerBridge', {
  postTorrent: (detail) => ipcRenderer.sendToHost('tr4ker-torrent', detail),
});
