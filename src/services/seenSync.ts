/**
 * Synchro des « déjà vu » vers l'API perso (api-download-manager.php, SQLite).
 * Offline-first : le localStorage reste la source immédiate ; le serveur
 * sert de partage inter-appareils (union local + distant). Sans URL/token
 * configurés, tout reste 100 % local.
 */
import { isServerConfigured, serverApi } from './serverApi';
import {
  loadSeenSuggestions,
  markSeenSuggestion,
  clearSeenSuggestions,
  replaceSeenSuggestions,
  seenKeyFor,
  type SeenSuggestion,
} from './seenSuggestions';

export function isSeenSyncConfigured(): boolean {
  return isServerConfigured();
}

async function api(action: 'list' | 'add' | 'clear' | 'ping', body?: unknown): Promise<any> {
  return serverApi(action, body);
}

/** Charge l'union local + serveur (repli : local seul si serveur injoignable). */
export async function loadSeenMerged(): Promise<SeenSuggestion[]> {
  const local = loadSeenSuggestions();
  if (!isSeenSyncConfigured()) return local;
  try {
    const data = await api('list');
    const remote: SeenSuggestion[] = Array.isArray(data.seen) ? data.seen : [];
    const keys = new Set(local.map((s) => seenKeyFor(s.t)));
    const merged = [...local];
    for (const r of remote) {
      if (typeof r?.t !== 'string' || r.t.trim() === '') continue;
      if (keys.has(seenKeyFor(r.t))) continue;
      keys.add(seenKeyFor(r.t));
      merged.push(r);
    }
    return replaceSeenSuggestions(merged);
  } catch {
    return local;
  }
}

/** Marque vu en local + pousse au serveur (erreurs serveur ignorées, retry à la prochaine synchro). */
export async function markSeenEverywhere(title: string, year?: string): Promise<SeenSuggestion[]> {
  const next = markSeenSuggestion(title, year);
  if (isSeenSyncConfigured()) {
    try {
      await api('add', { title: (title || '').trim(), year: (year || '').trim() });
    } catch {
      /* repli local : déjà persisté */
    }
  }
  return next;
}

/** Efface local + serveur. */
export async function clearSeenEverywhere(): Promise<void> {
  clearSeenSuggestions();
  if (isSeenSyncConfigured()) {
    try {
      await api('clear', {});
    } catch {
      /* ignore */
    }
  }
}
