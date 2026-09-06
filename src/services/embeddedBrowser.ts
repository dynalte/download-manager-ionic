/**
 * Navigateur TR4KER embarqué sans <iframe>.
 *
 * Pourquoi : tr4ker.net envoie X-Frame-Options / CSP frame-ancestors qui
 * interdisent l'iframe ("n'autorise pas la connexion"). Aucun code client
 * ne peut contourner ça dans une iframe — c'est imposé par le navigateur.
 *
 * Astuce : @capgo/inappbrowser ouvre une vraie WebView native en plein
 * écran (top-level document, pas une frame). Le serveur l'autorise car
 * ce n'est pas de l'embarquement. On y injecte un intercepteur JS qui
 * capte les clics .torrent / magnet: et les renvoie à l'app via
 * window.mobileApp.postMessage (cookies/session conservés car le fetch
 * se fait DANS la page TR4KER).
 *
 * Sur Electron (exe Windows) : même principe via une BrowserWindow TR4KER
 * dédiée pilotée par electron/main.cjs (fenêtre top-level = autorisée),
 * interception will-navigate / will-download + pont IPC window.desktop.
 */
import { Capacitor } from '@capacitor/core';
import { InAppBrowser, ToolBarType } from '@capgo/inappbrowser';

export interface EmbeddedTorrentBytes {
  bytesBase64: string;
  filename: string;
  sourceURL: string;
  pageURL: string;
}

export interface EmbeddedCallbacks {
  onMagnet: (magnetURL: string, pageURL: string) => void;
  onTorrentBytes: (t: EmbeddedTorrentBytes) => void;
  /** URL .torrent dont le téléchargement direct a échoué côté page : l'app retentera en fetch direct. */
  onTorrentUrl: (url: string, pageURL: string) => void;
  onClose?: () => void;
}

function isTorrentHref(href: string): boolean {
  const l = href.toLowerCase();
  return (
    l.includes('.torrent') ||
    (l.includes('/api/torrents/') && l.includes('/download')) ||
    (l.includes('/download') && l.includes('torrent'))
  );
}

function fileNameFromUrl(url: string): string {
  try {
    const base = url.split('?')[0].split('/').pop() || 'download.torrent';
    return base.toLowerCase().endsWith('.torrent') ? base : `${base}.torrent`;
  } catch {
    return 'download.torrent';
  }
}

/**
 * Intercepteur invité TR4KER (mobile + exe).
 *
 * Le site est une SPA React dont le bouton "Télécharger" ne navigue pas :
 * il fait fetch(/api/torrents/<slug>/download) puis clic programmé sur une
 * ancre DÉTACHÉE en blob: (jamais dans le DOM -> aucun listener document ne
 * le voit). D'où 3 filets, du plus précis au plus général :
 *  1. clics sur liens <a> .torrent / magnet: (capture document) ;
 *  2. patch de HTMLAnchorElement.prototype.click : attrape les ancres
 *     détachées blob: (pattern exact du site), sniff bencode, rejoue le
 *     clic d'origine si ce n'est pas un torrent ;
 *  3. côté natif : will-navigate / will-download (session invité).
 * Le fetch se fait DANS la page : cookies/session TR4KER conservés.
 * Ré-entrant (gardes __tr4ker*) car réinjecté à chaque navigation SPA.
 *
 * NOTE : le code invité n'utilise ni backticks ni ${} (gabarit TS parent).
 */
function buildTr4kerGuestInterceptor(postLine: string): string {
  return `
(() => {
  if (window.__tr4kerInstalled) return;
  window.__tr4kerInstalled = true;
  window.__tr4kerRelaying = false;

  // Le site fait a.click() PUIS URL.revokeObjectURL() en synchrone : sans
  // ceci, nos lectures async (fetch blob) arrivent après révocation et
  // échouent en silence. On diffère toute révocation de 20 s (fuite négligeable).
  try {
    if (!URL.__tr4kerRevokePatched) {
      URL.__tr4kerRevokePatched = true;
      var __origRevoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = function (url) {
        var u = String(url);
        setTimeout(function () { try { __origRevoke(u); } catch (e9) {} }, 20000);
      };
    }
  } catch (e10) {}

  function __post(detail) {
    try { ${postLine} } catch (e) {}
  }
  function isTorrentHref(href) {
    if (!href) return false;
    var l = href.toLowerCase();
    return l.indexOf('.torrent') !== -1 ||
      (l.indexOf('/api/torrents/') !== -1 && l.indexOf('/download') !== -1) ||
      (l.indexOf('/download') !== -1 && l.indexOf('torrent') !== -1);
  }
  function isMagnet(href) {
    return !!href && href.toLowerCase().indexOf('magnet:') === 0;
  }
  function endsWithTorrent(name) {
    var l = (name || '').toLowerCase();
    return l.length >= 8 && l.lastIndexOf('.torrent') === l.length - 8;
  }
  function fileName(url, fallback) {
    var fb = (fallback && endsWithTorrent(fallback)) ? fallback : '';
    // blob: => le nom utile est l'attribut download, pas l'UUID.
    if (fb && (url || '').toLowerCase().indexOf('blob:') === 0) return fb;
    var base = '';
    try { base = url.split('?')[0].split('/').pop() || ''; } catch (e) {}
    if (base && !endsWithTorrent(base)) base = base + '.torrent';
    if (!base) base = fb || 'download.torrent';
    return base;
  }
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var chunk = 0x8000, out = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }
  function looksLikeTorrentBytes(buf) {
    try {
      var bytes = new Uint8Array(buf);
      if (bytes.length < 8 || bytes[0] !== 100) return false; // 'd' bencode
      var head = '';
      var n = bytes.length < 4096 ? bytes.length : 4096;
      for (var i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
      return head.toLowerCase().indexOf('announce') !== -1;
    } catch (e) { return false; }
  }
  function relayClick(anchor, href, dl) {
    window.__tr4kerRelaying = true;
    try {
      var c = document.createElement('a');
      c.href = href;
      if (dl) { try { c.setAttribute('download', dl); } catch (e2) {} }
      document.body.appendChild(c);
      c.click();
      c.remove();
    } catch (e3) {
      try { window.location.href = href; } catch (e4) {}
    }
    window.__tr4kerRelaying = false;
  }
  // Télécharge un blob: en page, poste les octets si torrent, sinon rejoue.
  function handleBlob(href, dlAttr, anchorText, replay) {
    fetch(href, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (blob) {
      if (blob.size > 25 * 1024 * 1024) { replay(href, dlAttr); return; }
      return blob.arrayBuffer().then(function (buf) {
        var pageURL = window.location.href;
        if (looksLikeTorrentBytes(buf)) {
          __post({ type: 'tr4ker-torrent-bytes', bytesBase64: bufToB64(buf),
            filename: fileName(href, dlAttr), sourceURL: href, pageURL: pageURL });
        } else if (dlAttr && endsWithTorrent(dlAttr)) {
          // Nommé .torrent mais sniff négatif (ex: erreur texte) : poste quand même,
          // l'app affichera l'erreur Transmission plutôt que de perdre le clic.
          __post({ type: 'tr4ker-torrent-bytes', bytesBase64: bufToB64(buf),
            filename: dlAttr, sourceURL: href, pageURL: pageURL });
        } else {
          replay(href, dlAttr);
        }
      });
    }).catch(function () {
      replay(href, dlAttr);
    });
  }

  document.addEventListener('click', function (ev) {
    if (window.__tr4kerRelaying) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var raw = '';
    try { raw = a.getAttribute('href') || ''; } catch (e) { return; }
    var href = raw;
    try { href = new URL(raw, window.location.href).toString(); } catch (e2) {}
    var pageURL = window.location.href;
    var dlAttr = '';
    try { dlAttr = a.getAttribute('download') || ''; } catch (e3) {}
    var text = '';
    try { text = a.textContent || ''; } catch (e4) {}

    if (isMagnet(href)) {
      ev.preventDefault(); ev.stopPropagation();
      __post({ type: 'tr4ker-magnet', url: href, pageURL: pageURL });
      return;
    }
    if (href.toLowerCase().indexOf('blob:') === 0) {
      ev.preventDefault(); ev.stopPropagation();
      handleBlob(href, dlAttr, text, function (h, d) { relayClick(a, h, d); });
      return;
    }
    if (isTorrentHref(href)) {
      ev.preventDefault(); ev.stopPropagation();
      fetch(href, { credentials: 'include', headers: { 'Accept': 'application/x-bittorrent,*/*' } })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (buf) {
          if (!looksLikeTorrentBytes(buf)) throw new Error('Réponse inattendue (pas un .torrent)');
          __post({ type: 'tr4ker-torrent-bytes', bytesBase64: bufToB64(buf),
            filename: fileName(href, dlAttr), sourceURL: href, pageURL: pageURL });
        })
        .catch(function () {
          __post({ type: 'tr4ker-torrent-url', url: href, pageURL: pageURL });
        });
    }
  }, true);

  // Attrape les a.click() programmés sur ancres détachées (pattern du site).
  try {
    var proto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    if (proto && !proto.__tr4kerClickPatched) {
      proto.__tr4kerClickPatched = true;
      var origClick = proto.click;
      proto.click = function () {
        var anchor = this;
        try {
          if (!window.__tr4kerRelaying) {
            var href2 = anchor.href || '';
            var dl2 = '';
            try { dl2 = anchor.getAttribute('download') || ''; } catch (e5) {}
            if (href2 && href2.toLowerCase().indexOf('blob:') === 0) {
              handleBlob(href2, dl2, '', function (h, d) {
                window.__tr4kerRelaying = true;
                try { origClick.call(anchor); } catch (e6) {}
                window.__tr4kerRelaying = false;
              });
              return;
            }
          }
        } catch (e7) {}
        return origClick.apply(this, arguments);
      };
    }
  } catch (e8) {}
})();
`;
}

/** Version mobile : poste via le bridge Capgo window.mobileApp. */
export const INTERCEPTOR_JS = buildTr4kerGuestInterceptor(
  'window.mobileApp.postMessage({ detail: detail })',
);

/** Version exe : poste via le preload minimal window.__tr4kerBridge. */
export const TR4KER_WEBVIEW_INTERCEPTOR_JS = buildTr4kerGuestInterceptor(
  'window.__tr4kerBridge.postTorrent(detail)',
);

export async function openTr4kerEmbedded(
  siteURL: string,
  cb: EmbeddedCallbacks,
): Promise<{ close: () => Promise<void> }> {
  // 1) Electron (exe Windows) : fenêtre TR4KER dédiée pilotée par le main
  //    (electron/main.cjs) via le pont window.desktop. Reste ouverte après
  //    interception (multitâche desktop) : close() la referme + se désabonne.
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
  if (desktop?.isElectron) {
    const offMagnet = desktop.onTr4kerMagnet((p) => cb.onMagnet(p.url, p.pageURL || ''));
    const offBytes = desktop.onTr4kerTorrentBytes((p) =>
      cb.onTorrentBytes({
        bytesBase64: p.bytesBase64,
        filename: p.filename || 'download.torrent',
        sourceURL: p.sourceURL || '',
        pageURL: p.pageURL || '',
      }),
    );
    const offUrl = desktop.onTr4kerTorrentUrl((p) => cb.onTorrentUrl(p.url, p.pageURL || ''));
    const offClosed = desktop.onTr4kerClosed(() => cb.onClose?.());
    const cleanup = () => {
      offMagnet();
      offBytes();
      offUrl();
      offClosed();
    };
    await desktop.openTr4ker(siteURL);
    return {
      close: async () => {
        cleanup();
        try {
          await desktop.closeTr4ker();
        } catch {
          /* déjà fermée */
        }
      },
    };
  }

  // 2) Sur le web (dev desktop), pas de WebView native : nouvel onglet.
  if (!Capacitor.isNativePlatform()) {
    window.open(siteURL, '_blank', 'noopener');
    return { close: async () => {} };
  }

  // Nettoie d'anciens listeners (un seul browser à la fois dans cet écran).
  try {
    await InAppBrowser.removeAllListeners();
  } catch {
    /* ignore */
  }

  await InAppBrowser.addListener('browserPageLoaded', () => {
    // Injection après chaque chargement (SPA : garde interne anti-double).
    void InAppBrowser.executeScript({ code: INTERCEPTOR_JS }).catch(() => {});
  });

  await InAppBrowser.addListener('messageFromWebview', (event) => {
    const d = (event?.detail ?? {}) as Record<string, unknown>;
    if (d['type'] === 'tr4ker-magnet' && typeof d['url'] === 'string') {
      cb.onMagnet(d['url'], typeof d['pageURL'] === 'string' ? d['pageURL'] : '');
    } else if (d['type'] === 'tr4ker-torrent-bytes' && typeof d['bytesBase64'] === 'string') {
      cb.onTorrentBytes({
        bytesBase64: d['bytesBase64'],
        filename: typeof d['filename'] === 'string' ? d['filename'] : 'download.torrent',
        sourceURL: typeof d['sourceURL'] === 'string' ? d['sourceURL'] : '',
        pageURL: typeof d['pageURL'] === 'string' ? d['pageURL'] : '',
      });
    } else if (d['type'] === 'tr4ker-torrent-url' && typeof d['url'] === 'string') {
      cb.onTorrentUrl(d['url'], typeof d['pageURL'] === 'string' ? d['pageURL'] : '');
    }
  });

  // Filet de sécurité : navigation top-level vers un .torrent / magnet:
  // (cas où le clic n'est pas passé par l'intercepteur, ex: window.location).
  await InAppBrowser.addListener('urlChangeEvent', (state) => {
    const url = state?.url ?? '';
    if (!url) return;
    if (url.toLowerCase().startsWith('magnet:')) {
      cb.onMagnet(url, '');
    } else if (isTorrentHref(url)) {
      cb.onTorrentUrl(url, '');
    }
  });

  await InAppBrowser.addListener('closeEvent', () => {
    cb.onClose?.();
  });

  await InAppBrowser.openWebView({
    url: siteURL,
    title: 'TR4KER',
    toolbarType: ToolBarType.NAVIGATION,
    showReloadButton: true,
    activeNativeNavigationForWebview: true,
  });

  // Première injection (si la page est déjà chargée avant browserPageLoaded).
  try {
    await InAppBrowser.executeScript({ code: INTERCEPTOR_JS });
  } catch {
    /* la réinjection via browserPageLoaded prendra le relais */
  }

  return {
    close: async () => {
      try {
        await InAppBrowser.close();
      } catch {
        /* déjà fermé */
      }
    },
  };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { fileNameFromUrl };

/** Vrai sur l'exe Windows (pont window.desktop), faux sur mobile/web. */
export function isDesktopElectron(): boolean {
  return typeof window !== 'undefined' && !!window.desktop?.isElectron;
}

/** Route un message invité TR4KER vers les callbacks (retourne 'torrent-url' à traiter à part sur desktop). */
export function handleGuestTorrentMessage(msg: unknown, cb: EmbeddedCallbacks): 'handled' | 'torrent-url' | 'ignored' {
  const d = (msg ?? {}) as Record<string, unknown>;
  if (d['type'] === 'tr4ker-magnet' && typeof d['url'] === 'string') {
    cb.onMagnet(d['url'], typeof d['pageURL'] === 'string' ? d['pageURL'] : '');
    return 'handled';
  }
  if (d['type'] === 'tr4ker-torrent-bytes' && typeof d['bytesBase64'] === 'string') {
    cb.onTorrentBytes({
      bytesBase64: d['bytesBase64'],
      filename: typeof d['filename'] === 'string' ? d['filename'] : 'download.torrent',
      sourceURL: typeof d['sourceURL'] === 'string' ? d['sourceURL'] : '',
      pageURL: typeof d['pageURL'] === 'string' ? d['pageURL'] : '',
    });
    return 'handled';
  }
  if (d['type'] === 'tr4ker-torrent-url' && typeof d['url'] === 'string') {
    cb.onTorrentUrl(d['url'], typeof d['pageURL'] === 'string' ? d['pageURL'] : '');
    return 'torrent-url';
  }
  return 'ignored';
}
