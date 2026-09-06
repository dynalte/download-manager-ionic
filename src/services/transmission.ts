/**
 * Port de TorrentUploadService.swift — API RPC Transmission.
 * Gère le header X-Transmission-Session-Id + Basic Auth.
 */
import { settings } from './settings';
import { AppConfig } from '../config/appConfig';

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

function baseRequest(sessionID?: string): HeadersInit {
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
  const res = await fetch(rpcURL(), { method: 'POST', headers: baseRequest() });
  const sessionID = res.headers.get('X-Transmission-Session-Id');
  if (!sessionID) {
    // Transmission renvoie 409 + header ; certains proxys le mettent dans le body.
    // On relit quand même le header (insensible à la casse déjà géré par fetch).
    throw new TorrentUploadError("Le serveur Transmission n'a pas retourne de session ID.");
  }
  return sessionID;
}

/** Récupère un session-id valide (avec retry sur 409). */
async function withSession<T>(fn: (sessionID: string) => Promise<Response>): Promise<T> {
  let sessionID = await fetchSessionID().catch(() => '');
  let res = await fn(sessionID);
  if (res.status === 409) {
    const retry = res.headers.get('X-Transmission-Session-Id');
    if (!retry) throw new TorrentUploadError("Le serveur Transmission n'a pas retourne de session ID.");
    res = await fn(retry);
  }
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new TorrentUploadError(`Le serveur a retourne ${res.status}. ${body}`);
  }
  const json = (await res.json()) as { result: string; arguments?: unknown };
  if (json.result !== 'success') {
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
      fetch(rpcURL(), {
        method: 'POST',
        headers: baseRequest(sessionID),
        body: JSON.stringify(payload),
      }),
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
      fetch(rpcURL(), {
        method: 'POST',
        headers: baseRequest(sessionID),
        body: JSON.stringify(payload),
      }),
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
        fetch(rpcURL(), {
          method: 'POST',
          headers: baseRequest(sessionID),
          body: JSON.stringify(payload),
        }),
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
    fetch(rpcURL(), {
      method: 'POST',
      headers: baseRequest(sessionID),
      body: JSON.stringify(payload),
    }),
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
