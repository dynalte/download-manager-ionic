/**
 * Port de DownloadCompletionMonitor.swift — notifications via Capacitor LocalNotifications.
 * Sur web : fallback silencieux (console + badge in-app).
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { folderForDownloadDir, settings } from './settings';
import { refreshLibrariesForType } from './plex';
import { appLog } from './debugLog';
import type { TransmissionDownloadItem } from './transmission';

let knownFinishedIDs = new Set<number>();
let hasSnapshot = false;
let authRequested = false;

export async function requestAuthorizationIfNeeded(): Promise<void> {
  if (!settings.downloadNotificationsEnabled || authRequested) return;
  authRequested = true;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.requestPermissions();
  } catch {
    /* ignore */
  }
}

export async function ingestDownloads(downloads: TransmissionDownloadItem[]): Promise<string[]> {
  const currentlyFinished = new Set(
    downloads.filter((d) => d.isFinished || d.percentDone >= 1.0).map((d) => d.id),
  );
  const newlyFinished: string[] = [];
  const finishedItems: TransmissionDownloadItem[] = [];
  if (hasSnapshot) {
    for (const d of downloads) {
      if (currentlyFinished.has(d.id) && !knownFinishedIDs.has(d.id)) {
        newlyFinished.push(d.name);
        finishedItems.push(d);
        if (settings.downloadNotificationsEnabled) await notifyCompletion(d.name, d.id);
      }
    }
  }
  knownFinishedIDs = currentlyFinished;
  hasSnapshot = true;
  // Scan Plex ciblé après un film/série terminé (best effort, une fois par téléchargement).
  if (finishedItems.length > 0) void refreshPlexForFinished(finishedItems);
  return newlyFinished;
}

/** Déclenche le scan des sections Plex correspondant aux dossiers terminés. */
async function refreshPlexForFinished(items: TransmissionDownloadItem[]): Promise<void> {
  if (!settings.plexToken.trim()) return;
  const kinds = new Set<'movie' | 'show'>();
  for (const d of items) {
    const folder = folderForDownloadDir(d.downloadDir);
    if (folder === 'films') kinds.add('movie');
    else if (folder === 'series') kinds.add('show');
  }
  for (const kind of kinds) {
    try {
      const n = await refreshLibrariesForType(settings.plexResolvedBaseURL, settings.plexToken, kind);
      appLog('info', 'plex', `scan auto après téléchargement (${kind}) : ${n} section(s)`);
    } catch (e) {
      appLog('warn', 'plex', `scan auto échoué (${kind}) : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function notifyCompletion(name: string, id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    console.info('[DownloadManager] Telechargement termine:', name);
    return;
  }
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: 'Telechargement termine',
          body: name,
          id: Math.abs(id) % 2147483647,
          sound: 'default',
        },
      ],
    });
  } catch {
    /* ignore */
  }
}
