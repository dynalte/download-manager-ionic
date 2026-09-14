import React, { useEffect, useState } from 'react';
import {
  IonAlert,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { chevronDownOutline, chevronForwardOutline, cloudDownloadOutline, filmOutline } from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import RatingStars from './RatingStars';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { requestBrowserOpen } from '../services/browserNavigation';
import { loadShowDetail, type ShowDetail, type ShowDetailSeason } from '../services/seriesCalendar';
import { settings } from '../services/settings';
import {
  hasRetrievedEpisode,
  requestEpisode,
  requestSeason,
  type SeriesSubscription,
} from '../services/seriesWatch';
import { buildAllocineUrl } from '../services/torrentScripts';

function fmtShowStatus(status: string): string {
  switch (status) {
    case 'Running':
      return 'en cours';
    case 'Ended':
      return 'terminée';
    case 'To Be Determined':
      return 'à venir';
    case 'In Development':
      return 'en développement';
    default:
      return status ? status.toLowerCase() : '';
  }
}

function fmtEpisode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function fmtAirDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR');
}

function seasonLabel(season: number): string {
  return season === 0 ? 'Spéciaux' : `Saison ${season}`;
}

interface Props {
  sub: SeriesSubscription | null;
  isOpen: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
  onChanged: () => void;
}

const ShowDetailModal: React.FC<Props> = ({ sub, isOpen, onClose, onToast, onChanged }) => {
  const history = useHistory();
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openSeason, setOpenSeason] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingSeason, setPendingSeason] = useState<ShowDetailSeason | null>(null);
  const [ratings, setRatings] = useState<AllocineRatings | null>(null);
  const [ratingsLoading, setRatingsLoading] = useState(false);

  const hasKey = settings.tr4kerApiKey !== '';

  useEffect(() => {
    if (!isOpen || !sub) {
      setDetail(null);
      setError('');
      setRatings(null);
      setBusyKey(null);
      setPendingSeason(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setDetail(null);
    void loadShowDetail(sub)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        const prefer = sub.lastSeason > 0 ? sub.lastSeason : d.seasons[d.seasons.length - 1]?.season;
        setOpenSeason(prefer ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    setRatingsLoading(true);
    void fetchAllocineRatings(sub.title, sub.year)
      .then((r) => {
        if (!cancelled) setRatings(r);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRatingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sub?.id]);

  async function retrieveEpisode(season: number, episode: number) {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey || !sub || busyKey) return;
    const key = `s${season}e${episode}`;
    setBusyKey(key);
    try {
      const msg = await requestEpisode(sub.id, season, episode, apiKey);
      onToast(msg);
      onChanged();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function retrieveSeason(season: ShowDetailSeason) {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey || !sub || busyKey) return;
    setBusyKey(`s${season.season}`);
    try {
      const aired = season.episodes.filter((ep) => ep.aired).map((ep) => ep.episode);
      const msg = await requestSeason(sub.id, season.season, aired, apiKey);
      onToast(msg);
      onChanged();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  const meta = sub
    ? [detail?.year || sub.year, detail?.network, detail?.status ? fmtShowStatus(detail.status) : '']
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onClose} className="detail-modal">
      <IonHeader>
        <IonToolbar>
          <IonTitle>{sub?.title ?? 'Série'}</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>Fermer</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        {!sub ? null : loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
            <p>
              <IonText color="medium">Chargement de la fiche…</IonText>
            </p>
          </div>
        ) : error ? (
          <div className="detail-sheet">
            <IonText color="danger">{error}</IonText>
          </div>
        ) : (
          <div className="detail-sheet">
            <div className="detail-top">
              {detail?.image ? (
                <img src={detail.image} alt={detail.name} className="poster-large detail-poster" />
              ) : null}
              <div className="detail-head">
                <h2 className="detail-title">{detail?.name || sub.title}</h2>
                {!!meta && (
                  <p>
                    <IonText color="medium">{meta}</IonText>
                  </p>
                )}
                <p>
                  <IonText color="medium">
                    {sub.lastSeason > 0
                      ? `Suivi depuis ${fmtEpisode(sub.lastSeason, sub.lastEpisode)}`
                      : 'Aucun épisode encore suivi'}
                  </IonText>
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
              </div>
            </div>
            <h3>Synopsis</h3>
            <IonText color="medium">
              <p className="detail-summary">{detail?.summary || 'Aucun résumé disponible.'}</p>
            </IonText>
            {!hasKey && (
              <p>
                <IonText color="warning">
                  <small>Colle ta clé API TR4KER dans Réglages pour récupérer des épisodes.</small>
                </IonText>
              </p>
            )}
            <h3>Saisons</h3>
            {!detail || detail.seasons.length === 0 ? (
              <IonText color="medium">Aucune saison listée sur TVMaze.</IonText>
            ) : (
              detail.seasons.map((season) => {
                const aired = season.episodes.filter((ep) => ep.aired);
                const pending = aired.filter((ep) => !hasRetrievedEpisode(sub, season.season, ep.episode));
                const expanded = openSeason === season.season;
                const seasonBusy = busyKey === `s${season.season}`;
                return (
                  <div key={season.season}>
                    <div className="season-head">
                      <IonButton
                        fill="clear"
                        color="dark"
                        onClick={() => setOpenSeason(expanded ? null : season.season)}
                      >
                        <IonIcon icon={expanded ? chevronDownOutline : chevronForwardOutline} slot="start" />
                        {seasonLabel(season.season)} ({season.episodes.length})
                      </IonButton>
                      <IonButton
                        size="small"
                        fill="outline"
                        disabled={!hasKey || !!busyKey || pending.length === 0}
                        onClick={() => setPendingSeason(season)}
                      >
                        {seasonBusy ? (
                          <IonSpinner style={{ width: 16, height: 16 }} />
                        ) : (
                          <>
                            <IonIcon icon={cloudDownloadOutline} slot="start" />
                            {pending.length === 0 ? 'Saison envoyée' : 'Récupérer'}
                          </>
                        )}
                      </IonButton>
                    </div>
                    {expanded && (
                      <IonList>
                        {season.episodes.map((ep) => {
                          const sent = hasRetrievedEpisode(sub, ep.season, ep.episode);
                          const epKey = `s${ep.season}e${ep.episode}`;
                          return (
                            <IonItem key={`${ep.season}-${ep.episode}`}>
                              <IonLabel>
                                <p>{fmtEpisode(ep.season, ep.episode)}</p>
                                <h2 style={{ whiteSpace: 'normal' }}>{ep.name || 'Sans titre'}</h2>
                                {!!ep.airDate && (
                                  <p>
                                    {fmtAirDate(ep.airDate)}
                                    {!ep.aired ? ' · à venir' : ''}
                                  </p>
                                )}
                              </IonLabel>
                              {sent ? (
                                <IonBadge color="success" slot="end">
                                  envoyé
                                </IonBadge>
                              ) : !ep.aired ? (
                                <IonBadge color="medium" slot="end">
                                  à venir
                                </IonBadge>
                              ) : (
                                <IonButton
                                  slot="end"
                                  size="small"
                                  fill="outline"
                                  disabled={!hasKey || !!busyKey}
                                  onClick={() => void retrieveEpisode(ep.season, ep.episode)}
                                >
                                  {busyKey === epKey ? (
                                    <IonSpinner style={{ width: 16, height: 16 }} />
                                  ) : (
                                    'Récupérer'
                                  )}
                                </IonButton>
                              )}
                            </IonItem>
                          );
                        })}
                      </IonList>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </IonContent>
      <IonFooter>
        <IonToolbar>
          <div className="detail-actions">
            <IonButton
              expand="block"
              fill="outline"
              disabled={!sub}
              onClick={() => {
                if (!sub) return;
                requestBrowserOpen(ratings?.url || buildAllocineUrl(sub.title));
                onClose();
                history.push('/browser');
              }}
            >
              <IonIcon icon={filmOutline} slot="start" />
              Voir sur Allociné
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>
      <IonAlert
        isOpen={pendingSeason !== null}
        onDidDismiss={() => setPendingSeason(null)}
        header={pendingSeason ? seasonLabel(pendingSeason.season) : ''}
        message={
          pendingSeason
            ? `Envoi vers Transmission : pack saison si trouvé, sinon chaque épisode déjà diffusé (${
                pendingSeason.episodes.filter((ep) => ep.aired && !hasRetrievedEpisode(sub!, pendingSeason.season, ep.episode))
                  .length
              } restant(s)).`
            : ''
        }
        buttons={[
          { text: 'Annuler', role: 'cancel' },
          {
            text: 'Récupérer',
            handler: () => {
              if (pendingSeason) void retrieveSeason(pendingSeason);
            },
          },
        ]}
      />
    </IonModal>
  );
};

export default ShowDetailModal;
