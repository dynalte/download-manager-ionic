/**
 * Recherche de torrents via V3X (v3x.club, tracker privé FR), en plus de
 * TR4KER et C411 (voir tr4kerDiscovery.ts et c411.ts).
 *
 * API utilisée : JSON maison (champ `torznab`, voir définition Jackett v3x) :
 *   GET https://api.v3x.club/indexer/search?apikey=<CLE>&q=...&cat=...&limit=100
 * Réponse : JSON { results: [...] }, un objet par torrent :
 *   title, details (fiche), download (.torrent), infohash, tmdbid,
 *   pubdate, size, seeders, leechers, grabs, category, subcategory,
 *   downloadvolumefactor (0 = freeleech), uploadvolumefactor.
 * Clé API : profil V3X, Réglages -> Intégrations (scope torznab).
 * Clé invalide -> HTTP 401. IDs catégories : voir V3X_CATEGORY_BY_KEY
 * (2000 films, 5000 séries, 7000 ebooks, 3030 audiobooks — même schéma que C411).
 *
 * Accès : via le serveur PHP perso par défaut (actions v3x_search /
 * v3x_download / v3x_detail de api-download-manager.php), même motif que
 * C411 (filtrage direct, CORS). Modes Réglages : proxy (défaut), direct, auto.
 */
import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  cleanTitle,
  extractYear,
  type DiscoveryCategoryKey,
  type DiscoveryFilm,
} from './tr4kerDiscovery';
import { extractTrackerPageSynopsis, extractTrackerPageTech, parseTechTags, type C411Detail } from './c411';
import { settings } from './settings';
import { isServerConfigured, serverApi } from './serverApi';

export const V3X_SITE_URL = 'https://v3x.club/';
export const V3X_API_URL = 'https://api.v3x.club/indexer/search';

export class V3XError extends Error {
  /** Échec réseau (connexion impossible) : éligible au repli proxy. */
  isNetworkFailure = false;
}

function networkError(msg: string): V3XError {
  const err = new V3XError(msg);
  err.isNetworkFailure = true;
  return err;
}

/**
 * Normalise la clé collée : espaces/retours chariot parasites supprimés.
 * Détecte l'erreur classique « URL collée au lieu de la clé seule ».
 */
function sanitizeApiKey(apiKey: string): string {
  const key = apiKey.replace(/\s+/g, '');
  if (!key) throw new V3XError("Colle ta clé API V3X d'abord (profil v3x.club, Réglages -> Intégrations).");
  if (/:\/\//.test(key) || /\/indexer\//i.test(key)) {
    throw new V3XError(
      'On dirait une URL complète : colle uniquement la clé (le long code seul, sans https://…), générée sur v3x.club (Réglages -> Intégrations, scope torznab).',
    );
  }
  return key;
}

interface V3XSearchParams {
  q?: string;
  cat?: string;
  limit?: number;
  tmdbid?: number;
  season?: number;
  ep?: number;
}

function buildParams(key: string, p: V3XSearchParams): Record<string, string> {
  const params: Record<string, string> = { apikey: key, limit: String(Math.max(1, Math.min(100, p.limit ?? 50))) };
  if (p.q !== undefined && p.q.trim() !== '') params.q = p.q.trim();
  if (p.cat) params.cat = p.cat;
  if (p.tmdbid) params.tmdbid = String(p.tmdbid);
  if (p.season !== undefined) params.season = String(p.season);
  if (p.ep !== undefined) params.ep = String(p.ep);
  return params;
}

/** Recherche JSON en direct (client -> api.v3x.club). */
async function searchDirect(params: Record<string, string>): Promise<{ status: number; raw: string }> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url: V3X_API_URL,
      params,
      headers: { Accept: 'application/json' },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 30000,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw networkError(
      `V3X injoignable (réseau : ${raw}). Maintenance, connexion coupée ou domaine bloqué (AdGuard/VPN/DNS) ?`,
    );
  }
  return { status: res.status, raw: typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {}) };
}

/** Recherche via le serveur PHP perso (action=v3x_search). */
async function searchViaProxy(params: Record<string, string>): Promise<{ status: number; raw: string }> {
  if (!isServerConfigured()) {
    throw new V3XError('Serveur perso non configuré (Réglages > Synchro vus) : proxy V3X impossible.');
  }
  let data: { status?: unknown; json?: unknown };
  try {
    data = (await serverApi('v3x_search', params)) as { status?: unknown; json?: unknown };
  } catch (e) {
    throw new V3XError(`Proxy V3X : ${e instanceof Error ? e.message : String(e)}`);
  }
  const status = typeof data.status === 'number' ? data.status : 0;
  const raw = typeof data.json === 'string' ? data.json : '';
  if (status === 0 || !raw) throw new V3XError('Proxy V3X : réponse vide (action v3x_search déployée côté PHP ?).');
  return { status, raw };
}

/** Routage selon Réglages (proxy par défaut ; direct ; auto = direct puis proxy). */
async function searchRaw(params: Record<string, string>): Promise<{ status: number; raw: string }> {
  const mode = settings.v3xProxyMode;
  if (mode === 'proxy') return searchViaProxy(params);
  try {
    return await searchDirect(params);
  } catch (e) {
    if (mode === 'auto' && e instanceof V3XError && e.isNetworkFailure && isServerConfigured()) {
      return searchViaProxy(params);
    }
    throw e;
  }
}

/** Catégorie V3X par portée de recherche du Catalogue. */
export const V3X_CATEGORY_BY_KEY: Record<DiscoveryCategoryKey, string> = {
  films: '2000',
  series: '5000',
  books: '7000',
  audiobooks: '3030',
};

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Préfixe numérique V3X -> slug compatible avec filterByDiscoveryCategory. */
function catSlugFor(numCat: string): string {
  const n = parseInt(numCat, 10);
  if (n >= 2000 && n < 3000) return 'films';
  if (n >= 5000 && n < 6000) return 'series';
  if (n === 3030) return 'livres-audio';
  if (n >= 3000 && n < 4000) return 'audio';
  if (n >= 7000 && n < 8000) return 'livres';
  return 'autre';
}

function catLabelFor(numCat: string, sub?: string): string {
  const slug = catSlugFor(numCat);
  const base =
    slug === 'films'
      ? 'Films & Vidéos'
      : slug === 'series'
        ? 'Séries TV'
        : slug === 'livres-audio'
          ? 'Audiobooks'
          : slug === 'audio'
            ? 'Musique'
            : slug === 'livres'
              ? 'Ebooks'
              : `Cat. ${numCat}`;
  const extra = (sub ?? '').trim();
  return extra && extra.toLowerCase() !== base.toLowerCase() ? `${base} · ${extra}` : base;
}

interface V3XRawItem {
  title?: unknown;
  details?: unknown;
  download?: unknown;
  infohash?: unknown;
  tmdbid?: unknown;
  pubdate?: unknown;
  size?: unknown;
  seeders?: unknown;
  leechers?: unknown;
  category?: unknown;
  subcategory?: unknown;
  downloadvolumefactor?: unknown;
}

/** "08/21/2026 01:28:14" (+ GMT) ou ISO -> Date. */
function parsePubDate(raw: unknown): Date | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) {
    d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function normalizeItem(raw: V3XRawItem): DiscoveryFilm | null {
  const name = String(raw.title ?? '').trim();
  if (!name) return null;
  const downloadUrl = String(raw.download ?? '').trim();
  // Sans URL de téléchargement, l'item est inexploitable (pas d'envoi Transmission).
  if (!downloadUrl) return null;
  const infohash = String(raw.infohash ?? '').trim().toLowerCase();
  const numCat = String(raw.category ?? '').trim();
  const slug = infohash
    ? `v3x:${infohash}`
    : `v3x:noid:${toNumber(raw.size)}:${name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 60)}`;
  const tmdbId = toNumber(raw.tmdbid);
  const detailsUrl = String(raw.details ?? '').trim() || undefined;
  return {
    slug,
    name,
    title: cleanTitle(name),
    year: extractYear(name),
    seeders: toNumber(raw.seeders),
    leechers: toNumber(raw.leechers),
    sizeBytes: toNumber(raw.size),
    addedAt: parsePubDate(raw.pubdate),
    category: `V3X · ${catLabelFor(numCat, String(raw.subcategory ?? ''))}`,
    catSlug: catSlugFor(numCat),
    // downloadvolumefactor 0 = gratuit en ratio (freeleech).
    isFreeleech: String(raw.downloadvolumefactor ?? '1').trim() === '0',
    ...(tmdbId > 0 ? { tmdbId } : {}),
    source: 'v3x',
    downloadUrl,
    ...(detailsUrl ? { detailsUrl } : {}),
  };
}

function parseSearchResponse(status: number, raw: string): DiscoveryFilm[] {
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 401) {
    throw new V3XError(
      `Clé API V3X refusée (HTTP 401${snippet ? ` : ${snippet}` : ''}). À générer sur v3x.club (Réglages -> Intégrations, scope torznab), puis coller dans Réglages.`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new V3XError(`V3X : HTTP ${status}.`);
  }
  if (/<html[\s>]/i.test(raw.slice(0, 500))) {
    throw new V3XError('V3X indisponible (maintenance du site ?).');
  }
  let parsed: { results?: V3XRawItem[]; error?: unknown; message?: unknown; error_description?: unknown };
  try {
    parsed = JSON.parse(raw) as { results?: V3XRawItem[]; error?: unknown; message?: unknown; error_description?: unknown };
  } catch {
    throw new V3XError('Réponse V3X illisible.');
  }
  if (parsed.error) {
    throw new V3XError(`V3X : ${String(parsed.error_description ?? parsed.message ?? parsed.error)}`);
  }
  const out: DiscoveryFilm[] = [];
  for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
    try {
      const f = normalizeItem(item);
      if (f) out.push(f);
    } catch {
      /* item ignoré */
    }
  }
  return out;
}

export interface SearchV3XOptions {
  /** Portée Catalogue (filtre `cat`). Omise = toutes catégories. */
  category?: DiscoveryCategoryKey | null;
  limit?: number;
}

export interface LatestV3XOptions {
  /** Portée Catalogue (filtre `cat`). Omise = toutes catégories. */
  category?: DiscoveryCategoryKey | null;
  limit?: number;
  /** Ne garder que les items ajoutés après ce timestamp (ms). 0 = tout. */
  sinceMs?: number;
}

async function searchItems(key: string, opts: { q?: string; cat?: DiscoveryCategoryKey | null; limit?: number }): Promise<DiscoveryFilm[]> {
  const { q = '', cat = null, limit = 50 } = opts;
  const params = buildParams(key, {
    q: q.trim(),
    cat: cat ? V3X_CATEGORY_BY_KEY[cat] : undefined,
    limit: Math.max(1, Math.min(100, limit)),
  });
  const { status, raw } = await searchRaw(params);
  return parseSearchResponse(status, raw);
}

/**
 * Recherche V3X par titre. Si le filtre catégorie ne renvoie rien,
 * rejoue sans filtre (filet de sécurité).
 */
export async function searchV3X(apiKey: string, query: string, opts: SearchV3XOptions = {}): Promise<DiscoveryFilm[]> {
  const key = sanitizeApiKey(apiKey);
  const q = query.trim();
  if (!q) throw new V3XError('Recherche vide.');
  const { category = null, limit = 50 } = opts;

  const withCat = category ? await searchItems(key, { q, cat: category, limit }) : [];
  if (category && withCat.length === 0) return searchItems(key, { q, limit });
  return category ? withCat : searchItems(key, { q, limit });
}

/** Dernières sorties V3X (recherche sans `q`), pour les Nouveautés du Catalogue. */
export async function fetchLatestV3X(apiKey: string, opts: LatestV3XOptions = {}): Promise<DiscoveryFilm[]> {
  const key = sanitizeApiKey(apiKey);
  const { category = null, limit = 100, sinceMs = 0 } = opts;
  let items = await searchItems(key, { cat: category, limit });
  if (category && items.length === 0) items = await searchItems(key, { limit });
  const fresh = sinceMs > 0 ? items.filter((f) => !f.addedAt || f.addedAt.getTime() >= sinceMs) : items;
  fresh.sort((a, b) => b.seeders - a.seeders);
  return fresh;
}

/**
 * Test de connexion + clé (Réglages > Tester) : recherche `limit=1` légère.
 * Teste le direct puis le proxy (si serveur configuré) et résume les deux.
 */
export async function testV3XConnection(apiKey: string): Promise<string> {
  const key = sanitizeApiKey(apiKey);
  const print = `clé ${key.length} car., …${key.slice(-4)}`;
  const params = buildParams(key, { q: 'test', limit: 1 });
  let directErr: string | null = null;
  try {
    const { status, raw } = await searchDirect(params);
    parseSearchResponse(status, raw);
  } catch (e) {
    directErr = e instanceof Error ? e.message : String(e);
  }
  let proxyState = 'proxy non configuré (Réglages > Synchro vus)';
  if (isServerConfigured()) {
    try {
      const { status, raw } = await searchViaProxy(params);
      parseSearchResponse(status, raw);
      proxyState = 'proxy OK';
    } catch (e) {
      proxyState = `proxy KO (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  if (directErr && proxyState !== 'proxy OK') {
    throw new V3XError(`${directErr} [${print}]`);
  }
  const via = !directErr ? 'direct' : 'proxy (direct en échec)';
  return `V3X OK via ${via} : connexion et clé valides. [${print}] [${proxyState}]`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** .torrent en direct (client -> URL download V3X). */
async function downloadDirect(url: string): Promise<Uint8Array> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/x-bittorrent,*/*' },
      responseType: 'arraybuffer',
      connectTimeout: 15000,
      readTimeout: 60000,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw networkError(`Téléchargement .torrent impossible (réseau : ${raw}).`);
  }
  if (res.status === 401) {
    throw new V3XError('Clé API V3X refusée (HTTP 401). À générer sur v3x.club (Réglages -> Intégrations, scope torznab).');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new V3XError(`Téléchargement .torrent : HTTP ${res.status}.`);
  }
  return typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data ?? []);
}

/** .torrent via le serveur PHP perso (action=v3x_download, base64). */
async function downloadViaProxy(url: string, apiKey: string): Promise<Uint8Array> {
  if (!isServerConfigured()) {
    throw new V3XError('Serveur perso non configuré (Réglages > Synchro vus) : proxy V3X impossible.');
  }
  let data: { status?: unknown; data_base64?: unknown };
  try {
    data = (await serverApi('v3x_download', { url, apikey: apiKey })) as { status?: unknown; data_base64?: unknown };
  } catch (e) {
    throw new V3XError(`Proxy V3X : ${e instanceof Error ? e.message : String(e)}`);
  }
  const status = typeof data.status === 'number' ? data.status : 0;
  if (status === 401) {
    throw new V3XError('Clé API V3X refusée par V3X (via proxy). À générer sur v3x.club (Réglages -> Intégrations).');
  }
  if (status < 200 || status >= 300) {
    throw new V3XError(`Téléchargement .torrent : HTTP ${status}.`);
  }
  const b64 = typeof data.data_base64 === 'string' ? data.data_base64 : '';
  if (!b64) throw new V3XError('Proxy V3X : .torrent vide (action v3x_download déployée côté PHP ?).');
  return base64ToBytes(b64);
}

/** Télécharge le .torrent d'un résultat V3X (vérifié bencode). */
export async function downloadV3XTorrent(film: Pick<DiscoveryFilm, 'downloadUrl'>, apiKey: string): Promise<Uint8Array> {
  const key = sanitizeApiKey(apiKey);
  let url = (film.downloadUrl ?? '').trim();
  if (!url) throw new V3XError('Lien de téléchargement V3X manquant.');
  // Filet de sécurité : la clé dans l'URL si le lien ne l'embarque pas.
  if (!/[?&]apikey=/i.test(url)) {
    url += `${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}`;
  }
  const mode = settings.v3xProxyMode;
  let bytes: Uint8Array;
  if (mode === 'proxy') {
    bytes = await downloadViaProxy(url, key);
  } else {
    try {
      bytes = await downloadDirect(url);
    } catch (e) {
      if (mode === 'auto' && e instanceof V3XError && e.isNetworkFailure && isServerConfigured()) {
        bytes = await downloadViaProxy(url, key);
      } else {
        throw e;
      }
    }
  }
  if (bytes.length === 0) throw new V3XError('.torrent vide reçu.');
  if (bytes[0] !== 100) throw new V3XError('Réponse inattendue (pas un .torrent).');
  return bytes;
}

// ---------- Fiche V3X (synopsis + technique, même forme que C411Detail) ----------

const V3X_DETAIL_TTL = 30 * 24 * 3600 * 1000;
const V3X_DETAIL_CACHE_KEY = 'v3x-detail-cache-v1';
const V3X_DETAIL_MAX = 300;
const v3xDetailCache = new Map<string, { at: number; data: C411Detail }>();
let v3xDetailCacheLoaded = false;

async function loadV3XDetailCache(): Promise<void> {
  if (v3xDetailCacheLoaded) return;
  v3xDetailCacheLoaded = true;
  try {
    const { value } = await Preferences.get({ key: V3X_DETAIL_CACHE_KEY });
    if (!value) return;
    const obj = JSON.parse(value) as Record<string, { at: number; data: C411Detail }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && v.data) v3xDetailCache.set(k, v);
    }
  } catch {
    /* premier lancement */
  }
}

function saveV3XDetailCache(): void {
  try {
    const obj: Record<string, { at: number; data: C411Detail }> = {};
    for (const [k, v] of v3xDetailCache) obj[k] = v;
    void Preferences.set({ key: V3X_DETAIL_CACHE_KEY, value: JSON.stringify(obj) }).catch(() => {});
  } catch {
    /* ignore */
  }
}

async function fetchV3XPageHtml(url: string, apiKey: string): Promise<string> {
  const mode = settings.v3xProxyMode;
  if (mode === 'proxy') {
    if (!isServerConfigured()) throw new V3XError('Serveur perso non configuré : proxy V3X impossible.');
    const data = (await serverApi('v3x_detail', { url, apikey: apiKey })) as { status?: unknown; html?: unknown };
    const status = typeof data.status === 'number' ? data.status : 0;
    const html = typeof data.html === 'string' ? data.html : '';
    if (status < 200 || status >= 300 || !html) throw new V3XError(`Fiche V3X : HTTP ${status || 'inconnu'}.`);
    return html;
  }
  try {
    const res = await CapacitorHttp.get({
      url,
      headers: { Accept: 'text/html,*/*' },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 25000,
    });
    if (res.status < 200 || res.status >= 300) throw new V3XError(`Fiche V3X : HTTP ${res.status}.`);
    const html = typeof res.data === 'string' ? res.data : '';
    if (!html) throw new V3XError('Fiche V3X vide.');
    return html;
  } catch (e) {
    if (mode === 'auto' && e instanceof V3XError && e.isNetworkFailure && isServerConfigured()) {
      const data = (await serverApi('v3x_detail', { url, apikey: apiKey })) as { status?: unknown; html?: unknown };
      const status = typeof data.status === 'number' ? data.status : 0;
      const html = typeof data.html === 'string' ? data.html : '';
      if (status < 200 || status >= 300 || !html) throw new V3XError(`Fiche V3X : HTTP ${status || 'inconnu'}.`);
      return html;
    }
    throw e;
  }
}

/**
 * Synopsis + détails techniques d'un résultat V3X (même forme que C411Detail,
 * pour un affichage identique dans la fiche Catalogue).
 * La fiche v3x.club exige probablement un login web : en cas d'échec, les
 * infos TMDB (tmdbid exposé par l'API) prennent le relais côté fiche.
 */
export async function fetchV3XDetail(
  film: Pick<DiscoveryFilm, 'slug' | 'name' | 'detailsUrl'>,
  apiKey = '',
): Promise<C411Detail> {
  const techTags = parseTechTags(film.name);
  const pageUrl = (film.detailsUrl ?? '').trim() || null;
  const cacheKey = pageUrl || `slug:${film.slug}`;
  const now = Date.now();
  await loadV3XDetailCache();
  const hit = v3xDetailCache.get(cacheKey);
  if (hit && now - hit.at < V3X_DETAIL_TTL) return hit.data;
  let synopsis: string | null = null;
  let techDetails: string | null = null;
  if (pageUrl && /^https?:\/\/(www\.)?v3x\.(club|tw)\//i.test(pageUrl)) {
    try {
      const html = await fetchV3XPageHtml(pageUrl, apiKey.trim());
      synopsis = extractTrackerPageSynopsis(html);
      techDetails = extractTrackerPageTech(html);
    } catch {
      /* repli : tags du nom + infos TMDB côté fiche */
    }
  }
  const data: C411Detail = { synopsis, techDetails, techTags, pageUrl };
  v3xDetailCache.set(cacheKey, { at: now, data });
  if (v3xDetailCache.size > V3X_DETAIL_MAX) {
    const first = v3xDetailCache.keys().next();
    if (!first.done) v3xDetailCache.delete(first.value);
  }
  saveV3XDetailCache();
  return data;
}
