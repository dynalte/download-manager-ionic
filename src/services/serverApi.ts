/**
 * Appels authentifiés vers l'API perso (api-download-manager.php).
 * Config (URL + token) : Réglages > Synchro vus.
 */
import { settings } from './settings';
import { fetchSessionStats } from './transmission';
import { appLog } from './debugLog';

export function isServerConfigured(): boolean {
  return settings.seenSyncURL !== '' && settings.seenSyncToken !== '';
}

export async function serverApi(action: string, body?: unknown): Promise<any> {
  const base = settings.seenSyncURL.replace(/\/$/, '');
  const res = await fetch(`${base}?action=${encodeURIComponent(action)}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-API-Token': settings.seenSyncToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Serveur perso : HTTP ${res.status}.`);
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data || data.ok !== true) throw new Error(`Serveur perso : ${data?.error || 'réponse invalide'}.`);
  return data;
}

/** Diagnostic affiché dans Réglages : ping + compteurs vus/suivis. */
export async function testServerConnection(): Promise<string> {
  if (!isServerConfigured()) {
    return 'Renseigne l’URL et le token avant de tester.';
  }
  const ping = (await serverApi('ping')) as { time?: number };
  const seen = (await serverApi('list')) as { seen?: unknown[] };
  const subs = (await serverApi('subs_list')) as { subs?: unknown[] };
  const nSeen = Array.isArray(seen.seen) ? seen.seen.length : 0;
  const nSubs = Array.isArray(subs.subs) ? subs.subs.length : 0;
  const when = ping.time ? new Date(ping.time * 1000).toLocaleTimeString() : '?';
  return `OK (serveur ${when}) : ${nSeen} déjà vu, ${nSubs} série(s) suivie(s).`;
}

/**
 * Rattrapage d'effacement : Transmission oublie parfois des données en
 * silence (bug upstream #5361). Après un torrent-remove réussi, efface le
 * résidu éventuel côté serveur (best effort, false si non configuré/échec).
 * location = downloadDir de session, name = racine du torrent.
 */
export async function wipeRemoteFiles(location: string, name: string): Promise<boolean> {
  if (!isServerConfigured()) return false;
  if (!location.trim() || !name.trim()) return false;
  try {
    const res = (await serverApi('files_wipe', { location: location.trim(), name: name.trim() })) as {
      deleted?: boolean;
    };
    return res.deleted === true;
  } catch {
    return false;
  }
}

export interface DiskSpace {
  /** Octets libres. */
  freeBytes: number;
  /** Octets totaux (0 si inconnus — ex : repli Transmission). */
  totalBytes: number;
  /** Source effective : API PHP perso ou RPC Transmission. */
  source: 'php' | 'transmission';
  /** Chemin mesuré (renvoyé par le PHP, si présent). */
  path?: string;
}

function toBytes(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Espace disque disponible : API PHP perso (`action=disk_space`) en priorité,
 * repli sur Transmission `session-stats` (espace libre du dossier de
 * téléchargement). Le format PHP est tolérant : `free` / `free_bytes` /
 * `available` (+ `total` / `total_bytes` / `size`, `path` optionnels).
 */
export async function fetchDiskSpace(): Promise<DiskSpace> {
  if (isServerConfigured()) {
    try {
      const d = (await serverApi('disk_space')) as Record<string, unknown>;
      const free = toBytes(d['freeBytes'] ?? d['free_bytes'] ?? d['free'] ?? d['available'] ?? d['available_bytes']);
      if (free !== null) {
        const total = toBytes(d['totalBytes'] ?? d['total_bytes'] ?? d['total'] ?? d['size'] ?? d['size_bytes']) ?? 0;
        const path = typeof d['path'] === 'string' && d['path'].trim() !== '' ? d['path'].trim() : undefined;
        return { freeBytes: free, totalBytes: total, source: 'php', path };
      }
      appLog('warn', 'disk', 'PHP disk_space sans champ libre exploitable.');
    } catch (e) {
      appLog('warn', 'disk', `PHP disk_space indisponible (${e instanceof Error ? e.message : String(e)}) : repli Transmission.`);
    }
  } else {
    appLog('info', 'disk', 'API PHP non configurée : repli Transmission.');
  }
  const stats = await fetchSessionStats();
  appLog('info', 'disk', `Transmission download-dir-free-space = ${stats.downloadDirFreeSpace}.`);
  return { freeBytes: stats.downloadDirFreeSpace, totalBytes: 0, source: 'transmission' };
}
