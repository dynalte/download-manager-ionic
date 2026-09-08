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
  RefresherEventDetail,
} from '@ionic/react';
import { settingsOutline, refreshOutline, downloadOutline, filmOutline, starOutline } from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import {
  fetchFilms,
  downloadFilmTorrent,
  fetchTorrentDetail,
  fetchSameMovieTorrents,
  loadAddedSlugs,
  markSlugAdded,
  formatBytes,
  FILMS_PERIODS,
  type DiscoveryFilm,
  type FilmsPeriod,
} from '../services/tr4kerDiscovery';
import { settings } from '../services/settings';
import { transmissionPath } from '../services/settings';
import { uploadTorrentData } from '../services/transmission';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { buildAllocineUrl } from '../services/torrentScripts';
import { requestBrowserOpen } from '../services/browserNavigation';
import SettingsModal from '../components/SettingsModal';
import RatingStars from '../components/RatingStars';

const PAGE_SIZE = 25;

const FilmsTab: React.FC = () => {
  const history = useHistory();
  const [films, setFilms] = useState<DiscoveryFilm[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<FilmsPeriod>('week');
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
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

  const hasKey = settings.tr4kerApiKey !== '';

  const loadFilms = useCallback(async (p: FilmsPeriod, q: string, pageNum: number, append: boolean) => {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setError('Colle ta clé API TR4KER dans Réglages pour voir les films.');
      return;
    }
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await fetchFilms(apiKey, { period: p, query: q, limit: PAGE_SIZE, page: pageNum, sort: 'seeders' });
      setFilms((prev) => (append ? [...prev, ...res.films.filter((f) => !prev.some((x) => x.slug === f.slug))] : res.films));
      setTotal(res.total);
      setPage(pageNum);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // Recharge à chaque changement de période / recherche validée.
  useEffect(() => {
    void loadFilms(period, query, 1, false);
  }, [period, query, loadFilms]);

  // Notes Allociné en arrière-plan (même pattern que l'onglet Plex).
  useEffect(() => {
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
        void fetchAllocineRatings(film.title, film.year)
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
  }, [films]);

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    await loadFilms(period, query, 1, false);
    event.detail.complete();
  }

  /** Ouvre la fiche + charge le descriptif TR4KER (toujours affiché). */
  function openDetail(film: DiscoveryFilm) {
    setDetail(film);
    setDetailDesc(undefined);
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setDetailDesc(null);
      return;
    }
    void fetchTorrentDetail(film.slug, apiKey)
      .then((d) => setDetailDesc(d.description ?? null))
      .catch(() => setDetailDesc(null));
  }

  /** Ouvre la liste des autres formats du film affiché. */
  async function openFormats(film: DiscoveryFilm) {
    setShowFormats(true);
    setFormats([]);
    setFormatsError('');
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

  /** Envoie le .torrent vers Transmission (dossier films). */
  async function sendToDownload(film: DiscoveryFilm) {
    if (addingSlug) return;
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setToast('Clé API TR4KER manquante (Réglages).');
      return;
    }
    setAddingSlug(film.slug);
    try {
      const bytes = await downloadFilmTorrent(film.slug, apiKey);
      const res = await uploadTorrentData(bytes, transmissionPath('films'));
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
          <IonTitle>Films</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => setShowSettings(true)}>
              <IonIcon icon={settingsOutline} />
            </IonButton>
            <IonButton onClick={() => void loadFilms(period, query, 1, false)} disabled={loading || !hasKey}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonSearchbar
            value={queryInput}
            placeholder="Rechercher un film..."
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
            value={period}
            onIonChange={(e) => setPeriod(String(e.detail.value) as FilmsPeriod)}
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
                {query ? `Recherche "${query}"` : 'Nouveautés'} triés par popularité (seeders)
                {total > 0 ? ` • ${films.length}/${total}` : ''}
              </small>
            </IonText>
          </p>
        </div>

        {loading && films.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
            <p>
              <IonText color="medium">Chargement des films...</IonText>
            </p>
          </div>
        ) : films.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonText color={error ? 'danger' : 'medium'}>{error || 'Aucun film trouvé'}</IonText>
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
                  <FilmRating film={film} />
                  <p>
                    {film.isFreeleech && <IonBadge color="tertiary">Freeleech</IonBadge>}{' '}
                    {addedSlugs.has(film.slug) && <IonBadge color="success">Ajouté</IonBadge>}
                  </p>
                </IonLabel>
              </IonItem>
            ))}
          </IonList>
        )}

        {films.length > 0 && films.length < total && (
          <div style={{ textAlign: 'center', padding: 12 }}>
            <IonButton fill="outline" size="small" disabled={loadingMore} onClick={() => void loadFilms(period, query, page + 1, true)}>
              {loadingMore ? <IonSpinner style={{ width: 16, height: 16 }} /> : 'Charger plus'}
            </IonButton>
          </div>
        )}

        {/* Fiche film */}
        <IonModal isOpen={detail !== null} onDidDismiss={() => setDetail(null)} className="detail-modal">
          <IonHeader>
            <IonToolbar>
              <IonTitle>Fiche film</IonTitle>
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
                <h3>Synopsis</h3>
                <IonText color="medium">
                  <p className="detail-summary">
                    {ratingsMap[detail.slug]?.synopsis ??
                      (ratingsMap[detail.slug] ? 'Aucun synopsis Allociné.' : 'Recherche du synopsis…')}
                  </p>
                </IonText>
                {(() => {
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
                <h3>Descriptif TR4KER</h3>
                <IonText color="medium">
                  <p className="detail-summary">
                    {detailDesc ?? (detailDesc === undefined ? 'Chargement…' : 'Aucun descriptif.')}
                  </p>
                </IonText>
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
                <IonButton expand="block" fill="outline" disabled={!detail} onClick={() => detail && openAllocine(detail)}>
                  <IonIcon icon={filmOutline} slot="start" />
                  Voir sur Allociné
                </IonButton>
                <IonButton expand="block" fill="outline" disabled={!detail} onClick={() => detail && void openFormats(detail)}>
                  <IonIcon icon={downloadOutline} slot="start" />
                  Autres formats
                </IonButton>
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
            if (films.length === 0) void loadFilms(period, query, 1, false);
          }}
        />
        <IonToast isOpen={toast !== ''} message={toast} duration={3500} onDidDismiss={() => setToast('')} />
      </IonContent>
    </IonPage>
  );
};

export default FilmsTab;
