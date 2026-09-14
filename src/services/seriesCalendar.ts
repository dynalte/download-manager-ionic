/**
 * Calendrier des sorties pour les séries suivies.
 * Source : API publique TVMaze (pas de clé). Cache local 12 h / 7 j.
 */
import { CapacitorHttp } from '@capacitor/core';
import type { SeriesSubscription } from './seriesWatch';

const CACHE_KEY = 'series_calendar_cache_v1';
const SHOW_TTL_MS = 7 * 24 * 3600 * 1000;
const EP_TTL_MS = 12 * 3600 * 1000;
const MISS_TTL_MS = 24 * 3600 * 1000;
const GAP_MS = 220;

export interface CalendarEpisode {
  subId: string;
  title: string;
  season: number;
  episode: number;
  episodeName: string;
  airDate: string;
  network: string;
}

export interface CalendarLoadResult {
  episodes: CalendarEpisode[];
  unresolved: string[];
}

interface CachedShow {
  showId: number;
  name: string;
  network: string;
  at: number;
}

interface CachedEpisode {
  season: number;
  episode: number;
  name: string;
  airDate: string;
}

interface CacheFile {
  shows: Record<string, CachedShow>;
  episodes: Record<string, { at: number; items: CachedEpisode[] }>;
}

interface TvMazeShow {
  id?: number;
  name?: string;
  premiered?: string | null;
  status?: string;
  url?: string;
  officialSite?: string | null;
  summary?: string | null;
  network?: { name?: string } | null;
  webChannel?: { name?: string } | null;
  image?: { medium?: string; original?: string } | null;
}

export interface ShowSearchHit {
  id: number;
  name: string;
  year?: string;
  network: string;
  status: string;
  image?: string;
}

interface TvMazeEpisode {
  name?: string;
  season?: number;
  number?: number | null;
  airdate?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

export function formatDayHeading(iso: string): string {
  const today = isoDate(new Date());
  const tomorrow = isoDate(addDays(new Date(), 1));
  if (iso === today) return "Aujourd'hui";
  if (iso === tomorrow) return 'Demain';
  const [y, m, d] = iso.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function groupByDate(eps: CalendarEpisode[]): { date: string; items: CalendarEpisode[] }[] {
  const map = new Map<string, CalendarEpisode[]>();
  for (const e of eps) {
    const arr = map.get(e.airDate) ?? [];
    arr.push(e);
    map.set(e.airDate, arr);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      items: items.sort(
        (x, y) => x.title.localeCompare(y.title, 'fr') || x.season - y.season || x.episode - y.episode,
      ),
    }));
}

export function isEpisodeCaughtUp(sub: SeriesSubscription, ep: CalendarEpisode): boolean {
  return sub.lastSeason > ep.season || (sub.lastSeason === ep.season && sub.lastEpisode >= ep.episode);
}

function loadCache(): CacheFile {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { shows: {}, episodes: {} };
    const parsed = JSON.parse(raw) as CacheFile;
    return {
      shows: parsed.shows && typeof parsed.shows === 'object' ? parsed.shows : {},
      episodes: parsed.episodes && typeof parsed.episodes === 'object' ? parsed.episodes : {},
    };
  } catch {
    return { shows: {}, episodes: {} };
  }
}

function saveCache(cache: CacheFile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota */
  }
}

async function tvmazeGet(path: string): Promise<{ status: number; data: unknown }> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url: `https://api.tvmaze.com${path}`,
      headers: { Accept: 'application/json' },
      responseType: 'json',
      connectTimeout: 12000,
      readTimeout: 20000,
    });
  } catch (e) {
    throw new Error(`TVMaze injoignable (${e instanceof Error ? e.message : String(e)})`);
  }
  let data = res.data as unknown;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }
  return { status: res.status, data };
}

function networkOf(show: TvMazeShow): string {
  return String(show.network?.name || show.webChannel?.name || '').trim();
}

function yearOf(premiered?: string | null): string | undefined {
  const y = String(premiered || '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : undefined;
}

function stripHtml(s: string): string {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Recherche de séries (API publique TVMaze, pas de clé). */
export async function searchShows(query: string): Promise<ShowSearchHit[]> {
  const q = encodeURIComponent(query.trim());
  if (!q) return [];
  const { status, data } = await tvmazeGet(`/search/shows?q=${q}`);
  if (status < 200 || status >= 300) {
    throw new Error(`Recherche TVMaze : HTTP ${status}`);
  }
  if (!Array.isArray(data)) return [];
  const out: ShowSearchHit[] = [];
  const seen = new Set<number>();
  for (const row of data as Array<{ show?: TvMazeShow }>) {
    const show = row.show;
    if (!show?.id || !show.name || seen.has(show.id)) continue;
    seen.add(show.id);
    out.push({
      id: show.id,
      name: String(show.name),
      year: yearOf(show.premiered),
      network: networkOf(show),
      status: String(show.status || '').trim(),
      image: String(show.image?.medium || '').trim() || undefined,
    });
  }
  return out;
}

/** Mémorise le mapping TVMaze d'un suivi (évite une 2e recherche pour le calendrier). */
export function primeShowCache(subId: string, hit: ShowSearchHit): void {
  const cache = loadCache();
  cache.shows[subId] = {
    showId: hit.id,
    name: hit.name,
    network: hit.network,
    at: Date.now(),
  };
  saveCache(cache);
}

/** Dernier épisode déjà diffusé (pour poser la base du suivi sans tout retélécharger). */
export async function fetchPreviousEpisode(showId: number): Promise<{ season: number; episode: number } | null> {
  const { status, data } = await tvmazeGet(`/shows/${showId}?embed=previousepisode`);
  if (status < 200 || status >= 300 || !data || typeof data !== 'object') return null;
  const embedded = (data as { _embedded?: { previousepisode?: TvMazeEpisode } })._embedded?.previousepisode;
  const season = Number(embedded?.season);
  const episode = Number(embedded?.number);
  if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) return null;
  return { season, episode };
}

function scoreShow(sub: SeriesSubscription, show: TvMazeShow): number {
  const q = norm(sub.query || sub.title);
  const n = norm(show.name || '');
  if (!q || !n) return -1;
  let score = 0;
  if (n === q) score += 100;
  else if (n.startsWith(q) || q.startsWith(n)) score += 70;
  else if (n.includes(q) || q.includes(n)) score += 40;
  else return -1;
  const year = String(sub.year || '').trim();
  if (year && show.premiered?.startsWith(year)) score += 25;
  if (show.status === 'Running') score += 4;
  return score;
}

async function resolveShow(sub: SeriesSubscription, cache: CacheFile, force: boolean): Promise<CachedShow | null> {
  const hit = cache.shows[sub.id];
  const now = Date.now();
  if (!force && hit) {
    const ttl = hit.showId > 0 ? SHOW_TTL_MS : MISS_TTL_MS;
    if (now - hit.at < ttl) return hit.showId > 0 ? hit : null;
  }
  const q = encodeURIComponent((sub.query || sub.title).trim());
  if (!q) return null;
  const { status, data } = await tvmazeGet(`/search/shows?q=${q}`);
  if (status < 200 || status >= 300 || !Array.isArray(data)) {
    const miss: CachedShow = { showId: 0, name: '', network: '', at: now };
    cache.shows[sub.id] = miss;
    return null;
  }
  let best: { show: TvMazeShow; score: number } | null = null;
  for (const row of data as Array<{ show?: TvMazeShow }>) {
    const show = row.show;
    if (!show?.id) continue;
    const score = scoreShow(sub, show);
    if (score < 0) continue;
    if (!best || score > best.score) best = { show, score };
  }
  const resolved: CachedShow = best
    ? { showId: best.show.id as number, name: String(best.show.name || sub.title), network: networkOf(best.show), at: now }
    : { showId: 0, name: '', network: '', at: now };
  cache.shows[sub.id] = resolved;
  return resolved.showId > 0 ? resolved : null;
}

async function resolveEpisodes(showId: number, cache: CacheFile, force: boolean): Promise<CachedEpisode[]> {
  const key = String(showId);
  const hit = cache.episodes[key];
  const now = Date.now();
  if (!force && hit && now - hit.at < EP_TTL_MS) return hit.items;
  const { status, data } = await tvmazeGet(`/shows/${showId}/episodes`);
  if (status < 200 || status >= 300 || !Array.isArray(data)) {
    return hit?.items ?? [];
  }
  const items: CachedEpisode[] = [];
  for (const raw of data as TvMazeEpisode[]) {
    const season = Number(raw.season);
    const episode = Number(raw.number);
    const airDate = String(raw.airdate || '');
    if (!Number.isFinite(season) || !Number.isFinite(episode) || episode <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(airDate)) continue;
    items.push({
      season,
      episode,
      name: String(raw.name || '').trim(),
      airDate,
    });
  }
  cache.episodes[key] = { at: now, items };
  return items;
}

/** Charge les dates de diffusion des séries suivies (best-effort, une série ratée n'échoue pas tout). */
export async function loadCalendarEpisodes(
  subs: SeriesSubscription[],
  force = false,
): Promise<CalendarLoadResult> {
  const cache = loadCache();
  const episodes: CalendarEpisode[] = [];
  const unresolved: string[] = [];
  let first = true;
  for (const sub of subs) {
    if (!first) await sleep(GAP_MS);
    first = false;
    try {
      const show = await resolveShow(sub, cache, force);
      if (!show) {
        unresolved.push(sub.title);
        continue;
      }
      await sleep(GAP_MS);
      const items = await resolveEpisodes(show.showId, cache, force);
      for (const it of items) {
        episodes.push({
          subId: sub.id,
          title: sub.title,
          season: it.season,
          episode: it.episode,
          episodeName: it.name,
          airDate: it.airDate,
          network: show.network,
        });
      }
    } catch {
      unresolved.push(sub.title);
    }
  }
  saveCache(cache);
  return { episodes, unresolved };
}

export interface ShowDetailEpisode {
  season: number;
  episode: number;
  name: string;
  airDate: string;
  aired: boolean;
}

export interface ShowDetailSeason {
  season: number;
  episodes: ShowDetailEpisode[];
}

export interface ShowDetail {
  showId: number;
  name: string;
  year?: string;
  network: string;
  status: string;
  image?: string;
  summary: string;
  url: string;
  officialSite?: string;
  seasons: ShowDetailSeason[];
}

/** Fiche TVMaze + saisons/épisodes pour un suivi. */
export async function loadShowDetail(sub: SeriesSubscription, force = false): Promise<ShowDetail> {
  const cache = loadCache();
  const resolved = await resolveShow(sub, cache, force);
  if (!resolved) {
    saveCache(cache);
    throw new Error(`Série introuvable sur TVMaze (« ${sub.title} »).`);
  }
  const { status, data } = await tvmazeGet(`/shows/${resolved.showId}?embed=episodes`);
  if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
    saveCache(cache);
    throw new Error(`Fiche TVMaze inaccessible (HTTP ${status}).`);
  }
  const show = data as TvMazeShow & { _embedded?: { episodes?: TvMazeEpisode[] } };
  const today = isoDate(new Date());
  let rawEps = Array.isArray(show._embedded?.episodes) ? show._embedded.episodes : [];
  if (rawEps.length === 0) {
    rawEps = (await resolveEpisodes(resolved.showId, cache, force)).map((it) => ({
      season: it.season,
      number: it.episode,
      name: it.name,
      airdate: it.airDate,
    }));
  }
  const cachedEps: CachedEpisode[] = [];
  const bySeason = new Map<number, ShowDetailEpisode[]>();
  for (const raw of rawEps) {
    const season = Number(raw.season);
    const episode = Number(raw.number);
    if (!Number.isFinite(season) || !Number.isFinite(episode) || episode <= 0) continue;
    const airDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.airdate || '')) ? String(raw.airdate) : '';
    const ep: ShowDetailEpisode = {
      season,
      episode,
      name: String(raw.name || '').trim(),
      airDate,
      aired: !airDate || airDate <= today,
    };
    const list = bySeason.get(season) ?? [];
    list.push(ep);
    bySeason.set(season, list);
    if (airDate) cachedEps.push({ season, episode, name: ep.name, airDate });
  }
  if (cachedEps.length > 0) {
    cache.episodes[String(resolved.showId)] = { at: Date.now(), items: cachedEps };
  }
  saveCache(cache);
  const seasons: ShowDetailSeason[] = [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => ({
      season,
      episodes: episodes.sort((a, b) => a.episode - b.episode),
    }));
  return {
    showId: resolved.showId,
    name: String(show.name || resolved.name || sub.title),
    year: yearOf(show.premiered) || sub.year,
    network: networkOf(show) || resolved.network,
    status: String(show.status || '').trim(),
    image: String(show.image?.original || show.image?.medium || '').trim() || undefined,
    summary: stripHtml(String(show.summary || '')),
    url: String(show.url || `https://www.tvmaze.com/shows/${resolved.showId}`).trim(),
    officialSite: String(show.officialSite || '').trim() || undefined,
    seasons,
  };
}
