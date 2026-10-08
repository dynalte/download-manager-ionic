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
  IonSearchbar,
  IonList,
  IonItem,
  IonText,
  IonSpinner,
  IonModal,
  IonBadge,
  IonFooter,
  IonToast,
  IonRefresher,
  IonRefresherContent,
  IonChip,
  RefresherEventDetail,
} from '@ionic/react';
import { settingsOutline, refreshOutline, downloadOutline, filmOutline, starOutline, sparklesOutline, notificationsOutline } from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import {
  fetchFilms,
  fetchTorrentDetail,
  fetchSameMovieTorrents,
  loadAddedSlugs,
  markSlugAdded,
  formatBytes,
  FILMS_PERIODS,
  DISCOVERY_CATEGORIES,
  discoveryCategory,
  filterByDiscoveryCategory,
  type DiscoveryFilm,
  type DiscoveryCategoryKey,
  type FilmsPeriod,
} from '../services/tr4kerDiscovery';
import { activeSourceKeys, downloadFromSource, fetchC411Detail, fetchLatestC411, parseTechTags, searchAllSources, techRowsFor, type C411Detail } from '../services/c411';
import { fetchLatestV3X, fetchV3XDetail } from '../services/v3x';
import { settings } from '../services/settings';
import { isServerConfigured } from '../services/serverApi';
import { transmissionPath } from '../services/settings';
import { uploadTorrentData } from '../services/transmission';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { fetchTmdbDetails, fetchTmdbPoster, formatRuntime, type TmdbDetails } from '../services/tmdb';
import { buildAllocineQuery, buildAllocineUrl } from '../services/torrentScripts';
import {
  forgetDeletedSubscription,
  loadSubscriptions,
  subscriptionIdFor,
  upsertSubscription,
} from '../services/seriesWatch';
import { pushSubscription } from '../services/seriesSync';
import { fetchPreviousEpisode, primeShowCache, searchShows, type ShowSearchHit } from '../services/seriesCalendar';
import { fetchSearchIdeas } from '../services/gemini';
import { requestBrowserOpen } from '../services/browserNavigation';
import SettingsModal from '../components/SettingsModal';
import SuggestModal from '../components/SuggestModal';
import RatingStars from '../components/RatingStars';

const PAGE_SIZE = 25;

/** Période Nouveautés -> seuil pubDate pour les dernières sorties C411 (0 = tout). */
function periodSinceMs(p: FilmsPeriod): number {
  const day = 24 * 3600 * 1000;
  if (p === 'day') return Date.now() - day;
  if (p === 'week') return Date.now() - 7 * day;
  if (p === 'month') return Date.now() - 31 * day;
  return 0;
}

/**
 * Visuel d'un résultat : notes/synopsis/affiche Allociné, avec repli affiche
 * TMDB quand Allociné ne renvoie rien (anti-bot / CORS). Les notes Allociné
 * existantes sont conservées, seule l'affiche manquante est complétée.
 */
async function fetchArtwork(film: DiscoveryFilm, cat: DiscoveryCategoryKey): Promise<AllocineRatings | null> {
  let r: AllocineRatings | null = null;
  try {
    r = await fetchAllocineRatings(film.title, film.year);
  } catch {
    r = null;
  }
  if ((r?.posterURL ?? null) || !settings.tmdbApiKey) return r;
  try {
    const p = await fetchTmdbPoster(settings.tmdbApiKey, film.title, film.year, cat === 'series' ? 'tv' : 'movie');
    if (!p?.posterURL) return r;
    return {
      title: r?.title ?? film.title,
      year: r?.year ?? film.year ?? '',
      url: r?.url ?? '',
      press: r?.press ?? null,
      pressReviews: r?.pressReviews ?? null,
      spectators: r?.spectators ?? null,
      votes: r?.votes ?? null,
      posterURL: p.posterURL,
      synopsis: r?.synopsis ?? null,
    };
  } catch {
    return r;
  }
}

const FilmsTab: React.FC = () => {
  const history = useHistory();
  const [films, setFilms] = useState<DiscoveryFilm[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<FilmsPeriod>('week');
  const [categoryKey, setCategoryKey] = useState<DiscoveryCategoryKey>(() => {
    const v = localStorage.getItem('films_category_v1') ?? 'films';
    return v === 'series' || v === 'books' || v === 'audiobooks' ? v : 'films';
  });
  const category = discoveryCategory(categoryKey);
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');
  /** Temporisation d'envoi de la recherche (la frappe reste locale et instantanée). */
  const queryTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (queryTimer.current !== null) window.clearTimeout(queryTimer.current);
    },
    [],
  );
  const [showSettings, setShowSettings] = useState(false);
  /** Modale Suggestions IA (composant partagé Plex + Catalogue). */
  const [showSuggest, setShowSuggest] = useState(false);
  const [toast, setToast] = useState('');
  const [detail, setDetail] = useState<DiscoveryFilm | null>(null);
  /** Descriptif TR4KER (repli si Allociné sans synopsis). undefined = en cours. */
  const [detailDesc, setDetailDesc] = useState<string | null | undefined>(undefined);
  /** Fiche C411 (synopsis + technique). null = pas encore chargée / échec. */
  const [c411Detail, setC411Detail] = useState<C411Detail | null>(null);
  const [c411Loading, setC411Loading] = useState(false);
  /** Notes Allociné de la fiche ouverte : chargement proactif dédié. */
  const [detailRatingLoading, setDetailRatingLoading] = useState(false);
  /** Fiche TMDB (repli quand la fiche C411 exige un login : infos + casting). */
  const [tmdbDetail, setTmdbDetail] = useState<TmdbDetails | null>(null);
  const [tmdbLoading, setTmdbLoading] = useState(false);
  /** Ajout de la série affichée aux suivis (fiche Catalogue -> onglet Suivis). */
  const [watchAdding, setWatchAdding] = useState(false);
  /** Autres formats du même film (2e modale). */
  const [showFormats, setShowFormats] = useState(false);
  const [formats, setFormats] = useState<DiscoveryFilm[]>([]);
  const [formatsLoading, setFormatsLoading] = useState(false);
  const [formatsError, setFormatsError] = useState('');
  const [addingSlug, setAddingSlug] = useState<string | null>(null);
  const [addedSlugs, setAddedSlugs] = useState<Set<string>>(() => loadAddedSlugs());
  /** Notes Allociné par slug (rempli en arrière-plan, concurrence limitée). */
  const [ratingsMap, setRatingsMap] = useState<Record<string, AllocineRatings>>({});
  const ratingsMapRef = useRef<Record<string, AllocineRatings>>({});
  const ratingsFillReq = useRef(0);
  /** Idées de recherches complémentaires (Gemini) pour la requête en cours. */
  const [ideas, setIdeas] = useState<string[]>([]);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [ideasError, setIdeasError] = useState('');
  /** Total C411 du chargement Nouveautés (non paginé : conservé pour « Charger plus » TR4KER). */
  const c411ExtraTotal = useRef(0);
  /** Total V3X du chargement Nouveautés (même motif que C411). */
  const v3xExtraTotal = useRef(0);

  const hasKey = settings.tr4kerApiKey !== '' || settings.c411ApiKey !== '' || settings.v3xApiKey !== '';
  /** Libellé des sources actives pour la recherche ("TR4KER", "C411", "V3X"...). */
  const searchSourcesLabel = (() => {
    const keys = activeSourceKeys();
    return [keys.tr4kerApiKey !== '' ? 'TR4KER' : '', keys.c411ApiKey !== '' ? 'C411' : '', keys.v3xApiKey !== '' ? 'V3X' : ''].filter(Boolean).join(' + ');
  })();

  const loadItems = useCallback(async (cat: DiscoveryCategoryKey, p: FilmsPeriod, q: string, pageNum: number, append: boolean) => {
    const keys = activeSourceKeys();
    if (!keys.tr4kerApiKey && !keys.c411ApiKey && !keys.v3xApiKey) {
      setError('Colle ta clé API TR4KER, C411 ou V3X dans Réglages pour voir les films.');
      return;
    }
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const def = discoveryCategory(cat);
      // Recherche par titre : TR4KER + C411 + V3X fusionnés (tri seeders).
      if (q.trim() !== '') {
        const res = await searchAllSources(q, keys, { category: cat, limit: PAGE_SIZE });
        const items = filterByDiscoveryCategory(res.films, cat);
        setFilms(items);
        setTotal(items.length);
        setPage(1);
        setError('');
        if (res.partialErrors.length > 0) setToast(res.partialErrors.join(' / '));
        return;
      }
      // Sans recherche : Nouveautés TR4KER (période, paginé) + dernières
      // sorties C411/V3X (rechargées à chaque filtre, pas à « Charger plus »).
      const partial: string[] = [];
      let tr4kerFilms: DiscoveryFilm[] = [];
      let tr4kerTotal = 0;
      if (keys.tr4kerApiKey) {
        try {
          const res = await fetchFilms(keys.tr4kerApiKey, { cat: def.cat, period: p, query: q, limit: PAGE_SIZE, page: pageNum, sort: 'seeders' });
          tr4kerFilms = res.films;
          tr4kerTotal = res.total;
        } catch (e) {
          partial.push(e instanceof Error ? e.message : String(e));
        }
      }
      let c411Count = append ? c411ExtraTotal.current : 0;
      let c411Films: DiscoveryFilm[] = [];
      if (!append && keys.c411ApiKey) {
        try {
          c411Films = await fetchLatestC411(keys.c411ApiKey, { category: cat, limit: 100, sinceMs: periodSinceMs(p) });
          c411Count = c411Films.length;
          c411ExtraTotal.current = c411Count;
        } catch (e) {
          partial.push(e instanceof Error ? e.message : String(e));
        }
      }
      let v3xCount = append ? v3xExtraTotal.current : 0;
      let v3xFilms: DiscoveryFilm[] = [];
      if (!append && keys.v3xApiKey) {
        try {
          v3xFilms = await fetchLatestV3X(keys.v3xApiKey, { category: cat, limit: 100, sinceMs: periodSinceMs(p) });
          v3xCount = v3xFilms.length;
          v3xExtraTotal.current = v3xCount;
        } catch (e) {
          partial.push(e instanceof Error ? e.message : String(e));
        }
      }
      const merged = filterByDiscoveryCategory([...tr4kerFilms, ...c411Films, ...v3xFilms], cat);
      merged.sort((a, b) => b.seeders - a.seeders);
      if (merged.length === 0 && partial.length > 0) throw new Error(partial.join(' / '));
      setFilms((prev) => (append ? [...prev, ...merged.filter((f) => !prev.some((x) => x.slug === f.slug))] : merged));
      setTotal(tr4kerTotal + c411Count + v3xCount);
      setPage(pageNum);
      setError('');
      if (partial.length > 0) setToast(partial.join(' / '));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // Recharge à chaque changement de catégorie / période / recherche validée.
  useEffect(() => {
    void loadItems(categoryKey, period, query, 1, false);
    // Idées IA liées à l'ancienne requête : périmées.
    setIdeas([]);
    setIdeasError('');
  }, [categoryKey, period, query, loadItems]);

  /** Demande à Gemini des recherches complémentaires (tap → relance la recherche). */
  async function loadIdeas() {
    const q = query.trim();
    if (!q || ideasLoading) return;
    if (!settings.geminiApiKey) {
      setIdeasError('Clé API Gemini manquante : Réglages > IA Gemini.');
      return;
    }
    setIdeasLoading(true);
    setIdeasError('');
    try {
      const context = films.slice(0, 8).map((f) => f.title);
      setIdeas(await fetchSearchIdeas(settings.geminiApiKey, q, category.label, context, settings.geminiModel));
    } catch (e) {
      setIdeasError(e instanceof Error ? e.message : String(e));
    } finally {
      setIdeasLoading(false);
    }
  }

  function runIdea(idea: string) {
    const v = idea.trim();
    if (!v) return;
    if (queryTimer.current !== null) window.clearTimeout(queryTimer.current);
    setQueryInput(v);
    setQuery(v);
  }

  // Notes Allociné en arrière-plan (films + séries uniquement), avec repli
  // affiche TMDB quand Allociné est bloqué (anti-bot / CORS).
  useEffect(() => {
    if (!category.allocine) return;
    const reqId = ++ratingsFillReq.current;
    const pending = films.filter((f) => !ratingsMapRef.current[f.slug]).slice(0, 60);
    if (pending.length === 0) return;
    let cursor = 0;
    let active = 0;
    const CONCURRENCY = 3;
    const pump = () => {
      if (ratingsFillReq.current !== reqId) return;
      while (active < CONCURRENCY && cursor < pending.length) {
        const film = pending[cursor++];
        active += 1;
        void fetchArtwork(film, categoryKey)
          .then((r) => {
            if (r && ratingsFillReq.current === reqId) {
              ratingsMapRef.current = { ...ratingsMapRef.current, [film.slug]: r };
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
    return () => window.clearTimeout(stagger);
  }, [films, category.allocine, categoryKey]);

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    await loadItems(categoryKey, period, query, 1, false);
    event.detail.complete();
  }

  /** Ouvre la fiche + charge le descriptif (TR4KER) ou la fiche tracker (C411/V3X : synopsis + technique). */
  function openDetail(film: DiscoveryFilm) {
    setDetail(film);
    setDetailDesc(undefined);
    setC411Detail(null);
    setTmdbDetail(null);
    const wantTracker = film.source === 'c411' || film.source === 'v3x';
    setC411Loading(wantTracker);
    // Fiche TMDB via les IDs Torznab (imdbid/tmdbid) : remplace les sections
    // INFORMATIONS + CASTING de la fiche C411 (login web requis, inaccessible).
    const wantTmdb =
      settings.tmdbApiKey.trim() !== '' && (typeof film.tmdbId === 'number' || !!film.imdbId);
    setTmdbLoading(wantTmdb);
    const wantRating = discoveryCategory(categoryKey).allocine && !ratingsMapRef.current[film.slug];
    setDetailRatingLoading(wantRating);
    if (wantTracker) {
      setDetailDesc(null);
      const detailPromise =
        film.source === 'v3x'
          ? fetchV3XDetail(film, settings.v3xApiKey)
          : fetchC411Detail(film, settings.c411ApiKey);
      void detailPromise
        .then((d) => {
          setC411Detail(d);
        })
        .catch(() => setC411Detail(null))
        .finally(() => setC411Loading(false));
    } else {
      setC411Loading(false);
      const apiKey = settings.tr4kerApiKey;
      if (!apiKey) {
        setDetailDesc(null);
      } else {
        void fetchTorrentDetail(film.slug, apiKey)
          .then((d) => setDetailDesc(d.description ?? null))
          .catch(() => setDetailDesc(null));
      }
    }
    // Notes Allociné de la fiche : ne pas attendre le remplissage différé
    // de la liste (stagger 600 ms) quand on ouvre directement une fiche.
    if (wantTmdb) {
      void fetchTmdbDetails(settings.tmdbApiKey, {
        tmdbId: film.tmdbId,
        imdbId: film.imdbId,
        kind: categoryKey === 'series' ? 'tv' : 'movie',
      })
        .then((d) => setTmdbDetail(d))
        .catch(() => setTmdbDetail(null))
        .finally(() => setTmdbLoading(false));
    }
    if (wantRating) {
      void fetchArtwork(film, categoryKey)
        .then((r) => {
          if (r) {
            ratingsMapRef.current = { ...ratingsMapRef.current, [film.slug]: r };
            setRatingsMap(ratingsMapRef.current);
          }
        })
        .catch(() => {})
        .finally(() => setDetailRatingLoading(false));
    }
  }

  /** Ferme la fiche (réinitialise les états liés). */
  function closeDetail() {
    setDetail(null);
    setC411Detail(null);
    setC411Loading(false);
    setTmdbDetail(null);
    setTmdbLoading(false);
    setDetailRatingLoading(false);
    setWatchAdding(false);
  }

  /** Ouvre la liste des autres formats du film affiché (TR4KER uniquement). */
  async function openFormats(film: DiscoveryFilm) {
    setShowFormats(true);
    setFormats([]);
    setFormatsError('');
    if (film.source !== 'tr4ker') {
      setFormatsError(`Autres formats : TR4KER uniquement (résultat ${film.source === 'v3x' ? 'V3X' : 'C411'}).`);
      return;
    }
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setFormatsError('Clé API TR4KER manquante (Réglages).');
      return;
    }
    setFormatsLoading(true);
    try {
      setFormats(await fetchSameMovieTorrents(film, apiKey));
    } catch (e) {
      setFormatsError(e instanceof Error ? e.message : String(e));
    } finally {
      setFormatsLoading(false);
    }
  }

  /** Envoie le .torrent vers Transmission (dossier de la catégorie), quelle que soit la source. */
  async function sendToDownload(film: DiscoveryFilm) {
    if (addingSlug) return;
    const keys = activeSourceKeys();
    if (!keys.tr4kerApiKey && !keys.c411ApiKey && !keys.v3xApiKey) {
      setToast('Clé API TR4KER, C411 ou V3X manquante (Réglages).');
      return;
    }
    setAddingSlug(film.slug);
    try {
      const bytes = await downloadFromSource(film, keys);
      const folder = discoveryCategory(categoryKey).folder;
      const res = await uploadTorrentData(bytes, transmissionPath(folder));
      const name = res.added?.name ?? res.duplicate?.name ?? film.title;
      markSlugAdded(film.slug);
      setAddedSlugs(loadAddedSlugs());
      setToast(res.duplicate ? `Déjà présent : ${name}` : `Ajouté vers Transmission : ${name}`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingSlug(null);
    }
  }

  function openAllocine(film: DiscoveryFilm) {
    const r = ratingsMap[film.slug];
    requestBrowserOpen(r?.url || buildAllocineUrl(`${film.title} ${film.year ?? ''}`.trim()));
    closeDetail();
    history.push('/browser');
  }

  /** La série de la fiche est-elle déjà suivie (même test que l'onglet Suivis) ? */
  function detailWatchId(film: DiscoveryFilm): string {
    return subscriptionIdFor(film.title, film.year);
  }

  /** Ajoute la série affichée aux suivis (même flux que Suggestions/Suivis : base TVMaze si trouvée). */
  async function addDetailToWatch() {
    if (!detail || watchAdding) return;
    const film = detail;
    const id = detailWatchId(film);
    const existing = loadSubscriptions().find((s) => s.id === id || s.title.trim().toLowerCase() === film.title.trim().toLowerCase());
    if (existing) {
      setToast(`${existing.title} est déjà suivie`);
      closeDetail();
      history.push('/watch');
      return;
    }
    setWatchAdding(true);
    try {
      // Base TVMaze (dernier épisode diffusé) quand la série s'y trouve ;
      // sinon suivi créé sans base (détection dès les packs dispo).
      let hit: ShowSearchHit | null = null;
      try {
        let hits = await searchShows(film.title);
        if (hits.length === 0 && film.year) hits = await searchShows(`${film.title} ${film.year}`);
        if (hits.length > 0) {
          const want = film.title.trim().toLowerCase();
          const year = String(film.year || '').trim();
          let best = hits[0];
          let bestScore = -1;
          for (const h of hits) {
            const n = h.name.trim().toLowerCase();
            let score = 0;
            if (n === want) score += 100;
            else if (n.startsWith(want) || want.startsWith(n)) score += 70;
            else if (n.includes(want) || want.includes(n)) score += 40;
            else score += 10;
            if (year && h.year === year) score += 25;
            if (score > bestScore) {
              bestScore = score;
              best = h;
            }
          }
          hit = best;
        }
      } catch {
        /* TVMaze injoignable : suivi sans base */
      }
      const prev = hit ? await fetchPreviousEpisode(hit.id).catch(() => null) : null;
      const maxS = prev?.season ?? 0;
      const maxE = prev?.episode ?? 0;
      const sub = {
        id,
        title: hit ? hit.name : film.title,
        query: buildAllocineQuery(hit ? hit.name : film.title) || film.title,
        year: hit ? hit.year : film.year,
        enabled: true,
        lastSeason: maxS,
        lastEpisode: maxE,
        addedKeys: [],
        createdAt: Date.now(),
        lastCheckAt: 0,
        lastResult: hit ? `Base TVMaze : S${String(maxS).padStart(2, '0')}E${String(maxE).padStart(2, '0')}` : 'Ajoutée depuis le Catalogue',
        updatedAt: Date.now(),
      };
      forgetDeletedSubscription(sub.id);
      upsertSubscription(sub);
      if (hit) primeShowCache(sub.id, hit);
      void pushSubscription(sub).catch(() => {});
      setToast(`Suivi activé : ${sub.title}. Voir l’onglet Suivis.`);
      closeDetail();
      history.push('/watch');
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setWatchAdding(false);
    }
  }

  const FilmRating: React.FC<{ film: DiscoveryFilm; big?: boolean }> = ({ film, big }) => {
    const r = ratingsMap[film.slug];
    const v = r ? (r.spectators ?? r.press) : null;
    if (v == null) return null;
    return (
      <span className="ratings-inline">
        <RatingStars value={v} size={big ? 18 : 14} />
        <strong>{formatAllocineNote(v)}</strong>
      </span>
    );
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Catalogue</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => setShowSuggest(true)} title="Suggestions IA">
              <IonIcon icon={sparklesOutline} />
            </IonButton>
            <IonButton onClick={() => setShowSettings(true)}>
              <IonIcon icon={settingsOutline} />
            </IonButton>
            <IonButton onClick={() => void loadItems(categoryKey, period, query, 1, false)} disabled={loading || !hasKey}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonSearchbar
            value={queryInput}
            placeholder={`Rechercher ${category.label.toLowerCase()}...`}
            onIonInput={(e) => {
              const v = String(e.detail.value ?? '');
              // Saisie immédiate côté champ ; la recherche (réseau + re-render
              // de la liste) ne part qu'après 600 ms sans frappe, pour ne pas
              // perturber la saisie en cours.
              setQueryInput(v);
              if (queryTimer.current !== null) window.clearTimeout(queryTimer.current);
              queryTimer.current = window.setTimeout(() => setQuery(v.trim()), 600);
            }}
          />
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        <div style={{ padding: '8px 12px' }}>
          <IonSegment
            value={categoryKey}
            onIonChange={(e) => {
              const v = String(e.detail.value) as DiscoveryCategoryKey;
              setCategoryKey(v);
              try {
                localStorage.setItem('films_category_v1', v);
              } catch {
                /* ignore */
              }
            }}
          >
            {DISCOVERY_CATEGORIES.map((c) => (
              <IonSegmentButton key={c.key} value={c.key}>
                <IonLabel>{c.label}</IonLabel>
              </IonSegmentButton>
            ))}
          </IonSegment>
          <IonSegment
            value={period}
            onIonChange={(e) => setPeriod(String(e.detail.value) as FilmsPeriod)}
            style={{ marginTop: 8 }}
          >
            {FILMS_PERIODS.map((p) => (
              <IonSegmentButton key={p.key} value={p.key}>
                <IonLabel>{p.label}</IonLabel>
              </IonSegmentButton>
            ))}
          </IonSegment>
          <p>
            <IonText color="medium">
              <small>
                {query
                  ? `Recherche "${query}" (${searchSourcesLabel})`
                  : `Nouveautés (${searchSourcesLabel})`}{' '}
                {category.label.toLowerCase()} triés par {query ? 'pertinence' : 'popularité (seeders)'}
                {total > 0 ? ` • ${films.length}/${total}` : ''}
              </small>
            </IonText>
          </p>
          {query.trim() !== '' && (
            <div>
              {ideas.length === 0 && !ideasLoading && (
                <IonButton size="small" fill="outline" onClick={() => void loadIdeas()}>
                  <IonIcon icon={sparklesOutline} slot="start" />
                  Idées de recherche IA
                </IonButton>
              )}
              {ideasLoading && (
                <p>
                  <IonSpinner style={{ width: 16, height: 16 }} />
                  <IonText color="medium"> Idées en cours…</IonText>
                </p>
              )}
              {!!ideasError && (
                <p>
                  <IonText color="danger">{ideasError}</IonText>
                </p>
              )}
              {ideas.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0 8px' }}>
                  {ideas.map((idea) => (
                    <IonChip key={idea} outline onClick={() => runIdea(idea)}>
                      <IonIcon icon={sparklesOutline} color="tertiary" />
                      <IonLabel>{idea}</IonLabel>
                    </IonChip>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {loading && films.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
            <p>
              <IonText color="medium">Chargement des {category.label.toLowerCase()}...</IonText>
            </p>
          </div>
        ) : films.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonText color={error ? 'danger' : 'medium'}>{error || `Aucun résultat (${category.label.toLowerCase()})`}</IonText>
            {!hasKey && (
              <p>
                <IonButton size="small" onClick={() => setShowSettings(true)}>
                  Ouvrir les réglages
                </IonButton>
              </p>
            )}
          </div>
        ) : (
          <IonList>
            {films.map((film) => (
              <IonItem key={film.slug} button onClick={() => openDetail(film)}>
                {ratingsMap[film.slug]?.posterURL ? (
                  <img src={ratingsMap[film.slug]?.posterURL ?? ''} alt="" className="poster-thumb" slot="start" loading="lazy" />
                ) : (
                  <IonIcon icon={filmOutline} slot="start" color="primary" />
                )}
                <IonLabel>
                  <h2 style={{ whiteSpace: 'normal' }}>
                    {film.title}
                    {film.year ? ` (${film.year})` : ''}
                  </h2>
                  <p>
                    {formatBytes(film.sizeBytes)} • {film.seeders} seeders
                    {film.addedAt ? ` • ${film.addedAt.toLocaleDateString()}` : ''}
                  </p>
                  {category.allocine && <FilmRating film={film} />}
                  <p>
                    {film.isFreeleech && <IonBadge color="tertiary">Freeleech</IonBadge>}{' '}
                    {film.source === 'c411' && <IonBadge color="secondary">C411</IonBadge>}{' '}{film.source === 'v3x' && <IonBadge color="secondary">V3X</IonBadge>}{' '}
                    {addedSlugs.has(film.slug) && <IonBadge color="success">Ajouté</IonBadge>}
                  </p>
                </IonLabel>
              </IonItem>
            ))}
          </IonList>
        )}

        {films.length > 0 && films.length < total && (
          <div style={{ textAlign: 'center', padding: 12 }}>
            <IonButton fill="outline" size="small" disabled={loadingMore} onClick={() => void loadItems(categoryKey, period, query, page + 1, true)}>
              {loadingMore ? <IonSpinner style={{ width: 16, height: 16 }} /> : 'Charger plus'}
            </IonButton>
          </div>
        )}

        {/* Fiche */}
        <IonModal isOpen={detail !== null} onDidDismiss={() => closeDetail()} className="detail-modal">
          <IonHeader>
            <IonToolbar>
              <IonTitle>Fiche</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => closeDetail()}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            {detail && (
              <div className="detail-sheet">
                <div className="detail-top">
                  {ratingsMap[detail.slug]?.posterURL && (
                    <img src={ratingsMap[detail.slug]?.posterURL ?? ''} alt={detail.title} className="poster-large detail-poster" />
                  )}
                  <div className="detail-head">
                    <h2 className="detail-title">
                      {detail.title}
                      {detail.year ? ` (${detail.year})` : ''}
                    </h2>
                    <p>
                      {detail.isFreeleech && <IonBadge color="tertiary">Freeleech</IonBadge>}{' '}
                      {detail.source === 'c411' && <IonBadge color="secondary">C411</IonBadge>}{' '}{detail.source === 'v3x' && <IonBadge color="secondary">V3X</IonBadge>}{' '}
                      {addedSlugs.has(detail.slug) && <IonBadge color="success">Ajouté</IonBadge>}
                    </p>
                    <div className="detail-meta">
                      <p>
                        Taille : {formatBytes(detail.sizeBytes)} • {detail.seeders} seeders / {detail.leechers} leechers
                      </p>
                      {detail.addedAt && <p>Ajouté le : {detail.addedAt.toLocaleString()}</p>}
                      {detail.category && <p>Catégorie : {detail.category}</p>}
                    </div>
                  </div>
                </div>
                {category.allocine && (
                  <>
                    <h3>Synopsis</h3>
                    <IonText color="medium">
                      <p className="detail-summary">
                        {(() => {
                          const allo = ratingsMap[detail.slug]?.synopsis ?? null;
                          if (allo) return allo;
                          if (detail.source === 'c411' || detail.source === 'v3x') {
                            if (c411Detail?.synopsis) return c411Detail.synopsis;
                            if (tmdbDetail?.overview) return tmdbDetail.overview;
                            if (c411Loading || tmdbLoading) return 'Chargement du synopsis…';
                            return 'Aucun synopsis (ni Allociné, ni tracker, ni TMDB).';
                          }
                          if (tmdbDetail?.overview) return tmdbDetail.overview;
                          if (ratingsMap[detail.slug] || (!detailRatingLoading && !tmdbLoading))
                            return 'Aucun synopsis Allociné.';
                          return 'Recherche du synopsis…';
                        })()}
                      </p>
                    </IonText>
                    {(detail.source === 'c411' || detail.source === 'v3x') && ratingsMap[detail.slug]?.synopsis && c411Detail?.synopsis && (
                      <IonText color="medium">
                        <p className="detail-summary">
                          <strong>Synopsis {detail.source === 'v3x' ? 'V3X' : 'C411'} : </strong>
                          {c411Detail.synopsis}
                        </p>
                      </IonText>
                    )}
                  </>
                )}
                {category.allocine &&
                  (tmdbLoading ? (
                    <p className="ratings-row">
                      <IonSpinner style={{ width: 16, height: 16 }} />
                      <IonText color="medium">Chargement des informations TMDB…</IonText>
                    </p>
                  ) : (
                    tmdbDetail &&
                    (tmdbDetail.genres.length > 0 ||
                      tmdbDetail.countries.length > 0 ||
                      tmdbDetail.director ||
                      tmdbDetail.rating != null ||
                      tmdbDetail.cast.length > 0 ||
                      tmdbDetail.runtimeMin != null) && (
                      <>
                        <h3>Informations</h3>
                        <div className="detail-meta">
                          {tmdbDetail.runtimeMin != null && (
                            <p>Durée : {formatRuntime(tmdbDetail.runtimeMin)}</p>
                          )}
                          {tmdbDetail.genres.length > 0 && <p>Genres : {tmdbDetail.genres.join(', ')}</p>}
                          {tmdbDetail.countries.length > 0 && <p>Pays : {tmdbDetail.countries.join(', ')}</p>}
                          {tmdbDetail.director && <p>Réalisateur : {tmdbDetail.director}</p>}
                          {tmdbDetail.rating != null && (
                            <p>
                              Note TMDB : {tmdbDetail.rating.toFixed(1).replace('.', ',')}/10
                              {tmdbDetail.votes != null ? ` (${tmdbDetail.votes.toLocaleString('fr-FR')} votes)` : ''}
                            </p>
                          )}
                        </div>
                        {tmdbDetail.cast.length > 0 && (
                          <>
                            <h3>Casting</h3>
                            <IonText color="medium">
                              <p className="detail-summary">{tmdbDetail.cast.join(', ')}</p>
                            </IonText>
                          </>
                        )}
                      </>
                    )
                  ))}
                {category.allocine &&
                  (() => {
                    const r = ratingsMap[detail.slug];
                    if (!r || (r.press == null && r.spectators == null)) {
                      if (detailRatingLoading) {
                        return (
                          <p className="ratings-row">
                            <IonIcon icon={starOutline} />
                            <IonText color="medium">Recherche de la note Allociné…</IonText>
                          </p>
                        );
                      }
                      return (
                        <p className="ratings-row">
                          <IonIcon icon={starOutline} />
                          <IonText color="medium">
                            Aucune note Allociné trouvée.
                            {!isServerConfigured() &&
                              ' (Web : configure le serveur perso — Réglages > Synchro vus — pour activer le relais Allociné.)'}
                          </IonText>
                        </p>
                      );
                    }
                    return (
                      <div className="ratings-block">
                        <IonBadge color="tertiary">Allociné</IonBadge>
                        {r.press != null && (
                          <div className="ratings-line">
                            <RatingStars value={r.press} />
                            <strong>{formatAllocineNote(r.press)}</strong>
                            <IonText color="medium">
                              <small>Presse{r.pressReviews ? ` • ${r.pressReviews} critiques` : ''}</small>
                            </IonText>
                          </div>
                        )}
                        {r.spectators != null && (
                          <div className="ratings-line">
                            <RatingStars value={r.spectators} />
                            <strong>{formatAllocineNote(r.spectators)}</strong>
                            <IonText color="medium">
                              <small>
                                Spectateurs{r.votes ? ` • ${r.votes.toLocaleString('fr-FR')} votes` : ''}
                              </small>
                            </IonText>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                {(detail.source === 'c411' || detail.source === 'v3x') && (
                  <>
                    <h3>Détails techniques</h3>
                    {(() => {
                      const rows = techRowsFor(detail.name);
                      if (rows.length > 0) {
                        return (
                          <div className="detail-meta">
                            {rows.map((row) => (
                              <p key={row.label}>
                                {row.label} : {row.value}
                              </p>
                            ))}
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {(c411Detail?.techTags ?? parseTechTags(detail.name)).length > 0 && (
                      <p>
                        {(c411Detail?.techTags ?? parseTechTags(detail.name)).map((t) => (
                          <IonBadge key={t} color="medium" style={{ marginRight: 4 }}>
                            {t}
                          </IonBadge>
                        ))}
                      </p>
                    )}
                    <IonText color="medium">
                      <p className="detail-summary">
                        {c411Detail?.techDetails ??
                          (c411Loading
                            ? 'Chargement des détails tracker…'
                            : techRowsFor(detail.name).length > 0
                              ? 'Caractéristiques ci-dessus, lues dans le nom du torrent (la fiche tracker exige une connexion web).'
                              : 'Aucun détail technique (ni fiche tracker accessible, ni marqueur dans le nom).')}
                      </p>
                    </IonText>
                    {detail.detailsUrl && (
                      <IonButton
                        size="small"
                        fill="clear"
                        onClick={() => {
                          if (detail.detailsUrl) {
                            requestBrowserOpen(detail.detailsUrl);
                            closeDetail();
                            history.push('/browser');
                          }
                        }}
                      >
                        Voir la fiche {detail.source === 'v3x' ? 'V3X' : 'C411'}
                      </IonButton>
                    )}
                  </>
                )}
                {detail.source === 'tr4ker' && (
                  <>
                    <h3>Descriptif TR4KER</h3>
                    <IonText color="medium">
                      <p className="detail-summary">
                        {detailDesc ?? (detailDesc === undefined ? 'Chargement…' : 'Aucun descriptif.')}
                      </p>
                    </IonText>
                  </>
                )}
                <h3>Torrent</h3>
                <IonText color="medium">
                  <p className="detail-summary">{detail.name}</p>
                </IonText>
              </div>
            )}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <div className="detail-actions">
                <IonButton
                  expand="block"
                  disabled={!detail || addingSlug !== null}
                  onClick={() => detail && void sendToDownload(detail)}
                >
                  <IonIcon icon={downloadOutline} slot="start" />
                  {detail && addingSlug === detail.slug
                    ? 'Envoi en cours…'
                    : detail && addedSlugs.has(detail.slug)
                      ? 'Renvoyer vers Transmission'
                      : 'Télécharger'}
                </IonButton>
                {category.allocine && (
                  <IonButton expand="block" fill="outline" disabled={!detail} onClick={() => detail && openAllocine(detail)}>
                    <IonIcon icon={filmOutline} slot="start" />
                    Voir sur Allociné
                  </IonButton>
                )}
                {categoryKey === 'series' && (
                  <IonButton
                    expand="block"
                    fill="outline"
                    disabled={!detail || watchAdding}
                    onClick={() => void addDetailToWatch()}
                  >
                    <IonIcon icon={notificationsOutline} slot="start" />
                    {detail && loadSubscriptions().some((s) => s.id === detailWatchId(detail))
                      ? 'Déjà suivie — voir Suivis'
                      : watchAdding
                        ? 'Ajout en cours…'
                        : 'Ajouter aux suivis'}
                  </IonButton>
                )}
                {categoryKey === 'films' && detail?.source === 'tr4ker' && (
                  <IonButton expand="block" fill="outline" disabled={!detail} onClick={() => detail && void openFormats(detail)}>
                    <IonIcon icon={downloadOutline} slot="start" />
                    Autres formats
                  </IonButton>
                )}
              </div>
            </IonToolbar>
          </IonFooter>
        </IonModal>

        {/* Autres formats du même film */}
        <IonModal isOpen={showFormats} onDidDismiss={() => setShowFormats(false)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>Autres formats{detail ? ` — ${detail.title}` : ''}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowFormats(false)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            {formatsLoading ? (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <IonSpinner />
                <p>
                  <IonText color="medium">Recherche des autres formats…</IonText>
                </p>
              </div>
            ) : formatsError ? (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <IonText color="danger">{formatsError}</IonText>
              </div>
            ) : formats.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <IonText color="medium">Aucun autre format trouvé.</IonText>
              </div>
            ) : (
              <IonList>
                {formats.map((f) => (
                  <IonItem key={f.slug}>
                    <IonLabel>
                      <h2 style={{ whiteSpace: 'normal', fontSize: 14 }}>{f.name}</h2>
                      <p>
                        {formatBytes(f.sizeBytes)} • {f.seeders} seeders
                        {f.addedAt ? ` • ${f.addedAt.toLocaleDateString()}` : ''}
                      </p>
                      <p>
                        {f.isFreeleech && <IonBadge color="tertiary">Freeleech</IonBadge>}{' '}
                        {addedSlugs.has(f.slug) && <IonBadge color="success">Ajouté</IonBadge>}
                      </p>
                    </IonLabel>
                    <IonButton
                      slot="end"
                      size="small"
                      disabled={addingSlug !== null}
                      onClick={() => void sendToDownload(f)}
                    >
                      <IonIcon icon={downloadOutline} slot="icon-only" />
                    </IonButton>
                  </IonItem>
                ))}
              </IonList>
            )}
          </IonContent>
        </IonModal>

        <SettingsModal
          isOpen={showSettings}
          onClose={() => {
            setShowSettings(false);
            // Cas clé API tout juste collée : recharge si la liste est vide.
            if (films.length === 0) void loadItems(categoryKey, period, query, 1, false);
          }}
        />
        <IonToast isOpen={toast !== ''} message={toast} duration={3500} onDidDismiss={() => setToast('')} />
        <SuggestModal isOpen={showSuggest} onClose={() => setShowSuggest(false)} />
      </IonContent>
    </IonPage>
  );
};

export default FilmsTab;
