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
  IonInput,
  IonText,
  IonSpinner,
  IonModal,
  IonBadge,
  IonRefresher,
  IonRefresherContent,
  IonFooter,
  RefresherEventDetail,
} from '@ionic/react';
import { settingsOutline, refreshOutline, playOutline, eyeOutline, eyeOffOutline, gridOutline, filmOutline, notificationsOutline, sparklesOutline, downloadOutline, searchOutline } from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import { useHistory } from 'react-router-dom';
import {
  fetchLibrariesData,
  fetchPlayersDetailed,
  fetchSeasonEpisodes,
  fetchShowSeasons,
  fetchWatchHistory,
  playOnPlayer,
  probeAndAddManualPlayer,
  removeManualPlayer as removeManualPlayerEntry,
  type PlexEpisodeItem,
  type PlexLibraryData,
  type PlexLibraryItem,
  type PlexPlayerTarget,
  type PlexSeasonItem,
} from '../services/plex';
import { settings, Keys, transmissionPath } from '../services/settings';
import { buildAllocineQuery, buildAllocineUrl } from '../services/torrentScripts';
import { fetchGeminiRecommendations, type GeminiRecommendation } from '../services/gemini';
import { fetchOpenRouterRecommendations } from '../services/openrouter';
import { searchTorrents, downloadFilmTorrent, formatBytes, type DiscoveryFilm } from '../services/tr4kerDiscovery';
import { uploadTorrentData } from '../services/transmission';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { loadSeenSuggestions, seenKeyFor, seenKeys, type SeenSuggestion } from '../services/seenSuggestions';
import { loadSeenMerged, markSeenEverywhere } from '../services/seenSync';
import { subscriptionIdFor, upsertSubscription } from '../services/seriesWatch';
import { pushSubscription } from '../services/seriesSync';
import { requestBrowserOpen } from '../services/browserNavigation';
import { isDesktopElectron } from '../services/embeddedBrowser';
import SettingsModal from '../components/SettingsModal';
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
  /** Suggestions IA Gemini */
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const [suggestions, setSuggestions] = useState<GeminiRecommendation[]>([]);
  const [suggestCount, setSuggestCount] = useState(10);
  const [suggestWant, setSuggestWant] = useState<'all' | 'movies' | 'series'>('all');
  const [semanticQuery, setSemanticQuery] = useState('');
  /** Nombre de vus (historique, même supprimés) exclus des dernières suggestions. */
  const [suggestHistoryCount, setSuggestHistoryCount] = useState(0);
  /** Suggestions marquées « déjà vu » (persistées, exclues des générations). */
  const [seenList, setSeenList] = useState<SeenSuggestion[]>(() => loadSeenSuggestions());
  /** Notes Allociné par suggestion (clé titre|année, rempli en arrière-plan). */
  const [suggestRatingsMap, setSuggestRatingsMap] = useState<Record<string, AllocineRatings>>({});
  const suggestRatingsMapRef = useRef<Record<string, AllocineRatings>>({});
  const suggestRatingsReq = useRef(0);
  /** Torrents TR4KER trouvés par suggestion (index -> résultats). */
  const [dlResults, setDlResults] = useState<Record<number, DiscoveryFilm[]>>({});
  const [dlLoading, setDlLoading] = useState<number | null>(null);
  const [dlError, setDlError] = useState<Record<number, string>>({});
  const [sendingSlug, setSendingSlug] = useState<string | null>(null);
  const [dlMsg, setDlMsg] = useState('');

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

  async function generateSuggestions() {
    // Provider IA : OpenRouter si sa clé est renseignée, sinon Gemini.
    const useOpenRouter = settings.openrouterApiKey !== '';
    if (!useOpenRouter && !settings.geminiApiKey) {
      setSuggestError('Clé API manquante : ouvre Réglages > IA OpenRouter (clé gratuite sur openrouter.ai/keys) ou IA Gemini.');
      return;
    }
    setSuggestLoading(true);
    setSuggestError('');
    setDlResults({});
    setDlError({});
    setDlMsg('');
    try {
      // Base la suggestion sur la collection COMPLÈTE (pas les 20 derniers affichés) :
      // recharge jusqu'à 1000 items/section, repli sur la liste déjà chargée si échec.
      let source = libraries;
      try {
        const full = await fetchLibrariesData(
          settings.plexResolvedBaseURL,
          settings.plexToken,
          settings.plexSectionKeys,
          1000,
        );
        if (full.length > 0) {
          source = full;
          setLibraries(full);
        }
      } catch {
        /* repli : liste affichée */
      }
      const entries = source.flatMap((lib) =>
        lib.items.map((i) => ({ title: i.title, year: i.year, type: i.type })),
      );
      if (entries.length === 0) throw new Error('Librairie Plex vide.');
      // Historique de visionnage (vus même supprimés) + titres marqués « déjà vu » :
      // best effort, exclus des suggestions (prompt IA + filtre local).
      // Les « déjà vu » fusionnent local + serveur SQLite si synchro configurée.
      let history: { title: string; year?: string; type: string }[] = [];
      let seen: SeenSuggestion[] = seenList;
      try {
        seen = await loadSeenMerged();
        setSeenList(seen);
      } catch {
        /* repli : état en mémoire */
      }
      try {
        history = await fetchWatchHistory(
          settings.plexResolvedBaseURL,
          settings.plexToken,
          300,
        );
      } catch {
        history = [];
      }
      setSuggestHistoryCount(history.length);
      const seenEntries = seen.map((s) => ({ title: s.t, year: s.y, type: 'unknown' }));
      const intent = semanticQuery.trim();
      const opts = {
        count: suggestCount,
        want: suggestWant,
        intent: intent || undefined,
        history: [...history, ...seenEntries],
      };
      let recs;
      if (useOpenRouter) {
        try {
          recs = await fetchOpenRouterRecommendations(settings.openrouterApiKey, entries, {
            ...opts,
            model: settings.openrouterModel,
          });
        } catch (e) {
          // Repli inter-provider sur quota/réseau/serveur : OpenRouter :free saturé → Gemini.
          // (Pas de repli sur clé invalide ou résultat vide : l'erreur reste affichée.)
          const msg = e instanceof Error ? e.message : String(e);
          const fallbackable = /429|402|injoignable|délai dépassé|ne répond pas|HTTP 5\d\d/i.test(msg);
          if (!settings.geminiApiKey || !fallbackable) throw e;
          recs = await fetchGeminiRecommendations(settings.geminiApiKey, entries, {
            ...opts,
            model: settings.geminiModel,
          });
          setDlMsg('OpenRouter saturé : génération via Gemini.');
        }
      } else {
        recs = await fetchGeminiRecommendations(settings.geminiApiKey, entries, {
          ...opts,
          model: settings.geminiModel,
        });
      }
      // Filet local : exclut les « déjà vu » même si Gemini les renvoie.
      const seenSet = seenKeys(seen);
      setSuggestions(recs.filter((r) => !seenSet.has(seenKeyFor(r.title))));
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestLoading(false);
    }
  }

  /** Bouton unique : suggestions ABSENTES de Plex, biaisées par l'intention si saisie. */
  async function generateUnified() {
    await generateSuggestions();
  }

  /** Marque une suggestion comme déjà vue : persistée (local + serveur) + retirée de la liste. */
  function markSuggestionSeen(rec: GeminiRecommendation) {
    void markSeenEverywhere(rec.title, rec.year).then((next) => {
      setSeenList(next);
      const keys = seenKeys(next);
      setSuggestions((prev) => prev.filter((r) => !keys.has(seenKeyFor(r.title))));
    });
  }

  function suggestRatingKey(rec: GeminiRecommendation): string {
    return `${rec.title.trim().toLowerCase()}|${(rec.year || '').trim()}`;
  }

  // Notes Allociné des suggestions en arrière-plan (concurrence limitée, comme Films/Plex).
  useEffect(() => {
    const reqId = ++suggestRatingsReq.current;
    const pending = suggestions.filter((r) => !suggestRatingsMapRef.current[suggestRatingKey(r)]).slice(0, 30);
    if (pending.length === 0) return;
    let cursor = 0;
    let active = 0;
    const CONCURRENCY = 3;
    const pump = () => {
      if (suggestRatingsReq.current !== reqId) return;
      while (active < CONCURRENCY && cursor < pending.length) {
        const rec = pending[cursor++];
        active += 1;
        void fetchAllocineRatings(rec.title, rec.year)
          .then((r) => {
            if (r && suggestRatingsReq.current === reqId) {
              suggestRatingsMapRef.current = { ...suggestRatingsMapRef.current, [suggestRatingKey(rec)]: r };
              setSuggestRatingsMap(suggestRatingsMapRef.current);
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
    return () => window.clearTimeout(stagger);
  }, [suggestions]);

  /** Recherche les torrents TR4KER d'une suggestion (films + séries). */
  async function searchTorrentsFor(rec: GeminiRecommendation, index: number) {
    // Repli : referme si déjà affiché.
    if (dlResults[index] !== undefined && dlLoading !== index) {
      setDlResults((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setDlError((prev) => ({ ...prev, [index]: 'Clé API TR4KER manquante : ajoute-la dans Réglages.' }));
      return;
    }
    setDlLoading(index);
    setDlError((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    try {
      const found = await searchTorrents(apiKey, rec.year ? `${rec.title} ${rec.year}` : rec.title);
      setDlResults((prev) => ({ ...prev, [index]: found }));
    } catch (e) {
      setDlError((prev) => ({ ...prev, [index]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDlLoading(null);
    }
  }

  /** Télécharge le .torrent puis l'envoie vers Transmission (dossier films/séries). */
  async function sendSuggestionTorrent(film: DiscoveryFilm, rec: GeminiRecommendation) {
    if (sendingSlug) return;
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setDlMsg('Clé API TR4KER manquante (Réglages).');
      return;
    }
    setSendingSlug(film.slug);
    setDlMsg('');
    try {
      const bytes = await downloadFilmTorrent(film.slug, apiKey);
      const folder = rec.type === 'series' ? transmissionPath('series') : transmissionPath('films');
      const res = await uploadTorrentData(bytes, folder);
      const name = res.added?.name ?? res.duplicate?.name ?? film.title;
      setDlMsg(res.duplicate ? `Déjà présent dans Transmission : ${name}` : `Ajouté vers Transmission (${folder}) : ${name}`);
    } catch (e) {
      setDlMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSendingSlug(null);
    }
  }

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
      };
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
            <IonButton onClick={() => { setSuggestError(''); setShowSuggest(true); }} title="Suggestions IA">
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
                  onClick={() => { setSuggestError(''); setShowSuggest(true); }}
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

        {/* Suggestions IA Gemini basées sur la collection */}
        <IonModal isOpen={showSuggest} onDidDismiss={() => setShowSuggest(false)} className="detail-modal">
          <IonHeader>
            <IonToolbar>
              <IonTitle>Suggestions IA</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowSuggest(false)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            <div className="detail-sheet">
              <IonText color="medium">
                <p style={{ marginTop: 0 }}>
                  {settings.openrouterApiKey !== '' ? 'OpenRouter' : 'Gemini'} analyse les titres de ta librairie Plex ({libraries.reduce((n, l) => n + l.items.length, 0)} affichés, collection complète rechargée à la génération{suggestHistoryCount > 0 ? ` + ${suggestHistoryCount} vus (historique, même supprimés)` : ''}{seenList.length > 0 ? ` + ${seenList.length} marqués vus` : ''}) pour proposer des films/séries ni en collection ni déjà vus.
                </p>
              </IonText>
              <IonSegment
                value={suggestWant}
                onIonChange={(e) => setSuggestWant(String(e.detail.value) as 'all' | 'movies' | 'series')}
              >
                <IonSegmentButton value="all">
                  <IonLabel>Tous</IonLabel>
                </IonSegmentButton>
                <IonSegmentButton value="movies">
                  <IonLabel>Films</IonLabel>
                </IonSegmentButton>
                <IonSegmentButton value="series">
                  <IonLabel>Séries</IonLabel>
                </IonSegmentButton>
              </IonSegment>

              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--ion-color-light)', borderRadius: 4, padding: '0 8px' }}>
                  <IonIcon icon={searchOutline} color="medium" />
                  <IonInput
                    placeholder="Optionnel : envie (ex: film d'action sombre...) — que du ABSENT de Plex"
                    value={semanticQuery}
                    onIonInput={(e) => setSemanticQuery(e.detail.value!)}
                    style={{ padding: '8px 0' }}
                  />
                </div>
              </div>

              <IonButton
                expand="block"
                style={{ marginTop: 12 }}
                onClick={() => void generateUnified()}
                disabled={suggestLoading}
              >
                <IonIcon icon={sparklesOutline} slot="start" />
                {suggestLoading
                  ? 'Analyse en cours...'
                  : semanticQuery.trim()
                    ? `Suggérer des nouveautés : ${semanticQuery.trim().slice(0, 30)}${semanticQuery.trim().length > 30 ? '…' : ''}`
                    : 'Générer les suggestions (absents de Plex)'}
              </IonButton>
              {suggestLoading && (
                <div style={{ textAlign: 'center', padding: 16 }}>
                  <IonSpinner />
                  <p>
                    <IonText color="medium">Gemini explore ta collection...</IonText>
                  </p>
                </div>
              )}
              {!!suggestError && (
                <p>
                  <IonText color="danger">{suggestError}</IonText>
                </p>
              )}
              {!settings.geminiApiKey && !settings.openrouterApiKey && !suggestLoading && (
                <p>
                  <IonText color="warning">
                    {'Ajoute ta clé API dans Réglages > IA OpenRouter (gratuite sur openrouter.ai/keys, modèles :free) ou IA Gemini.'}
                  </IonText>
                </p>
              )}
            </div>
            {suggestions.length > 0 && (
              <IonList>
                {suggestions.map((rec, i) => (
                  <IonItem key={`${rec.title}-${i}`}>
                    <IonLabel>
                      <h2 style={{ whiteSpace: 'normal' }}>
                        {rec.title}
                        {rec.year ? ` (${rec.year})` : ''}
                      </h2>
                      <p>
                        <IonBadge color={rec.type === 'movie' ? 'primary' : rec.type === 'series' ? 'tertiary' : 'medium'}>
                          {rec.type === 'movie' ? 'Film' : rec.type === 'series' ? 'Série' : 'À vérifier'}
                        </IonBadge>
                      </p>
                      {!!rec.reason && (
                        <p style={{ whiteSpace: 'normal' }}>
                          <IonText color="medium">{rec.reason}</IonText>
                        </p>
                      )}
                      {(() => {
                        const r = suggestRatingsMap[suggestRatingKey(rec)];
                        if (!r) return null;
                        if (r.press == null && r.spectators == null) return null;
                        return (
                          <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                            {r.spectators != null && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <RatingStars value={r.spectators} size={14} />
                                <strong>{formatAllocineNote(r.spectators)}</strong>
                                <IonText color="medium">
                                  <small>Spectateurs{r.votes ? ` • ${r.votes.toLocaleString('fr-FR')} votes` : ''}</small>
                                </IonText>
                              </span>
                            )}
                            {r.press != null && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <RatingStars value={r.press} size={14} />
                                <strong>{formatAllocineNote(r.press)}</strong>
                                <IonText color="medium">
                                  <small>Presse{r.pressReviews ? ` • ${r.pressReviews} critiques` : ''}</small>
                                </IonText>
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                        <IonButton
                          size="small"
                          fill="outline"
                          onClick={() => {
                            requestBrowserOpen(buildAllocineUrl(rec.year ? `${rec.title} ${rec.year}` : rec.title));
                            setShowSuggest(false);
                            history.push('/browser');
                          }}
                        >
                          <IonIcon icon={filmOutline} slot="start" />
                          Allociné
                        </IonButton>
                        <IonButton
                          size="small"
                          onClick={() => void searchTorrentsFor(rec, i)}
                          disabled={dlLoading === i}
                        >
                          <IonIcon icon={downloadOutline} slot="start" />
                          {dlResults[i] !== undefined ? 'Masquer' : 'Télécharger'}
                        </IonButton>
                        <IonButton
                          size="small"
                          fill="clear"
                          onClick={() => markSuggestionSeen(rec)}
                        >
                          <IonIcon icon={eyeOffOutline} slot="start" />
                          Déjà vu
                        </IonButton>
                      </div>
                      {dlLoading === i && (
                        <div style={{ padding: '8px 0' }}>
                          <IonSpinner style={{ width: 18, height: 18 }} />
                          <IonText color="medium"> Recherche sur TR4KER...</IonText>
                        </div>
                      )}
                      {!!dlError[i] && (
                        <p style={{ whiteSpace: 'normal' }}>
                          <IonText color="danger">{dlError[i]}</IonText>
                        </p>
                      )}
                      {dlResults[i] !== undefined && (
                        <div style={{ marginTop: 4 }}>
                          {dlResults[i].length === 0 ? (
                            <p style={{ whiteSpace: 'normal' }}>
                              <IonText color="medium">Aucun torrent trouvé sur TR4KER pour ce titre.</IonText>
                            </p>
                          ) : (
                            dlResults[i].slice(0, 8).map((f) => (
                              <div
                                key={f.slug}
                                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--ion-color-light-shade, #eee)' }}
                              >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, whiteSpace: 'normal', wordBreak: 'break-word' }}>{f.name}</div>
                                  <IonText color="medium">
                                    <small>
                                      {formatBytes(f.sizeBytes)} • {f.seeders} seeders
                                      {f.isFreeleech ? ' • Freeleech' : ''}
                                    </small>
                                  </IonText>
                                </div>
                                <IonButton
                                  size="small"
                                  fill={sendingSlug === f.slug ? 'outline' : 'solid'}
                                  disabled={sendingSlug !== null}
                                  onClick={() => void sendSuggestionTorrent(f, rec)}
                                >
                                  <IonIcon icon={downloadOutline} slot="start" />
                                  {sendingSlug === f.slug ? '...' : 'OK'}
                                </IonButton>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </IonLabel>
                  </IonItem>
                ))}
              </IonList>
            )}
            {!!dlMsg && (
              <div style={{ padding: '4px 16px 12px' }}>
                <IonText color="medium">
                  <p style={{ whiteSpace: 'normal' }}>{dlMsg}</p>
                </IonText>
              </div>
            )}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <IonButton expand="block" fill="clear" onClick={() => void generateUnified()} disabled={suggestLoading}>
                <IonIcon icon={refreshOutline} slot="start" />
                Relancer avec d'autres idées
              </IonButton>
            </IonToolbar>
          </IonFooter>
        </IonModal>
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

