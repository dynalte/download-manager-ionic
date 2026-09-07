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
}

export interface EpisodeCandidate {
  season: number;
  episode: number;
  name: string;
  slug: string;
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
export function parseEpisode(name: string): { season: number; episode: number } | null {
  const n = name.replace(/[._-]+/g, ' ');
  let m = /s(\d{1,2})\s*e(\d{1,3})/i.exec(n);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = /(?:^|\s)(\d{1,2})\s*x\s*(\d{1,3})(?:\s|$)/i.exec(n);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
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
  const i = subs.findIndex((s) => s.id === sub.id);
  if (i >= 0) subs[i] = sub;
  else subs.push(sub);
  saveSubscriptions(subs);
  return subs;
}

export function removeSubscription(id: string): SeriesSubscription[] {
  const subs = loadSubscriptions().filter((s) => s.id !== id);
  saveSubscriptions(subs);
  return subs;
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
}

function normalizeSearchItem(raw: unknown): { slug: string; name: string } | null {
  const r = (raw ?? {}) as Tr4kerSearchItem;
  const slug = String(r.slug ?? r.kept_slug ?? '').trim();
  const name = String(r.name ?? r.title ?? r.kept_name ?? r.label ?? '').trim();
  if (!slug || !name) return null;
  return { slug, name };
}

async function tr4kerSearchRaw(
  query: string,
  apiKey: string,
  params: Record<string, string>,
): Promise<Array<{ slug: string; name: string }>> {
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
  const out: Array<{ slug: string; name: string }> = [];
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
 */
async function tr4kerSearch(query: string, apiKey: string, sub?: SeriesSubscription): Promise<Array<{ slug: string; name: string }>> {
  try {
    return await tr4kerSearchRaw(query, apiKey, { q: query, limit: '25', search_in: 'title' });
  } catch (e) {
    if (!isTooBroadError(e)) throw e;
  }
  try {
    return await tr4kerSearchRaw(query, apiKey, { q: query, limit: '10', search_in: 'title', sort: 'recent' });
  } catch (e) {
    if (!isTooBroadError(e)) throw e;
  }
  if (sub) {
    const seasons = [sub.lastSeason, sub.lastSeason + 1, sub.lastSeason + 2].filter((n) => n > 0);
    const agg = new Map<string, { slug: string; name: string }>();
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
  throw new SeriesWatchError('TR4KER : recherche trop large, même resserrée (tri récent + saisons).');
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
  const fresh: EpisodeCandidate[] = [];
  for (const item of items) {
    if (!queryMatchesName(sub.query, item.name)) continue;
    const se = parseEpisode(item.name);
    if (!se) continue;
    if (!isNewer(se, sub.lastSeason, sub.lastEpisode)) continue;
    const key = `${item.slug}|${se.season}x${se.episode}`;
    if (seen.has(key) || seen.has(item.slug)) continue;
    fresh.push({ season: se.season, episode: se.episode, name: item.name, slug: item.slug });
  }
  // Un torrent par épisode (le premier trouvé), ordre croissant.
  fresh.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const added: EpisodeCandidate[] = [];
  const picked = new Set<string>();
  for (const cand of fresh) {
    const epKey = `${cand.season}x${cand.episode}`;
    if (picked.has(epKey)) continue;
    picked.add(epKey);
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
  sub.lastResult = added.length === 0 ? 'Rien de nouveau' : `${added.length} épisode(s) ajouté(s)`;
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

/** Vrai si une vérification globale est due (throttle 6 h). */
export function isGlobalCheckDue(): boolean {
  try {
    const last = parseInt(localStorage.getItem(LAST_GLOBAL_CHECK_KEY) ?? '0', 10);
    return !Number.isFinite(last) || Date.now() - last > GLOBAL_CHECK_THROTTLE_MS;
  } catch {
    return true;
  }
}
