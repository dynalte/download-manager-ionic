/**
 * Recherche de torrents via C411 (c411.org, tracker privé FR), en plus de
 * TR4KER (voir tr4kerDiscovery.ts).
 *
 * API utilisée : Torznab (standard newznab, aussi consommé par Sonarr/Radarr
 * et le plugin qBittorrent c411) :
 *   GET https://c411.org/api/torznab?apikey=<CLE>&t=search&q=...&cat=...&limit=100
 * Réponse : flux RSS/XML, un <item> par torrent :
 *   title, link (fiche), enclosure@url (.torrent, clé incluse),
 *   pubDate, size, torznab:attr (category, infohash, seeders, peers, grabs...).
 * Clé API : profil c411.org (même principe que la clé TR4KER dans Réglages).
 * Clé invalide -> HTTP 401. IDs catégories : voir C411_CATEGORY_BY_KEY
 * (2000 films, 5000 séries, 7000 ebooks, 3000 audio dont 3030 audiobooks).
 *
 * Accès : via le serveur PHP perso par défaut (actions c411_search /
 * c411_download de api-download-manager.php), car l'accès direct est filtré
 * (403 hors navigateur). Modes Réglages : proxy (défaut), direct, auto.
 */
import { CapacitorHttp } from '@capacitor/core';
import {
  cleanTitle,
  extractYear,
  searchTorrents as searchTr4ker,
  downloadFilmTorrent,
  type DiscoveryCategoryKey,
  type DiscoveryFilm,
} from './tr4kerDiscovery';
import { settings } from './settings';
import { isServerConfigured, serverApi } from './serverApi';

export const C411_SITE_URL = 'https://c411.org/';
export const C411_TORZNAB_URL = 'https://c411.org/api/torznab';

export class C411Error extends Error {
  /** Échec réseau (connexion impossible) : éligible au repli proxy. */
  isNetworkFailure = false;
}

function networkError(msg: string): C411Error {
  const err = new C411Error(msg);
  err.isNetworkFailure = true;
  return err;
}

/**
 * Normalise la clé collée : espaces/retours chariot parasites supprimés.
 * Détecte l'erreur classique « URL Torznab complète collée au lieu de la
 * clé seule » (donne un 401 garanti) avec un message explicite.
 */
function sanitizeApiKey(apiKey: string): string {
  const key = apiKey.replace(/\s+/g, '');
  if (!key) throw new C411Error("Colle ta clé API C411 d'abord (profil c411.org).");
  if (/:\/\//.test(key) || /\/api\//i.test(key)) {
    throw new C411Error(
      'On dirait une URL Torznab complète : colle uniquement la clé (le long code seul, sans https://…), générée sur c411.org/user/integrations.',
    );
  }
  return key;
}

/** Torznab en direct (client -> c411.org). Lève (réseau) ou renvoie {status, raw}. */
async function torznabDirect(params: Record<string, string>): Promise<{ status: number; raw: string }> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url: C411_TORZNAB_URL,
      params,
      headers: { Accept: 'application/rss+xml,application/xml,text/xml' },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 30000,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw networkError(
      `C411 injoignable (réseau : ${raw}). Site en maintenance, connexion coupée ou domaine bloqué (AdGuard/VPN/DNS) ?`,
    );
  }
  return { status: res.status, raw: typeof res.data === 'string' ? res.data : '' };
}

/**
 * Torznab via le serveur PHP perso (action=c411_search) : sorties
 * https://c411.org uniquement, clé transmise par requête (jamais stockée).
 */
async function torznabViaProxy(params: Record<string, string>, apiKey: string): Promise<{ status: number; raw: string }> {
  if (!isServerConfigured()) {
    throw new C411Error('Serveur perso non configuré (Réglages > Synchro vus) : proxy C411 impossible.');
  }
  let data: { status?: unknown; xml?: unknown };
  try {
    data = (await serverApi('c411_search', { ...params, apikey: apiKey })) as { status?: unknown; xml?: unknown };
  } catch (e) {
    throw new C411Error(`Proxy C411 : ${e instanceof Error ? e.message : String(e)}`);
  }
  const status = typeof data.status === 'number' ? data.status : 0;
  const raw = typeof data.xml === 'string' ? data.xml : '';
  if (status === 0 || !raw) throw new C411Error('Proxy C411 : réponse vide (action c411_search déployée côté PHP ?).');
  return { status, raw };
}

/**
 * Routage Torznab selon Réglages (proxy par défaut : tout passe par le PHP ;
 * direct ; auto = direct puis proxy en secours réseau).
 * Les erreurs de clé (401/403) ne basculent jamais de voie.
 */
async function torznabRaw(params: Record<string, string>, apiKey: string): Promise<{ status: number; raw: string }> {
  const mode = settings.c411ProxyMode;
  if (mode === 'proxy') return torznabViaProxy(params, apiKey);
  try {
    return await torznabDirect(params);
  } catch (e) {
    if (mode === 'auto' && e instanceof C411Error && e.isNetworkFailure && isServerConfigured()) {
      return torznabViaProxy(params, apiKey);
    }
    throw e;
  }
}

function checkTorznabStatus(status: number, raw: string): string {
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 401) {
    throw new C411Error(
      `Clé API C411 refusée (HTTP 401${snippet ? ` : ${snippet}` : ''}). À générer sur c411.org/user/integrations, page « Intégrations API », puis coller dans Réglages.`,
    );
  }
  if (status === 403) {
    throw new C411Error(
      `Accès C411 bloqué (HTTP 403${snippet ? ` : ${snippet}` : ''}) : filtrage anti-bot de l'accès direct. Passe par le proxy (Réglages > C411 > Proxy).`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new C411Error(`C411 : HTTP ${status}.`);
  }
  if (/<html[\s>]/i.test(raw.slice(0, 500))) {
    throw new C411Error('C411 indisponible (maintenance du site ?).');
  }
  return raw;
}

/** Catégorie Torznab C411 par portée de recherche du Catalogue. */
export const C411_CATEGORY_BY_KEY: Record<DiscoveryCategoryKey, string> = {
  films: '2000',
  series: '5000',
  books: '7000',
  audiobooks: '3030',
};

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Préfixe numérique Torznab -> slug compatible avec le filtre client
 * filterByDiscoveryCategory (mots-clés FR).
 */
function catSlugFor(numCat: string): string {
  const n = parseInt(numCat, 10);
  if (n >= 2000 && n < 3000) return 'films';
  if (n >= 5000 && n < 6000) return 'series';
  if (n === 3030) return 'livres-audio';
  if (n >= 3000 && n < 4000) return 'audio';
  if (n >= 7000 && n < 8000) return 'livres';
  return 'autre';
}

function catLabelFor(numCat: string): string {
  const slug = catSlugFor(numCat);
  if (slug === 'films') return 'Films & Vidéos';
  if (slug === 'series') return 'Séries TV';
  if (slug === 'livres-audio') return 'Audiobooks';
  if (slug === 'audio') return 'Musique';
  if (slug === 'livres') return 'Ebooks';
  return `Cat. ${numCat}`;
}

function textOf(parent: Element, tag: string): string {
  const el = parent.getElementsByTagName(tag)[0];
  return el?.textContent?.trim() ?? '';
}

/** Attributs torznab:attr d'un <item> (insensible au préfixe de namespace). */
function torznabAttrs(item: Element): { values: Record<string, string>; categories: string[] } {
  const values: Record<string, string> = {};
  const categories: string[] = [];
  const all = item.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName !== 'attr') continue;
    const name = (el.getAttribute('name') ?? '').toLowerCase();
    const value = el.getAttribute('value') ?? '';
    if (!name) continue;
    if (name === 'category') {
      if (value) categories.push(value);
    } else {
      values[name] = value;
    }
  }
  return { values, categories };
}

function normalizeItem(item: Element): DiscoveryFilm | null {
  const name = textOf(item, 'title');
  if (!name) return null;
  const { values, categories } = torznabAttrs(item);
  const numCat = categories[0] ?? '';
  const infohash = (values['infohash'] ?? '').trim().toLowerCase();
  const enclosure = item.getElementsByTagName('enclosure')[0];
  const downloadUrl = enclosure?.getAttribute('url')?.trim() ?? '';
  // Sans URL de téléchargement, l'item est inexploitable (pas d'envoi Transmission).
  if (!downloadUrl) return null;
  const sizeEl = toNumber(textOf(item, 'size')) || toNumber(values['size']);
  const sizeAttr = enclosure ? toNumber(enclosure.getAttribute('length')) : 0;
  let addedAt: Date | undefined;
  const pubDate = textOf(item, 'pubDate');
  if (pubDate) {
    const d = new Date(pubDate);
    if (!Number.isNaN(d.getTime())) addedAt = d;
  }
  const slug = infohash
    ? `c411:${infohash}`
    : `c411:noid:${sizeEl || sizeAttr}:${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
  return {
    slug,
    name,
    title: cleanTitle(name),
    year: extractYear(name),
    seeders: toNumber(values['seeders']),
    leechers: toNumber(values['peers']),
    sizeBytes: sizeEl > 0 ? sizeEl : sizeAttr,
    addedAt,
    category: `C411 · ${catLabelFor(numCat)}`,
    catSlug: catSlugFor(numCat),
    isFreeleech: false,
    source: 'c411',
    downloadUrl,
  };
}

function parseTorznab(xml: string): DiscoveryFilm[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    throw new C411Error('Réponse C411 illisible.');
  }
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new C411Error('Réponse C411 illisible.');
  }
  const errEl = doc.getElementsByTagName('error')[0];
  if (errEl) {
    const desc = errEl.getAttribute('description') ?? errEl.textContent ?? '';
    throw new C411Error(`C411 : ${desc.trim() || `erreur ${errEl.getAttribute('code') ?? ''}`.trim()}.`);
  }
  const items = doc.getElementsByTagName('item');
  const out: DiscoveryFilm[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const f = normalizeItem(items[i]);
      if (f) out.push(f);
    } catch {
      /* item ignoré */
    }
  }
  return out;
}

export interface SearchC411Options {
  /** Portée Catalogue (filtre `cat` serveur). Omis = toutes catégories. */
  category?: DiscoveryCategoryKey | null;
  limit?: number;
}

export interface LatestC411Options {
  /** Portée Catalogue (filtre `cat` serveur). Omis = toutes catégories. */
  category?: DiscoveryCategoryKey | null;
  limit?: number;
  /** Ne garder que les items ajoutés après ce timestamp (ms). 0 = tout. */
  sinceMs?: number;
}

async function torznabSearchItems(
  key: string,
  opts: { q?: string; cat?: DiscoveryCategoryKey | null; limit?: number },
): Promise<DiscoveryFilm[]> {
  const { q = '', cat = null, limit = 50 } = opts;
  const params: Record<string, string> = {
    apikey: key,
    t: 'search',
    limit: String(Math.max(1, Math.min(100, limit))),
  };
  const trimmed = q.trim();
  if (trimmed) params.q = trimmed;
  if (cat) params.cat = C411_CATEGORY_BY_KEY[cat];
  const { status, raw } = await torznabRaw(params, key);
  return parseTorznab(checkTorznabStatus(status, raw));
}

/**
 * Recherche Torznab C411 par titre. Si le filtre catégorie ne renvoie rien,
 * rejoue sans filtre (le serveur peut exiger des IDs feuilles exacts).
 */
export async function searchC411(apiKey: string, query: string, opts: SearchC411Options = {}): Promise<DiscoveryFilm[]> {
  const key = sanitizeApiKey(apiKey);
  const q = query.trim();
  if (!q) throw new C411Error('Recherche vide.');
  const { category = null, limit = 50 } = opts;

  const withCat = category ? await torznabSearchItems(key, { q, cat: category, limit }) : [];
  if (category && withCat.length === 0) return torznabSearchItems(key, { q, limit });
  return category ? withCat : torznabSearchItems(key, { q, limit });
}

/**
 * Dernières sorties C411 (Torznab `t=search` sans `q` = tri antéchronologique),
 * pour les Nouveautés du Catalogue. Filtre période côté client (pubDate).
 */
export async function fetchLatestC411(apiKey: string, opts: LatestC411Options = {}): Promise<DiscoveryFilm[]> {
  const key = sanitizeApiKey(apiKey);
  const { category = null, limit = 100, sinceMs = 0 } = opts;
  let items = await torznabSearchItems(key, { cat: category, limit });
  if (category && items.length === 0) items = await torznabSearchItems(key, { limit });
  const fresh = sinceMs > 0 ? items.filter((f) => !f.addedAt || f.addedAt.getTime() >= sinceMs) : items;
  fresh.sort((a, b) => b.seeders - a.seeders);
  return fresh;
}

function checkCapsResponse(status: number, raw: string): void {
  checkTorznabStatus(status, raw);
  if (!/<caps[\s>]/i.test(raw.slice(0, 2000))) {
    throw new C411Error('Réponse C411 inattendue (pas du Torznab).');
  }
}

/**
 * Test de connexion + clé (Réglages > Tester) : `t=caps` léger, sans recherche.
 * Teste le direct puis le proxy (si serveur configuré) et résume les deux.
 * Affiche une empreinte de la clé envoyée (longueur + fin masquée) pour
 * comparer avec la clé testée dans Safari.
 */
export async function testC411Connection(apiKey: string): Promise<string> {
  const key = sanitizeApiKey(apiKey);
  const print = `clé ${key.length} car., …${key.slice(-4)}`;
  const params = { apikey: key, t: 'caps' };
  let directErr: string | null = null;
  try {
    const { status, raw } = await torznabDirect(params);
    checkCapsResponse(status, raw);
  } catch (e) {
    directErr = e instanceof Error ? e.message : String(e);
  }
  let proxyState = 'proxy non configuré (Réglages > Synchro vus)';
  if (isServerConfigured()) {
    try {
      const { status, raw } = await torznabViaProxy(params, key);
      checkCapsResponse(status, raw);
      proxyState = 'proxy OK';
    } catch (e) {
      proxyState = `proxy KO (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  if (directErr && proxyState !== 'proxy OK') {
    throw new C411Error(`${directErr} [${print}]`);
  }
  const via = !directErr ? 'direct' : 'proxy (direct en échec)';
  return `C411 OK via ${via} : connexion et clé valides. [${print}] [${proxyState}]`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** .torrent en direct (client -> URL enclosure c411.org). */
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
    const body = typeof res.data === 'string' ? res.data : '';
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new C411Error(
      `Clé API C411 refusée (HTTP 401${snippet ? ` : ${snippet}` : ''}). À générer sur c411.org/user/integrations, page « Intégrations API », puis coller dans Réglages.`,
    );
  }
  if (res.status === 403) {
    throw new C411Error("Accès C411 bloqué (HTTP 403) : filtrage anti-bot de l'accès direct. Passe par le proxy (Réglages > C411 > Proxy).");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new C411Error(`Téléchargement .torrent : HTTP ${res.status}.`);
  }
  return typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data ?? []);
}

/** .torrent via le serveur PHP perso (action=c411_download, base64). */
async function downloadViaProxy(url: string, apiKey: string): Promise<Uint8Array> {
  if (!isServerConfigured()) {
    throw new C411Error('Serveur perso non configuré (Réglages > Synchro vus) : proxy C411 impossible.');
  }
  let data: { status?: unknown; data_base64?: unknown };
  try {
    data = (await serverApi('c411_download', { url, apikey: apiKey })) as { status?: unknown; data_base64?: unknown };
  } catch (e) {
    throw new C411Error(`Proxy C411 : ${e instanceof Error ? e.message : String(e)}`);
  }
  const status = typeof data.status === 'number' ? data.status : 0;
  if (status === 401) {
    throw new C411Error("Clé API C411 refusée par c411.org (via proxy). À générer sur c411.org/user/integrations, page « Intégrations API », puis coller dans Réglages.");
  }
  if (status === 403) {
    throw new C411Error("Accès C411 bloqué par c411.org (HTTP 403, via proxy) : filtrage côté tracker (IP serveur ? incident ?).");
  }
  if (status < 200 || status >= 300) {
    throw new C411Error(`Téléchargement .torrent : HTTP ${status}.`);
  }
  const b64 = typeof data.data_base64 === 'string' ? data.data_base64 : '';
  if (!b64) throw new C411Error('Proxy C411 : .torrent vide (action c411_download déployée côté PHP ?).');
  return base64ToBytes(b64);
}

/** Télécharge le .torrent d'un résultat C411 (vérifié bencode). */
export async function downloadC411Torrent(film: Pick<DiscoveryFilm, 'downloadUrl'>, apiKey: string): Promise<Uint8Array> {
  const key = sanitizeApiKey(apiKey);
  let url = (film.downloadUrl ?? '').trim();
  if (!url) throw new C411Error('Lien de téléchargement C411 manquant.');
  // L'enclosure Torznab embarque normalement la clé ; filet de sécurité.
  if (!/[?&]apikey=/i.test(url)) {
    url += `${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}`;
  }
  const mode = settings.c411ProxyMode;
  let bytes: Uint8Array;
  if (mode === 'proxy') {
    bytes = await downloadViaProxy(url, key);
  } else {
    try {
      bytes = await downloadDirect(url);
    } catch (e) {
      if (mode === 'auto' && e instanceof C411Error && e.isNetworkFailure && isServerConfigured()) {
        bytes = await downloadViaProxy(url, key);
      } else {
        throw e;
      }
    }
  }
  if (bytes.length === 0) throw new C411Error('.torrent vide reçu.');
  if (bytes[0] !== 100) throw new C411Error('Réponse inattendue (pas un .torrent).');
  return bytes;
}

// ---------- Recherche fusionnée TR4KER + C411 ----------

export interface SourceKeys {
  tr4kerApiKey: string;
  c411ApiKey: string;
}

/**
 * Clés des sources activées dans Réglages (interrupteurs TR4KER/C411).
 * Une source désactivée ou sans clé vaut '' et est ignorée des recherches.
 */
export function activeSourceKeys(): SourceKeys {
  return {
    tr4kerApiKey: settings.tr4kerEnabled ? settings.tr4kerApiKey : '',
    c411ApiKey: settings.c411Enabled ? settings.c411ApiKey : '',
  };
}

export interface SearchAllOptions {
  /** Portée Catalogue (appliquée aux deux sources). Omise = toutes catégories. */
  category?: DiscoveryCategoryKey | null;
  /** Plafond par source. */
  limit?: number;
}

export interface SearchAllResult {
  films: DiscoveryFilm[];
  /** Sources effectivement interrogées. */
  sources: Array<'tr4ker' | 'c411'>;
  /** Erreurs des sources en échec (résultats partiels quand l'autre a répondu). */
  partialErrors: string[];
}

/**
 * Recherche un titre sur TR4KER et/ou C411 (selon les clés renseignées),
 * fusionnée et triée par seeders. Au moins une source doit répondre ;
 * l'échec d'une source n'annule pas les résultats de l'autre.
 */
export async function searchAllSources(query: string, keys: SourceKeys, opts: SearchAllOptions = {}): Promise<SearchAllResult> {
  const q = query.trim();
  if (!q) throw new C411Error('Recherche vide.');
  const { category = null, limit = 25 } = opts;
  const jobs: Array<Promise<DiscoveryFilm[]>> = [];
  const sources: Array<'tr4ker' | 'c411'> = [];
  if (keys.tr4kerApiKey.trim()) {
    sources.push('tr4ker');
    jobs.push(searchTr4ker(keys.tr4kerApiKey, q, limit));
  }
  if (keys.c411ApiKey.trim()) {
    sources.push('c411');
    jobs.push(searchC411(keys.c411ApiKey, q, { category, limit }));
  }
  if (jobs.length === 0) throw new C411Error('Clé API TR4KER ou C411 manquante (Réglages).');
  const settled = await Promise.allSettled(jobs);
  const films: DiscoveryFilm[] = [];
  const partialErrors: string[] = [];
  const seen = new Set<string>();
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const f of r.value) {
        if (seen.has(f.slug)) continue;
        seen.add(f.slug);
        films.push(f);
      }
    } else {
      const label = sources[i] === 'c411' ? 'C411' : 'TR4KER';
      partialErrors.push(`${label} : ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  if (films.length === 0 && partialErrors.length > 0) {
    throw new Error(partialErrors.join(' / '));
  }
  films.sort((a, b) => b.seeders - a.seeders);
  return { films, sources, partialErrors };
}

/** Télécharge le .torrent d'un résultat quelle que soit sa source. */
export async function downloadFromSource(film: DiscoveryFilm, keys: SourceKeys): Promise<Uint8Array> {
  if (film.source === 'c411') return downloadC411Torrent(film, keys.c411ApiKey);
  return downloadFilmTorrent(film.slug, keys.tr4kerApiKey);
}
