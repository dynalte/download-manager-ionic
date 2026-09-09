/**
 * Synchro des séries suivies vers l'API perso (SQLite, table series_subs).
 * Offline-first : localStorage immédiat ; le serveur partage entre appareils.
 * Conflits : fusion côté app (union addedKeys, progression max, état le plus
 * récent gagne) — le serveur est un dumb store (last-writer-wins par upsert).
 */
import {
  loadSubscriptions,
  replaceSubscriptions,
  type SeriesSubscription,
} from './seriesWatch';
import { isServerConfigured, serverApi } from './serverApi';

function sanitize(sub: SeriesSubscription): SeriesSubscription | null {
  if (!sub || typeof sub.id !== 'string' || typeof sub.title !== 'string') return null;
  return {
    id: sub.id,
    title: sub.title,
    query: typeof sub.query === 'string' ? sub.query : sub.title,
    year: typeof sub.year === 'string' ? sub.year : '',
    enabled: sub.enabled !== false,
    lastSeason: Number.isFinite(sub.lastSeason) ? sub.lastSeason : 0,
    lastEpisode: Number.isFinite(sub.lastEpisode) ? sub.lastEpisode : 0,
    addedKeys: Array.isArray(sub.addedKeys) ? sub.addedKeys.filter((k) => typeof k === 'string').slice(-500) : [],
    createdAt: Number.isFinite(sub.createdAt) ? sub.createdAt : Date.now(),
    lastCheckAt: Number.isFinite(sub.lastCheckAt) ? sub.lastCheckAt : 0,
    lastResult: typeof sub.lastResult === 'string' ? sub.lastResult : '',
  };
}

/** Fusion d'un distant dans le local : union anti-doublons, progression et état les plus récents. */
function mergeSub(local: SeriesSubscription, remote: SeriesSubscription): SeriesSubscription {
  const keys = [...new Set([...local.addedKeys, ...remote.addedKeys])].slice(-500);
  const winner = (remote.lastCheckAt ?? 0) >= (local.lastCheckAt ?? 0) ? remote : local;
  const seasonNewer =
    remote.lastSeason > local.lastSeason ||
    (remote.lastSeason === local.lastSeason && remote.lastEpisode > local.lastEpisode);
  const base = seasonNewer ? remote : winner;
  return { ...base, addedKeys: keys };
}

/** Charge l'union local + serveur (repli : local seul). Repousse la fusion au serveur. */
export async function loadSubscriptionsMerged(): Promise<SeriesSubscription[]> {
  const local = loadSubscriptions();
  if (!isServerConfigured()) return local;
  try {
    const data = (await serverApi('subs_list')) as { subs?: SeriesSubscription[] };
    const remote = Array.isArray(data.subs) ? data.subs : [];
    const byId = new Map(local.map((s) => [s.id, s]));
    for (const raw of remote) {
      const r = sanitize(raw);
      if (!r) continue;
      const l = byId.get(r.id);
      byId.set(r.id, l ? mergeSub(l, r) : r);
    }
    const merged = replaceSubscriptions([...byId.values()]);
    // Convergence serveur (best effort, un par un).
    for (const s of merged) {
      try {
        await serverApi('subs_upsert', { sub: s });
      } catch {
        break;
      }
    }
    return merged;
  } catch {
    return local;
  }
}

/** Pousse un abonnement (après création, toggle, vérification). */
export async function pushSubscription(sub: SeriesSubscription): Promise<void> {
  if (!isServerConfigured()) return;
  const clean = sanitize(sub);
  if (!clean) return;
  try {
    await serverApi('subs_upsert', { sub: clean });
  } catch {
    /* repli local : déjà persisté */
  }
}

/** Pousse tous les abonnements (après vérification globale). */
export async function pushAllSubscriptions(): Promise<void> {
  if (!isServerConfigured()) return;
  for (const s of loadSubscriptions()) {
    try {
      await serverApi('subs_upsert', { sub: s });
    } catch {
      break;
    }
  }
}

/** Supprime un abonnement côté serveur. */
export async function removeSubscriptionOnServer(id: string): Promise<void> {
  if (!isServerConfigured()) return;
  try {
    await serverApi('subs_remove', { id });
  } catch {
    /* ignore */
  }
}
