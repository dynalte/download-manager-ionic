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
