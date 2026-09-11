import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  IonFooter,
  RefresherEventDetail,
} from '@ionic/react';
import { settingsOutline, refreshOutline, playOutline, eyeOutline, gridOutline, filmOutline, notificationsOutline, sparklesOutline } from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import { useHistory } from 'react-router-dom';
import {
  fetchLibrariesData,
  fetchPlayersDetailed,
  fetchSeasonEpisodes,
  fetchShowSeasons,
  playOnPlayer,
  probeAndAddManualPlayer,
  removeManualPlayer as removeManualPlayerEntry,
  type PlexEpisodeItem,
  type PlexLibraryData,
  type PlexLibraryItem,
  type PlexPlayerTarget,
  type PlexSeasonItem,
} from '../services/plex';
import { settings, Keys } from '../services/settings';
import { buildAllocineQuery, buildAllocineUrl } from '../services/torrentScripts';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { subscriptionIdFor, upsertSubscription } from '../services/seriesWatch';
import { forgetDeletedSubscription } from '../services/seriesWatch';
import { pushSubscription } from '../services/seriesSync';
import { requestBrowserOpen } from '../services/browserNavigation';
import { isDesktopElectron } from '../services/embeddedBrowser';
import SettingsModal from '../components/SettingsModal';
import SuggestModal from '../components/SuggestModal';
import PlayerPicker from '../components/PlayerPicker';
import RatingStars from '../components/RatingStars';

type MediaFilter = 'all' | 'movies' | 'series';
type WatchFilter = 'all' | 'watched' | 'unwatched';
type DisplayMode = 'list' | 'grid';

function getStored(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback;
}

const PlexTab: React.FC = () => {
  const history = useHistory();
  const [libraries, setLibraries] = useState<PlexLibraryData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>((getStored(Keys.plexMediaFilter, 'all') as MediaFilter) || 'all');
  const [watchFilter, setWatchFilter] = useState<WatchFilter>((getStored(Keys.plexWatchFilter, 'all') as WatchFilter) || 'all');
  const [displayMode, setDisplayMode] = useState<DisplayMode>((getStored(Keys.plexDisplayMode, 'list') as DisplayMode) || 'list');
  const [players, setPlayers] = useState<PlexPlayerTarget[]>([]);
  const [playersDebug, setPlayersDebug] = useState('');
  const [playersDiagnostic, setPlayersDiagnostic] = useState('');
  const [selectedItem, setSelectedItem] = useState<PlexLibraryItem | null>(null);
  const [showPlayerPicker, setShowPlayerPicker] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [playbackMsg, setPlaybackMsg] = useState('');
  const [detail, setDetail] = useState<PlexLibraryItem | null>(null);
  const [seasons, setSeasons] = useState<PlexSeasonItem[]>([]);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [season, setSeason] = useState<PlexSeasonItem | null>(null);
  const [episodes, setEpisodes] = useState<PlexEpisodeItem[]>([]);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [ratings, setRatings] = useState<AllocineRatings | null>(null);
  const [ratingsLoading, setRatingsLoading] = useState(false);
  const ratingsReq = useRef(0);
  /** Notes par item.id pour la liste/grille (rempli en arrière-plan). */
  const [ratingsMap, setRatingsMap] = useState<Record<string, AllocineRatings>>({});
  const ratingsMapRef = useRef<Record<string, AllocineRatings>>({});
  const ratingsFillReq = useRef(0);
  /** Modale Suggestions IA (composant partagé Plex + Catalogue). */
  const [showSuggest, setShowSuggest] = useState(false);

  /** Note la plus parlante pour l'affichage compact (spectateurs > presse). */
  function bestNote(r: AllocineRatings): number | null {
    return r.spectators ?? r.press;
  }

  /** Étoiles compactes d'un item de liste/grille (rien si pas encore chargé). */
  const ListRating: React.FC<{ item: PlexLibraryItem }> = ({ item }) => {
    const r = ratingsMap[item.id];
    const v = r ? bestNote(r) : null;
    if (v == null) return null;
    return (
      <span className="ratings-inline">
        <RatingStars value={v} size={14} />
        <strong>{formatAllocineNote(v)}</strong>
      </span>
    );
  };

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

  // Remplit les notes de la liste/grille en arrière-plan (exe + natif) :
  // visibles d'abord, concurrence limitée, cache de 30 j, silencieux.
  useEffect(() => {
    if (!isDesktopElectron() && !Capacitor.isNativePlatform()) return;
    const reqId = ++ratingsFillReq.current;
    const seen = new Set<string>();
    const queue: PlexLibraryItem[] = [];
    for (const lib of filteredLibraries) {
      for (const item of lib.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          queue.push(item);
        }
      }
    }
    for (const lib of libraries) {
      for (const item of lib.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          queue.push(item);
        }
      }
    }
    const pending = queue.filter((item) => !ratingsMapRef.current[item.id]);
    if (pending.length === 0) return;
    let cursor = 0;
    let active = 0;
    const CONCURRENCY = 3;
    const pump = () => {
      if (ratingsFillReq.current !== reqId) return;
      while (active < CONCURRENCY && cursor < pending.length) {
        const item = pending[cursor++];
        active += 1;
        void fetchAllocineRatings(item.title, item.year)
          .then((r) => {
            if (r && ratingsFillReq.current === reqId) {
              ratingsMapRef.current = { ...ratingsMapRef.current, [item.id]: r };
              setRatingsMap(ratingsMapRef.current);
            }
          })
          .catch(() => {})
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };
    const stagger = window.setTimeout(pump, 600);
    return () => {
      window.clearTimeout(stagger);
    };
  }, [libraries, filteredLibraries]);

  async function preparePlayback(item: PlexLibraryItem) {
    setSelectedItem(item);
    setLoadingPlayers(true);
    setPlaybackMsg('Recherche des lecteurs Plex (ouvre l’app Plex sur ta Fire TV si absente)...');
    try {
      const { players: list, debug } = await fetchPlayersDetailed(settings.plexResolvedBaseURL, settings.plexToken);
      const dbg = `resources ${debug.keptResources}/${debug.rawResources} • clients ${debug.clientsCount} • sessions ${debug.sessionsCount} • serveurs ${debug.servers.length}${debug.errors.length ? ` • erreurs: ${debug.errors.join(' | ')}` : ''}`;
      setPlayersDebug(dbg);
      setPlayersDiagnostic(
        [`compte: ${debug.account || '?'}`, `synthese: ${dbg}`, ...debug.devicesSummary,
         ...(debug.filteredOut.length ? [`ecartes: ${debug.filteredOut.map((f) => `"${f.name}" [${f.product}] (${f.reason})`).join(', ')}`] : []),
         ...(debug.errors.length ? [`erreurs: ${debug.errors.join(' | ')}`] : []),
         `lecteurs finaux: ${list.map((p) => `"${p.name}" [${p.product}/${p.platform}] presence=${p.presence === true ? 'en-ligne' : p.presence === false ? 'hors-ligne' : '?'} source=${p.source}`).join(' ; ') || 'aucun'}`,
        ].join('\n'),
      );
      if (list.length === 0) {
        setPlaybackMsg(`Aucun lecteur Plex detecte (${dbg}). Ouvre l’app Plex sur la Fire TV (même compte, même Wi-Fi) puis réessaie.`);
        return;
      }
      const online = list.filter((p) => p.presence === true).length;
      setPlayers(list);
      setPlaybackMsg(
        `${list.length} lecteur(s) (${dbg})${online ? ` dont ${online} en ligne` : ''} — choisis un lecteur « En ligne » pour ${item.title}`,
      );
      setShowPlayerPicker(true);
    } catch (e) {
      setPlaybackMsg(`Erreur detection lecteurs Plex: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingPlayers(false);
    }
  }

  async function startPlayback(item: PlexLibraryItem, player: PlexPlayerTarget) {
    try {
      const label = item.type.toLowerCase() === 'show' ? ' (épisode à lire résolu auto)' : '';
      setPlaybackMsg(`Envoi de "${item.title}"${label} vers ${player.name}...`);
      await playOnPlayer(item, player, settings.plexResolvedBaseURL, settings.plexToken);
      setPlaybackMsg(`Commande envoyee a ${player.name} — si rien ne démarre, vérifie que l’app Plex est ouverte sur la TV.`);
    } catch (e) {
      setPlaybackMsg(`Echec lecture sur ${player.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Ajout manuel d'une Fire TV par IP (contourne plex.tv). */
  async function addManualPlayer(host: string, port: string) {
    setLoadingPlayers(true);
    setPlaybackMsg(`Sondage de la TV sur ${host}:${port}... (lance une lecture sur la TV si ça échoue)`);
    try {
      const added = await probeAndAddManualPlayer(host, port, settings.plexToken);
      setPlaybackMsg(`TV ajoutée : ${added.name}. Actualisation de la liste...`);
      if (selectedItem) await preparePlayback(selectedItem);
      else {
        const { players: list } = await fetchPlayersDetailed(settings.plexResolvedBaseURL, settings.plexToken);
        setPlayers(list);
      }
    } catch (e) {
      setPlaybackMsg(`Ajout manuel impossible: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingPlayers(false);
    }
  }

  function handleRemoveManual(baseURL: string) {
    removeManualPlayerEntry(baseURL);
    setPlayers((prev) => prev.filter((p) => !(p.source.includes('manual') && p.baseURL === baseURL)));
    setPlaybackMsg('Lecteur manuel retiré.');
  }

  async function openDetail(item: PlexLibraryItem) {
    setDetail(item);
    setSeasons([]);
    setRatings(null);
    // Notes Allociné (exe + natif, silencieux si indisponible).
    const reqId = ++ratingsReq.current;
    setRatingsLoading(true);
    void fetchAllocineRatings(item.title, item.year)
      .then((r) => {
        if (ratingsReq.current === reqId) setRatings(r);
        if (r) {
          ratingsMapRef.current = { ...ratingsMapRef.current, [item.id]: r };
          setRatingsMap(ratingsMapRef.current);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (ratingsReq.current === reqId) setRatingsLoading(false);
      });
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

  /** Abonne la série au suivi auto : baseline = dernier épisode présent dans Plex. */
  async function subscribeShow(item: PlexLibraryItem) {
    try {
      setPlaybackMsg('Analyse des épisodes Plex présents...');
      const seasons = await fetchShowSeasons(settings.plexResolvedBaseURL, settings.plexToken, item.ratingKey);
      let maxS = 0;
      let maxE = 0;
      for (const s of seasons) {
        const eps = await fetchSeasonEpisodes(settings.plexResolvedBaseURL, settings.plexToken, s.ratingKey);
        for (const ep of eps) {
          const si = ep.seasonIndex ?? s.index ?? 0;
          const ei = ep.episodeIndex ?? 0;
          if (si > maxS || (si === maxS && ei > maxE)) {
            maxS = si;
            maxE = ei;
          }
        }
      }
      const query = buildAllocineQuery(item.title) || item.title;
      const base =
        maxS > 0 ? `S${String(maxS).padStart(2, '0')}E${String(maxE).padStart(2, '0')}` : 'aucun épisode';
      const sub = {
        id: subscriptionIdFor(item.title, item.year),
        title: item.title,
        query,
        year: item.year != null ? String(item.year) : undefined,
        enabled: true,
        lastSeason: maxS,
        lastEpisode: maxE,
        addedKeys: [],
        createdAt: Date.now(),
        lastCheckAt: 0,
        lastResult: `Base Plex : ${base}`,
        updatedAt: Date.now(),
      };
      forgetDeletedSubscription(sub.id);
      upsertSubscription(sub);
      void pushSubscription(sub);
      setPlaybackMsg(`Suivi activé : ${item.title} (base ${base}). Voir l’onglet Suivis.`);
    } catch (e) {
      setPlaybackMsg(`Suivi impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function openSeason(s: PlexSeasonItem) {    setSeason(s);
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
            <IonButton onClick={() => setShowSuggest(true)} title="Suggestions IA">
              <IonIcon icon={sparklesOutline} />
            </IonButton>
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
                <IonButton
                  size="small"
                  fill="outline"
                  onClick={() => setShowSuggest(true)}
                >
                  <IonIcon icon={sparklesOutline} slot="start" />
                  Suggestions IA
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
                        <ListRating item={item} />
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
                          <ListRating item={item} />
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
        <IonModal isOpen={detail !== null} onDidDismiss={() => setDetail(null)} className="detail-modal">
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
              <div className="detail-sheet">
                <div className="detail-top">
                  {detail.posterURL && <img src={detail.posterURL} alt={detail.title} className="poster-large detail-poster" />}
                  <div className="detail-head">
                    <h2 className="detail-title">{detail.title}</h2>
                    <p>
                      <IonBadge className="detail-badge" color={detail.isWatched ? 'success' : 'warning'}>
                        {detail.isWatched ? 'Vu' : 'Non vu'}
                      </IonBadge>
                    </p>
                    {ratingsLoading ? (
                      <p className="ratings-row">
                        <IonSpinner style={{ width: 18, height: 18 }} />
                        <IonText color="medium">Notes Allociné…</IonText>
                      </p>
                    ) : ratings && (ratings.press != null || ratings.spectators != null) ? (
                      <div className="ratings-block">
                        <IonBadge color="tertiary">Allociné</IonBadge>
                        {ratings.press != null && (
                          <div className="ratings-line">
                            <RatingStars value={ratings.press} />
                            <strong>{formatAllocineNote(ratings.press)}</strong>
                            <IonText color="medium">
                              <small>Presse{ratings.pressReviews ? ` • ${ratings.pressReviews} critiques` : ''}</small>
                            </IonText>
                          </div>
                        )}
                        {ratings.spectators != null && (
                          <div className="ratings-line">
                            <RatingStars value={ratings.spectators} />
                            <strong>{formatAllocineNote(ratings.spectators)}</strong>
                            <IonText color="medium">
                              <small>
                                Spectateurs{ratings.votes ? ` • ${ratings.votes.toLocaleString('fr-FR')} votes` : ''}
                              </small>
                            </IonText>
                          </div>
                        )}
                      </div>
                    ) : null}
                    <div className="detail-meta">
                      {detail.year && <p>Annee: {detail.year}</p>}
                      {detail.addedAt && <p>Ajoute le: {detail.addedAt.toLocaleString()}</p>}
                      <p>Type: {detail.type === 'show' ? 'Serie' : 'Film'}</p>
                    </div>
                  </div>
                </div>
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
                  <p className="detail-summary">{detail.summary || 'Aucun resume disponible.'}</p>
                </IonText>
              </div>
            )}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <div className="detail-actions">
                <IonButton
                  expand="block"
                  onClick={() => detail && void preparePlayback(detail)}
                  disabled={!detail}
                >
                  <IonIcon icon={playOutline} slot="start" />
                  Lire sur Plex
                </IonButton>
                <IonButton
                  expand="block"
                  fill="outline"
                  disabled={!detail}
                  onClick={() => {
                    if (!detail) return;
                    requestBrowserOpen(buildAllocineUrl(detail.title));
                    setDetail(null);
                    history.push('/browser');
                  }}
                >
                  <IonIcon icon={filmOutline} slot="start" />
                  Voir sur Allociné
                </IonButton>
                {detail && detail.type.toLowerCase() === 'show' && (
                  <IonButton expand="block" fill="outline" onClick={() => void subscribeShow(detail)}>
                    <IonIcon icon={notificationsOutline} slot="start" />
                    Suivre la série
                  </IonButton>
                )}
              </div>
            </IonToolbar>
          </IonFooter>
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

        <SuggestModal isOpen={showSuggest} onClose={() => setShowSuggest(false)} />
        <PlayerPicker
          isOpen={showPlayerPicker}
          title={selectedItem?.title ?? 'Choisir un lecteur'}
          players={players}
          debug={playersDebug}
          diagnostic={playersDiagnostic}
          refreshing={loadingPlayers}
          onRefresh={() => {
            if (selectedItem) void preparePlayback(selectedItem);
          }}
          onAddManual={(host, port) => void addManualPlayer(host, port)}
          onRemoveManual={handleRemoveManual}
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

