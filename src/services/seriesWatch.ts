/**
 * Suivi de séries : abonnement -> détection des nouveaux épisodes sur
 * TR4KER -> ajout automatique vers Transmission -> notification locale.
 *
 * Source : API TR4KER publique documentée (`X-Api-Key` personnelle,
 * générable dans les réglages du compte TR4KER, à coller dans Réglages).
 * Recherche : GET /api/torrents?q=<titre>&limit=25&search_in=title
 * Fichier : GET /api/torrents/<slug>/download (même clé).
 *
 * Vérification : au lancement + retour au premier plan (throttle 6 h) +
 * bouton manuel. iOS ne permet pas de cron en tâche de fond.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { settings } from './settings';
import { transmissionPath } from './settings';
import { uploadTorrentData } from './transmission';
import { requestAuthorizationIfNeeded } from './completionMonitor';

const SUBS_KEY = 'series_watch_subs_v1';
const LAST_GLOBAL_CHECK_KEY = 'series_watch_last_global_check';
/** Abonnements supprimés (pierres tombales anti-résurrection par un autre appareil). */
const SUB_DELETED_KEY = 'series_watch_deleted_v1';
const SUB_DELETED_MAX = 200;
const GLOBAL_CHECK_THROTTLE_MS = 6 * 3600 * 1000;

export interface SeriesSubscription {
  id: string;
  /** Titre d'origine (Plex). */
  title: string;
  /** Requête TR4KER (titre nettoyé). */
  query: string;
  year?: string;
  enabled: boolean;
  lastSeason: number;
  lastEpisode: number;
  /** Slugs/noms déjà traités (anti-doublon). */
  addedKeys: string[];
  createdAt: number;
  lastCheckAt: number;
  lastResult: string;
  /** Dernière écriture locale (fusion inter-appareils : le plus récent gagne). */
  updatedAt: number;
}

export interface EpisodeCandidate {
  season: number;
  episode: number;
  name: string;
  slug: string;
  /** Label qualité (ex : « 1080p • HEVC • WEB-DL »). */
  quality: string;
}

export interface CheckResult {
  subId: string;
  added: EpisodeCandidate[];
  error?: string;
}

export class SeriesWatchError extends Error {}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** S01E02, 1x02, s1.e2... (insensible à la casse, séparateurs libres). */
export function parseEpisode(name: string): { season: number; episode: number; isPack: boolean } | null {
  const n = name.replace(/[._-]+/g, ' ');
  // Plages : S01E01-E265, S01E01 à E265, S01E01-E02 → retient le max (pack).
  let m = /s(\d{1,2})\s*e(\d{1,3})\s*(?:[-–]|à|a|to)\s*e?(\d{1,3})/i.exec(n);
  if (m) {
    const ep = Math.max(parseInt(m[2], 10), parseInt(m[3], 10));
    return { season: parseInt(m[1], 10), episode: ep, isPack: true };
  }
  m = /s(\d{1,2})\s*e(\d{1,3})/i.exec(n);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), isPack: false };
  m = /(?:^|\s)(\d{1,2})\s*x\s*(\d{1,3})(?:\s|$)/i.exec(n);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), isPack: false };
  return null;
}

/** La query ressemble-t-elle au nom du torrent (anti-homonymes) ? */
function queryMatchesName(query: string, name: string): boolean {
  const tokens = norm(query)
    .split(' ')
    .filter((t) => t.length > 2 && !/^(19|20)\d{2}$/.test(t));
  if (tokens.length === 0) return true;
  const n = ` ${norm(name)} `;
  return tokens.every((t) => n.includes(` ${t}`) || n.includes(t));
}

function isNewer(a: { season: number; episode: number }, season: number, episode: number): boolean {
  return a.season > season || (a.season === season && a.episode > episode);
}

/** Préférence : 1080p d'abord, bonus HEVC/H.265, malus CAM/TS. */
export function qualityScore(name: string, seeders = 0): number {
  const n = name.toLowerCase();
  if (/(^|[^a-z0-9])(cam|ts|tc|telesync|telecine|scr|screener|r5|dvdscr)([^a-z0-9]|$)/.test(n)) return -1000;
  let score = 0;
  if (/\b1080p\b/.test(n)) score += 40;
  else if (/\b(2160p|4k)\b/.test(n)) score += 30;
  else if (/\b720p\b/.test(n)) score += 20;
  else if (/\b(480p|576p)\b/.test(n)) score += 5;
  if (/\b(hevc|h\.?265|x265)\b/.test(n)) score += 15;
  else if (/\b(avc|h\.?264|x264)\b/.test(n)) score += 5;
  if (/\b(web[ .-]?(dl|rip)|web)\b/.test(n)) score += 6;
  else if (/\b(bluray|bdrip|brrip)\b/.test(n)) score += 6;
  else if (/\bhdtv\b/.test(n)) score += 3;
  // Tie-break : plus seedé = mieux, sans jamais inverser la qualité.
  score += Math.min(Math.max(seeders, 0), 999) / 10000;
  return score;
}

/** Label compact pour l'inspecteur (ex : « 1080p • HEVC • WEB-DL »). */
export function qualityLabel(name: string): string {
  const n = name.toLowerCase();
  const parts: string[] = [];
  const res = /\b(2160p|4k|1080p|720p|480p|576p)\b/.exec(n)?.[1]?.toUpperCase();
  if (res) parts.push(res);
  if (/\b(hevc|h\.?265|x265)\b/.test(n)) parts.push('HEVC');
  else if (/\b(avc|h\.?264|x264)\b/.test(n)) parts.push('H264');
  if (/\bweb[ .-]?(dl|rip)\b/.test(n)) parts.push('WEB-DL');
  else if (/\bweb\b/.test(n)) parts.push('WEB');
  else if (/\b(bluray|bdrip|brrip)\b/.test(n)) parts.push('BluRay');
  else if (/\bhdtv\b/.test(n)) parts.push('HDTV');
  return parts.join(' • ');
}

function fmtSE(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

// ---------- Persistance ----------

export function loadSubscriptions(): SeriesSubscription[] {
  try {
    const raw = localStorage.getItem(SUBS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SeriesSubscription[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSubscriptions(subs: SeriesSubscription[]): void {
  try {
    localStorage.setItem(SUBS_KEY, JSON.stringify(subs));
  } catch {
    /* stockage indisponible */
  }
}

export function upsertSubscription(sub: SeriesSubscription): SeriesSubscription[] {
  const subs = loadSubscriptions();
  const next: SeriesSubscription = { ...sub, updatedAt: Date.now() };
  const i = subs.findIndex((s) => s.id === next.id);
  if (i >= 0) subs[i] = next;
  else subs.push(next);
  saveSubscriptions(subs);
  return subs;
}

export function removeSubscription(id: string): SeriesSubscription[] {
  const subs = loadSubscriptions().filter((s) => s.id !== id);
  saveSubscriptions(subs);
  return subs;
}

/** Remplace toute la liste (fusion serveur). Retourne la liste normalisée. */
export function replaceSubscriptions(list: SeriesSubscription[]): SeriesSubscription[] {
  const next = (Array.isArray(list) ? list : []).filter(
    (s) => s && typeof s.id === 'string' && typeof s.title === 'string',
  );
  saveSubscriptions(next);
  return next;
}

/** Marque un abonnement comme supprimé (un autre appareil ne doit pas le ressusciter). */
export function noteDeletedSubscription(id: string): void {
  try {
    const raw = localStorage.getItem(SUB_DELETED_KEY);
    const arr = (raw ? JSON.parse(raw) : []) as string[];
    const next = [id, ...arr.filter((x) => x !== id)].slice(0, SUB_DELETED_MAX);
    localStorage.setItem(SUB_DELETED_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function loadDeletedSubscriptionIds(): string[] {
  try {
    const raw = localStorage.getItem(SUB_DELETED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Oublie une suppression (réabonnement : l'id revit normalement). */
export function forgetDeletedSubscription(id: string): void {
  try {
    const raw = localStorage.getItem(SUB_DELETED_KEY);
    const arr = (raw ? JSON.parse(raw) : []) as string[];
    localStorage.setItem(SUB_DELETED_KEY, JSON.stringify(arr.filter((x) => x !== id)));
  } catch {
    /* ignore */
  }
}

export function subscriptionIdFor(title: string, year?: string | number | null): string {
  return `${norm(title)}|${String(year ?? '').trim()}`.slice(0, 120) || `sub-${Date.now()}`;
}

// ---------- API TR4KER ----------

interface Tr4kerSearchItem {
  slug?: string;
  kept_slug?: string;
  name?: string;
  title?: string;
  kept_name?: string;
  label?: string;
  size_bytes?: number;
  seeders?: number;
  seeds?: number;
}

/** Résultat de recherche (seeders conservés pour départager la qualité). */
export interface SearchHit {
  slug: string;
  name: string;
  seeders: number;
}

function normalizeSearchItem(raw: unknown): SearchHit | null {
  const r = (raw ?? {}) as Tr4kerSearchItem;
  const slug = String(r.slug ?? r.kept_slug ?? '').trim();
  const name = String(r.name ?? r.title ?? r.kept_name ?? r.label ?? '').trim();
  if (!slug || !name) return null;
  const seeds = parseInt(String(r.seeders ?? r.seeds ?? '0'), 10);
  return { slug, name, seeders: Number.isFinite(seeds) && seeds > 0 ? seeds : 0 };
}

async function tr4kerSearchRaw(
  query: string,
  apiKey: string,
  params: Record<string, string>,
): Promise<SearchHit[]> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url: 'https://tr4ker.net/api/torrents',
      params,
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 30000,
    });
  } catch (e) {
    throw new SeriesWatchError(`TR4KER injoignable (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SeriesWatchError('Clé API TR4KER refusée (vérifie-la dans Réglages).');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SeriesWatchError(`Recherche TR4KER : HTTP ${res.status}.`);
  }
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
  let parsed: { torrents?: unknown[]; error?: unknown; message?: unknown };
  try {
    parsed = JSON.parse(raw) as { torrents?: unknown[]; error?: unknown; message?: unknown };
  } catch {
    throw new SeriesWatchError('Réponse TR4KER illisible.');
  }
  if (parsed.error) {
    const msg = String(parsed.message ?? parsed.error ?? 'erreur inconnue');
    const err = new SeriesWatchError(`TR4KER : ${msg}`);
    (err as unknown as { tooBroad?: boolean }).tooBroad = /trop longue|affinez/i.test(msg);
    throw err;
  }
  const out: SearchHit[] = [];
  for (const item of parsed.torrents ?? []) {
    const n = normalizeSearchItem(item);
    if (n) out.push(n);
  }
  return out;
}

function isTooBroadError(e: unknown): boolean {
  return (e as unknown as { tooBroad?: boolean } | null)?.tooBroad === true;
}

/**
 * Recherche avec replis : l'API refuse les requêtes trop larges
 * ("recherche trop longue"). On resserre : tri récent + page courte,
 * puis ciblage des saisons suivies (la saison en cours + les suivantes).
 * Les replis se déclenchent aussi quand le 1er appel réussit mais ne
 * contient rien de plus récent que la base (tri par seeders qui enterre
 * les nouveautés, ex : que des S14-S32 alors que la base est en S34).
 */
async function tr4kerSearch(query: string, apiKey: string, sub?: SeriesSubscription): Promise<SearchHit[]> {
  const hasNewer = (items: SearchHit[]): boolean => {
    if (!sub) return items.length > 0;
    return items.some((it) => {
      if (!queryMatchesName(query, it.name)) return false;
      const se = parseEpisode(it.name);
      // Les packs ne comptent pas (ignorés en auto) : on force les replis
      // pour chercher l'épisode individuel.
      return !!se && !se.isPack && isNewer(se, sub.lastSeason, sub.lastEpisode);
    });
  };
  const merge = (lists: Array<SearchHit[]>): SearchHit[] => {
    const agg = new Map<string, SearchHit>();
    for (const items of lists) for (const it of items) agg.set(it.slug, it);
    return [...agg.values()];
  };
  try {
    const first = await tr4kerSearchRaw(query, apiKey, { q: query, limit: '25', search_in: 'title' });
    if (hasNewer(first)) return first;
    // Succès mais rien de neuf : on force les replis ciblés au lieu de s'arrêter.
    const refined = await tr4kerRefined(query, apiKey, sub);
    if (refined.length > 0) return merge([refined, first]);
    return first;
  } catch (e) {
    if (!isTooBroadError(e)) throw e;
  }
  try {
    const recent = await tr4kerSearchRaw(query, apiKey, { q: query, limit: '10', search_in: 'title', sort: 'recent' });
    if (hasNewer(recent)) return recent;
    const refined = await tr4kerRefined(query, apiKey, sub);
    if (refined.length > 0) return merge([refined, recent]);
    return recent;
  } catch (e) {
    if (!isTooBroadError(e)) throw e;
  }
  const refined = await tr4kerRefined(query, apiKey, sub);
  if (refined.length > 0) return refined;
  throw new SeriesWatchError('TR4KER : recherche trop large, même resserrée (tri récent + saisons).');
}

/** Replis ciblés : tri récent + saisons suivies (en cours et suivantes). */
async function tr4kerRefined(
  query: string,
  apiKey: string,
  sub?: SeriesSubscription,
): Promise<SearchHit[]> {
  try {
    return await tr4kerSearchRaw(query, apiKey, { q: query, limit: '25', search_in: 'title', sort: 'recent' });
  } catch (e) {
    if (!isTooBroadError(e)) throw e;
  }
  if (sub) {
    const seasons = [sub.lastSeason, sub.lastSeason + 1, sub.lastSeason + 2].filter((n) => n > 0);
    const agg = new Map<string, SearchHit>();
    let lastErr: unknown = null;
    for (const s of seasons) {
      try {
        const items = await tr4kerSearchRaw(query, apiKey, {
          q: query,
          limit: '25',
          search_in: 'title',
          sort: 'recent',
          season: String(s),
        });
        for (const it of items) agg.set(it.slug, it);
      } catch (e) {
        if (!isTooBroadError(e)) throw e;
        lastErr = e;
      }
    }
    if (agg.size > 0) return [...agg.values()];
    if (lastErr) throw lastErr;
  }
  return [];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function tr4kerDownloadBytes(slug: string, apiKey: string): Promise<Uint8Array> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url: `https://tr4ker.net/api/torrents/${encodeURIComponent(slug)}/download`,
      headers: { Accept: 'application/x-bittorrent,*/*', 'X-Api-Key': apiKey },
      responseType: 'arraybuffer',
      connectTimeout: 15000,
      readTimeout: 60000,
    });
  } catch (e) {
    throw new SeriesWatchError(`Téléchargement .torrent impossible (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SeriesWatchError(`Téléchargement .torrent : HTTP ${res.status}.`);
  }
  const bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data ?? []);
  if (bytes.length === 0) throw new SeriesWatchError('.torrent vide reçu.');
  if (bytes[0] !== 100) throw new SeriesWatchError('Réponse inattendue (pas un .torrent).');
  return bytes;
}

// ---------- Vérification ----------

async function notifyEpisode(title: string, season: number, episode: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await requestAuthorizationIfNeeded();
    await LocalNotifications.schedule({
      notifications: [
        {
          title: 'Nouvel épisode ajouté',
          body: `${title} ${fmtSE(season, episode)} → Transmission`,
          id: Math.abs(Math.floor(Math.random() * 2147483647)),
          sound: 'default',
        },
      ],
    });
  } catch {
    /* ignore */
  }
}

/** Vérifie un abonnement : détecte, ajoute à Transmission, notifie. */
export async function checkSubscription(sub: SeriesSubscription, apiKey: string): Promise<CheckResult> {
  const items = await tr4kerSearch(sub.query, apiKey, sub);
  const seen = new Set(sub.addedKeys);
  const fresh: Array<EpisodeCandidate & { score: number }> = [];
  let packsSkipped = 0;
  for (const item of items) {
    if (!queryMatchesName(sub.query, item.name)) continue;
    const se = parseEpisode(item.name);
    if (!se) continue;
    if (!isNewer(se, sub.lastSeason, sub.lastEpisode)) continue;
    const key = `${item.slug}|${se.season}x${se.episode}`;
    if (seen.has(key) || seen.has(item.slug)) continue;
    // Packs (plages E01-E265) : jamais en auto — doublons massifs assurés.
    // Visibles dans la loupe d'inspection, à ajouter à la main si besoin.
    if (se.isPack) {
      packsSkipped += 1;
      continue;
    }
    fresh.push({ season: se.season, episode: se.episode, name: item.name, slug: item.slug, quality: qualityLabel(item.name), score: qualityScore(item.name, item.seeders) });
  }
  // Un torrent par épisode : le meilleur score (1080p, HEVC, seeders), ordre croissant.
  const best = new Map<string, EpisodeCandidate & { score: number }>();
  for (const cand of fresh) {
    const epKey = `${cand.season}x${cand.episode}`;
    const cur = best.get(epKey);
    if (!cur || cand.score > cur.score) best.set(epKey, cand);
  }
  const ordered = [...best.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const added: EpisodeCandidate[] = [];
  for (const cand of ordered) {
    const epKey = `${cand.season}x${cand.episode}`;
    const bytes = await tr4kerDownloadBytes(cand.slug, apiKey);
    await uploadTorrentData(bytes, transmissionPath('series'));
    const key = `${cand.slug}|${epKey}`;
    sub.addedKeys.push(key);
    if (sub.addedKeys.length > 500) sub.addedKeys = sub.addedKeys.slice(-500);
    if (isNewer(cand, sub.lastSeason, sub.lastEpisode)) {
      sub.lastSeason = cand.season;
      sub.lastEpisode = cand.episode;
    }
    added.push(cand);
    await notifyEpisode(sub.title, cand.season, cand.episode);
  }
  sub.lastCheckAt = Date.now();
  sub.lastResult =
    added.length === 0
      ? packsSkipped > 0
        ? `Rien de nouveau (${packsSkipped} pack(s) ignoré(s), voir la loupe)`
        : 'Rien de nouveau'
      : `${added.length} épisode(s) ajouté(s)`;
  upsertSubscription(sub);
  return { subId: sub.id, added };
}

/** Vérifie tous les abonnements actifs (clé API requise). */
export async function checkAllSubscriptions(apiKey: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const sub of loadSubscriptions().filter((s) => s.enabled)) {
    try {
      results.push(await checkSubscription({ ...sub, addedKeys: [...sub.addedKeys] }, apiKey));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cur = loadSubscriptions().find((s) => s.id === sub.id);
      if (cur) {
        cur.lastCheckAt = Date.now();
        cur.lastResult = `Erreur : ${msg}`;
        upsertSubscription(cur);
      }
      results.push({ subId: sub.id, added: [], error: msg });
    }
  }
  try {
    localStorage.setItem(LAST_GLOBAL_CHECK_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  return results;
}

export interface InspectCandidate {
  name: string;
  slug: string;
  matchesQuery: boolean;
  season: number | null;
  episode: number | null;
  isPack: boolean;
  newer: boolean;
  alreadyAdded: boolean;
  quality: string;
  /** Ce que ferait une vraie vérification avec ce candidat. */
  verdict: 'ajouté' | 'ignoré';
  reason: string;
}

/**
 * Recherche à blanc (aucun téléchargement) : renvoie chaque candidat TR4KER
 * avec le motif de sa prise en compte ou de son rejet. Sert au diagnostic
 * (« nouvel épisode non détecté », « faux positif ajouté »).
 */
export async function inspectSubscription(
  sub: SeriesSubscription,
  apiKey: string,
): Promise<{ query: string; base: string; candidates: InspectCandidate[] }> {
  const items = await tr4kerSearch(sub.query, apiKey, sub);
  const seen = new Set(sub.addedKeys);
  const out: InspectCandidate[] = [];
  for (const item of items) {
    const matchesQuery = queryMatchesName(sub.query, item.name);
    const se = matchesQuery ? parseEpisode(item.name) : null;
    const newer = se ? isNewer(se, sub.lastSeason, sub.lastEpisode) : false;
    const key = se ? `${item.slug}|${se.season}x${se.episode}` : '';
    const alreadyAdded = se ? seen.has(key) || seen.has(item.slug) : false;
    let verdict: 'ajouté' | 'ignoré' = 'ignoré';
    let reason = '';
    if (!matchesQuery) {
      reason = 'titre hors sujet (query)';
    } else if (!se) {
      reason = 'pas de SxxExx lisible';
    } else if (!newer) {
      reason = `déjà couvert (base ${fmtSE(sub.lastSeason, sub.lastEpisode)})`;
    } else if (alreadyAdded) {
      reason = 'déjà traité (anti-doublon)';
    } else if (se.isPack) {
      reason = 'pack — ignoré en auto, ajout manuel conseillé';
    } else {
      verdict = 'ajouté';
      reason = 'nouvel épisode';
    }
    out.push({
      name: item.name,
      slug: item.slug,
      matchesQuery,
      season: se?.season ?? null,
      episode: se?.episode ?? null,
      isPack: se?.isPack ?? false,
      newer,
      alreadyAdded,
      quality: qualityLabel(item.name),
      verdict,
      reason,
    });
  }
  // « Serait ajouté » d'abord : le diagnostic utile en tête de liste.
  out.sort((a, b) =>
    a.verdict === b.verdict ? 0 : a.verdict === 'ajouté' ? -1 : 1,
  );
  return {
    query: sub.query,
    base: `S${String(sub.lastSeason).padStart(2, '0')}E${String(sub.lastEpisode).padStart(2, '0')}`,
    candidates: out.slice(0, 40),
  };
}

/**
 * Téléchargement forcé d'un candidat d'inspection (ex : reprendre le 1080p
 * alors que la base est déjà au même S/E via une autre qualité).
 * Enregistre l'anti-doublon et n'avance la base que si plus récent.
 */
export async function forceDownloadCandidate(
  subId: string,
  cand: { slug: string; name: string; season: number; episode: number },
  apiKey: string,
): Promise<string> {
  const sub = loadSubscriptions().find((s) => s.id === subId);
  if (!sub) throw new SeriesWatchError('Suivi introuvable (rafraîchis la liste).');
  const key = `${cand.slug}|${cand.season}x${cand.episode}`;
  if (sub.addedKeys.includes(key) || sub.addedKeys.includes(cand.slug)) {
    throw new SeriesWatchError('Déjà traité (anti-doublon).');
  }
  const bytes = await tr4kerDownloadBytes(cand.slug, apiKey);
  await uploadTorrentData(bytes, transmissionPath('series'));
  sub.addedKeys.push(key);
  if (sub.addedKeys.length > 500) sub.addedKeys = sub.addedKeys.slice(-500);
  if (isNewer(cand, sub.lastSeason, sub.lastEpisode)) {
    sub.lastSeason = cand.season;
    sub.lastEpisode = cand.episode;
  }
  sub.lastCheckAt = Date.now();
  sub.lastResult = `Forcé : ${fmtSE(cand.season, cand.episode)} ajouté`;
  upsertSubscription(sub);
  await notifyEpisode(sub.title, cand.season, cand.episode);
  return `${sub.title} ${fmtSE(cand.season, cand.episode)} → Transmission`;
}

/** Vrai si une vérification globale est due (throttle 6 h). */
export function isGlobalCheckDue(): boolean {
  try {
    const last = parseInt(localStorage.getItem(LAST_GLOBAL_CHECK_KEY) ?? '0', 10);
    return !Number.isFinite(last) || Date.now() - last > GLOBAL_CHECK_THROTTLE_MS;
  } catch {
    return true;
  }
}
