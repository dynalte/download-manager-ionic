/**
 * Découverte de films via l'API TR4KER (mêmes appels que le front
 * tr4ker.net, extraits de son bundle public : pas de doc officielle).
 *
 * Listing : GET /api/torrents?cat=films&period=day|week|month (+q=... en recherche)
 *           (`period` omis = tout ; `cat` omis = toutes catégories —
 *           comme le front tr4ker.net qui n'envoie `period` que si != 'all').
 *           Slugs exacts (GET /api/public/categories) : `films`, `series`,
 *           `livres`, `livres-audio`, `audio`, ...
 *   Variantes : tri `recent` (défaut sans q), `size`, `name`.
 * Réponse : { torrents: [...], total, total_capped }.
 * Item utile : slug, name, size_bytes, seeders, leechers, created_at,
 *   cat_slug, year, tmdb_id, is_freeleech.
 * Fichier : GET /api/torrents/<slug>/download -> .torrent (bencode, `d...`).
 */
import { CapacitorHttp } from '@capacitor/core';

export type FilmsPeriod = 'day' | 'week' | 'month' | 'all';

export const FILMS_PERIODS: Array<{ key: FilmsPeriod; label: string }> = [
  { key: 'day', label: 'Jour' },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'all', label: 'Tout' },
];

/** Portées de recherche de l'onglet Films. */
export type DiscoveryCategoryKey = 'films' | 'series' | 'books' | 'audiobooks';

export interface DiscoveryCategory {
  key: DiscoveryCategoryKey;
  label: string;
  /** Slug `cat` serveur (slugs exacts : parents `series`/`livres` inclus,
   *  `livres-audio` = sous-catégorie directe). */
  cat: string | null;
  /** Dossier Transmission de destination. */
  folder: 'films' | 'series' | 'livres';
  /** Allociné ne couvre que films + séries (notes, affiches, synopsis). */
  allocine: boolean;
  /** Mots-clés (normalisés) des libellés de catégorie TR4KER (filet de sécurité). */
  matchWords: string[];
  /** Mots qui excluent un item du filtre (ex : pas d'audio dans Livres). */
  excludeWords?: string[];
}

export const DISCOVERY_CATEGORIES: DiscoveryCategory[] = [
  { key: 'films', label: 'Films', cat: 'films', folder: 'films', allocine: true, matchWords: [] },
  { key: 'series', label: 'Séries', cat: 'series', folder: 'series', allocine: true, matchWords: ['serie', 'emission', 'anime'] },
  { key: 'books', label: 'Livres', cat: 'livres', folder: 'livres', allocine: false, matchWords: ['livre', 'ebook', 'book', 'roman', 'bd', 'manga', 'comics', 'presse', 'magazine', 'document', 'jdr'], excludeWords: ['audio'] },
  { key: 'audiobooks', label: 'Audiobooks', cat: 'livres-audio', folder: 'livres', allocine: false, matchWords: ['audio'] },
];

export function discoveryCategory(key: string): DiscoveryCategory {
  return DISCOVERY_CATEGORIES.find((c) => c.key === key) ?? DISCOVERY_CATEGORIES[0];
}

function normWord(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Filtre client par catégorie (filet de sécurité si le serveur ignore `cat`
 * et renvoie du mixte). Retourne la liste brute si le filtre élimine tout
 * (on préfère afficher plutôt que masquer).
 */
export function filterByDiscoveryCategory(items: DiscoveryFilm[], key: DiscoveryCategoryKey): DiscoveryFilm[] {
  const cat = discoveryCategory(key);
  if (cat.matchWords.length === 0) return items;
  const wanted = cat.matchWords.map(normWord);
  const excluded = (cat.excludeWords ?? []).map(normWord);
  const kept = items.filter((f) => {
    const hay = normWord([f.category ?? '', f.catSlug ?? ''].join(' '));
    if (excluded.some((w) => hay.includes(w))) return false;
    return wanted.some((w) => hay.includes(w));
  });
  return kept.length > 0 ? kept : items;
}

export interface DiscoveryFilm {
  slug: string;
  name: string;
  /** Titre nettoyé pour affichage / Allociné. */
  title: string;
  year?: string;
  seeders: number;
  leechers: number;
  sizeBytes: number;
  addedAt?: Date;
  category?: string;
  /** Slug de catégorie brut (filtre client séries/livres/audiobooks). */
  catSlug?: string;
  isFreeleech: boolean;
  tmdbId?: number;
}

export class DiscoveryError extends Error {}

const API_BASE = 'https://tr4ker.net/api/torrents';

interface RawItem {
  slug?: string;
  name?: string;
  size_bytes?: number;
  seeders?: number;
  leechers?: number;
  created_at?: string;
  cat_slug?: string;
  sub_cat_name?: string;
  parent_cat_name?: string;
  year?: string | number;
  tmdb_id?: number;
  is_freeleech?: boolean;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Année = premier millésime 4 chiffres du nom (les teams sont après). */
export function extractYear(name: string): string | undefined {
  const m = /(?<![0-9])(19\d{2}|20\d{2})(?![0-9])/.exec(name.replace(/[._-]+/g, ' '));
  return m ? m[1] : undefined;
}

/** Titre lisible : coupe au millésime / tag technique, nettoie séparateurs. */
export function cleanTitle(name: string): string {
  const spaced = name.replace(/[._]+/g, ' ');
  const cut = spaced.split(/\(\d{4}\)|\bS\d{1,2}E\d{1,3}\b/i)[0];
  const yearCut = cut.split(/(?<!\d)(?:19\d{2}|20\d{2})(?!\d)/)[0];
  return yearCut.replace(/\s{2,}/g, ' ').replace(/[-_:]+$/g, '').trim() || spaced.trim();
}

function normalizeItem(raw: RawItem): DiscoveryFilm | null {
  const slug = String(raw.slug ?? '').trim();
  const name = String(raw.name ?? '').trim();
  if (!slug || !name) return null;
  let addedAt: Date | undefined;
  if (raw.created_at) {
    const d = new Date(raw.created_at);
    if (!Number.isNaN(d.getTime())) addedAt = d;
  }
  const yearRaw = raw.year != null && String(raw.year).trim() !== '' ? String(raw.year).trim() : extractYear(name);
  return {
    slug,
    name,
    title: cleanTitle(name),
    year: yearRaw,
    seeders: toNumber(raw.seeders),
    leechers: toNumber(raw.leechers),
    sizeBytes: toNumber(raw.size_bytes),
    addedAt,
    category: raw.sub_cat_name || raw.parent_cat_name || raw.cat_slug || undefined,
    catSlug: raw.cat_slug || undefined,
    isFreeleech: !!raw.is_freeleech,
    tmdbId: typeof raw.tmdb_id === 'number' && raw.tmdb_id > 0 ? raw.tmdb_id : undefined,
  };
}

export interface FetchFilmsOptions {
  period?: FilmsPeriod;
  query?: string;
  limit?: number;
  page?: number;
  /** Tri serveur : `seeders` = popularité, `recent` = nouveautés. */
  sort?: 'seeders' | 'recent';
  /**
   * Filtre catégorie serveur. Défaut 'films' (comportement historique).
   * `null` = aucun filtre (recherche/listing toutes catégories).
   */
  cat?: string | null;
}

export interface FetchFilmsResult {
  films: DiscoveryFilm[];
  total: number;
  capped: boolean;
}

async function getJSON(url: string, apiKey: string, params: Record<string, string>): Promise<unknown> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url,
      params,
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 30000,
    });
  } catch (e) {
    throw new DiscoveryError(`TR4KER injoignable (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new DiscoveryError('Clé API TR4KER refusée (vérifie-la dans Réglages).');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DiscoveryError(`TR4KER : HTTP ${res.status}.`);
  }
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DiscoveryError('Réponse TR4KER illisible.');
  }
}

/**
 * Les x derniers films, triés par popularité (seeders serveur).
 * Filtres période : jour / semaine / mois / tout (paramètre `period` natif).
 */
export async function fetchFilms(apiKey: string, opts: FetchFilmsOptions = {}): Promise<FetchFilmsResult> {
  const { period = 'week', query = '', limit = 25, page = 1, sort = 'seeders', cat = 'films' } = opts;
  if (!apiKey.trim()) throw new DiscoveryError('Clé API TR4KER manquante (Réglages).');
  const params: Record<string, string> = {
    sort,
    limit: String(Math.max(1, Math.min(100, limit))),
    page: String(Math.max(1, page)),
  };
  if (cat !== null && cat.trim() !== '') params.cat = cat.trim();
  // Comme le front tr4ker.net : `period` seulement si != 'all'.
  if (period !== 'all') params.period = period;
  const q = query.trim();
  if (q) params.q = q;
  const parsed = (await getJSON(API_BASE, apiKey, params)) as {
    torrents?: RawItem[];
    total?: number;
    total_capped?: boolean;
    error?: unknown;
    message?: unknown;
  };
  if (parsed.error) throw new DiscoveryError(`TR4KER : ${String(parsed.message ?? parsed.error)}`);
  const films: DiscoveryFilm[] = [];
  for (const item of parsed.torrents ?? []) {
    const f = normalizeItem(item);
    if (f) films.push(f);
  }
  // Sécurité : tri local par seeders (popularité) si le serveur ne l'a pas fait.
  if (sort === 'seeders') films.sort((a, b) => b.seeders - a.seeders);
  return {
    films,
    total: typeof parsed.total === 'number' ? parsed.total : films.length,
    capped: !!parsed.total_capped,
  };
}

/**
 * Recherche générique (toutes catégories : films, séries...) par titre.
 * Utilisée par les suggestions IA : pas de filtre `cat`, tri seeders local.
 */
export async function searchTorrents(apiKey: string, query: string, limit = 15): Promise<DiscoveryFilm[]> {
  if (!apiKey.trim()) throw new DiscoveryError('Clé API TR4KER manquante (Réglages).');
  const q = query.trim();
  if (!q) throw new DiscoveryError('Recherche vide.');
  const parsed = (await getJSON(API_BASE, apiKey, {
    q,
    limit: String(Math.max(1, Math.min(25, limit))),
    search_in: 'title',
    sort: 'seeders',
  })) as { torrents?: RawItem[]; error?: unknown; message?: unknown };
  if (parsed.error) throw new DiscoveryError(`TR4KER : ${String(parsed.message ?? parsed.error)}`);
  const out: DiscoveryFilm[] = [];
  for (const item of parsed.torrents ?? []) {
    const f = normalizeItem(item);
    if (f) out.push(f);
  }
  out.sort((a, b) => b.seeders - a.seeders);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Télécharge le .torrent d'un slug (vérifié bencode). */
export async function downloadFilmTorrent(slug: string, apiKey: string): Promise<Uint8Array> {  let res;
  try {
    res = await CapacitorHttp.get({
      url: `${API_BASE}/${encodeURIComponent(slug)}/download`,
      headers: { Accept: 'application/x-bittorrent,*/*', 'X-Api-Key': apiKey },
      responseType: 'arraybuffer',
      connectTimeout: 15000,
      readTimeout: 60000,
    });
  } catch (e) {
    throw new DiscoveryError(`Téléchargement .torrent impossible (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DiscoveryError(`Téléchargement .torrent : HTTP ${res.status}.`);
  }
  const bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data ?? []);
  if (bytes.length === 0) throw new DiscoveryError('.torrent vide reçu.');
  if (bytes[0] !== 100) throw new DiscoveryError('Réponse inattendue (pas un .torrent).');
  return bytes;
}

export interface TorrentDetail {
  description?: string;
}

/** Fiche torrent (descriptif uploader, repli quand Allociné n'a pas de synopsis). */
export async function fetchTorrentDetail(slug: string, apiKey: string): Promise<TorrentDetail> {  const parsed = (await getJSON(`${API_BASE}/${encodeURIComponent(slug)}`, apiKey, {})) as {
    description?: unknown;
    error?: unknown;
    message?: unknown;
  };
  if (parsed.error) throw new DiscoveryError(`TR4KER : ${String(parsed.message ?? parsed.error)}`);
  const raw = String(parsed.description ?? '').trim();
  if (!raw) return {};
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
  return text ? { description: text } : {};
}

function normTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 2 && !/^(19|20)\d{2}$/.test(t));
}

/** Le nom candidat désigne-t-il le même film (titre + millésime) ? */
function isSameMovie(film: DiscoveryFilm, name: string): boolean {
  const tokens = normTokens(film.title);
  if (tokens.length === 0) return false;
  const n = ` ${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (!tokens.every((t) => n.includes(` ${t} `) || n.includes(t))) return false;
  if (film.year) {
    const y = extractYear(name);
    if (y && y !== film.year) return false; // remake/homonyme d'une autre année
  }
  return true;
}

function isTooBroadMessage(msg: string): boolean {
  return /trop longue|trop large|affinez/i.test(msg);
}

/**
 * Autres formats du même film (1080p, 4K, WEB-DL...) : recherche par titre
 * (cat=films), filtrée titre + millésime, triée par seeders.
 */
export async function fetchSameMovieTorrents(film: DiscoveryFilm, apiKey: string): Promise<DiscoveryFilm[]> {
  const q = film.title.trim();
  if (!q) throw new DiscoveryError('Titre inexploitable pour la recherche.');
  const attempts: Record<string, string>[] = [
    { q, limit: '25', search_in: 'title', sort: 'seeders' },
    { q, limit: '10', search_in: 'title', sort: 'recent' },
  ];
  let lastErr: unknown = null;
  for (const extra of attempts) {
    try {
      const parsed = (await getJSON(API_BASE, apiKey, { cat: 'films', ...extra })) as {
        torrents?: RawItem[];
        error?: unknown;
        message?: unknown;
      };
      if (parsed.error) throw new DiscoveryError(`TR4KER : ${String(parsed.message ?? parsed.error)}`);
      const out: DiscoveryFilm[] = [];
      for (const item of parsed.torrents ?? []) {
        const f = normalizeItem(item);
        if (!f || f.slug === film.slug) continue;
        if (!isSameMovie(film, f.name)) continue;
        out.push(f);
      }
      out.sort((a, b) => b.seeders - a.seeders);
      return out;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isTooBroadMessage(msg)) throw e;
      // Titre trop courant : resserre (tri récent + page courte).
    }
  }
  throw lastErr instanceof Error ? lastErr : new DiscoveryError('Recherche des autres formats impossible.');
}

// ---------- Slugs déjà envoyés (badge "Ajouté") ----------

const ADDED_KEY = 'films_added_slugs_v1';

export function loadAddedSlugs(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(ADDED_KEY) ?? '[]') as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function markSlugAdded(slug: string): void {
  try {
    const arr = JSON.parse(localStorage.getItem(ADDED_KEY) ?? '[]') as string[];
    const set = new Set(Array.isArray(arr) ? arr : []);
    set.add(slug);
    localStorage.setItem(ADDED_KEY, JSON.stringify([...set].slice(-500)));
  } catch {
    /* ignore */
  }
}

/** "8.4 Go" / "750 Mo" (fr). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '?';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}
