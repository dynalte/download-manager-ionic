import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  IonText,
  IonSpinner,
  IonModal,
  IonBadge,
  IonRefresher,
  IonRefresherContent,
  RefresherEventDetail,
} from '@ionic/react';
import { settingsOutline, refreshOutline, playOutline, eyeOutline, gridOutline } from 'ionicons/icons';
import {
  fetchLibrariesData,
  fetchPlayers,
  fetchSeasonEpisodes,
  fetchShowSeasons,
  playOnPlayer,
  type PlexEpisodeItem,
  type PlexLibraryData,
  type PlexLibraryItem,
  type PlexPlayerTarget,
  type PlexSeasonItem,
} from '../services/plex';
import { settings, Keys } from '../services/settings';
import SettingsModal from '../components/SettingsModal';
import PlayerPicker from '../components/PlayerPicker';

type MediaFilter = 'all' | 'movies' | 'series';
type WatchFilter = 'all' | 'watched' | 'unwatched';
type DisplayMode = 'list' | 'grid';

function getStored(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback;
}

const PlexTab: React.FC = () => {
  const [libraries, setLibraries] = useState<PlexLibraryData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>((getStored(Keys.plexMediaFilter, 'all') as MediaFilter) || 'all');
  const [watchFilter, setWatchFilter] = useState<WatchFilter>((getStored(Keys.plexWatchFilter, 'all') as WatchFilter) || 'all');
  const [displayMode, setDisplayMode] = useState<DisplayMode>((getStored(Keys.plexDisplayMode, 'list') as DisplayMode) || 'list');
  const [players, setPlayers] = useState<PlexPlayerTarget[]>([]);
  const [selectedItem, setSelectedItem] = useState<PlexLibraryItem | null>(null);
  const [showPlayerPicker, setShowPlayerPicker] = useState(false);
  const [playbackMsg, setPlaybackMsg] = useState('');
  const [detail, setDetail] = useState<PlexLibraryItem | null>(null);
  const [seasons, setSeasons] = useState<PlexSeasonItem[]>([]);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [season, setSeason] = useState<PlexSeasonItem | null>(null);
  const [episodes, setEpisodes] = useState<PlexEpisodeItem[]>([]);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);

  const refreshLibraries = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchLibrariesData(
        settings.plexResolvedBaseURL,
        settings.plexToken,
        settings.plexSectionKeys,
        20,
      );
      setLibraries(data);
      setError('');
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);

  const filteredLibraries = useMemo(
    () =>
      libraries
        .map((lib) => ({
          ...lib,
          items: lib.items.filter((item) => {
            const mediaOk =
              mediaFilter === 'all' ||
              (mediaFilter === 'movies' ? item.type.toLowerCase() === 'movie' : item.type.toLowerCase() === 'show');
            const watchOk =
              watchFilter === 'all' || (watchFilter === 'watched' ? item.isWatched : !item.isWatched);
            return mediaOk && watchOk;
          }),
        }))
        .filter((lib) => lib.items.length > 0),
    [libraries, mediaFilter, watchFilter],
  );

  async function preparePlayback(item: PlexLibraryItem) {
    setSelectedItem(item);
    setPlaybackMsg('Recherche des lecteurs Plex...');
    try {
      const list = await fetchPlayers(settings.plexResolvedBaseURL, settings.plexToken);
      if (list.length === 0) {
        setPlaybackMsg('Aucun lecteur Plex detecte.');
        return;
      }
      setPlayers(list);
      setPlaybackMsg(`Choisis un lecteur pour ${item.title}`);
      setShowPlayerPicker(true);
    } catch {
      setPlaybackMsg('Erreur detection lecteurs Plex.');
    }
  }

  async function startPlayback(item: PlexLibraryItem, player: PlexPlayerTarget) {
    try {
      setPlaybackMsg(`Envoi de la commande vers ${player.name}...`);
      await playOnPlayer(item, player, settings.plexResolvedBaseURL, settings.plexToken);
      setPlaybackMsg(`Commande envoyee a ${player.name}`);
    } catch (e) {
      setPlaybackMsg(`Echec lecture sur ${player.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function openDetail(item: PlexLibraryItem) {
    setDetail(item);
    setSeasons([]);
    if (item.type.toLowerCase() === 'show') {
      setLoadingSeasons(true);
      try {
        setSeasons(await fetchShowSeasons(settings.plexResolvedBaseURL, settings.plexToken, item.ratingKey));
      } catch {
        /* ignore */
      } finally {
        setLoadingSeasons(false);
      }
    }
  }

  async function openSeason(s: PlexSeasonItem) {
    setSeason(s);
    setLoadingEpisodes(true);
    try {
      setEpisodes(await fetchSeasonEpisodes(settings.plexResolvedBaseURL, settings.plexToken, s.ratingKey));
    } catch {
      setEpisodes([]);
    } finally {
      setLoadingEpisodes(false);
    }
  }

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    await refreshLibraries();
    event.detail.complete();
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Plex</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => setShowSettings(true)}>
              <IonIcon icon={settingsOutline} />
            </IonButton>
            <IonButton onClick={() => void refreshLibraries()} disabled={loading}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        {loading && libraries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
            <p>
              <IonText color="medium">Chargement des bibliotheques Plex...</IonText>
            </p>
          </div>
        ) : libraries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonText color={error ? 'danger' : 'medium'}>{error || 'Aucune donnee Plex'}</IonText>
          </div>
        ) : (
          <>
            <div style={{ padding: '8px 12px' }}>
              <IonSegment
                value={mediaFilter}
                onIonChange={(e) => {
                  const v = String(e.detail.value) as MediaFilter;
                  setMediaFilter(v);
                  localStorage.setItem(Keys.plexMediaFilter, v);
                }}
              >
                <IonSegmentButton value="all">
                  <IonLabel>Tous</IonLabel>
                </IonSegmentButton>
                <IonSegmentButton value="movies">
                  <IonLabel>Films</IonLabel>
                </IonSegmentButton>
                <IonSegmentButton value="series">
                  <IonLabel>Series</IonLabel>
                </IonSegmentButton>
              </IonSegment>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <IonButton
                  size="small"
                  fill={displayMode !== 'list' ? 'solid' : 'outline'}
                  onClick={() => {
                    const v: DisplayMode = displayMode === 'list' ? 'grid' : 'list';
                    setDisplayMode(v);
                    localStorage.setItem(Keys.plexDisplayMode, v);
                  }}
                >
                  <IonIcon icon={gridOutline} slot="start" />
                  {displayMode === 'list' ? 'Liste' : 'Grille'}
                </IonButton>
                <IonButton
                  size="small"
                  fill={watchFilter !== 'all' ? 'solid' : 'outline'}
                  onClick={() => {
                    const order: WatchFilter[] = ['all', 'watched', 'unwatched'];
                    const v = order[(order.indexOf(watchFilter) + 1) % order.length];
                    setWatchFilter(v);
                    localStorage.setItem(Keys.plexWatchFilter, v);
                  }}
                >
                  <IonIcon icon={eyeOutline} slot="start" />
                  {watchFilter === 'all' ? 'Tous' : watchFilter === 'watched' ? 'Vus' : 'Non vus'}
                </IonButton>
              </div>
              {lastRefresh && (
                <p>
                  <IonText color="medium">
                    <small>Derniere mise a jour: {lastRefresh.toLocaleString()}</small>
                  </IonText>
                </p>
              )}
            </div>

            {filteredLibraries.map((lib) => (
              <div key={lib.id}>
                <IonItem lines="none">
                  <IonLabel>
                    <strong>
                      {lib.section.title} • {lib.section.type === 'movie' ? 'Films' : 'Series'} • {lib.totalItems}
                    </strong>
                  </IonLabel>
                </IonItem>
                {displayMode === 'grid' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 12, padding: '0 12px 12px' }}>
                    {lib.items.map((item) => (
                      <div key={item.id} onClick={() => void openDetail(item)} style={{ cursor: 'pointer' }}>
                        {item.posterURL ? (
                          <img src={item.posterURL} alt={item.title} className="poster-grid" loading="lazy" />
                        ) : (
                          <div className="poster-grid" />
                        )}
                        <div style={{ fontSize: 12 }}>{item.title}</div>
                        <IonBadge color={item.isWatched ? 'success' : 'warning'}>{item.isWatched ? 'Vu' : 'Non vu'}</IonBadge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <IonList>
                    {lib.items.map((item) => (
                      <IonItem key={item.id} button onClick={() => void openDetail(item)}>
                        {item.posterURL ? (
                          <img src={item.posterURL} alt="" className="poster-thumb" slot="start" loading="lazy" />
                        ) : null}
                        <IonLabel>
                          <h2 style={{ whiteSpace: 'normal' }}>{item.title}</h2>
                          <p>
                            {item.year ?? 'annee ?'}
                            {item.addedAt ? ` • ajoute le ${item.addedAt.toLocaleDateString()}` : ''}
                          </p>
                          <IonBadge color={item.isWatched ? 'success' : 'warning'}>
                            {item.isWatched ? 'Vu' : 'Non vu'}
                          </IonBadge>
                        </IonLabel>
                      </IonItem>
                    ))}
                  </IonList>
                )}
              </div>
            ))}
          </>
        )}

        {!!playbackMsg && (
          <p className="footer-message">
            <IonText color="medium">{playbackMsg}</IonText>
          </p>
        )}

        {/* Fiche détail (film / serie) */}
        <IonModal isOpen={detail !== null} onDidDismiss={() => setDetail(null)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>Fiche detail</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setDetail(null)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            {detail && (
              <div style={{ padding: 16 }}>
                {detail.posterURL && <img src={detail.posterURL} alt={detail.title} className="poster-large" />}
                <h2>{detail.title}</h2>
                <p>
                  <IonBadge color={detail.isWatched ? 'success' : 'warning'}>
                    {detail.isWatched ? 'Vu' : 'Non vu'}
                  </IonBadge>
                </p>
                {detail.year && <p>Annee: {detail.year}</p>}
                {detail.addedAt && <p>Ajoute le: {detail.addedAt.toLocaleString()}</p>}
                <p>Type: {detail.type === 'show' ? 'Serie' : 'Film'}</p>
                {detail.type.toLowerCase() === 'show' && (
                  <div>
                    <h3>Saisons</h3>
                    {loadingSeasons ? (
                      <IonSpinner />
                    ) : seasons.length === 0 ? (
                      <IonText color="medium">Aucune saison disponible.</IonText>
                    ) : (
                      <IonList>
                        {seasons.map((s) => (
                          <IonItem key={s.id} button onClick={() => void openSeason(s)}>
                            <IonLabel>
                              S{String(s.index ?? 0).padStart(2, '0')} • {s.title} ({s.viewedEpisodeCount}/{s.episodeCount})
                            </IonLabel>
                          </IonItem>
                        ))}
                      </IonList>
                    )}
                  </div>
                )}
                <h3>Synopsis</h3>
                <IonText color="medium">
                  <p>{detail.summary || 'Aucun resume disponible.'}</p>
                </IonText>
                <IonButton expand="block" onClick={() => void preparePlayback(detail)}>
                  <IonIcon icon={playOutline} slot="start" />
                  Lire sur Plex
                </IonButton>
              </div>
            )}
          </IonContent>
        </IonModal>

        {/* Episodes de la saison */}
        <IonModal isOpen={season !== null} onDidDismiss={() => setSeason(null)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>{season?.title ?? 'Saison'}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setSeason(null)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            {loadingEpisodes ? (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <IonSpinner />
              </div>
            ) : (
              <IonList>
                {episodes.map((ep) => (
                  <IonItem
                    key={ep.id}
                    button
                    onClick={() =>
                      void preparePlayback({
                        id: ep.id,
                        ratingKey: ep.ratingKey,
                        title: ep.title,
                        summary: ep.summary,
                        type: 'episode',
                        isWatched: ep.isWatched,
                        posterURL: ep.posterURL,
                      })
                    }
                  >
                    <IonLabel>
                      <p>
                        S{String(ep.seasonIndex ?? 0).padStart(2, '0')}E{String(ep.episodeIndex ?? 0).padStart(2, '0')}
                      </p>
                      <h2 style={{ whiteSpace: 'normal' }}>{ep.title}</h2>
                      <IonBadge color={ep.isWatched ? 'success' : 'warning'}>
                        {ep.isWatched ? 'Vu' : 'Non vu'}
                      </IonBadge>
                    </IonLabel>
                  </IonItem>
                ))}
              </IonList>
            )}
          </IonContent>
        </IonModal>

        <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
        <PlayerPicker
          isOpen={showPlayerPicker}
          title={selectedItem?.title ?? 'Choisir un lecteur'}
          players={players}
          onCancel={() => setShowPlayerPicker(false)}
          onSelect={(player) => {
            setShowPlayerPicker(false);
            if (selectedItem) void startPlayback(selectedItem, player);
          }}
        />
      </IonContent>
    </IonPage>
  );
};

export default PlexTab;
