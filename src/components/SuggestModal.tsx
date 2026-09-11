import React, { useEffect, useRef, useState } from 'react';
import {
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
  IonFooter,
  IonChip,
} from '@ionic/react';
import { refreshOutline, downloadOutline, filmOutline, eyeOffOutline, sparklesOutline, searchOutline } from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import { fetchLibrariesData, fetchWatchHistory, type PlexLibraryData } from '../services/plex';
import { settings, transmissionPath } from '../services/settings';
import { buildAllocineUrl } from '../services/torrentScripts';
import { fetchGeminiRecommendations, fetchFollowUpIdeas, type GeminiRecommendation } from '../services/gemini';
import { searchTorrents, downloadFilmTorrent, formatBytes, type DiscoveryFilm } from '../services/tr4kerDiscovery';
import { uploadTorrentData } from '../services/transmission';
import { fetchAllocineRatings, formatAllocineNote, type AllocineRatings } from '../services/allocine';
import { loadSeenSuggestions, seenKeyFor, seenKeys, type SeenSuggestion } from '../services/seenSuggestions';
import { buildOwnedIndex, isOwned } from '../services/aiSuggest';
import { loadSeenMerged, markSeenEverywhere } from '../services/seenSync';
import { requestBrowserOpen } from '../services/browserNavigation';
import RatingStars from './RatingStars';

type SuggestWant = 'all' | 'movies' | 'series';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modale Suggestions IA (Gemini) partagée entre les onglets Plex et Catalogue :
 * recommandations absentes de la librairie Plex, pistes de suivi, liens
 * Allociné / téléchargement TR4KER → Transmission, marquage « déjà vu ».
 */
const SuggestModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const history = useHistory();
  const [libraries, setLibraries] = useState<PlexLibraryData[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const [suggestions, setSuggestions] = useState<GeminiRecommendation[]>([]);
  const [suggestCount, setSuggestCount] = useState(10);
  const [suggestWant, setSuggestWant] = useState<SuggestWant>('all');
  const [semanticQuery, setSemanticQuery] = useState('');
  /** Pistes de recherche suivantes (Gemini) après une génération. */
  const [followIdeas, setFollowIdeas] = useState<string[]>([]);
  const [followLoading, setFollowLoading] = useState(false);
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

  useEffect(() => {
    if (isOpen) setSuggestError('');
  }, [isOpen]);

  async function generateSuggestions(intentOverride?: string) {
    // Provider IA : Gemini uniquement.
    if (!settings.geminiApiKey) {
      setSuggestError('Clé API manquante : ouvre Réglages > IA Gemini (clé gratuite sur aistudio.google.com/apikey).');
      return;
    }
    setSuggestLoading(true);
    setSuggestError('');
    setDlResults({});
    setDlError({});
    setDlMsg('');
    setFollowIdeas([]);
    try {
      // Collection COMPLÈTE + historique + « déjà vu » en parallèle
      // (un seul temps d'attente réseau au lieu de trois en chaîne).
      const tSuggest = Date.now();
      const sElapsed = () => `${((Date.now() - tSuggest) / 1000).toFixed(1)}s`;
      const timed = async <T,>(label: string, pr: Promise<T>): Promise<T> => {
        const s = Date.now();
        const v = await pr;
        try {
          console.info(`[plex][+${sElapsed()}] ${label} en ${((Date.now() - s) / 1000).toFixed(1)}s`);
        } catch {
          /* ignore */
        }
        return v;
      };
      const [full, seenLoaded, historyLoaded] = await Promise.all([
        timed(
          'bibliothèque Plex',
          fetchLibrariesData(
            settings.plexResolvedBaseURL,
            settings.plexToken,
            settings.plexSectionKeys,
            1000,
          ).catch(() => null),
        ),
        timed('déjà-vu', loadSeenMerged().catch(() => null)),
        timed(
          'historique Plex',
          fetchWatchHistory(
            settings.plexResolvedBaseURL,
            settings.plexToken,
            300,
          ).catch(() => []),
        ),
      ]);
      // Base la suggestion sur la collection COMPLÈTE rechargée.
      let source = libraries;
      if (full && full.length > 0) {
        source = full;
        setLibraries(full);
      }
      const entries = source.flatMap((lib) =>
        lib.items.map((i) => ({ title: i.title, year: i.year, type: i.type })),
      );
      if (entries.length === 0) throw new Error('Librairie Plex vide.');
      // Historique de visionnage (vus même supprimés) + titres marqués « déjà vu » :
      // best effort, exclus des suggestions (prompt IA + filtre local).
      // Les « déjà vu » fusionnent local + serveur SQLite si synchro configurée.
      const seen = seenLoaded ?? seenList;
      if (seenLoaded) setSeenList(seenLoaded);
      const history = historyLoaded ?? [];
      setSuggestHistoryCount(history.length);
      try {
        console.info(
          `[plex][+${sElapsed()}] base : ${entries.length} titres collection, ` +
            `${history.length} historique, ${seen.length} déjà-vu — appel IA…`,
        );
      } catch {
        /* ignore */
      }
      const seenEntries = seen.map((s) => ({ title: s.t, year: s.y, type: 'unknown' }));
      // Intention : piste tapée (chip) prioritaire sur le champ (setState asynchrone).
      const intent = (intentOverride ?? semanticQuery).trim();
      const opts = {
        count: suggestCount,
        want: suggestWant,
        intent: intent || undefined,
        history: [...history, ...seenEntries],
      };
      let recs;
      recs = await fetchGeminiRecommendations(settings.geminiApiKey, entries, {
        ...opts,
        model: settings.geminiModel,
      });
      // Filet local : exclut les « déjà vu » (exact + variantes) même si l'IA les renvoie.
      const seenIdx = buildOwnedIndex(seen.map((s) => ({ title: s.t, year: s.y })));
      const before = recs.length;
      const kept = recs.filter((r) => !isOwned({ title: r.title, year: r.year }, seenIdx).excluded);
      try {
        console.info(`[plex][+${sElapsed()}] filet déjà-vu : ${before} → ${kept.length} (${before - kept.length} exclues), total ${sElapsed()}`);
      } catch {
        /* ignore */
      }
      setSuggestions(kept);
      // Pistes suivantes : chargées en arrière-plan (silencieux si échec).
      if (kept.length > 0) void loadFollowIdeas(kept, intent);
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

  /** Pistes de recherche suivantes (Gemini) à partir des recos affichées. */
  async function loadFollowIdeas(recs: GeminiRecommendation[], intent: string) {
    if (recs.length === 0) return;
    setFollowLoading(true);
    try {
      setFollowIdeas(await fetchFollowUpIdeas(settings.geminiApiKey, recs, intent, settings.geminiModel));
    } catch {
      setFollowIdeas([]);
    } finally {
      setFollowLoading(false);
    }
  }

  /** Tap sur une piste : l'intention est posée puis la génération relancée. */
  function runFollowIdea(idea: string) {
    const v = idea.trim();
    if (!v || suggestLoading) return;
    setSemanticQuery(v);
    void generateSuggestions(v);
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

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onClose} className="detail-modal">
      <IonHeader>
        <IonToolbar>
          <IonTitle>Suggestions IA</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>Fermer</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="detail-sheet">
          <IonText color="medium">
            <p style={{ marginTop: 0 }}>
              {'Gemini analyse les titres de ta librairie Plex'} ({libraries.reduce((n, l) => n + l.items.length, 0)} rechargés à la génération{suggestHistoryCount > 0 ? ` + ${suggestHistoryCount} vus (historique, même supprimés)` : ''}{seenList.length > 0 ? ` + ${seenList.length} marqués vus` : ''}) pour proposer des films/séries ni en collection ni déjà vus.
            </p>
          </IonText>
          <IonSegment
            value={suggestWant}
            onIonChange={(e) => setSuggestWant(String(e.detail.value) as SuggestWant)}
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
          <IonSegment
            value={String(suggestCount)}
            onIonChange={(e) => setSuggestCount(parseInt(String(e.detail.value), 10) || 10)}
            style={{ marginTop: 8 }}
          >
            {[5, 10, 15, 20].map((n) => (
              <IonSegmentButton key={n} value={String(n)}>
                <IonLabel>{n}</IonLabel>
              </IonSegmentButton>
            ))}
          </IonSegment>

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
          {!settings.geminiApiKey && !suggestLoading && (
            <p>
              <IonText color="warning">
                {'Ajoute ta clé API Gemini dans Réglages > IA Gemini (gratuite sur aistudio.google.com/apikey).'}
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
                        onClose();
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
        {suggestions.length > 0 && (followIdeas.length > 0 || followLoading) && (
          <div style={{ padding: '4px 16px 4px' }}>
            <IonText color="medium">
              <p style={{ marginBottom: 4 }}>Explorer aussi :</p>
            </IonText>
            {followLoading && followIdeas.length === 0 ? (
              <p>
                <IonSpinner style={{ width: 16, height: 16 }} />
                <IonText color="medium"> Pistes en cours…</IonText>
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {followIdeas.map((idea) => (
                  <IonChip key={idea} outline onClick={() => runFollowIdea(idea)}>
                    <IonIcon icon={sparklesOutline} color="tertiary" />
                    <IonLabel>{idea}</IonLabel>
                  </IonChip>
                ))}
              </div>
            )}
          </div>
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
  );
};

export default SuggestModal;
