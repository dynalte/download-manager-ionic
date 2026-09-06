/**
 * Port de PlexService.swift (~1950 lignes) vers TypeScript.
 * Même API publique, parsing XML via DOMParser (au lieu de regex Swift).
 */
import { settings } from './settings';

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
  accessToken?: string;
  source: string;
  displayName: string;
}

export interface PlexLinkRecord {
  normalizedTitle: string;
  type: string;
  isWatched: boolean;
}

interface ServerContext {
  baseURL: string;
  machineIdentifier: string;
}

const PRODUCT = 'DownloadManager';

function plexHeaders(token: string, extra: Record<string, string> = {}): HeadersInit {
  return {
    'X-Plex-Token': token,
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': PRODUCT,
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

async function getXML(url: string, token: string): Promise<Document> {
  const res = await fetch(url, { headers: plexHeaders(token) });
  if (!res.ok) throw new PlexError(`Plex a retourne ${res.status}. ${await res.text().catch(() => '')}`);
  const text = await res.text();
  return new DOMParser().parseFromString(text, 'text/xml');
}

async function isPlexMediaServer(baseURL: string, token: string): Promise<boolean> {
  try {
    const doc = await getXML(`${baseURL}/library/sections`, token);
    return doc.getElementsByTagName('Directory').length > 0;
  } catch {
    return false;
  }
}

async function fetchMachineIdentifier(baseURL: string, token: string): Promise<string> {
  const res = await fetch(baseURL, { headers: plexHeaders(token) });
  const text = await res.text();
  const m = /machineIdentifier="([^"]+)"/.exec(text);
  if (!m) throw new PlexError('Reponse Plex invalide.');
  return m[1];
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
    return { baseURL, machineIdentifier: await fetchMachineIdentifier(baseURL, token) };
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
          return { baseURL: conn.url, machineIdentifier: await fetchMachineIdentifier(conn.url, token) };
        }
      } catch {
        /* essayer la connexion suivante */
      }
    }
  }
  throw new PlexError('Aucun serveur Plex accessible trouve via le cloud.');
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

/** Lecteurs : cloud (plex.tv resources) + serveur (/clients, sessions, devices). */
export async function fetchPlayers(baseURLString: string, token: string): Promise<PlexPlayerTarget[]> {
  if (!token.trim()) throw new PlexError('Token Plex manquant.');
  const players: PlexPlayerTarget[] = [];
  let firstError: unknown = null;

  try {
    const devices = await fetchResourcesDevices(token);
    devices.forEach((d, i) => {
      const provides = (d.getAttribute('provides') ?? '').toLowerCase();
      const product = (d.getAttribute('product') ?? '').toLowerCase();
      if (product.includes('media server')) return;
      if (provides.includes('server') && !provides.includes('player') && !provides.includes('client')) return;
      if (!(provides.includes('player') || provides.includes('client') || product.includes('plex'))) return;
      const conns = deviceConnections(d);
      const best = conns[0];
      const clientId = d.getAttribute('clientIdentifier') ?? d.getAttribute('machineIdentifier') ?? crypto.randomUUID();
      const name = d.getAttribute('name') ?? 'Lecteur Plex';
      const prod = d.getAttribute('product') ?? '';
      const plat = d.getAttribute('platform') ?? '';
      players.push({
        id: `resources|${i}|${clientId}`,
        targetClientIdentifier: clientId,
        name,
        product: prod,
        platform: plat,
        baseURL: best?.url,
        accessToken: d.getAttribute('accessToken') ?? undefined,
        source: 'resources',
        displayName: [name, prod, plat].filter(Boolean).join(' • ') || 'resources',
      });
    });
  } catch (e) {
    firstError = e;
  }

  try {
    const ctx = await resolveServerContext(baseURLString, token);
    const clients = await getXML(`${ctx.baseURL}/clients`, token);
    Array.from(clients.getElementsByTagName('Server')).forEach((el, i) => {
      const host = el.getAttribute('host') ?? el.getAttribute('address') ?? '';
      if (!host) return;
      const scheme = el.getAttribute('protocol') ?? 'http';
      const port = el.getAttribute('port') ?? '32400';
      const name = el.getAttribute('name') ?? 'Lecteur Plex';
      const machineId = el.getAttribute('machineIdentifier') ?? host;
      players.push({
        id: `clients|${i}|${machineId}`,
        targetClientIdentifier: machineId,
        name,
        product: el.getAttribute('product') ?? '',
        platform: el.getAttribute('platform') ?? '',
        baseURL: `${scheme}://${host}:${port}`,
        source: 'clients',
        displayName: name,
      });
    });
    const sessions = await getXML(`${ctx.baseURL}/status/sessions`, token);
    Array.from(sessions.getElementsByTagName('Player')).forEach((el, i) => {
      const machineId = el.getAttribute('machineIdentifier') ?? el.getAttribute('device') ?? crypto.randomUUID();
      const name = el.getAttribute('title') ?? el.getAttribute('device') ?? 'Lecteur Plex';
      players.push({
        id: `sessions|${i}|${machineId}`,
        targetClientIdentifier: machineId,
        name,
        product: el.getAttribute('product') ?? '',
        platform: el.getAttribute('platform') ?? '',
        source: 'sessions',
        displayName: name,
      });
    });
  } catch (e) {
    if (!firstError) firstError = e;
  }

  if (players.length === 0 && firstError) throw firstError;
  return players.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Lecture distante : crée une playQueue puis envoie playMedia (comme Swift). */
export async function playOnPlayer(
  item: PlexLibraryItem,
  player: PlexPlayerTarget,
  baseURLString: string,
  token: string,
): Promise<void> {
  const ctx = await resolveServerContext(baseURLString, token);
  const mediaType = item.type.toLowerCase() === 'track' || item.type.toLowerCase() === 'album' ? 'audio' : 'video';
  const uri = `server://${ctx.machineIdentifier}/com.plexapp.plugins.library/library/metadata/${item.ratingKey}`;
  const queueURL =
    `${ctx.baseURL}/playQueues?type=${mediaType === 'audio' ? 'audio' : 'video'}` +
    `&uri=${encodeURIComponent(uri)}&shuffle=0&repeat=0&continuous=1&own=1`;
  const queueRes = await fetch(queueURL, {
    method: 'POST',
    headers: { ...plexHeaders(token), Accept: 'application/json' },
  });
  if (!queueRes.ok) throw new PlexError(`Plex a retourne ${queueRes.status}.`);
  const queueText = await queueRes.text();
  const queueMatch = /playQueueID="(\d+)"/.exec(queueText) || /"playQueueID":\s*(\d+)/.exec(queueText);
  if (!queueMatch) throw new PlexError('Reponse Plex invalide.');
  const queueID = queueMatch[1];

  const serverURL = new URL(ctx.baseURL);
  const params = new URLSearchParams({
    machineIdentifier: ctx.machineIdentifier,
    protocol: serverURL.protocol.replace(':', ''),
    address: serverURL.hostname,
    port: serverURL.port || '32400',
    offset: '0',
    commandID: String(Date.now()),
    type: mediaType === 'audio' ? 'music' : 'video',
    key: `/library/metadata/${item.ratingKey}`,
    containerKey: `/playQueues/${queueID}?own=1`,
    providerIdentifier: 'com.plexapp.plugins.library',
    token,
    'X-Plex-Target-Client-Identifier': player.targetClientIdentifier,
  });
  const playURL = `${ctx.baseURL}/player/playback/playMedia?${params.toString()}`;
  const playRes = await fetch(playURL, { headers: plexHeaders(player.accessToken ?? token) });
  if (!playRes.ok) throw new PlexError(`Lecture Plex echouee: ${playRes.status} ${await playRes.text().catch(() => '')}`);
}

export { attr };
