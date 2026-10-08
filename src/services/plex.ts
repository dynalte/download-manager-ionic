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
  seasonIndex?: number;
  episodeIndex?: number;
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
  // Série / saison : uniquement si TOUS les épisodes sont vus.
  // viewCount / lastViewedAt sont incrémentés dès le 1er épisode.
  if (o.type === 'show' || o.type === 'season') {
    return o.leafCount > 0 && o.viewedLeafCount >= o.leafCount;
  }
  if (truthyFlag(o.viewedFlag)) return true;
  if (o.viewCount > 0) return true;
  if (o.lastViewedAt && o.lastViewedAt !== '' && o.lastViewedAt !== '0') return true;
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

/** IP privée (LAN) ? */
function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Extrait l'IP d'un hôte plex.direct (192-168-1-91.<hash>.plex.direct -> 192.168.1.91). */
function plexDirectIP(host: string): string | null {
  const m = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.[0-9a-f]+\.plex\.direct$/i.exec(host.trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]];
  if (parts.some((p) => +p > 255)) return null;
  return parts.join('.');
}

/**
 * URL https d'un LECTEUR via plex.direct (même mécanisme que les serveurs :
 * IP en pointillés + identifiant, certificat provisionné par plex.tv).
 * Permet de commander la TV depuis une page HTTPS (mixed-content sinon).
 * Retourne null si non constructible (pas une IPv4 ou pas d'identifiant).
 */
function httpsPlayerURL(ip: string, machineId: string, port: string): string | null {
  const cleanIP = ip.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanIP)) return null;
  if (cleanIP.split('.').some((p) => +p > 255)) return null;
  const hash = machineId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!hash) return null;
  const pp = port.trim() || '32500';
  return `https://${cleanIP.replace(/\./g, '-')}.${hash}.plex.direct:${pp}`;
}

/**
 * Adresse du serveur telle que le LECTEUR peut la joindre (le lecteur va y
 * chercher média + playQueue). Si lecteur et serveur sont sur le même LAN,
 * préfère le http://IP-locale:32400 (le plex.direct https externe est plus
 * lent et parfois injoignable depuis la TV).
 */
function serverAddressForPlayer(
  ctx: ServerContext,
  playerBase: string,
): { protocol: string; host: string; port: string } {
  let playerLan = false;
  try {
    playerLan = isPrivateHost(new URL(playerBase).hostname);
  } catch {
    /* ignore */
  }
  try {
    const u = new URL(ctx.baseURL);
    const embedded = plexDirectIP(u.hostname);
    if (playerLan && embedded && isPrivateHost(embedded)) {
      return { protocol: 'http', host: embedded, port: u.port || '32400' };
    }
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: u.port || '32400' };
  } catch {
    return { protocol: 'http', host: ctx.baseURL, port: '32400' };
  }
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
    if (!(await isPlexMediaServer(baseURL, token, CONN_PROBE_TIMEOUT_MS))) throw new PlexError('URL Plex invalide.');
    const info = await fetchMachineIdentifier(baseURL, token, CONN_PROBE_TIMEOUT_MS);
    return { baseURL, machineIdentifier: info.machineIdentifier, version: info.version };
  }
  // Cloud discovery via plex.tv : premier répondant gagne (pas d'attente
  // des connexions mortes en séquence).
  const devices = await fetchResourcesDevices(token);
  const servers = devices.filter((d) => {
    const provides = (d.getAttribute('provides') ?? '').toLowerCase();
    const product = (d.getAttribute('product') ?? '').toLowerCase();
    if (product.includes('media server')) return true;
    return provides.includes('server') && !provides.includes('player') && !provides.includes('client');
  });
  const cached = lastGoodServerURL().trim();
  const candidates: Array<{ url: string; machineId: string }> = [];
  for (const server of servers) {
    const machineId = server.getAttribute('clientIdentifier') ?? '';
    for (const conn of deviceConnections(server)) candidates.push({ url: conn.url, machineId });
  }
  candidates.sort((a, b) => (b.url === cached ? 1 : 0) - (a.url === cached ? 1 : 0));
  const winnerURL = await firstWinningConn(
    candidates.map((c) => c.url),
    token,
    CONN_PROBE_TIMEOUT_MS,
  );
  if (winnerURL) {
    saveLastGoodServerURL(winnerURL);
    const info = await fetchMachineIdentifier(winnerURL, token, CONN_PROBE_TIMEOUT_MS);
    return { baseURL: winnerURL, machineIdentifier: info.machineIdentifier, version: info.version };
  }
  throw new PlexError('Aucun serveur Plex accessible trouve via le cloud.');
}

/**
 * Tous les serveurs joignables (config + chaque serveur plex.tv).
 * La TV peut être connectée à n'importe lequel : la détection (/clients,
 * sessions) et la commande relayée doivent toutes les essayer, comme
 * l'app officielle qui sonde chaque connexion publiée.
 *
 * Les sondes ne cumulent plus les latences : premier répondant gagne
 * (pas d'attente des connexions mortes), timeout réel 10 s par connexion,
 * et dernière URL valide mémorisée (prioritaire à la prochaine détection).
 */
const CONN_PROBE_TIMEOUT_MS = 10000;
const LAST_SERVER_URL_KEY = 'plex_last_server_url';

function lastGoodServerURL(): string {
  try {
    return localStorage.getItem(LAST_SERVER_URL_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastGoodServerURL(url: string): void {
  try {
    localStorage.setItem(LAST_SERVER_URL_KEY, url);
  } catch {
    /* stockage indisponible */
  }
}

/** Ports d'écoute connus des lecteurs Plex (le 32500 n'est pas toujours ouvert). */
const PLAYER_PROBE_PORTS = ['32500', '32433', '8324', '3005', '32400', '8080', '8000', '8888'];

/** Première URL répondant comme PMS, sans attendre les connexions mortes. */
async function firstWinningConn(urls: string[], token: string, timeoutMs: number): Promise<string | null> {
  if (urls.length === 0) return null;
  return new Promise((resolve) => {
    let done = false;
    let settled = 0;
    for (const url of urls) {
      void (async () => {
        try {
          if (await isPlexMediaServer(url, token, timeoutMs)) {
            if (!done) {
              done = true;
              resolve(url);
            }
          }
        } catch {
          /* ignore : autre connexion tentée */
        }
        settled += 1;
        if (settled === urls.length && !done) resolve(null);
      })();
    }
  });
}

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
          if (await isPlexMediaServer(baseURL, token, CONN_PROBE_TIMEOUT_MS)) {
            const info = await fetchMachineIdentifier(baseURL, token, CONN_PROBE_TIMEOUT_MS).catch(() => ({
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
    // Dernière URL valide connue d'abord (cas courant : elle répond en premier).
    const cached = lastGoodServerURL().trim();
    await Promise.all(
      servers.map(async (server, si) => {
        const label = server.getAttribute('name') ?? 'serveur';
        // Premier répondant gagne : un serveur mort (ex Mac mini éteint,
        // IPs docker périmées) ne retarde plus la détection.
        const conns = deviceConnections(server);
        const ordered = [...conns].sort((a, b) => (b.url === cached ? 1 : 0) - (a.url === cached ? 1 : 0));
        const winnerURL = await firstWinningConn(
          ordered.map((c) => c.url),
          token,
          CONN_PROBE_TIMEOUT_MS,
        );
        const winner = winnerURL ? (ordered.find((c) => c.url === winnerURL) ?? null) : null;
        if (winner) {
          saveLastGoodServerURL(winner.url);
          const info = await fetchMachineIdentifier(winner.url, token, CONN_PROBE_TIMEOUT_MS).catch(() => ({
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

/**
 * Supprime un film ou une série de Plex ainsi que ses fichiers média.
 * Le serveur Plex doit autoriser la suppression des médias.
 */
export async function deletePlexMedia(
  baseURLString: string,
  token: string,
  ratingKey: string,
): Promise<void> {
  if (!ratingKey.trim()) throw new PlexError('Identifiant Plex manquant.');
  const ctx = await resolveServerContext(baseURLString, token);
  const url = `${ctx.baseURL}/library/metadata/${encodeURIComponent(ratingKey)}?X-Plex-Token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { method: 'DELETE', headers: plexHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new PlexError("Suppression refusée par Plex. Active l’autorisation de suppression des médias sur le serveur.");
    }
    throw new PlexError(`Suppression Plex impossible (${res.status}). ${body}`.trim());
  }
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

/**
 * Scan ciblé par type de média (films → sections movie, séries → show).
 * Utilisé en auto après un téléchargement terminé (0 si aucune section du type).
 */
export async function refreshLibrariesForType(
  baseURLString: string,
  token: string,
  sectionType: 'movie' | 'show',
): Promise<number> {
  const sections = await fetchSections(baseURLString, token);
  const keys = sections.filter((s) => s.type === sectionType).map((s) => s.key);
  if (keys.length === 0) return 0;
  return refreshLibraries(baseURLString, token, keys);
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
    }
    if (section.type !== 'show') continue;
    const seasonsUrl =
      `${ctx.baseURL}/library/sections/${section.key}/all?type=3` +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${perSectionLimit}&includeUserState=1`;
    const seasonsDoc = await getXML(seasonsUrl, settings.plexToken || token);
    for (const el of Array.from(seasonsDoc.getElementsByTagName('Directory'))) {
      const showTitle = decodeEntities(el.getAttribute('parentTitle') ?? el.getAttribute('grandparentTitle') ?? '');
      const normalized = normalizedTitleForMatching(showTitle);
      const seasonIndex = el.getAttribute('index') ? parseInt(el.getAttribute('index')!, 10) : NaN;
      if (!normalized || !Number.isFinite(seasonIndex)) continue;
      const leafCount = intAttr(el, 'leafCount');
      const viewedLeafCount = intAttr(el, 'viewedLeafCount');
      const isWatched = leafCount > 0 && viewedLeafCount >= leafCount;
      merged.set(`season|${normalized}|${seasonIndex}`, {
        normalizedTitle: normalized,
        type: 'season',
        isWatched,
        seasonIndex,
      });
    }
    const episodesUrl =
      `${ctx.baseURL}/library/sections/${section.key}/all?type=4&unwatched=0` +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${perSectionLimit}&includeUserState=1`;
    const episodesDoc = await getXML(episodesUrl, settings.plexToken || token);
    for (const el of Array.from(episodesDoc.getElementsByTagName('Video'))) {
      const rawType = (el.getAttribute('type') ?? 'episode').toLowerCase();
      if (rawType && rawType !== 'episode') continue;
      const showTitle = decodeEntities(el.getAttribute('grandparentTitle') ?? '');
      const normalized = normalizedTitleForMatching(showTitle);
      const seasonIndex = el.getAttribute('parentIndex') ? parseInt(el.getAttribute('parentIndex')!, 10) : NaN;
      const episodeIndex = el.getAttribute('index') ? parseInt(el.getAttribute('index')!, 10) : NaN;
      if (!normalized || !Number.isFinite(seasonIndex) || !Number.isFinite(episodeIndex)) continue;
      const watched = isWatchedFields({
        type: 'episode',
        viewCount: intAttr(el, 'viewCount'),
        viewedLeafCount: 0,
        leafCount: 0,
        lastViewedAt: el.getAttribute('lastViewedAt') ?? el.getAttribute('viewedAt') ?? undefined,
        viewedFlag: el.getAttribute('viewed') ?? undefined,
        viewOffset: intAttr(el, 'viewOffset'),
        durationMs: el.getAttribute('duration') ? parseInt(el.getAttribute('duration')!, 10) : undefined,
      });
      if (!watched) continue;
      merged.set(`episode|${normalized}|${seasonIndex}|${episodeIndex}`, {
        normalizedTitle: normalized,
        type: 'episode',
        isWatched: true,
        seasonIndex,
        episodeIndex,
      });
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
 * Sonde http://IP:PORT/resources et enregistre le lecteur.
 * Le 32500 n'est pas toujours ouvert (selon app/version) : replis sur les
 * autres ports d'écoute connus (desktop 32433, Roku 8324, PMP 3005).
 * NOTE : certains lecteurs ne répondent que pendant/après une lecture :
 * si ça échoue, lance une vidéo sur la TV puis réessaie (app au premier plan).
 */
export async function probeAndAddManualPlayer(
  hostOrURL: string,
  port: string,
  token: string,
): Promise<PlexPlayerTarget> {
  const firstBase = normalizePlayerBaseURL(hostOrURL, port);
  const triedPorts = [firstBase];
  for (const p of PLAYER_PROBE_PORTS) {
    try {
      const b = normalizePlayerBaseURL(hostOrURL, p);
      if (!triedPorts.includes(b)) triedPorts.push(b);
    } catch {
      /* ignore */
    }
  }
  const isHttpsPage = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const lanHttpBlocked = isHttpsPage && firstBase.startsWith('http://');
  let lastErr = '';
  for (const base of triedPorts) {
    try {
      const res = await fetchWithTimeout(`${base}/resources`, { headers: plexHeaders(token) }, 6000);
      const text = await res.text().catch(() => '');
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
        lastErr = `répond (HTTP ${res.status}) mais sans identifiant`;
        continue;
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
    } catch (e) {
      lastErr =
        e instanceof Error && e.name === 'AbortError'
          ? 'délai dépassé'
          : e instanceof Error
            ? e.message
            : String(e);
    }
  }
  throw new PlexError(
    `TV injoignable sur ${firstBase} (ports essayés : ${triedPorts.map((b) => b.split(':').pop()).join(', ')} — ${lastErr}). ` +
      (lanHttpBlocked
        ? `Page en HTTPS : le navigateur bloque le http:// local (mixed-content). Ouvre la PWA en http:// (port 8080) ou l'app native. `
        : `Vérifie l'IP (Réglages réseau de la Fire TV), le même Wi-Fi, et que l'app Plex est OUVERTE sur la TV (au premier plan). `),
  );
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
        try {
          const attrs = Array.from({ length: el.attributes.length }, (_, k) => `${el.attributes[k].name}=${el.attributes[k].value}`).join(' ');
          plexLog('info', `/clients attrs: ${attrs.slice(0, 500)}`);
        } catch {
          /* ignore */
        }
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
        try {
          const attrs = Array.from({ length: el.attributes.length }, (_, k) => `${el.attributes[k].name}=${el.attributes[k].value}`).join(' ');
          plexLog('info', `/sessions player attrs: ${attrs.slice(0, 600)}`);
        } catch {
          /* ignore */
        }
        // Ne plus jeter : repli sur un id local (lecture impossible mais visible).
        const machineId =
          el.getAttribute('machineIdentifier') ?? el.getAttribute('device') ?? `noid-session-${i}`;
        const name = el.getAttribute('title') ?? el.getAttribute('device') ?? 'Lecteur Plex';
        const address = el.getAttribute('address');
        const port = el.getAttribute('port');
        // Adresse sans port (cas Fire TV) : décline les ports d'écoute connus.
        // Le flux direct essaiera chacun jusqu'à acceptation (échecs rapides en LAN).
        // Variante https plex.direct (certificat plex.tv) pour les pages HTTPS.
        const playerBases: string[] = [];
        if (address) {
          const ports: string[] = [];
          for (const p of [port ?? '', ...PLAYER_PROBE_PORTS]) {
            const pp = p.trim();
            if (pp && !ports.includes(pp)) ports.push(pp);
          }
          for (const pp of ports) playerBases.push(`http://${address}:${pp}`);
          for (const pp of ports.slice(0, 2)) {
            const httpsURL = httpsPlayerURL(address, machineId, pp);
            if (httpsURL && !playerBases.includes(httpsURL)) playerBases.push(httpsURL);
          }
        }
        const direct = playerBases[0];
        upsert({
          id: `sessions|${i}|${machineId}`,
          targetClientIdentifier: machineId,
          name,
          product: el.getAttribute('product') ?? '',
          platform: el.getAttribute('platform') ?? '',
          baseURL: direct,
          connections: playerBases,
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

/** Lecture distante : crée une playQueue puis envoie playMedia (flux app officielle). */
export async function playOnPlayer(
  item: PlexLibraryItem,
  player: PlexPlayerTarget,
  baseURLString: string,
  token: string,
): Promise<void> {
  const playable = await resolvePlayableItem(item, baseURLString, token);
  plexLog('info', `lecture "${playable.title}" (${playable.type}/${playable.ratingKey}) -> "${player.name}" [${player.product}]`);
  if (player.presence === false) {
    plexLog('warn', `"${player.name}" hors ligne selon plex.tv : commande quand meme tentee`);
  }
  const mediaType = playable.type.toLowerCase() === 'track' || playable.type.toLowerCase() === 'album' ? 'audio' : 'video';
  const targetHeaders = plexHeaders(token, { 'X-Plex-Target-Client-Identifier': player.targetClientIdentifier });

  // Timeout borné : via le relay plex.tv une requête peut pendre des minutes
  // sans jamais répondre ("ça ne fait rien", aucun message). 25 s puis on
  // passe à la tentative suivante.
  const COMMAND_TIMEOUT_MS = 25000;
  const timeoutErr = (e: unknown) =>
    e instanceof Error && e.name === 'AbortError' ? 'délai dépassé (25 s, relay lent ?)' : e instanceof Error ? e.message : String(e);
  const serverCtxs = await resolveAllServerContexts(baseURLString, token);
  if (serverCtxs.length === 0) throw new PlexError('Aucun serveur Plex joignable pour lancer la lecture.');
  let serverErr = '';
  let queueCtx: ServerContext | null = null;
  let queueID = '';

  /** PlayQueue sur UN serveur (la file vit côté serveur, quel que soit l'accès). */
  async function createQueue(ctx: ServerContext): Promise<string> {
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
    if (!queueRes.ok) throw new PlexError(`playQueue HTTP ${queueRes.status}`);
    const queueText = await queueRes.text();
    const queueMatch = /playQueueID="(\d+)"/.exec(queueText) || /"playQueueID":\s*(\d+)/.exec(queueText);
    if (!queueMatch) throw new PlexError('reponse playQueue invalide');
    return queueMatch[1];
  }

  // 1) Flux officiel : playMedia DIRECTEMENT au lecteur (l'app officielle ne
  // passe pas par le relais serveur). Le lecteur va chercher média + file sur
  // le serveur : l'adresse fournie doit être joignable DEPUIS le lecteur
  // (LAN http:// si TV et serveur au même domicile).
  // Page HTTPS -> base http:// locale : le navigateur bloque (mixed-content)
  // AVANT tout réseau. Ces bases sont sautées (les variantes https plex.direct
  // restent essayées) ; si aucune ne passe, message explicite ci-dessous.
  const httpsPage = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const directBases = [...new Set([player.baseURL, ...(player.connections ?? [])].filter(Boolean) as string[])];
  const skippedHttp = httpsPage ? directBases.filter((b) => b.startsWith('http://')) : [];
  const triedBases = directBases.filter((b) => !b.startsWith('http://') || !httpsPage);
  let directErr = skippedHttp.length > 0 && triedBases.length === 0 ? 'bases http:// inaccessibles depuis une page HTTPS (mixed-content)' : '';
  if (triedBases.length > 0) {
    for (const ctx of serverCtxs) {
      try {
        queueID = await createQueue(ctx);
        queueCtx = ctx;
        break;
      } catch (e) {
        serverErr = `${ctx.baseURL}: ${timeoutErr(e)}`;
        plexLog('warn', `via serveur ${ctx.baseURL} -> ${serverErr}`);
      }
    }
    if (queueCtx) {
      const params = new URLSearchParams({
        offset: '0',
        commandID: String(Date.now()),
        type: mediaType === 'audio' ? 'music' : 'video',
        key: `/library/metadata/${playable.ratingKey}`,
        // window=xxx requis pour les lecteurs "oblivious" (Fire TV/Roku).
        containerKey: `/playQueues/${queueID}?window=200&own=1`,
        providerIdentifier: 'com.plexapp.plugins.library',
        token,
      });
      // Envoi parallèle, premier accepté gagne (8 ports × 25 s en séquence
      // serait interminable si filtrés ; en LAN les refus sont instantanés).
      const DIRECT_TIMEOUT_MS = 8000;
      const directWin = await new Promise<string | null>((resolve) => {
        if (triedBases.length === 0) {
          resolve(null);
          return;
        }
        let done = false;
        let settled = 0;
        for (const base of triedBases) {
          void (async () => {
            // Commande directe au lecteur (téléphone -> TV en LAN, ou https
            // plex.direct depuis une page HTTPS) : l'adresse serveur transmise
            // est celle joignable depuis le lecteur.
            const serverAddr = serverAddressForPlayer(queueCtx as ServerContext, base);
            const q = new URLSearchParams(params);
            q.set('machineIdentifier', (queueCtx as ServerContext).machineIdentifier);
            q.set('protocol', serverAddr.protocol);
            q.set('address', serverAddr.host);
            q.set('port', serverAddr.port);
            try {
              const directURL = `${base.replace(/\/$/, '')}/player/playback/playMedia?${q.toString()}`;
              if (!done) plexLog('info', `direct lecteur ${base} (serveur vu en ${serverAddr.protocol}://${serverAddr.host}:${serverAddr.port})...`);
              const res = await fetchWithTimeout(
                directURL,
                {
                  headers: plexHeaders(player.accessToken ?? token, {
                    'X-Plex-Target-Client-Identifier': player.targetClientIdentifier,
                  }),
                },
                DIRECT_TIMEOUT_MS,
              );
              const body = await res.text().catch(() => '');
              if (!done) plexLog('info', `direct ${base} -> HTTP ${res.status}`);
              if (res.ok && !/<Response[^>]*code="(4\d\d|5\d\d)"/.test(body)) {
                if (!done) {
                  done = true;
                  plexLog('info', `direct ${base} -> commande acceptee`);
                  resolve(base);
                }
                return;
              }
              if (!done) directErr = `HTTP ${res.status} ${body.slice(0, 200)}`;
            } catch (e) {
              if (!done) {
                directErr = timeoutErr(e);
                plexLog('warn', `direct ${base} -> echec (${directErr})`);
              }
            }
            settled += 1;
            if (settled === triedBases.length && !done) resolve(null);
          })();
        }
      });
      if (directWin) return;
    }
  }

  // 2) Repli historique : playMedia relayé PAR le serveur (PMS < 1.43 ;
  // PMS 1.43+ a supprimé la route -> 404 HTML, détecté ci-dessous).
  // Params partagés (sauf machineIdentifier/address/port/key/containerKey par serveur).
  const staticParams = new URLSearchParams({
    offset: '0',
    commandID: String(Date.now()),
    type: mediaType === 'audio' ? 'music' : 'video',
    providerIdentifier: 'com.plexapp.plugins.library',
    token,
  });
  for (const ctx of serverCtxs) {
    try {
      if (!queueID || queueCtx?.baseURL !== ctx.baseURL) {
        queueID = await createQueue(ctx);
        queueCtx = ctx;
      }
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
        containerKey: `/playQueues/${queueID}?window=200&own=1`,
      });
      for (const [k, v] of staticParams) params.set(k, v);
      const viaServerURL = `${ctx.baseURL}/player/playback/playMedia?${params.toString()}`;
      plexLog(
        'info',
        `via serveur ${ctx.baseURL} -> envoi playMedia (queue ${queueID}, key=/library/metadata/${playable.ratingKey}, ` +
          `target=${player.targetClientIdentifier}, serverMID=${ctx.machineIdentifier || 'VIDE!'})...`,
      );
      let playRes = await fetchWithTimeout(viaServerURL, { headers: targetHeaders }, COMMAND_TIMEOUT_MS);
      let body = await playRes.text().catch(() => '');
      // PMS 1.43+ : la route relais Companion a disparu (404 HTML, vérifié
      // GET+POST+PUT) — inutile de retenter en POST, la commande via
      // serveur est impossible sur ce PMS (repli : Plex Web + Cast).
      if (playRes.status === 404 && /<html/i.test(body)) {
        serverErr = `${ctx.baseURL}: relais playMedia supprimé par PMS (404)`;
        plexLog('warn', `via serveur ${ctx.baseURL} -> ${serverErr}`);
        break;
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

  throw new PlexError(
    `Lecture Plex echouee sur ${player.name}. ` +
      `Serveur: ${serverErr || 'ok sans effet (lecteur non connecté ?)'}` +
      (triedBases.length
        ? ` • Direct lecteur: ${directErr || 'injoignable'}`
        : directBases.length
          ? ` • Direct lecteur: ${directErr}`
          : ` • Pas d'adresse directe connue pour ce lecteur (ajoute sa IP via "Ajouter", ou lance une lecture sur la TV puis Actualiser : son adresse apparaîtra)`) +
      (/relais playMedia supprimé/.test(serverErr)
        ? ` Contournement : « Lire dans le navigateur » (Plex Web), puis l’icône Cast de Plex Web vers la Fire TV.`
        : ` Astuce Fire TV : ouvre l’app Plex sur la TV (même compte, même Wi-Fi), relance la détection, choisis le lecteur "en ligne".`),
  );
}

/** URL Plex Web (app.plex.tv) : lecture dans le navigateur, sans lecteur distant. */
export function buildPlexWebURL(machineIdentifier: string, ratingKey: string): string {
  return `https://app.plex.tv/desktop/#!/server/${encodeURIComponent(machineIdentifier)}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
}

/**
 * Repli quand aucun lecteur distant n'est visible (/clients + sessions vides,
 * TV éteinte ou autre compte) : ouvre le média dans Plex Web, qui lit
 * directement depuis le serveur (séries -> épisode à lire résolu auto).
 */
export async function resolvePlexWebURL(
  item: PlexLibraryItem,
  baseURLString: string,
  token: string,
): Promise<{ url: string; title: string }> {
  const ctxs = await resolveAllServerContexts(baseURLString, token);
  if (ctxs.length === 0) throw new PlexError('Aucun serveur Plex joignable pour ouvrir Plex Web.');
  const playable = await resolvePlayableItem(item, ctxs[0].baseURL, token);
  if (!ctxs[0].machineIdentifier) throw new PlexError('Identifiant serveur Plex introuvable (recharge les bibliothèques).');
  return { url: buildPlexWebURL(ctxs[0].machineIdentifier, playable.ratingKey), title: playable.title };
}

export { attr };
