import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonIcon,
  IonContent,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonList,
  IonItem,
  IonProgressBar,
  IonText,
  IonRefresher,
  IonRefresherContent,
  IonAlert,
  IonSpinner,
  IonBadge,
  RefresherEventDetail,
} from '@ionic/react';
import { settingsOutline, refreshOutline, trashOutline, sparklesOutline } from 'ionicons/icons';
import { fetchDownloads, removeTorrent, type TransmissionDownloadItem } from '../services/transmission';
import { fetchLinkRecords, normalizedTitleForMatching, type PlexLinkRecord } from '../services/plex';
import { refreshLibraries } from '../services/plex';
import { settings, folderDisplayName, folderForDownloadDir, type DestinationFolder } from '../services/settings';
import { ingestDownloads, requestAuthorizationIfNeeded } from '../services/completionMonitor';
import SettingsModal from '../components/SettingsModal';

type Filter = 'active' | 'finished' | 'all' | 'plexWatched' | 'plexUnwatched';

type CatFilter = 'all' | DestinationFolder | 'other';

const FILTER_LABELS: Record<Filter, string> = {
  active: 'En cours',
  finished: 'Termines',
  all: 'Tous',
  plexWatched: 'Vus Plex',
  plexUnwatched: 'Non vus Plex',
};

const CAT_LABELS: Record<CatFilter, string> = {
  all: 'Toutes',
  films: 'Films',
  series: 'Séries',
  musique: 'Musique',
  other: 'Autres',
};

const CAT_COLORS: Record<Exclude<CatFilter, 'all'>, string> = {
  films: 'primary',
  series: 'success',
  musique: 'warning',
  other: 'medium',
};

function categoryOf(d: TransmissionDownloadItem): DestinationFolder | null {
  return folderForDownloadDir(d.downloadDir);
}

const CategoryBadge: React.FC<{ item: TransmissionDownloadItem }> = ({ item }) => {
  const c = categoryOf(item);
  return <IonBadge color={c ? CAT_COLORS[c] : CAT_COLORS.other}>{c ? folderDisplayName[c] : 'Autre'}</IonBadge>;
};

function normalizedTorrentTitle(raw: string): string {
  const preClean = raw
    .replace(/[._]+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const stopWords = new Set([
    'multi', 'vostfr', 'vf', 'vff', 'truefrench', 'french', 'sub', 'subs',
    'web', 'webrip', 'webdl', 'web-dl', 'bdrip', 'bluray', 'dvdrip', 'hdrip', 'uhd',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'opus', 'aac', 'ac3', 'dts',
    'edition', 'extended', 'remastered', 'proper', 'repack', 'internal', 'complete',
    '10bit', '8bit', '2160p', '1080p', '720p', '480p',
  ]);
  const kept: string[] = [];
  for (const token of preClean.split(' ').map((s) => s.trim()).filter(Boolean)) {
    const t = token.replace(/[^a-z0-9]/g, '');
    if (!t) continue;
    if (stopWords.has(t)) continue;
    if (/^\d{3,4}p$/.test(t)) continue;
    if (/^\d+bit$/.test(t)) continue;
    if (/^(19|20)\d{2}$/.test(t) && kept.length >= 2) break;
    if (/^s\d{1,2}e\d{1,3}$/.test(t)) break;
    kept.push(t);
    if (kept.length >= 8) break;
  }
  return kept.join(' ').trim();
}

function isSeriesLikeTitle(title: string): boolean {
  const lowered = title.toLowerCase();
  return lowered.includes('season') || lowered.includes('saison') || lowered.includes('serie') || lowered.includes('series');
}

function isEpisodeLikeTitle(title: string): boolean {
  const lowered = title.toLowerCase();
  if (lowered.includes('episode')) return true;
  if (/\bs\d{1,2}e\d{1,3}\b/.test(lowered)) return true;
  if (/\be\d{1,3}\b/.test(lowered)) return true;
  return false;
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB`;
  return `${bytesPerSecond} o`;
}

function formatETA(seconds: number): string {
  if (seconds < 0) return '?';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${bytes} o`;
}

const TransmissionTab: React.FC = () => {
  const [filter, setFilter] = useState<Filter>('active');
  const [catFilter, setCatFilter] = useState<CatFilter>('all');
  const [downloads, setDownloads] = useState<TransmissionDownloadItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingDeletion, setPendingDeletion] = useState<TransmissionDownloadItem | null>(null);
  const [refreshingPlex, setRefreshingPlex] = useState(false);
  const [plexStatus, setPlexStatus] = useState('Plex inactif');
  const [showSettings, setShowSettings] = useState(false);
  const [linkRecords, setLinkRecords] = useState<PlexLinkRecord[]>([]);
  const timer = useRef<number | null>(null);

  const refreshDownloads = useCallback(async () => {
    setLoading(true);
    try {
      const latest = await fetchDownloads();
      await ingestDownloads(latest);
      setDownloads(latest);
      setError('');
    } catch (e) {
      setError(`Erreur lecture Transmission: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPlexWatched = useCallback(async () => {
    if (!settings.plexToken.trim()) {
      setLinkRecords([]);
      return;
    }
    try {
      const records = await fetchLinkRecords(settings.plexResolvedBaseURL, settings.plexToken, settings.plexSectionKeys, 1200);
      setLinkRecords(records);
    } catch {
      /* silencieux comme Swift */
    }
  }, []);

  const refreshPlexLibraries = useCallback(async () => {
    setRefreshingPlex(true);
    try {
      const keys = settings.plexSectionKeys;
      const count = await refreshLibraries(settings.plexResolvedBaseURL, settings.plexToken, keys);
      const selection = keys.length === 0 ? 'auto' : keys.join(',');
      const mode = settings.plexUseCloud ? 'cloud' : 'local';
      setPlexStatus(`Plex (${mode}): scan lance sur ${count} bibliotheque(s) [${selection}]`);
    } catch (e) {
      setPlexStatus(`Plex: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshingPlex(false);
    }
  }, []);

  useEffect(() => {
    void requestAuthorizationIfNeeded();
    void refreshDownloads();
    setPlexStatus(
      !settings.plexToken.trim()
        ? 'Plex: configure le token dans Reglages'
        : settings.plexUseCloud
          ? 'Plex cloud pret'
          : 'Plex pret',
    );
    void refreshPlexWatched();
    let tick = 0;
    const loop = () => {
      timer.current = window.setTimeout(async () => {
        await refreshDownloads();
        tick += 1;
        if (tick % 3 === 0) await refreshPlexWatched();
        loop();
      }, Math.max(10, settings.downloadPollIntervalSeconds) * 1000);
    };
    loop();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [refreshDownloads, refreshPlexWatched]);

  function plexWatchLabel(name: string): string | null {
    const normalized = normalizedTorrentTitle(name);
    if (!normalized) return null;
    const watchedMovies = new Set(linkRecords.filter((r) => r.type === 'movie' && r.isWatched).map((r) => r.normalizedTitle));
    const watchedSeries = new Set(linkRecords.filter((r) => r.type === 'show' && r.isWatched).map((r) => r.normalizedTitle));
    const prefixMatch = (set: Set<string>) => [...set].some((t) => normalized.startsWith(t) || t.startsWith(normalized));
    if (isSeriesLikeTitle(name)) {
      if (!isEpisodeLikeTitle(name) && (watchedSeries.has(normalized) || prefixMatch(watchedSeries))) return 'Plex: serie complete vue';
    } else if (watchedMovies.has(normalized) || prefixMatch(watchedMovies)) {
      return 'Plex: film vu';
    }
    return null;
  }

  function isWatched(name: string): boolean {
    return plexWatchLabel(name) !== null;
  }

  function isLinked(name: string): boolean {
    const normalized = normalizedTorrentTitle(name);
    if (!normalized) return false;
    const series = isSeriesLikeTitle(name);
    const pool = linkRecords.filter((r) => (series ? r.type === 'show' : r.type === 'movie')).map((r) => r.normalizedTitle);
    if (pool.includes(normalized)) return true;
    return pool.some((t) => normalized.startsWith(t) || t.startsWith(normalized));
  }

  const filtered = downloads.filter((d) => {
    if (catFilter !== 'all') {
      const c = categoryOf(d);
      if (catFilter === 'other' ? c !== null : c !== catFilter) return false;
    }
    switch (filter) {
      case 'active':
        return !d.isFinished && d.percentDone < 1.0;
      case 'finished':
        return d.isFinished || d.percentDone >= 1.0;
      case 'all':
        return true;
      case 'plexWatched':
        return isWatched(d.name);
      case 'plexUnwatched':
        return isLinked(d.name) && !isWatched(d.name);
    }
  });

  void normalizedTitleForMatching;

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    await refreshDownloads();
    await refreshPlexWatched();
    event.detail.complete();
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Transmission</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => setShowSettings(true)}>
              <IonIcon icon={settingsOutline} />
            </IonButton>
            <IonButton onClick={() => void refreshPlexLibraries()} disabled={refreshingPlex}>
              <IonIcon icon={sparklesOutline} />
            </IonButton>
            <IonButton onClick={() => void refreshDownloads()} disabled={loading}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>
        <IonSegment value={filter} onIonChange={(e) => setFilter(String(e.detail.value) as Filter)} scrollable>
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
            <IonSegmentButton key={f} value={f}>
              <IonLabel>{FILTER_LABELS[f]}</IonLabel>
            </IonSegmentButton>
          ))}
        </IonSegment>
        <IonSegment value={catFilter} onIonChange={(e) => setCatFilter(String(e.detail.value) as CatFilter)} scrollable>
          {(Object.keys(CAT_LABELS) as CatFilter[]).map((f) => (
            <IonSegmentButton key={f} value={f}>
              <IonLabel>{CAT_LABELS[f]}</IonLabel>
            </IonSegmentButton>
          ))}
        </IonSegment>

        {loading && filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
            <p>
              <IonText color="medium">Chargement des telechargements...</IonText>
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonText color="medium">Aucun telechargement pour ce filtre</IonText>
          </div>
        ) : (
          <IonList>
            {filtered.map((d) => (
              <IonItem key={d.id}>
                <IonButton fill="clear" color="danger" slot="start" onClick={() => setPendingDeletion(d)}>
                  <IonIcon icon={trashOutline} />
                </IonButton>
                <IonLabel>
                  <h2 style={{ whiteSpace: 'normal' }}>
                    {d.name} <CategoryBadge item={d} />
                  </h2>
                  <IonProgressBar value={d.percentDone} style={{ margin: '6px 0' }} />
                  <p>
                    {formatSize(d.totalSize)} • {Math.round(d.percentDone * 100)}% • {d.statusLabel} • {formatRate(d.rateDownload)}/s • Ratio{' '}
                    {d.uploadRatio < 0 ? '?' : d.uploadRatio.toFixed(2)} • ETA {formatETA(d.eta)}
                  </p>
                  {!!d.errorString && (
                    <IonText color="danger">
                      <p>{d.errorString}</p>
                    </IonText>
                  )}
                  {plexWatchLabel(d.name) && (
                    <IonText color="success">
                      <p>{plexWatchLabel(d.name)}</p>
                    </IonText>
                  )}
                </IonLabel>
              </IonItem>
            ))}
          </IonList>
        )}

        <p className="footer-message">
          <IonText color={error ? 'danger' : 'medium'}>{error || plexStatus}</IonText>
        </p>

        <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
        <IonAlert
          isOpen={pendingDeletion !== null}
          header="Supprimer ce telechargement ?"
          message={pendingDeletion?.name ?? ''}
          buttons={[
            { text: 'Annuler', role: 'cancel', handler: () => setPendingDeletion(null) },
            {
              text: 'Supprimer fichiers + torrent',
              role: 'destructive',
              handler: () => {
                const target = pendingDeletion;
                setPendingDeletion(null);
                if (target) {
                  void (async () => {
                    try {
                      await removeTorrent(target.id, true);
                      await refreshDownloads();
                    } catch (e) {
                      setError(`Erreur suppression: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  })();
                }
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default TransmissionTab;
