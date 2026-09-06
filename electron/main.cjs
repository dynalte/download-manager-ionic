// Processus principal Electron — charge le build web (dist/) en prod,
// le dev-server Vite (http://localhost:8100) en dev.
//
// Fenêtre TR4KER intégrée : tr4ker.net interdit l'<iframe> (X-Frame-Options
// / CSP) mais une BrowserWindow charge la page en document top-level, donc
// autorisé. Les clics .torrent / magnet: y sont interceptés (cookies de
// session conservés) et renvoyés à la fenêtre principale via IPC.
// La fenêtre TR4KER ne reçoit AUCUN preload : la page distante n'a accès
// à aucun bridge privilégié.
const { app, BrowserWindow, shell, ipcMain, net, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;
const DEV_URL = process.env.ELECTRON_DEV_URL || 'http://localhost:8100';
const TR4KER_URL = 'https://tr4ker.net/';
const SENTINEL_SCHEME = 'x-tr4ker-intercept://';
const MAX_TORRENT_BYTES = 20 * 1024 * 1024;

let mainWin = null;
let tr4kerWin = null;

function isTorrentUrl(u) {
  if (!u) return false;
  const l = String(u).toLowerCase();
  return (
    l.includes('.torrent') ||
    (l.includes('/api/torrents/') && l.includes('/download')) ||
    (l.includes('/download') && l.includes('torrent'))
  );
}

function isMagnetUrl(u) {
  return !!u && String(u).toLowerCase().startsWith('magnet:');
}

function fileNameFromUrl(u) {
  try {
    const base = String(u).split('?')[0].split('/').pop() || 'download.torrent';
    return /\.torrent$/i.test(base) ? base : `${base}.torrent`;
  } catch {
    return 'download.torrent';
  }
}

function sendToApp(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
    try {
      if (process.platform === 'win32') mainWin.flashFrame(true);
    } catch {
      /* ignore */
    }
  }
}

/** Télécharge un .torrent avec les cookies de la session Electron. */
async function fetchTorrentBytes(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/x-bittorrent,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('fichier vide');
  if (buf.length > MAX_TORRENT_BYTES) throw new Error('fichier trop volumineux');
  return buf;
}

function forwardTorrentBuffer(buf, { sourceURL, pageURL, filename }) {
  sendToApp('tr4ker:torrent-bytes', {
    bytesBase64: buf.toString('base64'),
    filename: filename || fileNameFromUrl(sourceURL),
    sourceURL: sourceURL || '',
    pageURL: pageURL || '',
  });
}

function forwardTorrentUrl(url, pageURL) {
  sendToApp('tr4ker:torrent-url', { url, pageURL: pageURL || '' });
}

/** Classifie une navigation : 'magnet' | 'torrent' | null. */
function classifyNavigation(url) {
  if (!url) return null;
  if (isMagnetUrl(url)) return 'magnet';
  if (String(url).startsWith(SENTINEL_SCHEME)) return 'sentinel';
  if (/^https?:/i.test(url) && isTorrentUrl(url)) return 'torrent';
  return null;
}

function handleMagnet(magnetURL, pageURL) {
  sendToApp('tr4ker:magnet', { url: magnetURL, pageURL: pageURL || '' });
}

function handleTorrentUrl(url, pageURL) {
  void fetchTorrentBytes(url)
    .then((buf) => forwardTorrentBuffer(buf, { sourceURL: url, pageURL, filename: fileNameFromUrl(url) }))
    .catch(() => forwardTorrentUrl(url, pageURL)); // l'app retentera en fetch direct
}

/** Capte un magnet: via une navigation sentinelle émise par le script injecté. */
function handleSentinel(url) {
  try {
    const u = new URL(url);
    if (u.host === 'magnet') {
      const magnet = u.searchParams.get('u');
      const pageURL = u.searchParams.get('p') || '';
      if (magnet && isMagnetUrl(magnet)) {
        handleMagnet(magnet, pageURL);
        return true;
      }
    }
  } catch {
    /* URL sentinelle malformée : ignore */
  }
  return false;
}

// Script injecté (depuis le processus main, pas de preload dans l'invité) :
// convertit les clics magnet: en navigation sentinelle interceptable.
// Les .torrent directs et les téléchargements sont captés côté main
// (will-navigate / will-download), avec les cookies de session.
const GUEST_INTERCEPTOR_JS = `
(() => {
  if (window.__tr4kerElectronInstalled) return;
  window.__tr4kerElectronInstalled = true;
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    let href = a.getAttribute('href') || '';
    try { href = new URL(href, window.location.href).toString(); } catch (e) {}
    if (/^magnet:/i.test(href)) {
      ev.preventDefault(); ev.stopPropagation();
      window.location.href = 'x-tr4ker-intercept://magnet?u='
        + encodeURIComponent(href) + '&p=' + encodeURIComponent(window.location.href);
    }
  }, true);
})();
`;

function injectInterceptor(wc) {
  wc.executeJavaScript(GUEST_INTERCEPTOR_JS).catch(() => {});
}

function openTr4kerWindow(url) {
  if (tr4kerWin && !tr4kerWin.isDestroyed()) {
    tr4kerWin.focus();
    if (url && /^https?:/i.test(url)) void tr4kerWin.loadURL(url).catch(() => {});
    return;
  }
  tr4kerWin = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'TR4KER',
    autoHideMenuBar: true,
    // Pas de preload : aucun bridge exposé à la page distante.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = tr4kerWin.webContents;

  const intercept = (url, pageURL) => {
    const kind = classifyNavigation(url);
    if (kind === 'magnet') {
      handleMagnet(url, pageURL);
      return true;
    }
    if (kind === 'sentinel') {
      return handleSentinel(url);
    }
    if (kind === 'torrent') {
      handleTorrentUrl(url, pageURL);
      return true;
    }
    return false;
  };

  wc.on('will-navigate', (event, url) => {
    if (intercept(url, wc.getURL())) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    if (intercept(url, wc.getURL())) event.preventDefault();
  });

  // Téléchargements .torrent (pièces jointes, blob:) : sauvetage en temp,
  // lecture des octets, renvoi à l'app, suppression du temp.
  wc.session.on('will-download', (event, item, contents) => {
    if (contents !== wc) return;
    saveTorrentDownloadFromItem(item, wc.getURL());
  });

  // Popups : interception torrent/magnet, sinon navigation dans la même fenêtre.
  tr4kerWin.webContents.setWindowOpenHandler(({ url }) => {
    if (intercept(url, wc.getURL())) return { action: 'deny' };
    if (/^https?:/i.test(url)) {
      void tr4kerWin.loadURL(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  wc.on('did-finish-load', () => injectInterceptor(wc));

  tr4kerWin.on('closed', () => {
    tr4kerWin = null;
    sendToApp('tr4ker:closed', {});
  });

  void tr4kerWin.loadURL(url && /^https?:/i.test(url) ? url : TR4KER_URL).catch(() => {});
  injectInterceptor(wc);
}

// Sauve un téléchargement .torrent en temp puis renvoie les octets à l'app.
// Ne touche pas aux téléchargements ordinaires (laisse faire Chromium).
function saveTorrentDownloadFromItem(item, pageURL) {
  const url = item.getURL();
  const name = item.getFilename() || '';
  const looksTorrent =
    isTorrentUrl(url) || /\.torrent$/i.test(name) || item.getMimeType() === 'application/x-bittorrent';
  if (!looksTorrent) return false; // téléchargement normal : laisse faire
  const savePath = path.join(app.getPath('temp'), `tr4ker-${Date.now()}-${name || 'download.torrent'}`);
  item.setSavePath(savePath);
  item.once('done', (_e, state) => {
    if (state !== 'completed') return;
    fs.readFile(savePath, (err, buf) => {
      fs.unlink(savePath, () => {});
      if (!err && buf.length > 0 && buf.length <= MAX_TORRENT_BYTES) {
        forwardTorrentBuffer(buf, { sourceURL: url, pageURL, filename: name || fileNameFromUrl(url) });
      } else {
        forwardTorrentUrl(url, pageURL);
      }
    });
  });
  return true;
}

// --- Balise <webview> TR4KER inline (onglet Site sur desktop) ---
// La webview vit dans sa propre session (partition persist:tr4ker) : le
// renderer ne peut pas télécharger avec ses cookies, donc le main attache
// will-download sur la session de l'invité via son WebContentsId.
const tr4kerGuestIds = new Set();

function ensureGuestDownloadHook(ses) {
  if (ses.__tr4kerHook) return;
  ses.__tr4kerHook = true;
  ses.on('will-download', (event, item, contents) => {
    if (!contents || !tr4kerGuestIds.has(contents.id)) return;
    saveTorrentDownloadFromItem(item, contents.getURL());
  });
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Download Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Requis pour la balise <webview> TR4KER inline dans l'onglet Site.
      webviewTag: true,
    },
  });

  if (isDev) {
    mainWin.loadURL(DEV_URL);
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') mainWin.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Les liens _blank de l'app principale partent dans le navigateur système.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  return mainWin;
}

ipcMain.handle('tr4ker:open', (_event, url) => {
  openTr4kerWindow(typeof url === 'string' ? url : TR4KER_URL);
  return { opened: true };
});

ipcMain.handle('tr4ker:close', () => {
  if (tr4kerWin && !tr4kerWin.isDestroyed()) tr4kerWin.close();
  return { closed: true };
});

// Chemin du preload minimal injecté dans la <webview> TR4KER inline
// (résolu côté main car différent entre dev et asar packagé).
ipcMain.handle('tr4ker:preload-path', () => path.join(__dirname, 'tr4ker-preload.cjs'));

// Attache l'interception des téléchargements .torrent à une <webview>.
ipcMain.handle('tr4ker:attach-downloads', (_event, contentsId) => {
  const contents = typeof contentsId === 'number' ? webContents.fromId(contentsId) : null;
  if (!contents || contents.isDestroyed()) return { attached: false };
  tr4kerGuestIds.add(contentsId);
  ensureGuestDownloadHook(contents.session);
  contents.once('destroyed', () => tr4kerGuestIds.delete(contentsId));
  return { attached: true };
});

// --- Transmission RPC sans CORS ---
// Le renderer (file://) ne peut pas appeler Transmission : le header
// X-Transmission-Session-Id n'est pas exposé (pas d'Access-Control-
// Expose-Headers) et le preflight est incomplet -> lecture impossible.
// Le main (Node, pas de CORS) fait le handshake complet et renvoie le JSON.
async function transmissionPost(url, authHeaders, payload, sessionId, signal) {
  const headers = { ...authHeaders };
  if (sessionId) headers['X-Transmission-Session-Id'] = sessionId;
  const res = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non-JSON (ex: page 401) */
  }
  return { status: res.status, sessionId: res.headers.get('x-transmission-session-id') || '', json, text };
}

ipcMain.handle('transmission:rpc', async (_event, args) => {
  const { url, username, password, payload } = args || {};
  if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) {
    throw new Error("URL Transmission invalide. Vérifiez Réglages (onglet Transmission).");
  }
  const authHeaders = { 'Content-Type': 'application/json' };
  if (username || password) {
    authHeaders.Authorization = 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    let r;
    try {
      r = await transmissionPost(url, authHeaders, payload || {}, '', ctrl.signal);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Transmission : délai dépassé (25 s). Serveur injoignable ?');
      throw new Error(`Transmission : serveur injoignable (${(e && e.message) || e}). Vérifiez l'URL et le réseau.`);
    }
    if (r.status === 409 && r.sessionId) {
      r = await transmissionPost(url, authHeaders, payload || {}, r.sessionId, ctrl.signal);
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error('Transmission : identifiants refusés (401). Vérifiez Réglages (onglet Transmission).');
    }
    if (r.status === 409 && !r.sessionId) {
      throw new Error("Transmission : pas de session-ID (pare-feu/proxy ?).");
    }
    if (r.status !== 200) {
      throw new Error(`Transmission : HTTP ${r.status}.`);
    }
    if (!r.json || r.json.result !== 'success') {
      throw new Error(`Transmission : ${(r.json && r.json.result) || 'réponse invalide'}.`);
    }
    return r.json.arguments ?? {};
  } finally {
    clearTimeout(timer);
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
