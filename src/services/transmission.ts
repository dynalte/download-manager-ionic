/**
 * Port de TorrentUploadService.swift — API RPC Transmission.
 * Gère le header X-Transmission-Session-Id + Basic Auth.
 */
import { settings } from './settings';
import { AppConfig } from '../config/appConfig';
import { appLog } from './debugLog';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export class TorrentUploadError extends Error {}

/** Réponse torrent-add : l'élément réellement créé (ou déjà présent). */
export interface TorrentAddInfo {
  id: number;
  name: string;
  hashString: string;
}

export interface TorrentAddResult {
  added?: TorrentAddInfo;
  duplicate?: TorrentAddInfo;
}

interface TorrentAddArguments {
  'torrent-added'?: TorrentAddInfo;
  'torrent-duplicate'?: TorrentAddInfo;
}

function toAddResult(args: TorrentAddArguments | null | undefined): TorrentAddResult {
  if (!args || typeof args !== 'object') return {};
  const out: TorrentAddResult = {};
  if (args['torrent-added']) out.added = args['torrent-added'];
  if (args['torrent-duplicate']) out.duplicate = args['torrent-duplicate'];
  return out;
}

export type TransmissionStatus =
  | 'stopped'
  | 'checkWait'
  | 'checking'
  | 'downloadWait'
  | 'downloading'
  | 'seedWait'
  | 'seeding'
  | 'unknown';

export interface TransmissionDownloadItem {
  id: number;
  name: string;
  percentDone: number;
  rateDownload: number;
  uploadRatio: number;
  eta: number;
  status: number;
  statusLabel: string;
  isFinished: boolean;
  errorString: string;
  /** Taille totale du torrent en octets (totalSize Transmission). */
  totalSize: number;
  /** Dossier de téléchargement du torrent (downloadDir Transmission). */
  downloadDir: string;
}

export function statusLabel(status: number): string {
  switch (status) {
    case 0:
      return 'Arrete';
    case 1:
      return 'En attente de verification';
    case 2:
      return 'Verification';
    case 3:
      return 'En attente';
    case 4:
      return 'Telechargement';
    case 5:
      return 'Attente seed';
    case 6:
      return 'Seed';
    default:
      return 'Inconnu';
  }
}

function rpcURL(): string {
  const s = settings.transmissionRPCURL.trim();
  return s === '' ? AppConfig.transmissionRPCURL : s;
}

/** Vrai sur l'exe Windows : le RPC passe par le main (pas de CORS). */
function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.desktop?.isElectron;
}

async function electronRpc<T>(payload: Record<string, unknown>): Promise<T> {
  const d = typeof window !== 'undefined' ? window.desktop : undefined;
  if (!d?.transmissionRpc) throw new TorrentUploadError('Bridge desktop indisponible.');
  try {
    const out = await d.transmissionRpc({
      url: rpcURL(),
      username: settings.transmissionUsername,
      password: settings.transmissionPassword,
      payload,
    });
    return out as unknown as T;
  } catch (e) {
    throw new TorrentUploadError(e instanceof Error ? e.message : String(e));
  }
}

function baseRequest(sessionID?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionID) headers['X-Transmission-Session-Id'] = sessionID;
  const username = settings.transmissionUsername;
  const password = settings.transmissionPassword;
  if (username !== '' || password !== '') {
    headers['Authorization'] = 'Basic ' + btoa(`${username}:${password}`);
  }
  return headers;
}

async function fetchSessionID(): Promise<string> {
  let res: RpcResponse;
  try {
    res = await rpcPost(baseRequest(), undefined);
  } catch (e) {
    appLog('error', 'transmission', `session-id : réseau injoignable (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`);
    throw e instanceof Error ? e : new Error(String(e));
  }
  const sessionID = res.headers.get('X-Transmission-Session-Id');
  if (!sessionID) {
    // Transmission renvoie 409 + header ; certains proxys le mettent dans le body.
    // On relit quand même le header (insensible à la casse déjà géré par fetch).
    appLog('error', 'transmission', `session-id : HTTP ${res.status} sans header de session`);
    throw new TorrentUploadError("Le serveur Transmission n'a pas retourne de session ID.");
  }
  return sessionID;
}

/** Réponse RPC minimale (fetch WebView ou CapacitorHttp natif). */
export interface RpcResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}

/**
 * POST RPC : requêtes natives via CapacitorHttp sur iOS/Android (pas de
 * CORS/preflight WebView — Transmission 4.1 ne répond plus les headers
 * CORS au OPTIONS, contrairement à la 4.0), fetch sinon.
 */
async function rpcPost(headers: Record<string, string>, body?: string): Promise<RpcResponse> {
  if (Capacitor.isNativePlatform()) {
    let res;
    try {
      res = await CapacitorHttp.post({
        url: rpcURL(),
        headers,
        data: body ?? '',
        connectTimeout: 15000,
        readTimeout: 90000,
        responseType: 'text',
      });
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    const rawHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) rawHeaders[k.toLowerCase()] = String(v);
    const textBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    return {
      status: res.status,
      headers: { get: (name: string) => rawHeaders[name.toLowerCase()] ?? null },
      text: async () => textBody,
      json: async () => JSON.parse(textBody || '{}') as unknown,
    };
  }
  const res = await fetch(rpcURL(), { method: 'POST', headers, body });
  return {
    status: res.status,
    headers: { get: (name: string) => res.headers.get(name) },
    text: () => res.text(),
    json: () => res.json(),
  };
}

/** Récupère un session-id valide (avec retry sur 409). */
async function withSession<T>(fn: (sessionID: string) => Promise<RpcResponse>): Promise<T> {
  let sessionID = await fetchSessionID().catch(() => '');
  let res: RpcResponse;
  try {
    res = await fn(sessionID);
  } catch (e) {
    appLog('error', 'transmission', `rpc : réseau injoignable (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`);
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (res.status === 409) {
    const retry = res.headers.get('X-Transmission-Session-Id');
    if (!retry) throw new TorrentUploadError("Le serveur Transmission n'a pas retourne de session ID.");
    try {
      res = await fn(retry);
    } catch (e) {
      appLog('error', 'transmission', `rpc (retry 409) : réseau injoignable (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    appLog('error', 'transmission', `rpc : HTTP ${res.status} (${body.slice(0, 200)})`);
    throw new TorrentUploadError(`Le serveur a retourne ${res.status}. ${body}`);
  }
  const json = (await res.json()) as { result: string; arguments?: unknown };
  if (json.result !== 'success') {
    appLog('error', 'transmission', `rpc : résultat "${json.result}"`);
    throw new TorrentUploadError(`Transmission a retourne une erreur: ${json.result}`);
  }
  return json.arguments as T;
}

export async function uploadTorrentData(data: Uint8Array | ArrayBuffer, downloadDir?: string): Promise<TorrentAddResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  const metainfo = btoa(binary);
  const payload = {
    method: 'torrent-add',
    tag: 1,
    arguments: { metainfo, paused: false, 'download-dir': downloadDir ?? undefined },
  };
  if (isElectron()) {
    return toAddResult(await electronRpc<TorrentAddArguments>(payload));
  }
  return toAddResult(
    await withSession<TorrentAddArguments>(async (sessionID) =>
      rpcPost(baseRequest(sessionID), JSON.stringify(payload)),
    ),
  );
}

export async function uploadMagnet(url: string, downloadDir?: string): Promise<TorrentAddResult> {
  const payload = {
    method: 'torrent-add',
    tag: 1,
    arguments: { filename: url, paused: false, 'download-dir': downloadDir ?? undefined },
  };
  if (isElectron()) {
    return toAddResult(await electronRpc<TorrentAddArguments>(payload));
  }
  return toAddResult(
    await withSession<TorrentAddArguments>(async (sessionID) =>
      rpcPost(baseRequest(sessionID), JSON.stringify(payload)),
    ),
  );
}

interface TorrentGetArguments {
  torrents: Array<{
    id: number;
    name: string;
    percentDone: number;
    rateDownload: number;
    uploadRatio: number;
    eta: number;
    status: number;
    isFinished: boolean;
    errorString: string;
    totalSize: number;
    downloadDir: string;
  }>;
}

export async function fetchDownloads(): Promise<TransmissionDownloadItem[]> {
  const payload = {
    method: 'torrent-get',
    tag: 2,
    arguments: {
      fields: [
        'id',
        'name',
        'percentDone',
        'rateDownload',
        'uploadRatio',
        'eta',
        'status',
        'isFinished',
        'errorString',
        'totalSize',
        'downloadDir',
      ],
    },
  };
  const args = isElectron()
    ? await electronRpc<TorrentGetArguments>(payload)
    : await withSession<TorrentGetArguments>(async (sessionID) =>
        rpcPost(baseRequest(sessionID), JSON.stringify(payload)),
      );
  return (args.torrents ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    percentDone: t.percentDone,
    rateDownload: t.rateDownload,
    uploadRatio: t.uploadRatio,
    eta: t.eta,
    status: t.status,
    statusLabel: statusLabel(t.status),
    isFinished: t.isFinished,
    errorString: t.errorString ?? '',
    totalSize: typeof t.totalSize === 'number' ? t.totalSize : 0,
    downloadDir: typeof t.downloadDir === 'string' ? t.downloadDir : '',
  }));
}

export async function removeTorrent(id: number, deleteLocalData = true): Promise<void> {
  const payload = {
    method: 'torrent-remove',
    tag: 3,
    arguments: { ids: [id], deleteLocalData },
  };
  if (isElectron()) {
    await electronRpc<unknown>(payload);
    return;
  }
  await withSession<unknown>(async (sessionID) =>
    rpcPost(baseRequest(sessionID), JSON.stringify(payload)),
  );
}

/** Télécharge un .torrent via l'URL (avec cookies du WebView impossible en iframe cross-origin :
 *  on fait un fetch direct, avec Referer de la page). Port de downloadTorrent(). */
export async function downloadTorrentBytes(url: string, referer?: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const headers: Record<string, string> = {};
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { credentials: 'include', headers });
  if (!res.ok) throw new TorrentUploadError(`Telechargement torrent impossible (${res.status}).`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const disp = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disp);
  let filename = m ? decodeURIComponent(m[1].replace(/"/g, '').trim()) : url.split('?')[0].split('/').pop() || 'download.torrent';
  filename = filename.trim() === '' ? 'download.torrent' : filename;
  if (!filename.toLowerCase().endsWith('.torrent')) filename += '.torrent';
  return { bytes: buf, filename };
}
