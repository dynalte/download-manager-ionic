// Processus principal Electron — charge le build web (dist/) en prod,
// le dev-server Vite (http://localhost:8100) en dev.
//
// Fenêtre TR4KER intégrée : tr4ker.net interdit l'<iframe> (X-Frame-Options
// / CSP) mais une BrowserWindow charge la page en document top-level, donc
// autorisé. Les clics .torrent / magnet: y sont interceptés (cookies de
// session conservés) et renvoyés à la fenêtre principale via IPC.
// La fenêtre TR4KER ne reçoit AUCUN preload : la page distante n'a accès
// à aucun bridge privilégié.
const { app, BrowserWindow, shell, ipcMain, net, webContents, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;
const DEV_URL = process.env.ELECTRON_DEV_URL || 'http://localhost:8100';
const TR4KER_URL = 'https://tr4ker.net/';

/** Icône des fenêtres : assets/ en dev, extraResources en packagé. */
function windowIcon() {
  const p = isDev
    ? path.join(__dirname, '..', 'assets', 'icon.png')
    : path.join(process.resourcesPath, 'assets', 'icon.png');
  try {
    if (fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return undefined;
}
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

/** Capte magnet: et demandes Allociné via navigations sentinelles émises par le script injecté. */
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
    if (u.host === 'allocine') {
      const title = u.searchParams.get('t') || '';
      const pageURL = u.searchParams.get('p') || '';
      if (title) {
        sendToApp('tr4ker:allocine', { title, pageURL });
        return true;
      }
    }
  } catch {
    /* URL sentinelle malformée : ignore */
  }
  return false;
}

// Script injecté (depuis le processus main, pas de preload dans l'invité) :
// convertit les clics magnet: en navigation sentinelle interceptable et
// ajoute un bouton "Allociné" sur les fiches /torrent/<slug> (sentinelle).
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
  function detailTitle() {
    let path = '';
    try { path = window.location.pathname || ''; } catch (e) {}
    if (path.toLowerCase().indexOf('/torrent/') === -1) return '';
    let h1s = [];
    try { h1s = document.querySelectorAll('h1'); } catch (e2) {}
    for (let i = 0; i < h1s.length; i++) {
      let t = '';
      try { t = (h1s[i].textContent || '').trim(); } catch (e3) {}
      if (t && t.length > 3 && t.toLowerCase() !== 'tr4ker') return t;
    }
    return '';
  }
  function refreshBtn() {
    let old = null;
    try { old = document.getElementById('__tr4kerAllocineBtn'); } catch (e4) {}
    const title = detailTitle();
    if (!title) { if (old && old.remove) { try { old.remove(); } catch (e5) {} } return; }
    if (old) { try { old.setAttribute('data-title', title); } catch (e6) {} return; }
    try {
      const b = document.createElement('button');
      b.id = '__tr4kerAllocineBtn';
      b.type = 'button';
      b.textContent = 'Allociné';
      b.setAttribute('data-title', title);
      b.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;padding:10px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:#4f46e5;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45);';
      b.addEventListener('click', (ev2) => {
        try { ev2.preventDefault(); ev2.stopPropagation(); } catch (e7) {}
        let t = '';
        try { t = b.getAttribute('data-title') || ''; } catch (e8) {}
        window.location.href = 'x-tr4ker-intercept://allocine?t='
          + encodeURIComponent(t) + '&p=' + encodeURIComponent(window.location.href);
      });
      document.body.appendChild(b);
    } catch (e9) {}
  }
  try { refreshBtn(); } catch (e10) {}
  try {
    let t = null;
    new MutationObserver(() => {
      if (t) return;
      t = setTimeout(() => { t = null; try { refreshBtn(); } catch (e11) {} }, 800);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e12) {}
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
    icon: windowIcon(),
    autoHideMenuBar: true,
    // Pas de preload : aucun bridge exposé à la page distante.
    // Partition partagée avec la <webview> inline (persist:tr4ker) : UNE seule
    // session TR4KER pour toute l'app, conservée entre les redémarrages.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:tr4ker' },
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

// --- Persistance explicite des cookies TR4KER ---
// Constat : dans cette app, Chromium ne flushe jamais les cookies sur disque
// (aucun fichier Cookies créé) -> la session TR4KER meurt à chaque redémarrage.
// On sauvegarde/restaure donc nous-mêmes les cookies tr4ker.net en JSON.
const TR4KER_COOKIE_BACKUP = 'tr4ker-cookies.json';
const TR4KER_COOKIE_HOSTS = ['tr4ker.net'];
const TR4KER_PARTITION = 'persist:tr4ker';

function tr4kerCookieFile() {
  try {
    return path.join(app.getPath('userData'), TR4KER_COOKIE_BACKUP);
  } catch {
    return null;
  }
}

function isTr4kerCookie(c) {
  const dom = String(c.domain || '').toLowerCase().replace(/^\./, '');
  return TR4KER_COOKIE_HOSTS.some((h) => dom === h || dom.endsWith(`.${h}`));
}

function tr4kerSessions() {
  const out = [];
  try {
    out.push(session.defaultSession);
  } catch {
    /* ignore */
  }
  try {
    out.push(session.fromPartition(TR4KER_PARTITION));
  } catch {
    /* ignore */
  }
  return [...new Set(out)];
}

/** Dernier message d'erreur du backup cookies (diagnostic via IPC). */
let lastCookieBackupError = '';

async function backupTr4kerCookies() {
  const file = tr4kerCookieFile();
  if (!file) return 0;
  let saved = 0;
  try {
    const seen = new Map();
    for (const ses of tr4kerSessions()) {
      let list = [];
      try {
        list = await ses.cookies.get({});
      } catch {
        continue;
      }
      for (const c of list) {
        if (!isTr4kerCookie(c)) continue;
        seen.set(`${c.domain}|${c.path}|${c.name}`, {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'lax',
          expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
        });
      }
    }
    fs.writeFileSync(file, JSON.stringify({ v: 1, at: Date.now(), cookies: [...seen.values()] }), 'utf8');
    saved = seen.size;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.warn('[cookies] backup impossible:', msg);
    lastCookieBackupError = msg;
    return 0;
  }
  if (saved > 0) console.info(`[cookies] ${saved} cookie(s) TR4KER sauvegardé(s)`);
  lastCookieBackupError = '';
  return saved;
}

async function restoreTr4kerCookies() {
  const file = tr4kerCookieFile();
  if (!file) return 0;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0; // pas de sauvegarde : premier lancement
  }
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  let restored = 0;
  for (const ses of tr4kerSessions()) {
    for (const c of cookies) {
      try {
        const details = {
          url: 'https://tr4ker.net/',
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          sameSite: c.sameSite || 'lax',
        };
        if (c.httpOnly) details.httpOnly = true;
        if (typeof c.expirationDate === 'number' && c.expirationDate > Date.now() / 1000) {
          details.expirationDate = c.expirationDate;
        }
        // Idempotent : évite l'accumulation de doublons à chaque lancement.
        try {
          await ses.cookies.remove('https://tr4ker.net/', c.name);
        } catch {
          /* ignore */
        }
        await ses.cookies.set(details);
        restored += 1;
      } catch {
        /* cookie refusé : ignore */
      }
    }
  }
  if (restored > 0) console.info(`[cookies] ${restored} cookie(s) TR4KER restauré(s)`);
  return restored;
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Download Manager',
    icon: windowIcon(),
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

// Déclenchement manuel de la sauvegarde cookies (debug/diagnostic).
ipcMain.handle('cookies:backup-now', async () => ({ saved: await backupTr4kerCookies(), error: lastCookieBackupError }));

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

app.whenReady().then(async () => {
  // Restaure la session AVANT d'ouvrir la moindre fenêtre.
  await restoreTr4kerCookies().catch(() => {});
  createWindow();
  // Sauvegarde périodique (couvre aussi les kills brutaux).
  setInterval(() => {
    void backupTr4kerCookies().catch(() => {});
  }, 30000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Best-effort synchrone impossible (API async) : la sauvegarde périodique couvre.
  void backupTr4kerCookies().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
