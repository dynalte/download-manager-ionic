/**
 * Port de DownloadCompletionMonitor.swift — notifications via Capacitor LocalNotifications.
 * Sur web : fallback silencieux (console + badge in-app).
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { settings } from './settings';
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
  if (hasSnapshot && settings.downloadNotificationsEnabled) {
    for (const d of downloads) {
      if (currentlyFinished.has(d.id) && !knownFinishedIDs.has(d.id)) {
        newlyFinished.push(d.name);
        await notifyCompletion(d.name, d.id);
      }
    }
  }
  knownFinishedIDs = currentlyFinished;
  hasSnapshot = true;
  return newlyFinished;
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
