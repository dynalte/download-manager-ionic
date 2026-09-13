/**
 * Config centralisée côté serveur (api-download-manager.php, table app_config).
 *
 * Principe : l'utilisateur ne saisit que l'URL + le token synchro, puis
 * « Récupérer » remplit tous les autres réglages (Transmission, Plex,
 * clés API, dossiers...). « Envoyer » fait l'inverse : il pousse la config
 * locale vers le serveur (amorçage depuis une app déjà configurée).
 *
 * Les clés sont les noms localStorage de settings.ts (Keys) ; la liste
 * miroir de CONFIG_KEYS côté PHP. seen_sync_url / seen_sync_token sont
 * exclus (bootstrap / secret d'auth).
 */
import { Keys, setSetting } from './settings';
import { isServerConfigured, serverApi } from './serverApi';

/** Clés synchronisables (miroir de CONFIG_KEYS côté PHP). */
export const REMOTE_CONFIG_KEYS: string[] = [
  Keys.transmissionRPCURL,
  Keys.transmissionUsername,
  Keys.transmissionPassword,
  Keys.folderFilmsPath,
  Keys.folderSeriesPath,
  Keys.folderMusiquePath,
  Keys.folderLivresPath,
  Keys.fileServerBaseURL,
  Keys.fileServerUsername,
  Keys.fileServerPassword,
  Keys.tr4kerApiKey,
  Keys.geminiApiKey,
  Keys.geminiModel,
  Keys.plexUseCloud,
  Keys.plexBaseURL,
  Keys.plexToken,
  Keys.plexSectionKeysCSV,
  Keys.plexMediaFilter,
  Keys.plexWatchFilter,
  Keys.plexDisplayMode,
  Keys.downloadNotificationsEnabled,
  Keys.downloadPollIntervalSeconds,
];

export interface RemoteConfigResult {
  /** Paires clé → valeur renvoyées par le serveur (filtrées sur l'allowlist). */
  config: Record<string, string>;
  /** Horodatage (updated_at max) côté serveur, 0 si inconnu. */
  updatedAt: number;
}

function sanitizeConfig(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  const allowed = new Set(REMOTE_CONFIG_KEYS);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) continue;
    out[k] = typeof v === 'string' ? v : v == null ? '' : String(v);
  }
  return out;
}

/** Récupère la config centralisée (GET config_get). */
export async function fetchRemoteConfig(): Promise<RemoteConfigResult> {
  if (!isServerConfigured()) {
    throw new Error('Renseigne l’URL et le token avant de récupérer.');
  }
  const data = (await serverApi('config_get')) as { config?: unknown; updatedAt?: unknown };
  const updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
  return { config: sanitizeConfig(data.config), updatedAt };
}

/** Écrit la config en localStorage. Retourne le nombre de clés appliquées. */
export function applyRemoteConfig(config: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(sanitizeConfig(config))) {
    setSetting(k, v);
    n++;
  }
  return n;
}

/** Lit la config locale synchronisable (pour config_set). */
export function readLocalConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const k of REMOTE_CONFIG_KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
  } catch {
    /* stockage indisponible */
  }
  return out;
}

/** Pousse la config locale vers le serveur (POST config_set). Retourne saved. */
export async function pushRemoteConfig(): Promise<number> {
  if (!isServerConfigured()) {
    throw new Error('Renseigne l’URL et le token avant d’envoyer.');
  }
  const data = (await serverApi('config_set', { config: readLocalConfig() })) as { saved?: unknown };
  return typeof data.saved === 'number' ? data.saved : 0;
}
