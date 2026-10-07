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
import { settingsOutline, refreshOutline, downloadOutline, filmOutline, starOutline, sparklesOutline } from 'ionicons/icons';
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
import { activeSourceKeys, downloadFromSource, fetchLatestC411, searchAllSources } from '../services/c411';
import { settings } from '../services/settings';
import { transmissionPath } from '../services/settings';
import { uploadTorrentData } from '../services/transmission';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { fetchTmdbPoster } from '../services/tmdb';
import { buildAllocineUrl } from '../services/torrentScripts';
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
  const [showSettings, setShowSettings] = useState(false);
  /** Modale Suggestions IA (composant partagé Plex + Catalogue). */
  const [showSuggest, setShowSuggest] = useState(false);
  const [toast, setToast] = useState('');
  const [detail, setDetail] = useState<DiscoveryFilm | null>(null);
  /** Descriptif TR4KER (repli si Allociné sans synopsis). undefined = en cours. */
  const [detailDesc, setDetailDesc] = useState<string | null | undefined>(undefined);
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

  const hasKey = settings.tr4kerApiKey !== '' || settings.c411ApiKey !== '';
  /** Libellé des sources actives pour la recherche ("TR4KER", "C411" ou "TR4KER + C411"). */
  const searchSourcesLabel = (() => {
    const keys = activeSourceKeys();
    return [keys.tr4kerApiKey !== '' ? 'TR4KER' : '', keys.c411ApiKey !== '' ? 'C411' : ''].filter(Boolean).join(' + ');
  })();

  const loadItems = useCallback(async (cat: DiscoveryCategoryKey, p: FilmsPeriod, q: string, pageNum: number, append: boolean) => {
    const keys = activeSourceKeys();
    if (!keys.tr4kerApiKey && !keys.c411ApiKey) {
      setError('Colle ta clé API TR4KER ou C411 dans Réglages pour voir les films.');
      return;
    }
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const def = discoveryCategory(cat);
      // Recherche par titre : TR4KER + C411 fusionnés (tri seeders).
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
      // sorties C411 (rechargées à chaque filtre, pas à « Charger plus »).
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
      const merged = filterByDiscoveryCategory([...tr4kerFilms, ...c411Films], cat);
      merged.sort((a, b) => b.seeders - a.seeders);
      if (merged.length === 0 && partial.length > 0) throw new Error(partial.join(' / '));
      setFilms((prev) => (append ? [...prev, ...merged.filter((f) => !prev.some((x) => x.slug === f.slug))] : merged));
      setTotal(tr4kerTotal + c411Count);
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

  /** Ouvre la fiche + charge le descriptif (TR4KER uniquement ; C411 n'en expose pas). */
  function openDetail(film: DiscoveryFilm) {
    setDetail(film);
    setDetailDesc(undefined);
    if (film.source !== 'tr4ker') {
      setDetailDesc(null);
      return;
    }
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setDetailDesc(null);
      return;
    }
    void fetchTorrentDetail(film.slug, apiKey)
      .then((d) => setDetailDesc(d.description ?? null))
      .catch(() => setDetailDesc(null));
  }

  /** Ouvre la liste des autres formats du film affiché (TR4KER uniquement). */
  async function openFormats(film: DiscoveryFilm) {
    setShowFormats(true);
    setFormats([]);
    setFormatsError('');
    if (film.source !== 'tr4ker') {
      setFormatsError('Autres formats : TR4KER uniquement (résultat C411).');
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
    if (!keys.tr4kerApiKey && !keys.c411ApiKey) {
      setToast('Clé API TR4KER ou C411 manquante (Réglages).');
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
    setDetail(null);
    history.push('/browser');
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
            debounce={700}
            onIonInput={(e) => {
              const v = String(e.detail.value ?? '');
              setQueryInput(v);
              setQuery(v.trim());
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
                {query ? `Recherche "${query}" (${searchSourcesLabel})` : `Nouveautés (${searchSourcesLabel})`} {category.label.toLowerCase()} triés par popularité (seeders)
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
                    {film.source === 'c411' && <IonBadge color="secondary">C411</IonBadge>}{' '}
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
        <IonModal isOpen={detail !== null} onDidDismiss={() => setDetail(null)} className="detail-modal">
          <IonHeader>
            <IonToolbar>
              <IonTitle>Fiche</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setDetail(null)}>Fermer</IonButton>
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
                      {detail.source === 'c411' && <IonBadge color="secondary">C411</IonBadge>}{' '}
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
                        {ratingsMap[detail.slug]?.synopsis ??
                          (ratingsMap[detail.slug] ? 'Aucun synopsis Allociné.' : 'Recherche du synopsis…')}
                      </p>
                    </IonText>
                  </>
                )}
                {category.allocine &&
                  (() => {
                    const r = ratingsMap[detail.slug];
                    if (!r) {
                      return (
                        <p className="ratings-row">
                          <IonIcon icon={starOutline} />
                          <IonText color="medium">Recherche de la note Allociné…</IonText>
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
