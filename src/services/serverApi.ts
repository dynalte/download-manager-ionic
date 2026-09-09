/**
 * Appels authentifiés vers l'API perso (api-download-manager.php).
 * Config (URL + token) : Réglages > Synchro vus.
 */
import { settings } from './settings';

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
