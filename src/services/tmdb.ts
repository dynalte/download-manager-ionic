/**
 * Affiches via l'API officielle TMDB (themoviedb.org, clé gratuite
 * « API Read Access Token » ou « API Key (v3 auth) »).
 *
 * Pourquoi : les affiches Allociné (og:image des fiches, voir allocine.ts)
 * sont bloquées hors navigateur (403 DataDome sur l'autocomplete, CORS
 * en Web) — le Catalogue se retrouve sans visuels. TMDB est fait pour ça :
 * JSON, CORS OK (Web + natif via CapacitorHttp), cache 30 jours.
 *
 * Usage : repli poster quand Allociné ne renvoie rien (notes/synopsis
 * Allociné conservées quand elles existent). Voir FilmsTab.
 */
import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

export interface TmdbPoster {
  title: string;
  year: string;
  /** https://image.tmdb.org/t/p/w500/… (null si aucun visuel). */
  posterURL: string | null;
}

export class TmdbError extends Error {}

const TMDB_TTL = 30 * 24 * 3600 * 1000;
const TMDB_CACHE_KEY = 'tmdb-poster-cache-v1';
const TMDB_CACHE_MAX = 500;

const cache = new Map<string, { at: number; data: TmdbPoster | null }>();
let cacheLoaded = false;

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const { value } = await Preferences.get({ key: TMDB_CACHE_KEY });
    if (!value) return;
    const obj = JSON.parse(value) as Record<string, { at: number; data: TmdbPoster | null }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') cache.set(k, v);
    }
  } catch {
    /* premier lancement */
  }
}

function saveCache(): void {
  try {
    const obj: Record<string, { at: number; data: TmdbPoster | null }> = {};
    for (const [k, v] of cache) obj[k] = v;
    void Preferences.set({ key: TMDB_CACHE_KEY, value: JSON.stringify(obj) }).catch(() => {});
  } catch {
    /* ignore */
  }
}

interface TmdbItem {
  poster_path?: string | null;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
}

/** Recherche brute (film ou série), premier résultat avec affiche. */
async function searchOnce(
  apiKey: string,
  kind: 'movie' | 'tv',
  query: string,
  year?: string | null,
): Promise<TmdbItem | null> {
  const params: Record<string, string> = {
    api_key: apiKey,
    query: query.trim(),
    language: 'fr-FR',
    include_adult: 'true',
  };
  const y = String(year ?? '').trim();
  if (/^(19|20)\d{2}$/.test(y)) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = y;
  let res;
  try {
    res = await CapacitorHttp.get({
      url: `https://api.themoviedb.org/3/search/${kind}`,
      params,
      headers: { Accept: 'application/json' },
      responseType: 'text',
      connectTimeout: 12000,
      readTimeout: 20000,
    });
  } catch (e) {
    throw new TmdbError(`TMDB injoignable (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new TmdbError('Clé TMDB refusée (vérifie-la dans Réglages).');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TmdbError(`TMDB : HTTP ${res.status}.`);
  }
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
  let parsed: { results?: TmdbItem[] };
  try {
    parsed = JSON.parse(raw) as { results?: TmdbItem[] };
  } catch {
    throw new TmdbError('Réponse TMDB illisible.');
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  // Préfère un résultat millésimé identique, sinon le premier avec affiche.
  const sameYear = results.find((r) => {
    const d = kind === 'movie' ? r.release_date : r.first_air_date;
    return !!r.poster_path && !!y && String(d ?? '').startsWith(y);
  });
  if (sameYear) return sameYear;
  return results.find((r) => !!r.poster_path) ?? null;
}

/**
 * Affiche TMDB d'un titre (+ millésime). `prefer` = type essayé d'abord,
 * l'autre en repli (les catégories Catalogue sont parfois mixtes).
 */
export async function fetchTmdbPoster(
  apiKey: string,
  title: string,
  year?: string | number | null,
  prefer: 'movie' | 'tv' = 'movie',
): Promise<TmdbPoster | null> {
  const key = apiKey.trim();
  if (!key) throw new TmdbError('Clé TMDB manquante (Réglages).');
  const q = title.trim();
  if (!q) throw new TmdbError('Titre vide.');
  const cacheKey = `${prefer}|${q.toLowerCase()}|${String(year ?? '').trim()}`;
  const now = Date.now();
  await loadCache();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < TMDB_TTL) return hit.data;
  const kinds: Array<'movie' | 'tv'> = prefer === 'movie' ? ['movie', 'tv'] : ['tv', 'movie'];
  let found: TmdbItem | null = null;
  for (const kind of kinds) {
    try {
      found = await searchOnce(key, kind, q, typeof year === 'number' ? String(year) : year);
    } catch {
      /* tentative suivante */
    }
    if (found) break;
  }
  const data: TmdbPoster | null = found?.poster_path
    ? {
        title: String(found.title ?? found.name ?? q),
        year: String((found.release_date ?? found.first_air_date ?? '').slice(0, 4)),
        posterURL: `https://image.tmdb.org/t/p/w500${found.poster_path}`,
      }
    : null;
  cache.set(cacheKey, { at: now, data });
  if (cache.size > TMDB_CACHE_MAX) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  saveCache();
  return data;
}

/** Test de connexion + clé (Réglages > Tester). */
export async function testTmdbConnection(apiKey: string): Promise<string> {
  const key = apiKey.trim();
  if (!key) throw new TmdbError("Colle ta clé TMDB d'abord (themoviedb.org/settings/api).");
  const found = await fetchTmdbPoster(key, 'Dune', '2021', 'movie');
  if (!found?.posterURL) throw new TmdbError('TMDB ne renvoie aucune affiche (clé invalide ?).');
  return `TMDB OK : affiche trouvée (« ${found.title} »).`;
}

// ---------- Fiche détaillée (repli quand la fiche C411 exige un login) ----------

export interface TmdbDetails {
  title: string;
  year: string;
  overview: string | null;
  /** Durée en minutes (film) ou par épisode (série). */
  runtimeMin: number | null;
  genres: string[];
  countries: string[];
  director: string | null;
  cast: string[];
  /** Note TMDB /10 (vote_average). */
  rating: number | null;
  votes: number | null;
  posterURL: string | null;
}

const DETAIL_TTL = 30 * 24 * 3600 * 1000;
const DETAIL_CACHE_KEY = 'tmdb-detail-cache-v1';
const DETAIL_CACHE_MAX = 300;

const detailCache = new Map<string, { at: number; data: TmdbDetails | null }>();
let detailCacheLoaded = false;

async function loadDetailCache(): Promise<void> {
  if (detailCacheLoaded) return;
  detailCacheLoaded = true;
  try {
    const { value } = await Preferences.get({ key: DETAIL_CACHE_KEY });
    if (!value) return;
    const obj = JSON.parse(value) as Record<string, { at: number; data: TmdbDetails | null }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') detailCache.set(k, v);
    }
  } catch {
    /* premier lancement */
  }
}

function saveDetailCache(): void {
  try {
    const obj: Record<string, { at: number; data: TmdbDetails | null }> = {};
    for (const [k, v] of detailCache) obj[k] = v;
    void Preferences.set({ key: DETAIL_CACHE_KEY, value: JSON.stringify(obj) }).catch(() => {});
  } catch {
    /* ignore */
  }
}

async function tmdbGet(apiKey: string, path: string, params: Record<string, string>): Promise<unknown> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url: `https://api.themoviedb.org/3${path}`,
      params: { api_key: apiKey, language: 'fr-FR', ...params },
      headers: { Accept: 'application/json' },
      responseType: 'text',
      connectTimeout: 12000,
      readTimeout: 20000,
    });
  } catch (e) {
    throw new TmdbError(`TMDB injoignable (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 401 || res.status === 403) throw new TmdbError('Clé TMDB refusée (vérifie-la dans Réglages).');
  if (res.status === 404) throw new TmdbError('Fiche TMDB introuvable.');
  if (res.status < 200 || res.status >= 300) throw new TmdbError(`TMDB : HTTP ${res.status}.`);
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TmdbError('Réponse TMDB illisible.');
  }
}

/**
 * Fiche TMDB complète par ID TMDB (ou IMDb via /find).
 * `kind` = 'movie' ou 'tv' (déduit de la catégorie Catalogue côté appelant).
 */
export async function fetchTmdbDetails(
  apiKey: string,
  opts: { tmdbId?: number; imdbId?: string; kind?: 'movie' | 'tv' },
): Promise<TmdbDetails | null> {
  const key = apiKey.trim();
  if (!key) return null;
  const cacheKey = `id:${opts.tmdbId ?? ''}|imdb:${opts.imdbId ?? ''}|${opts.kind ?? 'movie'}`;
  const now = Date.now();
  await loadDetailCache();
  const hit = detailCache.get(cacheKey);
  if (hit && now - hit.at < DETAIL_TTL) return hit.data;
  let data: TmdbDetails | null = null;
  try {
    let tmdbId = typeof opts.tmdbId === 'number' && opts.tmdbId > 0 ? opts.tmdbId : 0;
    let kind: 'movie' | 'tv' = opts.kind ?? 'movie';
    const imdb = (opts.imdbId ?? '').trim();
    if (!tmdbId && imdb) {
      const found = (await tmdbGet(key, `/find/${encodeURIComponent(imdb)}`, { external_source: 'imdb_id' })) as {
        movie_results?: Array<{ id?: number }>;
        tv_results?: Array<{ id?: number }>;
      };
      const movieHit = Array.isArray(found.movie_results) ? found.movie_results[0]?.id : undefined;
      const tvHit = Array.isArray(found.tv_results) ? found.tv_results[0]?.id : undefined;
      if (kind === 'tv' && tvHit) tmdbId = tvHit;
      else if (movieHit) {
        tmdbId = movieHit;
        kind = 'movie';
      } else if (tvHit) {
        tmdbId = tvHit;
        kind = 'tv';
      }
    }
    if (!tmdbId) throw new TmdbError('Sans ID.');
    const d = (await tmdbGet(key, `/${kind}/${tmdbId}`, { append_to_response: 'credits' })) as {
      title?: unknown;
      name?: unknown;
      overview?: unknown;
      runtime?: unknown;
      episode_run_time?: unknown;
      release_date?: unknown;
      first_air_date?: unknown;
      genres?: Array<{ name?: unknown }>;
      production_countries?: Array<{ name?: unknown }>;
      vote_average?: unknown;
      vote_count?: unknown;
      poster_path?: unknown;
      credits?: { cast?: Array<{ name?: unknown }>; crew?: Array<{ name?: unknown; job?: unknown }> };
    };
    const runtimeRaw =
      typeof d.runtime === 'number' && d.runtime > 0
        ? d.runtime
        : Array.isArray(d.episode_run_time) && typeof d.episode_run_time[0] === 'number' && d.episode_run_time[0] > 0
          ? d.episode_run_time[0]
          : null;
    const ratingRaw = typeof d.vote_average === 'number' ? d.vote_average : parseFloat(String(d.vote_average ?? ''));
    const votesRaw = typeof d.vote_count === 'number' ? d.vote_count : parseInt(String(d.vote_count ?? ''), 10);
    const cast = (Array.isArray(d.credits?.cast) ? d.credits!.cast! : [])
      .map((c) => String(c.name ?? '').trim())
      .filter(Boolean)
      .slice(0, 5);
    const director =
      (Array.isArray(d.credits?.crew) ? d.credits!.crew! : [])
        .map((c) => ({ name: String(c.name ?? '').trim(), job: String(c.job ?? '') }))
        .find((c) => c.name && /^(director|réalisateur)$/i.test(c.job))?.name ?? null;
    const overview = String(d.overview ?? '').trim();
    data = {
      title: String(d.title ?? d.name ?? ''),
      year: String(d.release_date ?? d.first_air_date ?? '').slice(0, 4),
      overview: overview !== '' ? overview : null,
      runtimeMin: runtimeRaw,
      genres: (Array.isArray(d.genres) ? d.genres : []).map((g) => String(g.name ?? '').trim()).filter(Boolean),
      countries: (Array.isArray(d.production_countries) ? d.production_countries : [])
        .map((c) => String(c.name ?? '').trim())
        .filter(Boolean),
      director,
      cast,
      rating: Number.isFinite(ratingRaw) && ratingRaw >= 0 && ratingRaw <= 10 ? Math.round(ratingRaw * 10) / 10 : null,
      votes: Number.isFinite(votesRaw) && votesRaw >= 0 ? votesRaw : null,
      posterURL: typeof d.poster_path === 'string' && d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
    };
  } catch {
    data = null;
  }
  detailCache.set(cacheKey, { at: now, data });
  if (detailCache.size > DETAIL_CACHE_MAX) {
    const first = detailCache.keys().next();
    if (!first.done) detailCache.delete(first.value);
  }
  saveDetailCache();
  return data;
}

/** 149 min -> "2h29" (présentation façon fiche C411). */
export function formatRuntime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}
