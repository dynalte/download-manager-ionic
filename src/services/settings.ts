/**
 * Port de AppSettings.swift + TransmissionDestinationFolder.
 * Stockage : localStorage (équivalent UserDefaults / @AppStorage).
 */
import { AppConfig } from '../config/appConfig';

export const Keys = {
  transmissionRPCURL: 'transmission_rpc_url_string',
  transmissionUsername: 'transmission_username',
  transmissionPassword: 'transmission_password',
  plexUseCloud: 'plex_use_cloud',
  plexBaseURL: 'plex_base_url',
  plexToken: 'plex_token',
  plexSectionKeysCSV: 'plex_section_keys_csv',
  folderFilmsPath: 'transmission_folder_films_path',
  folderSeriesPath: 'transmission_folder_series_path',
  folderMusiquePath: 'transmission_folder_musique_path',
  folderLivresPath: 'transmission_folder_livres_path',
  fileServerBaseURL: 'file_server_base_url',
  fileServerUsername: 'file_server_username',
  fileServerPassword: 'file_server_password',
  tr4kerApiKey: 'tr4ker_api_key',
  downloadNotificationsEnabled: 'download_notifications_enabled',
  downloadPollIntervalSeconds: 'download_poll_interval_seconds',
  plexMediaFilter: 'plex_media_filter',
  plexWatchFilter: 'plex_watch_filter',
  plexDisplayMode: 'plex_display_mode',
  geminiApiKey: 'gemini_api_key',
  geminiModel: 'gemini_model',
  seenSyncURL: 'seen_sync_url',
  seenSyncToken: 'seen_sync_token',
} as const;

export const DEFAULT_FOLDER_FILMS = '/downloads/films';
export const DEFAULT_FOLDER_SERIES = '/downloads/series';
export const DEFAULT_FOLDER_MUSIQUE = '/downloads/musique';
export const DEFAULT_FOLDER_LIVRES = '/downloads/livres';
export const DEFAULT_POLL_INTERVAL = 20;

function getString(key: string, fallback = ''): string {
  try {
    const v = localStorage.getItem(key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function getBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === '1' || v === 'true';
  } catch {
    return fallback;
  }
}

function getInt(key: string, fallback: number): number {
  const v = parseInt(getString(key, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export type DestinationFolder = 'films' | 'series' | 'musique' | 'livres';

export const DESTINATION_FOLDERS: DestinationFolder[] = ['films', 'series', 'musique', 'livres'];

export const folderDisplayName: Record<DestinationFolder, string> = {
  films: 'Films',
  series: 'Séries',
  musique: 'Musique',
  livres: 'Livres',
};

export const folderDefaultPath: Record<DestinationFolder, string> = {
  films: DEFAULT_FOLDER_FILMS,
  series: DEFAULT_FOLDER_SERIES,
  musique: DEFAULT_FOLDER_MUSIQUE,
  livres: DEFAULT_FOLDER_LIVRES,
};

const folderStorageKey: Record<DestinationFolder, string> = {
  films: Keys.folderFilmsPath,
  series: Keys.folderSeriesPath,
  musique: Keys.folderMusiquePath,
  livres: Keys.folderLivresPath,
};

export function transmissionPath(folder: DestinationFolder): string {
  const stored = getString(folderStorageKey[folder], '').trim();
  return stored === '' ? folderDefaultPath[folder] : stored;
}

function normalizeDir(dir: string): string {
  return dir.trim().replace(/\/+$/, '');
}

/** Retrouve la catégorie (films/series/musique) d'un downloadDir Transmission, ou null si inconnu. */
export function folderForDownloadDir(dir: string): DestinationFolder | null {
  const n = normalizeDir(dir);
  if (!n) return null;
  for (const folder of DESTINATION_FOLDERS) {
    if (normalizeDir(transmissionPath(folder)) === n) return folder;
  }
  return null;
}

export const settings = {
  get transmissionRPCURL(): string {
    const stored = getString(Keys.transmissionRPCURL, '').trim();
    return stored === '' ? AppConfig.transmissionRPCURL : stored;
  },
  get transmissionUsername(): string {
    const stored = getString(Keys.transmissionUsername, '').trim();
    return stored === '' ? AppConfig.transmissionUsername : stored;
  },
  get transmissionPassword(): string {
    return getString(Keys.transmissionPassword, AppConfig.transmissionPassword);
  },
  get plexUseCloud(): boolean {
    return getBool(Keys.plexUseCloud, AppConfig.plexUseCloudDefault);
  },
  get plexBaseURL(): string {
    const stored = getString(Keys.plexBaseURL, '').trim();
    return stored === '' ? AppConfig.plexBaseURL : stored;
  },
  /** Vide quand "cloud" actif — comme plexResolvedBaseURL côté Swift. */
  get plexResolvedBaseURL(): string {
    return this.plexUseCloud ? '' : this.plexBaseURL;
  },
  get plexToken(): string {
    return getString(Keys.plexToken, AppConfig.plexToken);
  },
  get plexSectionKeysCSV(): string {
    return getString(Keys.plexSectionKeysCSV, '');
  },
  get plexSectionKeys(): number[] {
    return this.plexSectionKeysCSV
      .split(',')
      .map((s) => s.trim())
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  },
  get downloadNotificationsEnabled(): boolean {
    return getBool(Keys.downloadNotificationsEnabled, true);
  },
  get downloadPollIntervalSeconds(): number {
    return getInt(Keys.downloadPollIntervalSeconds, DEFAULT_POLL_INTERVAL);
  },
  /** Serveur HTTP des fichiers téléchargés (envoi e-books). */
  get fileServerBaseURL(): string {
    const stored = getString(Keys.fileServerBaseURL, '').trim().replace(/\/+$/, '');
    return stored === '' ? AppConfig.fileServerBaseURL : stored;
  },
  get fileServerUsername(): string {
    const stored = getString(Keys.fileServerUsername, '').trim();
    return stored === '' ? AppConfig.fileServerUsername : stored;
  },
  get fileServerPassword(): string {
    return getString(Keys.fileServerPassword, AppConfig.fileServerPassword);
  },
  /** Clé API TR4KER personnelle (suivi de séries). Vide = suivi désactivé. */
  get tr4kerApiKey(): string {
    const stored = getString(Keys.tr4kerApiKey, '').trim();
    return stored === '' ? AppConfig.tr4kerApiKey : stored;
  },
  /** Clé API Google AI Studio pour les suggestions Gemini. Vide = désactivé. */
  get geminiApiKey(): string {
    return getString(Keys.geminiApiKey, '').trim();
  },
  get geminiModel(): string {
    const stored = getString(Keys.geminiModel, '').trim();
    // Migration : 2.x retirés par Google (404 pour les clés récentes) → défaut actuel.
    if (
      stored === '' ||
      stored === 'gemini-3-flash' ||
      stored.startsWith('gemini-2.') ||
      stored.startsWith('gemini-1.5') ||
      stored === 'gemini-pro'
    ) {
      return 'gemini-3.5-flash-lite';
    }
    return stored;
  },
  /** URL de l'API perso de synchro des « déjà vu » (vide = synchro désactivée). */
  get seenSyncURL(): string {
    const stored = getString(Keys.seenSyncURL, '').trim().replace(/\/+$/, '');
    return stored === '' ? 'http://photos2.dynaspirit.com:8080/api-download-manager.php' : stored;
  },
  /** Token partagé avec API_TOKEN côté PHP. Vide = synchro désactivée. */
  get seenSyncToken(): string {
    return getString(Keys.seenSyncToken, '').trim();
  },
};

export function setSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}
