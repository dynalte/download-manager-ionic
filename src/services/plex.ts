/**
 * Port de PlexService.swift (~1950 lignes) vers TypeScript.
 * Même API publique, parsing XML via DOMParser (au lieu de regex Swift).
 */
import { settings } from './settings';
import { plexLog } from './debugLog';

export class PlexError extends Error {}

export interface PlexLibrarySection {
  key: number;
  type: string;
  title: string;
}

export interface PlexLibraryItem {
  id: string;
  ratingKey: string;
  title: string;
  summary?: string;
  year?: string;
  addedAt?: Date;
  type: string;
  isWatched: boolean;
  posterURL?: string;
}

export interface PlexLibraryData {
  id: number;
  section: PlexLibrarySection;
  totalItems: number;
  items: PlexLibraryItem[];
}

export interface PlexSeasonItem {
  id: string;
  ratingKey: string;
  title: string;
  index?: number;
  episodeCount: number;
  viewedEpisodeCount: number;
  isWatched: boolean;
  posterURL?: string;
}

export interface PlexEpisodeItem {
  id: string;
  ratingKey: string;
  title: string;
  summary?: string;
  seasonIndex?: number;
  episodeIndex?: number;
  durationMs?: number;
  isWatched: boolean;
  posterURL?: string;
}

export interface PlexPlayerTarget {
  id: string;
  targetClientIdentifier: string;
  name: string;
  product: string;
  platform: string;
  baseURL?: string;
  /** Toutes les adresses connues (LAN, relay…) pour tentative directe. */
  connections?: string[];
  accessToken?: string;
  source: string;
  displayName: string;
  /** true = en ligne / connecté, false = hors ligne (app fermée), undefined = inconnu. */
  presence?: boolean;
}

export interface PlexLinkRecord {
  normalizedTitle: string;
  type: string;
  isWatched: boolean;
}

interface ServerContext {
  baseURL: string;
  machineIdentifier: string;
  version?: string;
}

const PRODUCT = 'DownloadManager';

/** Identifiant contrôleur stable (sinon Plex confond les contrôleurs). */
function clientIdentifier(): string {
  const KEY = 'plex_client_identifier';
  try {
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `dlm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    return PRODUCT;
  }
}

function plexHeaders(token: string, extra: Record<string, string> = {}): HeadersInit {
  return {
    'X-Plex-Token': token,
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': clientIdentifier(),
    Accept: 'text/xml',
    ...extra,
  };
}

function normalizeBaseURL(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new PlexError('URL Plex invalide.');
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  const u = new URL(withScheme);
  if (!u.port) u.port = '32400';
  u.pathname = '/';
  u.search = '';
  return u.toString().replace(/\/$/, '');
}

function decodeEntities(s: string): string {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function attr(el: Element, name: string): string | undefined {
  return el.getAttribute(name) ?? undefined;
}

function intAttr(el: Element, name: string): number {
  return parseInt(el.getAttribute(name) ?? '0', 10) || 0;
}

function posterURL(thumb: string | null | undefined, baseURL: string, token: string): string | undefined {
  if (!thumb) return undefined;
  const abs = thumb.startsWith('http') ? thumb : `${baseURL}${thumb.startsWith('/') ? '' : '/'}${thumb}`;
  const sep = abs.includes('?') ? '&' : '?';
  return `${abs}${sep}X-Plex-Token=${encodeURIComponent(token)}`;
}

function truthyFlag(v?: string): boolean {
  const n = (v ?? '').trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes';
}

function isWatchedFields(o: {
  type: string;
  viewCount: number;
  viewedLeafCount: number;
  leafCount: number;
  lastViewedAt?: string;
  viewedFlag?: string;
  viewOffset: number;
  durationMs?: number;
}): boolean {
  if (truthyFlag(o.viewedFlag)) return true;
  if (o.viewCount > 0) return true;
  if (o.lastViewedAt && o.lastViewedAt !== '' && o.lastViewedAt !== '0') return true;
  if (o.type === 'show' || o.type === 'season') return o.leafCount > 0 && o.viewedLeafCount >= o.leafCount;
  if (o.durationMs && o.durationMs > 0 && o.viewOffset > 0) {
    if (o.viewOffset >= 0.9 * o.durationMs || o.viewOffset * 1000 >= 0.9 * o.durationMs) return true;
  }
  return false;
}

export function normalizedTitleForMatching(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getXML(url: string, token: string, timeoutMs = 0): Promise<Document> {
  const res =
    timeoutMs > 0
      ? await fetchWithTimeout(url, { headers: plexHeaders(token) }, timeoutMs)
      : await fetch(url, { headers: plexHeaders(token) });
  if (!res.ok) throw new PlexError(`Plex a retourne ${res.status}. ${await res.text().catch(() => '')}`);
  const text = await res.text();
  return new DOMParser().parseFromString(text, 'text/xml');
}

async function isPlexMediaServer(baseURL: string, token: string, timeoutMs = 0): Promise<boolean> {
  try {
    const doc = await getXML(`${baseURL}/library/sections`, token, timeoutMs);
    return doc.getElementsByTagName('Directory').length > 0;
  } catch {
    return false;
  }
}

async function fetchMachineIdentifier(
  baseURL: string,
  token: string,
  timeoutMs = 0,
): Promise<{ machineIdentifier: string; version: string }> {
  const res =
    timeoutMs > 0
      ? await fetchWithTimeout(baseURL, { headers: plexHeaders(token) }, timeoutMs)
      : await fetch(baseURL, { headers: plexHeaders(token) });
  const text = await res.text();
  const m = /machineIdentifier="([^"]+)"/.exec(text);
  if (!m) throw new PlexError('Reponse Plex invalide.');
  return { machineIdentifier: m[1], version: /version="([^"]+)"/.exec(text)?.[1] ?? '' };
}

interface ResourceConn {
  url: string;
  isLocal: boolean;
  isRelay: boolean;
  isSecure: boolean;
}

function connScore(c: ResourceConn): number {
  let s = 0;
  if (!c.isRelay) s += 5;
  if (!c.isLocal) s += 3;
  if (c.isSecure) s += 2;
  if (c.isLocal) s += 1;
  return s;
}

async function fetchResourcesDevices(token: string): Promise<Element[]> {
  const res = await fetch(`https://plex.tv/api/resources?includeHttps=1&X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { 'X-Plex-Product': PRODUCT, 'X-Plex-Client-Identifier': PRODUCT },
  });
  if (!res.ok) throw new PlexError('Impossible de contacter plex.tv pour decouvrir le serveur.');
  const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
  return Array.from(doc.getElementsByTagName('Device'));
}

function deviceConnections(device: Element): ResourceConn[] {
  return Array.from(device.getElementsByTagName('Connection'))
    .map((c) => {
      const uri = c.getAttribute('uri');
      if (!uri) return null;
      return {
        url: uri.replace(/\/$/, ''),
        isLocal: c.getAttribute('local') === '1',
        isRelay: c.getAttribute('relay') === '1',
        isSecure: (c.getAttribute('protocol') ?? '').toLowerCase() === 'https' || uri.startsWith('https'),
      } as ResourceConn;
    })
    .filter((c): c is ResourceConn => !!c)
    .sort((a, b) => connScore(b) - connScore(a));
}

async function resolveServerContext(baseURLString: string, token: string): Promise<ServerContext> {
  if (!token.trim()) throw new PlexError('Token Plex manquant.');
  const trimmed = baseURLString.trim();
  if (trimmed !== '') {
    const baseURL = normalizeBaseURL(trimmed);
    if (!(await isPlexMediaServer(baseURL, token))) throw new PlexError('URL Plex invalide.');
    const info = await fetchMachineIdentifier(baseURL, token);
    return { baseURL, machineIdentifier: info.machineIdentifier, version: info.version };
  }
  // Cloud discovery via plex.tv
  const devices = await fetchResourcesDevices(token);
  const servers = devices.filter((d) => {
    const provides = (d.getAttribute('provides') ?? '').toLowerCase();
    const product = (d.getAttribute('product') ?? '').toLowerCase();
    if (product.includes('media server')) return true;
    return provides.includes('server') && !provides.includes('player') && !provides.includes('client');
  });
  for (const server of servers) {
    for (const conn of deviceConnections(server)) {
        try {
          if (await isPlexMediaServer(conn.url, token)) {
            const info = await fetchMachineIdentifier(conn.url, token);
            return { baseURL: conn.url, machineIdentifier: info.machineIdentifier, version: info.version };
          }
        } catch {
        /* essayer la connexion suivante */
      }
    }
  }
  throw new PlexError('Aucun serveur Plex accessible trouve via le cloud.');
}

/**
 * Tous les serveurs joignables (config + chaque serveur plex.tv).
 * La TV peut être connectée à n'importe lequel : la détection (/clients,
 * sessions) et la commande relayée doivent toutes les essayer, comme
 * l'app officielle qui sonde chaque connexion publiée.
 *
 * Les sondes passent souvent par le relay plex.tv (lent) : timeout généreux
 * mais borné (30 s), et serveurs sondés en parallèle pour ne pas
 * additionner les latences.
 */
const SERVER_PROBE_TIMEOUT_MS = 30000;

async function resolveAllServerContexts(
  baseURLString: string,
  token: string,
  preloadedDevices?: Element[],
): Promise<ServerContext[]> {
  const out: (ServerContext & { order: number })[] = [];
  const seen = new Set<string>();
  const push = (ctx: ServerContext, label: string, order: number) => {
    const key = ctx.machineIdentifier || ctx.baseURL;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...ctx, order });
    plexLog('info', `serveur OK (${label}): ${ctx.baseURL}${ctx.version ? ` [PMS ${ctx.version}]` : ''}`);
  };
  const jobs: Array<Promise<void>> = [];
  const trimmed = baseURLString.trim();
  if (trimmed !== '') {
    jobs.push(
      (async () => {
        try {
          const baseURL = normalizeBaseURL(trimmed);
          if (await isPlexMediaServer(baseURL, token, SERVER_PROBE_TIMEOUT_MS)) {
            const info = await fetchMachineIdentifier(baseURL, token, SERVER_PROBE_TIMEOUT_MS).catch(() => ({
              machineIdentifier: '',
              version: '',
            }));
            push({ baseURL, machineIdentifier: info.machineIdentifier, version: info.version }, 'config', -1);
          }
        } catch (e) {
          plexLog('warn', `serveur configure injoignable (${e instanceof Error ? e.message : String(e)})`);
        }
      })(),
    );
  }
  const probeServers = async (devices: Element[]) => {
    const servers = devices.filter((d) => {
      const provides = (d.getAttribute('provides') ?? '').toLowerCase();
      const product = (d.getAttribute('product') ?? '').toLowerCase();
      if (product.includes('media server')) return true;
      return provides.includes('server') && !provides.includes('player') && !provides.includes('client');
    });
    await Promise.all(
      servers.map(async (server, si) => {
        const label = server.getAttribute('name') ?? 'serveur';
        // Connexions sondées en parallèle (premier OK gagne) : un serveur mort
        // (ex Mac mini éteint) ne doit pas coûter N × timeout en séquence.
        const conns = deviceConnections(server);
        const winner = await Promise.all(
          conns.map(async (conn) => {
            try {
              const ok = await Promise.race([
                isPlexMediaServer(conn.url, token),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SERVER_PROBE_TIMEOUT_MS)),
              ]);
              return ok ? conn : null;
            } catch {
              return null;
            }
          }),
        ).then((rs) => rs.find((r): r is (typeof conns)[number] => !!r));
        if (winner) {
          const info = await fetchMachineIdentifier(winner.url, token, SERVER_PROBE_TIMEOUT_MS).catch(() => ({
            machineIdentifier: server.getAttribute('clientIdentifier') ?? '',
            version: '',
          }));
          push(
            { baseURL: winner.url, machineIdentifier: info.machineIdentifier, version: info.version },
            label,
            si,
          );
        } else {
          plexLog('warn', `serveur injoignable via toutes ses connexions (${label})`);
        }
      }),
    );
  };
  if (preloadedDevices) {
    await probeServers(preloadedDevices);
  } else {
    try {
      jobs.push(
        (async () => {
          await probeServers(await fetchResourcesDevices(token));
        })(),
      );
    } catch (e) {
      plexLog('warn', `liste serveurs plex.tv illisible (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  await Promise.all(jobs);
  return out
    .sort((a, b) => a.order - b.order)
    .map(({ baseURL, machineIdentifier, version }) => ({ baseURL, machineIdentifier, version }));
}

function parseSection(el: Element): PlexLibrarySection | null {
  const key = parseInt(el.getAttribute('key') ?? '', 10);
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (!Number.isFinite(key) || (type !== 'movie' && type !== 'show')) return null;
  return { key, type, title: decodeEntities(el.getAttribute('title') ?? 'Bibliotheque') };
}

function parseLibraryItem(el: Element, fallbackType: string, baseURL: string, token: string): PlexLibraryItem {
  const title = decodeEntities(el.getAttribute('title') ?? el.getAttribute('grandparentTitle') ?? 'Sans titre');
  const type = (el.getAttribute('type') ?? fallbackType).toLowerCase();
  const ratingKey = el.getAttribute('ratingKey') ?? `${title}`;
  const summary = el.getAttribute('summary')?.trim() || undefined;
  const year = el.getAttribute('year') ?? undefined;
  const addedAtRaw = el.getAttribute('addedAt');
  const isWatched = isWatchedFields({
    type,
    viewCount: intAttr(el, 'viewCount'),
    viewedLeafCount: intAttr(el, 'viewedLeafCount'),
    leafCount: intAttr(el, 'leafCount'),
    lastViewedAt: el.getAttribute('lastViewedAt') ?? el.getAttribute('viewedAt') ?? undefined,
    viewedFlag: el.getAttribute('viewed') ?? undefined,
    viewOffset: intAttr(el, 'viewOffset'),
    durationMs: el.getAttribute('duration') ? parseInt(el.getAttribute('duration')!, 10) : undefined,
  });
  return {
    id: ratingKey,
    ratingKey,
    title,
    summary,
    year,
    addedAt: addedAtRaw ? new Date(parseInt(addedAtRaw, 10) * 1000) : undefined,
    type,
    isWatched,
    posterURL: posterURL(el.getAttribute('thumb'), baseURL, token),
  };
}

export async function fetchSections(baseURLString: string, token: string): Promise<PlexLibrarySection[]> {
  const ctx = await resolveServerContext(baseURLString, token);
  const doc = await getXML(`${ctx.baseURL}/library/sections`, token);
  return Array.from(doc.getElementsByTagName('Directory'))
    .map(parseSection)
    .filter((s): s is PlexLibrarySection => !!s);
}

export async function fetchLibrariesData(
  baseURLString: string,
  token: string,
  preferredSectionKeys: number[],
  perSectionLimit = 20,
): Promise<PlexLibraryData[]> {
  const ctx = await resolveServerContext(baseURLString, token);
  const sectionsDoc = await getXML(`${ctx.baseURL}/library/sections`, token);
  let sections = Array.from(sectionsDoc.getElementsByTagName('Directory'))
    .map(parseSection)
    .filter((s): s is PlexLibrarySection => !!s);
  if (preferredSectionKeys.length > 0) {
    const set = new Set(preferredSectionKeys);
    sections = sections.filter((s) => set.has(s.key));
  }
  if (sections.length === 0) throw new PlexError('Aucune bibliotheque film/serie detectee sur Plex.');
  const out: PlexLibraryData[] = [];
  for (const section of sections) {
    const url =
      `${ctx.baseURL}/library/sections/${section.key}/all` +
      `?sort=addedAt%3Adesc&X-Plex-Container-Start=0&X-Plex-Container-Size=${Math.max(1, perSectionLimit)}&includeUserState=1`;
    const doc = await getXML(url, token);
    const total = parseInt(doc.documentElement.getAttribute('size') ?? '0', 10) || 0;
    const items = [...Array.from(doc.getElementsByTagName('Video')), ...Array.from(doc.getElementsByTagName('Directory'))]
      .filter((el) => el.getAttribute('title') || el.getAttribute('grandparentTitle'))
      .map((el) => parseLibraryItem(el, section.type, ctx.baseURL, token));
    out.push({ id: section.key, section, totalItems: total, items });
  }
  return out;
}

/** Entrée d'historique de visionnage (conservée même si le média est supprimé). */
export interface PlexHistoryItem {
  title: string;
  year?: string;
  /** 'movie' | 'show' (épisodes rattachés à leur série). */
  type: string;
  viewedAt?: Date;
}

/**
 * Historique de visionnage du serveur (`/status/sessions/history/all`).
 * Conservé par Plex même après suppression du média (et vidage de la
 * corbeille) : idéal pour exclure les déjà-vus des suggestions IA.
 * Best effort : tableau vide en cas d'échec (vieux PMS, droits limités).
 */
export async function fetchWatchHistory(
  baseURLString: string,
  token: string,
  limit = 500,
): Promise<PlexHistoryItem[]> {
  const ctx = await resolveServerContext(baseURLString, token);
  const size = Math.min(Math.max(limit, 1), 2000);
  const url =
    `${ctx.baseURL}/status/sessions/history/all` +
    `?sort=viewedAt%3Adesc&X-Plex-Container-Start=0&X-Plex-Container-Size=${size}`;
  const doc = await getXML(url, token);
  const els = Array.from(doc.getElementsByTagName('Video'));
  const seen = new Set<string>();
  const out: PlexHistoryItem[] = [];
  for (const el of els) {
    const rawType = (el.getAttribute('type') ?? '').toLowerCase();
    let title = '';
    let year: string | undefined;
    let type = 'movie';
    if (rawType === 'episode') {
      title = decodeEntities(el.getAttribute('grandparentTitle') ?? '');
      year = el.getAttribute('grandparentYear') ?? undefined;
      type = 'show';
    } else if (rawType === 'movie') {
      title = decodeEntities(el.getAttribute('title') ?? '');
      year = el.getAttribute('year') ?? undefined;
      type = 'movie';
    } else {
      continue; // clips, pistes… hors scope suggestions
    }
    title = title.trim();
    if (!title) continue;
    const key = `${type}|${normalizedTitleForMatching(title)}`;
    if (seen.has(key)) continue; // déduplique : ne garde que le plus récent
    seen.add(key);
    const viewedRaw = el.getAttribute('viewedAt') ?? el.getAttribute('lastViewedAt') ?? '';
    const viewedAt = viewedRaw && viewedRaw !== '0' ? new Date(parseInt(viewedRaw, 10) * 1000) : undefined;
    out.push({ title, year, type, viewedAt });
  }
  return out;
}

export async function fetchShowSeasons(
  baseURLString: string,
  token: string,
  showRatingKey: string,
): Promise<PlexSeasonItem[]> {
  const ctx = await resolveServerContext(baseURLString, token);
  const doc = await getXML(`${ctx.baseURL}/library/metadata/${showRatingKey}/children?includeUserState=1`, token);
  return Array.from(doc.getElementsByTagName('Directory'))
    .filter((el) => (el.getAttribute('type') ?? '').toLowerCase() === 'season')
    .map((el) => {
      const ratingKey = el.getAttribute('ratingKey') ?? crypto.randomUUID();
      const index = el.getAttribute('index') ? parseInt(el.getAttribute('index')!, 10) : undefined;
      const leafCount = intAttr(el, 'leafCount');
      const viewedLeafCount = intAttr(el, 'viewedLeafCount');
      return {
        id: ratingKey,
        ratingKey,
        title: decodeEntities(el.getAttribute('title') ?? (index !== undefined ? `Saison ${index}` : 'Saison')),
        index: Number.isFinite(index) ? index : undefined,
        episodeCount: leafCount,
        viewedEpisodeCount: viewedLeafCount,
        isWatched: isWatchedFields({
          type: 'season',
          viewCount: intAttr(el, 'viewCount'),
          viewedLeafCount,
          leafCount,
          lastViewedAt: el.getAttribute('lastViewedAt') ?? undefined,
          viewedFlag: el.getAttribute('viewed') ?? undefined,
          viewOffset: 0,
        }),
        posterURL: posterURL(el.getAttribute('thumb') ?? el.getAttribute('parentThumb'), ctx.baseURL, token),
      } as PlexSeasonItem;
    })
    .sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999));
}

export async function fetchSeasonEpisodes(
  baseURLString: string,
  token: string,
  seasonRatingKey: string,
): Promise<PlexEpisodeItem[]> {
  const ctx = await resolveServerContext(baseURLString, token);
  const doc = await getXML(`${ctx.baseURL}/library/metadata/${seasonRatingKey}/children?includeUserState=1`, token);
  return Array.from(doc.getElementsByTagName('Video'))
    .filter((el) => {
      const t = (el.getAttribute('type') ?? '').toLowerCase();
      return t === '' || t === 'episode';
    })
    .map((el) => {
      const ratingKey = el.getAttribute('ratingKey') ?? crypto.randomUUID();
      return {
        id: ratingKey,
        ratingKey,
        title: decodeEntities(el.getAttribute('title') ?? 'Episode'),
        summary: el.getAttribute('summary')?.trim() || undefined,
        seasonIndex: el.getAttribute('parentIndex') ? parseInt(el.getAttribute('parentIndex')!, 10) : undefined,
        episodeIndex: el.getAttribute('index') ? parseInt(el.getAttribute('index')!, 10) : undefined,
        durationMs: el.getAttribute('duration') ? parseInt(el.getAttribute('duration')!, 10) : undefined,
        isWatched: isWatchedFields({
          type: 'episode',
          viewCount: intAttr(el, 'viewCount'),
          viewedLeafCount: 0,
          leafCount: 0,
          lastViewedAt: el.getAttribute('lastViewedAt') ?? el.getAttribute('viewedAt') ?? undefined,
          viewedFlag: el.getAttribute('viewed') ?? undefined,
          viewOffset: intAttr(el, 'viewOffset'),
          durationMs: el.getAttribute('duration') ? parseInt(el.getAttribute('duration')!, 10) : undefined,
        }),
        posterURL: posterURL(
          el.getAttribute('thumb') ?? el.getAttribute('parentThumb') ?? el.getAttribute('grandparentThumb'),
          ctx.baseURL,
          token,
        ),
      } as PlexEpisodeItem;
    })
    .sort((a, b) => (a.seasonIndex ?? 9999) - (b.seasonIndex ?? 9999) || (a.episodeIndex ?? 9999) - (b.episodeIndex ?? 9999));
}

export async function refreshLibraries(
  baseURLString: string,
  token: string,
  preferredSectionKeys: number[],
): Promise<number> {
  const ctx = await resolveServerContext(baseURLString, token);
  const sections = await fetchSections(baseURLString, token);
  const keys = preferredSectionKeys.length === 0 ? sections.map((s) => s.key) : preferredSectionKeys.filter((k) => sections.some((s) => s.key === k));
  if (keys.length === 0) throw new PlexError('Aucune bibliotheque film/serie detectee sur Plex.');
  for (const key of keys) {
    await fetch(`${ctx.baseURL}/library/sections/${key}/refresh`, { headers: plexHeaders(token) });
  }
  return keys.length;
}

export async function fetchLinkRecords(
  baseURLString: string,
  token: string,
  preferredSectionKeys: number[],
  perSectionLimit = 1200,
): Promise<PlexLinkRecord[]> {
  const sections = await fetchSections(baseURLString, token);
  const ctx = await resolveServerContext(baseURLString, token);
  const selected =
    preferredSectionKeys.length === 0 ? sections : sections.filter((s) => preferredSectionKeys.includes(s.key));
  if (selected.length === 0) throw new PlexError('Aucune bibliotheque film/serie detectee sur Plex.');
  const merged = new Map<string, PlexLinkRecord>();
  for (const section of selected) {
    const url =
      `${ctx.baseURL}/library/sections/${section.key}/all` +
      `?sort=titleSort%3Aasc&X-Plex-Container-Start=0&X-Plex-Container-Size=${perSectionLimit}&includeUserState=1`;
    const doc = await getXML(url, settings.plexToken || token);
    const items = [...Array.from(doc.getElementsByTagName('Video')), ...Array.from(doc.getElementsByTagName('Directory'))].map(
      (el) => parseLibraryItem(el, section.type, ctx.baseURL, token),
    );
    const recordType = section.type === 'show' ? 'show' : 'movie';
    for (const item of items) {
      const normalized = normalizedTitleForMatching(item.title);
      if (!normalized) continue;
      const key = `${recordType}|${normalized}`;
      const next: PlexLinkRecord = { normalizedTitle: normalized, type: recordType, isWatched: item.isWatched };
      const existing = merged.get(key);
      if (!existing || (!existing.isWatched && next.isWatched)) merged.set(key, next);
      else if (!existing) merged.set(key, next);
    }
  }
  return [...merged.values()];
}

/** Lecteurs : cloud (plex.tv resources) + serveur (/clients, sessions) + manuels (IP). */
export interface PlayersDebug {
  rawResources: number;
  keptResources: number;
  clientsCount: number;
  sessionsCount: number;
  errors: string[];
  filteredOut: Array<{ name: string; product: string; provides: string; reason: string }>;
  /** Une ligne par appareil brut plex.tv (diagnostic copiable). */
  devicesSummary: string[];
  /** Compte plex.tv vu par le token (username/home). */
  account: string;
  /** Serveurs joignables sondés pour /clients + sessions. */
  servers: string[];
}

/** Lecteur ajouté à la main (ex Fire TV invisible sur plex.tv). */
export interface ManualPlayerEntry {
  baseURL: string;
  targetClientIdentifier: string;
  name: string;
  product: string;
  platform: string;
  addedAt: number;
}

const MANUAL_PLAYERS_KEY = 'plex_manual_players';

export function getManualPlayers(): ManualPlayerEntry[] {
  try {
    const raw = localStorage.getItem(MANUAL_PLAYERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ManualPlayerEntry[];
    return Array.isArray(arr) ? arr.filter((m) => m && m.baseURL && m.targetClientIdentifier) : [];
  } catch {
    return [];
  }
}

function saveManualPlayers(list: ManualPlayerEntry[]): void {
  try {
    localStorage.setItem(MANUAL_PLAYERS_KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible */
  }
}

export function removeManualPlayer(baseURL: string): void {
  saveManualPlayers(getManualPlayers().filter((m) => m.baseURL !== baseURL));
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function normalizePlayerBaseURL(hostOrURL: string, port: string): string {
  const h = hostOrURL.trim();
  if (!h) throw new PlexError('Adresse IP vide.');
  const withScheme = h.includes('://') ? h : `http://${h}`;
  const u = new URL(withScheme);
  u.port = (port || '').trim() || u.port || '32500';
  u.pathname = '/';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

/** Présence : le lecteur répond-il en LAN (même une 401/404 = joignable). */
async function probePlayerPresence(baseURL: string, token: string): Promise<void> {
  const res = await fetchWithTimeout(`${baseURL.replace(/\/$/, '')}/player/timeline/poll?wait=0`, {
    headers: plexHeaders(token),
  }, 4000);
  await res.text().catch(() => '');
}

/**
 * Sonde http://IP:32500/resources et enregistre le lecteur.
 * NOTE : certains lecteurs ne répondent que pendant/après une lecture :
 * si ça échoue, lance une vidéo sur la TV puis réessaie.
 */
export async function probeAndAddManualPlayer(
  hostOrURL: string,
  port: string,
  token: string,
): Promise<PlexPlayerTarget> {
  const base = normalizePlayerBaseURL(hostOrURL, port);
  let text = '';
  let status = 0;
  try {
    const res = await fetchWithTimeout(`${base}/resources`, { headers: plexHeaders(token) }, 8000);
    status = res.status;
    text = await res.text().catch(() => '');
  } catch (e) {
    throw new PlexError(
      `TV injoignable sur ${base} (${e instanceof Error && e.name === 'AbortError' ? 'délai dépassé' : e instanceof Error ? e.message : String(e)}). ` +
        `Vérifie l'IP (Réglages réseau de la Fire TV), le même Wi-Fi, et rebuild l'app (réseau local iOS requis).`,
    );
  }
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const candidates = [
    doc.documentElement,
    ...Array.from(doc.getElementsByTagName('Player')),
    ...Array.from(doc.getElementsByTagName('Device')),
    ...Array.from(doc.getElementsByTagName('MediaContainer')),
  ];
  const found = candidates.find((el) => el && el.getAttribute && el.getAttribute('machineIdentifier'));
  const machineId = found?.getAttribute('machineIdentifier') ?? undefined;
  if (!machineId) {
    throw new PlexError(
      `La TV répond sur ${base} (HTTP ${status}) mais sans identifiant. Lance une lecture sur la TV puis réessaie.`,
    );
  }
  const name = found?.getAttribute('deviceName') ?? found?.getAttribute('title') ?? found?.getAttribute('name') ?? 'Fire TV';
  const entry: ManualPlayerEntry = {
    baseURL: base,
    targetClientIdentifier: machineId,
    name,
    product: found?.getAttribute('product') ?? 'Plex for Android (TV)',
    platform: found?.getAttribute('platform') ?? 'Android',
    addedAt: Date.now(),
  };
  const others = getManualPlayers().filter((m) => m.baseURL !== base);
  saveManualPlayers([...others, entry]);
  plexLog('info', `lecteur manuel ajoute: "${entry.name}" id=${machineId} base=${base}`);
  return {
    id: `manual|${base}`,
    targetClientIdentifier: machineId,
    name: entry.name,
    product: entry.product,
    platform: entry.platform,
    baseURL: base,
    connections: [base],
    source: 'manual',
    presence: true,
    displayName: entry.name,
  };
}

export async function fetchPlayersDetailed(
  baseURLString: string,
  token: string,
): Promise<{ players: PlexPlayerTarget[]; debug: PlayersDebug }> {
  if (!token.trim()) throw new PlexError('Token Plex manquant.');
  const byId = new Map<string, PlexPlayerTarget>();
  const debug: PlayersDebug = {
    rawResources: 0,
    keptResources: 0,
    clientsCount: 0,
    sessionsCount: 0,
    errors: [],
    filteredOut: [],
    devicesSummary: [],
    account: '',
    servers: [],
  };

  // Identité du compte vu par le token + appareils, en parallèle : une Fire
  // TV liée à un AUTRE compte Plex n'apparaîtra jamais dans /api/resources.
  // (Non bloquant : la détection continue même si l'un échoue.)
  let devices: Element[] = [];
  try {
    const [ares, devs] = await Promise.all([
      fetch(`https://plex.tv/api/v2/user?X-Plex-Token=${encodeURIComponent(token)}`, {
        headers: { 'X-Plex-Product': PRODUCT, 'X-Plex-Client-Identifier': PRODUCT, Accept: 'application/json' },
      }).catch(() => null),
      fetchResourcesDevices(token),
    ]);
    devices = devs;
    if (ares && ares.ok) {
      const u = (await ares.json()) as Record<string, unknown>;
      debug.account = `username=${String(u['username'] ?? '?')} home=${String(u['home'] ?? '?')} homeAdmin=${String(u['homeAdmin'] ?? '?')}`;
    } else if (ares) {
      debug.account = `illisible (HTTP ${ares.status})`;
    } else {
      debug.account = 'erreur réseau';
    }
  } catch (e) {
    debug.account = `erreur (${e instanceof Error ? e.message : String(e)})`;
    try {
      devices = await fetchResourcesDevices(token);
    } catch (e2) {
      debug.errors.push(`resources: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
  plexLog('info', `compte plex.tv -> ${debug.account || '?'}`);

  const upsert = (p: PlexPlayerTarget) => {
    const key = (p.targetClientIdentifier || '').toLowerCase();
    if (!key) return;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, p);
      return;
    }
    // Fusionne les sources : garde le token/connexions les plus riches.
    const conns = [...(existing.connections ?? []), ...(p.connections ?? [])].filter(Boolean);
    const uniqConns = [...new Set(conns)];
    // Préfère une baseURL LAN (/clients) à un relay cloud.
    const pickBase = (a?: string, b?: string) => {
      if (!a) return b;
      if (!b) return a;
      const aRelay = /plex\.direct|relay/i.test(a);
      const bRelay = /plex\.direct|relay/i.test(b);
      if (aRelay && !bRelay) return b;
      if (bRelay && !aRelay) return a;
      // Préfère le LAN (192.168/10./172.16) à une IP publique.
      const aLan = /^(https?:\/\/)?(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
      const bLan = /^(https?:\/\/)?(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b);
      if (!aLan && bLan) return b;
      return a;
    };
    byId.set(key, {
      ...existing,
      baseURL: pickBase(existing.baseURL, p.baseURL),
      connections: uniqConns,
      accessToken: existing.accessToken ?? p.accessToken,
      // En ligne si vu par AU MOINS une source en ligne.
      presence: existing.presence === true || p.presence === true ? true : (existing.presence ?? p.presence),
      source: existing.source.includes(p.source) ? existing.source : `${existing.source}+${p.source}`,
      product: existing.product || p.product,
      platform: existing.platform || p.platform,
      name: existing.name && existing.name !== 'Lecteur Plex' ? existing.name : p.name,
    });
  };

  const isFireTVLike = (product: string, platform: string, name: string): boolean => {
    const s = `${product} ${platform} ${name}`.toLowerCase();
    return s.includes('fire') || s.includes('aft') || s.includes('android (tv)') || s.includes('android tv') || s.includes('fire tv');
  };

  try {
    // `devices` déjà chargés en parallèle avec le compte : pas de 2e appel.
    if (devices.length === 0 && debug.errors.length === 0) {
      debug.errors.push('resources: aucun appareil renvoyé par plex.tv');
    }
    debug.rawResources = devices.length;
    plexLog('info', `plex.tv resources -> ${devices.length} appareil(s) brut(s)`);
    devices.forEach((d, i) => {
      const provides = (d.getAttribute('provides') ?? '').toLowerCase();
      const product = d.getAttribute('product') ?? '';
      const productL = product.toLowerCase();
      const name0 = d.getAttribute('name') ?? `appareil ${i}`;
      const plat0 = d.getAttribute('platform') ?? '';
      const presence0 = d.getAttribute('presence');
      const owned = d.getAttribute('owned');
      const hasId = !!(d.getAttribute('clientIdentifier') ?? d.getAttribute('machineIdentifier'));
      const nConns = d.getElementsByTagName('Connection').length;
      const hasToken = !!d.getAttribute('accessToken');
      const summary =
        `[R${i}] name="${name0}" product="${product}" platform="${plat0}" provides="${provides || '?'}" ` +
        `presence=${presence0 ?? '?'} owned=${owned ?? '?'} id=${hasId ? 'oui' : 'NON'} conns=${nConns} token=${hasToken ? 'oui' : 'non'}`;
      debug.devicesSummary.push(summary);
      plexLog('info', summary);
      // N'exclut que les purs serveurs (un Shield peut être server+player : on le garde).
      const isServerOnly = provides.includes('server') && !provides.includes('player') && !provides.includes('client') && !provides.includes('controller');
      if (isServerOnly) {
        debug.filteredOut.push({ name: name0, product, provides, reason: 'serveur uniquement' });
        return;
      }
      // Garde TOUT le reste : player/client/controller, produit Plex, ou provides vide/inconnu.
      // (Avant, certains clients Fire TV à provides atypique étaient jetés.)
      const looksPlayer =
        provides.includes('player') ||
        provides.includes('client') ||
        provides.includes('controller') ||
        productL.includes('plex') ||
        provides.trim() === '' ||
        true; // filet large : on ne jette plus rien ici sauf serveur pur
      if (!looksPlayer) {
        debug.filteredOut.push({ name: name0, product, provides, reason: 'filtre looksPlayer' });
        return;
      }
      const conns = deviceConnections(d);
      const best = conns[0];
      // Ne plus jeter les appareils sans identifiant (ancien code mettait un UUID de repli).
      const clientId =
        d.getAttribute('clientIdentifier') ?? d.getAttribute('machineIdentifier') ?? `noid-resources-${i}`;
      const name = d.getAttribute('name') ?? 'Lecteur Plex';
      const plat = d.getAttribute('platform') ?? '';
      const presenceRaw = d.getAttribute('presence');
      const presence = presenceRaw == null ? undefined : presenceRaw === '1';
      const urls = conns.map((c) => c.url);
      if (best) urls.unshift(best.url);
      upsert({
        id: `resources|${i}|${clientId}`,
        targetClientIdentifier: clientId,
        name,
        product,
        platform: plat,
        baseURL: best?.url,
        connections: [...new Set(urls)],
        accessToken: d.getAttribute('accessToken') ?? undefined,
        source: 'resources',
        presence,
        displayName: [name, product, plat].filter(Boolean).join(' • ') || 'resources',
      });
      debug.keptResources += 1;
    });
  } catch (e) {
    debug.errors.push(`resources: ${e instanceof Error ? e.message : String(e)}`);
  }

  // /clients + sessions sur TOUS les serveurs joignables : la TV peut être
  // connectée à n'importe lequel (debian2 ou Mac mini), pas forcément celui
  // configuré. Sans ça, un lecteur actif reste invisible.
  // `devices` déjà en main : pas de nouvel appel plex.tv.
  const serverCtxs = await resolveAllServerContexts(baseURLString, token, devices);
  debug.servers = serverCtxs.map((c) => c.baseURL);
  if (serverCtxs.length === 0) {
    debug.errors.push('aucun serveur Plex joignable');
  }
  for (const ctx of serverCtxs) {
    try {
      const clients = await getXML(`${ctx.baseURL}/clients`, token);
      const clientEls = Array.from(clients.getElementsByTagName('Server'));
      debug.clientsCount += clientEls.length;
      plexLog('info', `/clients sur ${ctx.baseURL} -> ${clientEls.length} lecteur(s)`);
      clientEls.forEach((el, i) => {
        const host = el.getAttribute('host') ?? el.getAttribute('address') ?? '';
        if (!host) return;
        const scheme = el.getAttribute('protocol') ?? 'http';
        // Les lecteurs Plex écoutent en général sur 32500 (Fire TV/Android),
        // 8324 (Roku), 32433 (desktop) — pas 32400 (serveur).
        const port = el.getAttribute('port') ?? '32500';
        const name = el.getAttribute('name') ?? 'Lecteur Plex';
        const machineId = el.getAttribute('machineIdentifier') ?? host;
        const baseURL = `${scheme}://${host}:${port}`;
        plexLog('info', `/clients: "${name}" [${el.getAttribute('product') ?? '?'}] -> ${baseURL}`);
        upsert({
          id: `clients|${i}|${machineId}`,
          targetClientIdentifier: machineId,
          name,
          product: el.getAttribute('product') ?? '',
          platform: el.getAttribute('platform') ?? '',
          baseURL,
          connections: [baseURL],
          source: 'clients',
          presence: true,
          displayName: name,
        });
      });
    } catch (e) {
      debug.errors.push(`/clients ${ctx.baseURL}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const sessions = await getXML(`${ctx.baseURL}/status/sessions`, token);
      const playerEls = Array.from(sessions.getElementsByTagName('Player'));
      debug.sessionsCount += playerEls.length;
      playerEls.forEach((el, i) => {
        // Ne plus jeter : repli sur un id local (lecture impossible mais visible).
        const machineId =
          el.getAttribute('machineIdentifier') ?? el.getAttribute('device') ?? `noid-session-${i}`;
        const name = el.getAttribute('title') ?? el.getAttribute('device') ?? 'Lecteur Plex';
        const address = el.getAttribute('address');
        const port = el.getAttribute('port');
        const direct = address && port ? `http://${address}:${port}` : undefined;
        upsert({
          id: `sessions|${i}|${machineId}`,
          targetClientIdentifier: machineId,
          name,
          product: el.getAttribute('product') ?? '',
          platform: el.getAttribute('platform') ?? '',
          baseURL: direct,
          connections: direct ? [direct] : [],
          source: 'sessions',
          presence: true,
          displayName: name,
        });
      });
    } catch (e) {
      debug.errors.push(`sessions ${ctx.baseURL}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Lecteurs manuels (ajoutés par IP) : testés en parallèle, jamais jetés.
  const manuals = getManualPlayers();
  await Promise.all(
    manuals.map(async (m) => {
      let presence: boolean | undefined;
      try {
        await probePlayerPresence(m.baseURL, token);
        presence = true;
      } catch {
        presence = false;
      }
      upsert({
        id: `manual|${m.baseURL}`,
        targetClientIdentifier: m.targetClientIdentifier,
        name: m.name,
        product: m.product,
        platform: m.platform,
        baseURL: m.baseURL,
        connections: [m.baseURL],
        source: 'manual',
        presence,
        displayName: m.name,
      });
      plexLog('info', `manuel ${m.baseURL} -> ${presence ? 'joignable' : 'injoignable (TV eteinte ou IP changee ?)'}`);
    }),
  );

  const players = [...byId.values()];
  if (debug.errors.length > 0) {
    for (const err of debug.errors) plexLog('warn', `erreur detection -> ${err}`);
  }
  plexLog(
    'info',
    `resultat: ${players.length} lecteur(s) (resources ${debug.keptResources}/${debug.rawResources}, ` +
      `/clients ${debug.clientsCount}, sessions ${debug.sessionsCount}, serveurs sondes ${debug.servers.length})` +
      (debug.filteredOut.length ? `, ecartes: ${debug.filteredOut.map((f) => `"${f.name}" (${f.reason})`).join(', ')}` : ''),
  );
  for (const p of players) {
    plexLog(
      'info',
      `lecteur: name="${p.name}" product="${p.product}" platform="${p.platform}" presence=${p.presence === true ? 'en-ligne' : p.presence === false ? 'hors-ligne' : '?'} source=${p.source} base=${p.baseURL ?? '?'}`,
    );
  }
  if (players.length === 0 && debug.errors.length > 0) throw new PlexError(debug.errors.join(' | '));
  // Libellé riche : statut + IP pour retrouver une Fire TV.
  for (const p of players) {
    const host = (() => {
      try {
        return p.baseURL ? new URL(p.baseURL).host : '';
      } catch {
        return '';
      }
    })();
    const status = p.presence === true ? 'en ligne' : p.presence === false ? 'hors ligne (ouvre l’app Plex)' : p.source;
    p.displayName = [p.name, p.product, p.platform].filter(Boolean).join(' • ') + ` — ${status}` + (host ? ` — ${host}` : '');
  }
  return {
    players: players.sort((a, b) => {
      const aOn = a.presence === true ? 0 : a.presence === false ? 2 : 1;
      const bOn = b.presence === true ? 0 : b.presence === false ? 2 : 1;
      if (aOn !== bOn) return aOn - bOn;
      const aFire = isFireTVLike(a.product, a.platform, a.name) ? 0 : 1;
      const bFire = isFireTVLike(b.product, b.platform, b.name) ? 0 : 1;
      if (aFire !== bFire) return aFire - bFire;
      return (a.name || '').localeCompare(b.name || '');
    }),
    debug,
  };
}

export async function fetchPlayers(baseURLString: string, token: string): Promise<PlexPlayerTarget[]> {
  const { players, debug } = await fetchPlayersDetailed(baseURLString, token);
  plexLog(
    'info',
    `lecteurs: ${players.length} (resources ${debug.keptResources}/${debug.rawResources}, clients ${debug.clientsCount}, sessions ${debug.sessionsCount})` +
      (debug.errors.length ? ` erreurs: ${debug.errors.join(' | ')}` : ''),
  );
  return players;
}

/** Résout un item lisible : film/épisode direct, série/saison -> épisode à lire. */
async function resolvePlayableItem(
  item: PlexLibraryItem,
  baseURLString: string,
  token: string,
): Promise<PlexLibraryItem> {
  const t = item.type.toLowerCase();
  if (t !== 'show' && t !== 'season') return item;
  // Série : premier épisode non vu, sinon S01E01.
  const seasons = await fetchShowSeasons(baseURLString, token, item.ratingKey);
  const ordered = [...seasons].sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999));
  let firstEp: PlexEpisodeItem | null = null;
  let firstUnwatched: PlexEpisodeItem | null = null;
  for (const s of ordered) {
    if (s.episodeCount === 0) continue;
    const eps = await fetchSeasonEpisodes(baseURLString, token, s.ratingKey);
    for (const ep of eps) {
      if (!firstEp) firstEp = ep;
      if (!ep.isWatched && !firstUnwatched) firstUnwatched = ep;
    }
    if (firstUnwatched) break;
  }
  const ep = firstUnwatched ?? firstEp;
  if (!ep) throw new PlexError('Aucun épisode lisible trouvé pour cette série.');
  return {
    id: ep.id,
    ratingKey: ep.ratingKey,
    title: ep.title,
    summary: ep.summary,
    type: 'episode',
    isWatched: ep.isWatched,
    posterURL: ep.posterURL,
  };
}

/** Lecture distante : crée une playQueue puis envoie playMedia (comme Swift / python-plexapi). */
export async function playOnPlayer(
  item: PlexLibraryItem,
  player: PlexPlayerTarget,
  baseURLString: string,
  token: string,
): Promise<void> {
  const playable = await resolvePlayableItem(item, baseURLString, token);
  plexLog('info', `lecture "${playable.title}" (${playable.type}/${playable.ratingKey}) -> "${player.name}" [${player.product}]`);
  if (player.presence === false) {
    plexLog('warn', `"${player.name}" hors ligne selon plex.tv : commande quand meme tentee (direct LAN en repli)`);
  }
  const mediaType = playable.type.toLowerCase() === 'track' || playable.type.toLowerCase() === 'album' ? 'audio' : 'video';
  const targetHeaders = plexHeaders(token, { 'X-Plex-Target-Client-Identifier': player.targetClientIdentifier });

  // 1) Via chaque serveur joignable : la TV peut être connectée à n'importe
  // lequel (pas forcément celui configuré). L'app officielle fait pareil :
  // playQueue sur LE serveur, puis playMedia relayé par LUI.
  const serverCtxs = await resolveAllServerContexts(baseURLString, token);
  if (serverCtxs.length === 0) throw new PlexError('Aucun serveur Plex joignable pour lancer la lecture.');
  let serverErr = '';
  let directCtx: ServerContext | null = null;
  let directQueueID = '';
  // Params partagés (sauf machineIdentifier/address/port/key/containerKey par serveur).
  const staticParams = new URLSearchParams({
    offset: '0',
    commandID: String(Date.now()),
    type: mediaType === 'audio' ? 'music' : 'video',
    providerIdentifier: 'com.plexapp.plugins.library',
    token,
  });
  // Timeout borné : via le relay plex.tv une requête peut pendre des minutes
  // sans jamais répondre ("ça ne fait rien", aucun message). 25 s puis on
  // passe au serveur suivant / au repli direct.
  const COMMAND_TIMEOUT_MS = 25000;
  const timeoutErr = (e: unknown) =>
    e instanceof Error && e.name === 'AbortError' ? 'délai dépassé (25 s, relay lent ?)' : e instanceof Error ? e.message : String(e);
  for (const ctx of serverCtxs) {
    try {
      const uri = `server://${ctx.machineIdentifier}/com.plexapp.plugins.library/library/metadata/${playable.ratingKey}`;
      const queueURL =
        `${ctx.baseURL}/playQueues?type=${mediaType === 'audio' ? 'audio' : 'video'}` +
        `&uri=${encodeURIComponent(uri)}&shuffle=0&repeat=0&continuous=1&own=1`;
      plexLog('info', `via serveur ${ctx.baseURL} -> creation playQueue...`);
      const queueRes = await fetchWithTimeout(
        queueURL,
        { method: 'POST', headers: { ...plexHeaders(token), Accept: 'application/json' } },
        COMMAND_TIMEOUT_MS,
      );
      if (!queueRes.ok) {
        serverErr = `${ctx.baseURL}: playQueue HTTP ${queueRes.status}`;
        plexLog('warn', `via serveur ${ctx.baseURL} -> ${serverErr}`);
        continue;
      }
      const queueText = await queueRes.text();
      const queueMatch = /playQueueID="(\d+)"/.exec(queueText) || /"playQueueID":\s*(\d+)/.exec(queueText);
      if (!queueMatch) {
        serverErr = `${ctx.baseURL}: reponse playQueue invalide`;
        continue;
      }
      // PlayQueue créée : mémorise pour le repli direct.
      directCtx = ctx;
      directQueueID = queueMatch[1];
      const serverURL = new URL(ctx.baseURL);
      // X-Plex-Target-Client-Identifier DOIT être un header, pas un query
      // param (sinon le serveur répond 200 sans rien jouer).
      const params = new URLSearchParams({
        machineIdentifier: ctx.machineIdentifier,
        protocol: serverURL.protocol.replace(':', ''),
        address: serverURL.hostname,
        port: serverURL.port || '32400',
        key: `/library/metadata/${playable.ratingKey}`,
        // window=xxx requis pour les lecteurs "oblivious" (Fire TV/Roku).
        containerKey: `/playQueues/${queueMatch[1]}?window=200&own=1`,
      });
      for (const [k, v] of staticParams) params.set(k, v);
      const viaServerURL = `${ctx.baseURL}/player/playback/playMedia?${params.toString()}`;
      plexLog(
        'info',
        `via serveur ${ctx.baseURL} -> envoi playMedia (queue ${queueMatch[1]}, key=/library/metadata/${playable.ratingKey}, ` +
          `target=${player.targetClientIdentifier}, serverMID=${ctx.machineIdentifier || 'VIDE!'})...`,
      );
      let playRes = await fetchWithTimeout(viaServerURL, { headers: targetHeaders }, COMMAND_TIMEOUT_MS);
      let body = await playRes.text().catch(() => '');
      // PMS 1.43+ répond parfois 404 en GET sur le proxy Companion : retente
      // une fois en POST avant de conclure (sans effet si la route a disparu).
      if (playRes.status === 404) {
        plexLog('info', `via serveur ${ctx.baseURL} -> GET 404, nouvel essai en POST...`);
        playRes = await fetchWithTimeout(viaServerURL, { method: 'POST', headers: targetHeaders }, COMMAND_TIMEOUT_MS);
        body = await playRes.text().catch(() => '');
      }
      plexLog('info', `via serveur ${ctx.baseURL} -> HTTP ${playRes.status} (${body.slice(0, 120) || 'corps vide'})`);
      if (playRes.ok) {
        // Le serveur répond 200 même quand le lecteur n'est pas connecté :
        // vérifie qu'il n'a pas renvoyé une erreur XML.
        if (/<Response[^>]*code="(4\d\d|5\d\d)"/.test(body)) {
          serverErr = `${ctx.baseURL}: ${body.slice(0, 200)}`;
        } else {
          plexLog('info', `via serveur ${ctx.baseURL} -> commande acceptee`);
          return;
        }
      } else {
        serverErr = `${ctx.baseURL}: HTTP ${playRes.status} ${body.slice(0, 200)}`;
      }
    } catch (e) {
      serverErr = `${ctx.baseURL}: ${timeoutErr(e)}`;
      plexLog('warn', `via serveur -> echec (${serverErr})`);
    }
  }

  // 2) Repli direct vers le lecteur (indispensable Fire TV/Roku en LAN).
  // NOTE iOS : requiert NSAllowsLocalNetworking (scripts/cap-ios-ats.cjs),
  // sinon le fetch http://192.168.x.x:32500 est bloqué par ATS.
  const directBases = [...new Set([player.baseURL, ...(player.connections ?? [])].filter(Boolean) as string[])];
  plexLog('info', `repli direct -> ${directBases.length} adresse(s) a essayer`);
  let directErr = '';
  // Params directs adossés à la playQueue créée sur le premier serveur OK.
  const params = (() => {
    const fallback = serverCtxs[0];
    const c = directCtx ?? fallback;
    const u = new URL(c.baseURL);
    const p = new URLSearchParams({
      machineIdentifier: c.machineIdentifier,
      protocol: u.protocol.replace(':', ''),
      address: u.hostname,
      port: u.port || '32400',
      offset: '0',
      commandID: String(Date.now()),
      type: mediaType === 'audio' ? 'music' : 'video',
      key: `/library/metadata/${playable.ratingKey}`,
      containerKey: `/playQueues/${directQueueID || '0'}?window=200&own=1`,
      providerIdentifier: 'com.plexapp.plugins.library',
      token,
    });
    return p;
  })();
  for (const base of directBases) {
    // Ne tente le direct que sur du http(s) LAN, pas sur un relay plex.direct
    // qui refusera le CORS depuis la WebView.
    try {
      const directURL = `${base.replace(/\/$/, '')}/player/playback/playMedia?${params.toString()}`;
      plexLog('info', `repli direct -> essai ${base}`);
      const res = await fetchWithTimeout(
        directURL,
        {
          headers: plexHeaders(player.accessToken ?? token, {
            'X-Plex-Target-Client-Identifier': player.targetClientIdentifier,
          }),
        },
        COMMAND_TIMEOUT_MS,
      );
      const body = await res.text().catch(() => '');
      plexLog('info', `repli direct ${base} -> HTTP ${res.status}`);
      if (res.ok && !/<Response[^>]*code="(4\d\d|5\d\d)"/.test(body)) return;
      directErr = `HTTP ${res.status} ${body.slice(0, 200)}`;
    } catch (e) {
      directErr = timeoutErr(e);
      plexLog('warn', `repli direct ${base} -> echec (${directErr})`);
    }
  }

  throw new PlexError(
    `Lecture Plex echouee sur ${player.name}. ` +
      `Serveur: ${serverErr || 'ok sans effet (lecteur non connecté ?)'}` +
      (directBases.length
        ? ` • Direct: ${directErr || 'injoignable'}`
        : ` • Pas d'adresse directe connue pour ce lecteur (ajoute sa IP via "Ajouter" : 192.168.1.x:32500)`) +
      ` Astuce Fire TV : ouvre l’app Plex sur la TV (même compte, même Wi-Fi), relance la détection, choisis le lecteur "en ligne".`,
  );
}

export { attr };
