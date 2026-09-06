/**
 * Port de WebView.swift — scripts JS injectés côté iOS (WKUserScript).
 * En Ionic/Capacitor, l'iframe tr4ker.net est cross-origin : l'injection directe
 * est impossible. Ces scripts sont conservés pour un vrai WebView natif
 * (ex: @capacitor/browser ouvert avec bridge) et documentent la logique.
 * La page Site utilise les helpers TS ci-dessous (détection torrent/magnet,
 * bouton Allociné) qui répliquent le comportement.
 */

export function shouldHandleAsTorrentUrl(raw: string): boolean {
  const lower = raw.toLowerCase();
  try {
    const u = new URL(raw);
    if ((u.pathname.toLowerCase().endsWith('.torrent')) || lower.includes('.torrent')) return true;
    if (u.pathname.toLowerCase().includes('/api/torrents/') && u.pathname.toLowerCase().includes('/download')) return true;
    if (lower.includes('/download') && (lower.includes('torrent') || u.pathname.toLowerCase().includes('/torrents/'))) return true;
    return false;
  } catch {
    return (
      lower.includes('.torrent') ||
      (lower.includes('/api/torrents/') && lower.includes('/download')) ||
      (lower.includes('/download') && lower.includes('torrent'))
    );
  }
}

export function isMagnetUrl(raw: string): boolean {
  return raw.toLowerCase().startsWith('magnet:');
}

export function isAllocineHost(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === 'allocine.fr' || h === 'www.allocine.fr' || h === 'm.allocine.fr';
  } catch {
    return false;
  }
}

const STOP_WORDS = new Set([
  'multi', 'vostfr', 'vf', 'vff', 'truefrench', 'french', 'sub', 'subs', 'subbed',
  'web', 'webrip', 'web-dl', 'webdl', 'bdrip', 'bluray', 'dvdrip', 'hdrip', 'uhd',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'opus', 'aac', 'ac3', 'dts',
  'edition', 'extended', 'remastered', 'proper', 'repack', 'internal', 'complete',
]);

export function buildAllocineQuery(rawTitle: string): string {
  const sanitized = rawTitle
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(new RegExp('[\\[\\(].*?[\\]\\)]', 'g'), ' ')
    .trim();
  const kept: string[] = [];
  for (const token of sanitized.split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (/^s\d{1,2}e\d{1,3}$/i.test(lower) || /^e\d{1,3}$/i.test(lower)) break;
    if (/^(19|20)\d{2}$/.test(lower) && kept.length >= 2) break;
    if (STOP_WORDS.has(lower)) continue;
    if (/^\d{3,4}p$/.test(lower)) continue;
    if (/^\d+bits?$/.test(lower)) continue;
    if (/^\d(\.\d)?$/.test(lower)) continue;
    kept.push(token);
    if (kept.length >= 7) break;
  }
  return kept.join(' ').trim();
}

export function buildAllocineUrl(rawTitle: string): string {
  return `https://www.allocine.fr/rechercher/?q=${encodeURIComponent(buildAllocineQuery(rawTitle))}`;
}

/** Normalise un nom de fichier .torrent (comme normalizeFilename côté Swift). */
export function normalizeTorrentFilename(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'download.torrent';
  if (trimmed.toLowerCase().endsWith('.torrent')) return trimmed;
  return `${trimmed}.torrent`;
}

/** Script fetch-interceptor d'origine (référence / WebView natif). */
export const FETCH_INTERCEPTOR_SCRIPT = `(() => { /* voir WebView.swift fetchInterceptorScript */ })();`;
