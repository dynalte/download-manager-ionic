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
  IonList,
  IonItem,
  IonLabel,
  IonText,
  IonToggle,
  IonSpinner,
  IonRefresher,
  IonRefresherContent,
  IonToast,
  IonModal,
  IonBadge,
  IonSegment,
  IonSegmentButton,
  IonSearchbar,
  RefresherEventDetail,
} from '@ionic/react';
import {
  addOutline,
  informationCircleOutline,
  refreshOutline,
  trashOutline,
  playOutline,
  searchOutline,
  settingsOutline,
} from 'ionicons/icons';
import {
  checkAllSubscriptions,
  checkSubscription,
  forceDownloadCandidate,
  forgetDeletedSubscription,
  inspectSubscription,
  isGlobalCheckDue,
  loadSubscriptions,
  noteDeletedSubscription,
  removeSubscription,
  subscriptionIdFor,
  upsertSubscription,
  type InspectCandidate,
  type SeriesSubscription,
} from '../services/seriesWatch';
import { settings } from '../services/settings';
import { isServerConfigured } from '../services/serverApi';
import { appLog } from '../services/debugLog';
import {
  loadSubscriptionsMerged,
  pushAllSubscriptions,
  pushSubscription,
  removeSubscriptionOnServer,
} from '../services/seriesSync';
import SettingsModal from '../components/SettingsModal';
import ShowDetailModal from '../components/ShowDetailModal';
import { buildAllocineQuery } from '../services/torrentScripts';
import {
  addDays,
  fetchPreviousEpisode,
  formatDayHeading,
  groupByDate,
  isEpisodeCaughtUp,
  isoDate,
  loadCalendarEpisodes,
  primeShowCache,
  searchShows,
  type CalendarLoadResult,
  type ShowSearchHit,
} from '../services/seriesCalendar';

function fmtSE(sub: SeriesSubscription): string {
  if (sub.lastSeason <= 0) return 'aucun épisode repéré';
  return `S${String(sub.lastSeason).padStart(2, '0')}E${String(sub.lastEpisode).padStart(2, '0')}`;
}

function fmtEpisode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

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
      return status.toLowerCase();
  }
}

type WatchView = 'list' | 'calendar';

function CalendarPanel({
  subs,
  result,
  loading,
  onPickSeries,
}: {
  subs: SeriesSubscription[];
  result: CalendarLoadResult | null;
  loading: boolean;
  onPickSeries: (subId: string) => void;
}) {
  const byId = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);
  const groups = useMemo(() => {
    const today = isoDate(new Date());
    const end = isoDate(addDays(new Date(), 14));
    const eps = (result?.episodes ?? []).filter((e) => e.airDate >= today && e.airDate <= end);
    return groupByDate(eps);
  }, [result]);

  return (
    <>
      {loading && !result ? (
        <div className="cal-empty">
          <IonSpinner />
          <p>
            <IonText color="medium">Chargement des dates de diffusion…</IonText>
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="cal-empty">
          <IonText color="medium">Aucune sortie dans les 14 prochains jours.</IonText>
        </div>
      ) : (
        groups.map((g) => (
          <React.Fragment key={g.date}>
            <div className="cal-heading">{formatDayHeading(g.date)}</div>
            <IonList>
              {g.items.map((ep) => {
                const sub = byId.get(ep.subId);
                const caught = sub ? isEpisodeCaughtUp(sub, ep) : false;
                return (
                  <IonItem key={`${ep.subId}-${ep.season}-${ep.episode}`} button onClick={() => onPickSeries(ep.subId)}>
                    <IonLabel>
                      <h2 style={{ whiteSpace: 'normal' }}>{ep.title}</h2>
                      <p>
                        {fmtEpisode(ep.season, ep.episode)}
                        {ep.episodeName ? ` · ${ep.episodeName}` : ''}
                        {ep.network ? ` · ${ep.network}` : ''}
                      </p>
                    </IonLabel>
                    {caught ? (
                      <IonBadge color="success" slot="end">
                        repéré
                      </IonBadge>
                    ) : (
                      <IonBadge color="primary" slot="end">
                        nouveau
                      </IonBadge>
                    )}
                  </IonItem>
                );
              })}
            </IonList>
          </React.Fragment>
        ))
      )}
      {!!result?.unresolved.length && (
        <div style={{ padding: '8px 16px 16px' }}>
          <IonText color="medium">
            <small>Introuvable sur TVMaze : {result.unresolved.join(', ')}</small>
          </IonText>
        </div>
      )}
    </>
  );
}

const SeriesWatchTab: React.FC = () => {
  const [subs, setSubs] = useState<SeriesSubscription[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  /** Inspection à blanc d'un suivi (diagnostic, aucun téléchargement). */
  const [inspecting, setInspecting] = useState<SeriesSubscription | null>(null);
  const [inspectRes, setInspectRes] = useState<{ query: string; base: string; candidates: InspectCandidate[] } | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [forcingSlug, setForcingSlug] = useState<string | null>(null);
  const [view, setView] = useState<WatchView>('list');
  const [calResult, setCalResult] = useState<CalendarLoadResult | null>(null);
  const [calLoading, setCalLoading] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addHits, setAddHits] = useState<ShowSearchHit[]>([]);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [detailSub, setDetailSub] = useState<SeriesSubscription | null>(null);
  const [addingId, setAddingId] = useState<number | null>(null);

  const refresh = useCallback(() => {
    // Recharge + fusionne avec le serveur (repousse la fusion) ; repli local si hors ligne.
    void loadSubscriptionsMerged().then(setSubs);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadCalendar = useCallback(
    async (force = false) => {
      if (subs.length === 0) {
        setCalResult({ episodes: [], unresolved: [] });
        return;
      }
      setCalLoading(true);
      try {
        const res = await loadCalendarEpisodes(subs, force);
        setCalResult(res);
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      } finally {
        setCalLoading(false);
      }
    },
    [subs],
  );

  useEffect(() => {
    if (view !== 'calendar') return;
    void loadCalendar(false);
  }, [view, loadCalendar]);

  useEffect(() => {
    if (view !== 'list' || !focusedId) return;
    const el = document.getElementById(`sub-${focusedId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [view, focusedId]);

  useEffect(() => {
    if (!detailSub) return;
    const live = subs.find((s) => s.id === detailSub.id);
    setDetailSub(live ?? null);
  }, [subs, detailSub?.id]);

  async function runCheckAll(silent = false) {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      if (!silent) setToast('Colle ta clé API TR4KER dans Réglages pour activer le suivi');
      return;
    }
    if (checking) return;
    setChecking(true);
    try {
      const results = await checkAllSubscriptions(apiKey);
      const added = results.reduce((n, r) => n + r.added.length, 0);
      const errors = results.filter((r) => r.error);
      if (!silent || added > 0 || errors.length > 0) {
        setToast(
          added > 0
            ? `${added} nouvel(s) épisode(s) vers Transmission`
            : errors.length > 0
              ? `Vérification : ${errors[0].error}`
              : 'Rien de nouveau',
        );
      }
    } finally {
      setChecking(false);
      refresh();
      void pushAllSubscriptions();
    }
  }

  async function runCheckOne(sub: SeriesSubscription) {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setToast('Colle ta clé API TR4KER dans Réglages pour activer le suivi');
      return;
    }
    if (checking) return;
    setCheckingId(sub.id);
    try {
      const live = loadSubscriptions().find((s) => s.id === sub.id) ?? sub;
      const r = await checkSubscription({ ...live, addedKeys: [...live.addedKeys] }, apiKey);
      setToast(r.added.length > 0 ? `${r.added.length} nouvel(s) épisode(s) vers Transmission` : 'Rien de nouveau');
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingId(null);
      refresh();
    }
  }

  async function forceOne(c: InspectCandidate) {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey || !inspecting || c.season === null || c.episode === null) return;
    setForcingSlug(c.slug);
    try {
      const msg = await forceDownloadCandidate(
        inspecting.id,
        { slug: c.slug, name: c.name, season: c.season, episode: c.episode },
        apiKey,
      );
      setToast(msg);
      const updated = loadSubscriptions().find((s) => s.id === inspecting.id);
      if (updated) void pushSubscription(updated);
      refresh();
      await openInspect(inspecting);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setForcingSlug(null);
    }
  }

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    if (view === 'calendar') await loadCalendar(true);
    else await runCheckAll();
    event.detail.complete();
  }

  function pickSeriesFromCalendar(subId: string) {
    const sub = subs.find((s) => s.id === subId);
    if (sub) setDetailSub(sub);
  }

  function openAddModal() {
    setShowAdd(true);
    setAddError('');
  }

  function closeAddModal() {
    setShowAdd(false);
    setAddQuery('');
    setAddHits([]);
    setAddError('');
    setAddingId(null);
  }

  useEffect(() => {
    if (!showAdd) return;
    const q = addQuery.trim();
    if (q.length < 2) {
      setAddHits([]);
      setAddError('');
      setAddLoading(false);
      return;
    }
    let cancelled = false;
    setAddLoading(true);
    const t = window.setTimeout(() => {
      void searchShows(q)
        .then((hits) => {
          if (cancelled) return;
          setAddHits(hits);
          setAddError('');
        })
        .catch((e) => {
          if (cancelled) return;
          setAddHits([]);
          setAddError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setAddLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [addQuery, showAdd]);

  async function addShow(hit: ShowSearchHit) {
    if (addingId !== null) return;
    const id = subscriptionIdFor(hit.name, hit.year);
    if (loadSubscriptions().some((s) => s.id === id)) {
      setToast(`${hit.name} est déjà suivie`);
      return;
    }
    setAddingId(hit.id);
    try {
      const prev = await fetchPreviousEpisode(hit.id);
      const maxS = prev?.season ?? 0;
      const maxE = prev?.episode ?? 0;
      const query = buildAllocineQuery(hit.name) || hit.name;
      const base = maxS > 0 ? fmtEpisode(maxS, maxE) : 'aucun épisode';
      const sub: SeriesSubscription = {
        id,
        title: hit.name,
        query,
        year: hit.year,
        enabled: true,
        lastSeason: maxS,
        lastEpisode: maxE,
        addedKeys: [],
        createdAt: Date.now(),
        lastCheckAt: 0,
        lastResult: `Base TVMaze : ${base}`,
        updatedAt: Date.now(),
      };
      forgetDeletedSubscription(sub.id);
      upsertSubscription(sub);
      void pushSubscription(sub);
      primeShowCache(sub.id, hit);
      setToast(`Suivi activé : ${hit.name} (base ${base})`);
      refresh();
      setView('list');
      setFocusedId(sub.id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingId(null);
    }
  }

  async function openInspect(sub: SeriesSubscription) {
    const apiKey = settings.tr4kerApiKey;
    if (!apiKey) {
      setToast('Colle ta clé API TR4KER dans Réglages pour activer le suivi');
      return;
    }
    setInspecting(sub);
    setInspectRes(null);
    setInspectError('');
    setInspectLoading(true);
    try {
      const live = loadSubscriptions().find((s) => s.id === sub.id) ?? sub;
      const res = await inspectSubscription({ ...live, addedKeys: [...live.addedKeys] }, apiKey);
      setInspectRes(res);
      // Miroir console Xcode (via pont natif) : pratique en debug device.
      appLog('info', 'inspect', `${sub.title} | query="${res.query}" base=${res.base} | ${res.candidates.length} candidat(s)`);
      for (const c of res.candidates) {
        const se = c.season !== null ? `S${String(c.season).padStart(2, '0')}E${String(c.episode ?? 0).padStart(2, '0')}` : 'sans S/E';
        appLog(
          c.verdict === 'ajouté' ? 'info' : 'debug',
          'inspect',
          `${c.verdict === 'ajouté' ? 'AJOUTE' : 'ignore'} ${se}${c.isPack ? ' pack' : ''} "${c.name.slice(0, 120)}" — ${c.reason}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appLog('error', 'inspect', `${sub.title} : ${msg}`);
      setInspectError(msg);
    } finally {
      setInspectLoading(false);
    }
  }

  const hasKey = settings.tr4kerApiKey !== '';

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Suivis</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={openAddModal} title="Ajouter une série">
              <IonIcon icon={addOutline} />
            </IonButton>
            <IonButton onClick={() => setShowSettings(true)}>
              <IonIcon icon={settingsOutline} />
            </IonButton>
            <IonButton onClick={() => void runCheckAll()} disabled={checking || !hasKey}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonSegment value={view} onIonChange={(e) => setView((e.detail.value as WatchView) || 'list')}>
          <IonSegmentButton value="list">
            <IonLabel>Liste</IonLabel>
          </IonSegmentButton>
          <IonSegmentButton value="calendar">
            <IonLabel>À venir</IonLabel>
          </IonSegmentButton>
        </IonSegment>
      </IonHeader>
      <IonContent fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        {!hasKey && (
          <div style={{ padding: '12px 16px' }}>
            <IonText color="medium">
              <small>
                Colle ta clé API TR4KER (réglages du compte TR4KER) dans Réglages pour activer la détection auto.
              </small>
            </IonText>
          </div>
        )}
        {!isServerConfigured() && subs.length > 0 && view === 'list' && (
          <div style={{ padding: '0 16px 8px' }}>
            <IonText color="warning">
              <small>
                Synchro serveur inactive sur cet appareil : renseigne URL + token (Réglages &gt; Synchro vus) pour retrouver ces suivis sur iPhone/bureau.
              </small>
            </IonText>
          </div>
        )}

        {view === 'calendar' ? (
          <CalendarPanel
            subs={subs}
            result={calResult}
            loading={calLoading}
            onPickSeries={pickSeriesFromCalendar}
          />
        ) : checking && subs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
          </div>
        ) : subs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonText color="medium">
              <p>Aucune série suivie.</p>
            </IonText>
            <IonButton onClick={openAddModal}>
              <IonIcon icon={addOutline} slot="start" />
              Ajouter une série
            </IonButton>
            <p>
              <IonText color="medium">
                <small>Tu peux aussi t’abonner depuis la fiche d’une série dans Plex.</small>
              </IonText>
            </p>
          </div>
        ) : (
          <IonList>
            {subs.map((sub) => (
              <IonItem key={sub.id} id={`sub-${sub.id}`} className={focusedId === sub.id ? 'sub-focused' : undefined}>
                <IonToggle
                  slot="start"
                  checked={sub.enabled}
                  onIonChange={(e) => {
                    const next = loadSubscriptions().map((s) =>
                      s.id === sub.id ? { ...s, enabled: e.detail.checked } : s,
                    );
                    const updated = next.find((s) => s.id === sub.id);
                    if (updated) {
                      upsertSubscription(updated);
                      void pushSubscription(updated);
                      refresh();
                    }
                  }}
                />
                <IonLabel onClick={() => setDetailSub(sub)} style={{ cursor: 'pointer' }}>
                  <h2 style={{ whiteSpace: 'normal' }}>{sub.title}</h2>
                  <p>
                    Dernier : {fmtSE(sub)}
                    {sub.lastCheckAt > 0 ? ` • vérifié le ${new Date(sub.lastCheckAt).toLocaleString()}` : ''}
                  </p>
                  {!!sub.lastResult && (
                    <p>
                      <IonText color="medium">{sub.lastResult}</IonText>
                    </p>
                  )}
                </IonLabel>
                <IonButton fill="clear" slot="end" onClick={() => setDetailSub(sub)} title="Fiche de la série">
                  <IonIcon icon={informationCircleOutline} />
                </IonButton>
                <IonButton
                  fill="clear"
                  slot="end"
                  disabled={checking || checkingId !== null || !hasKey}
                  onClick={() => void runCheckOne(sub)}
                >
                  {checkingId === sub.id ? <IonSpinner style={{ width: 18, height: 18 }} /> : <IonIcon icon={playOutline} />}
                </IonButton>
                <IonButton fill="clear" slot="end" disabled={!hasKey} onClick={() => void openInspect(sub)}>
                  <IonIcon icon={searchOutline} />
                </IonButton>
                <IonButton
                  fill="clear"
                  color="danger"
                  slot="end"
                  onClick={() => {
                    noteDeletedSubscription(sub.id);
                    removeSubscription(sub.id);
                    void removeSubscriptionOnServer(sub.id);
                    refresh();
                  }}
                >
                  <IonIcon icon={trashOutline} />
                </IonButton>
              </IonItem>
            ))}
          </IonList>
        )}

        <IonModal isOpen={showAdd} onDidDismiss={closeAddModal} className="detail-modal">
          <IonHeader>
            <IonToolbar>
              <IonTitle>Ajouter une série</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={closeAddModal}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            <IonSearchbar
              value={addQuery}
              debounce={0}
              placeholder="Nom de la série"
              onIonInput={(e) => setAddQuery(String(e.detail.value ?? ''))}
            />
            <div className="detail-sheet" style={{ paddingTop: 4 }}>
              {addLoading ? (
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <IonSpinner />
                </div>
              ) : addError ? (
                <p>
                  <IonText color="danger">{addError}</IonText>
                </p>
              ) : addQuery.trim().length < 2 ? (
                <p>
                  <IonText color="medium">Tape au moins 2 lettres pour chercher sur TVMaze.</IonText>
                </p>
              ) : addHits.length === 0 ? (
                <p>
                  <IonText color="medium">Aucun résultat pour « {addQuery.trim()} ».</IonText>
                </p>
              ) : (
                <IonList>
                  {addHits.map((hit) => {
                    const followed = subs.some((s) => s.id === subscriptionIdFor(hit.name, hit.year));
                    const meta = [hit.year, hit.network, hit.status ? fmtShowStatus(hit.status) : '']
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <IonItem key={hit.id}>
                        {hit.image ? (
                          <img src={hit.image} alt="" className="poster-thumb" slot="start" />
                        ) : null}
                        <IonLabel>
                          <h2 style={{ whiteSpace: 'normal' }}>{hit.name}</h2>
                          {!!meta && <p>{meta}</p>}
                        </IonLabel>
                        {followed ? (
                          <IonBadge color="success" slot="end">
                            suivie
                          </IonBadge>
                        ) : (
                          <IonButton
                            slot="end"
                            fill="outline"
                            disabled={addingId !== null}
                            onClick={() => void addShow(hit)}
                          >
                            {addingId === hit.id ? <IonSpinner style={{ width: 16, height: 16 }} /> : 'Suivre'}
                          </IonButton>
                        )}
                      </IonItem>
                    );
                  })}
                </IonList>
              )}
              <p>
                <IonText color="medium">
                  <small>
                    Le suivi part du dernier épisode déjà diffusé : seuls les prochains iront vers Transmission. Pour rattraper un ancien épisode ou une saison, ouvre la fiche de la série.
                  </small>
                </IonText>
              </p>
            </div>
          </IonContent>
        </IonModal>

        <IonModal isOpen={inspecting !== null} onDidDismiss={() => setInspecting(null)} className="detail-modal">
          <IonHeader>
            <IonToolbar>
              <IonTitle>Inspecter : {inspecting?.title ?? ''}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setInspecting(null)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent>
            <div className="detail-sheet">
              {inspectLoading ? (
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <IonSpinner />
                  <p>
                    <IonText color="medium">Recherche TR4KER à blanc (aucun téléchargement)…</IonText>
                  </p>
                </div>
              ) : inspectError ? (
                <p>
                  <IonText color="danger">{inspectError}</IonText>
                </p>
              ) : inspectRes ? (
                <>
                  <IonText color="medium">
                    <p style={{ marginTop: 0 }}>
                      Requête : « {inspectRes.query} » • base suivie : {inspectRes.base} • {inspectRes.candidates.length} candidat(s).
                    </p>
                  </IonText>
                  {inspectRes.candidates.length === 0 ? (
                    <p>
                      <IonText color="warning">TR4KER ne renvoie rien pour cette requête (titre non indexé ou recherche trop large).</IonText>
                    </p>
                  ) : (
                    <IonList>
                      {inspectRes.candidates.map((c) => (
                        <IonItem key={c.slug}>
                          <IonLabel>
                            <h2 style={{ whiteSpace: 'normal' }}>{c.name}</h2>
                            <p>
                              <IonBadge color={c.verdict === 'ajouté' ? 'success' : 'medium'}>
                                {c.verdict === 'ajouté' ? 'serait ajouté' : 'ignoré'}
                              </IonBadge>{' '}
                              <IonBadge color="primary">
                                {c.season !== null ? `S${String(c.season).padStart(2, '0')}E${String(c.episode ?? 0).padStart(2, '0')}` : 'sans S/E'}
                              </IonBadge>{' '}
                              {c.isPack && <IonBadge color="tertiary">pack</IonBadge>}{' '}
                              {!!c.quality && <IonBadge color="secondary">{c.quality}</IonBadge>}
                            </p>
                            <p style={{ whiteSpace: 'normal' }}>
                              <IonText color="medium">{c.reason}</IonText>
                            </p>
                            {c.season !== null && c.verdict === 'ignoré' && !c.alreadyAdded && (
                              <IonButton
                                size="small"
                                fill="outline"
                                disabled={forcingSlug !== null}
                                onClick={() => void forceOne(c)}
                              >
                                {forcingSlug === c.slug ? <IonSpinner style={{ width: 16, height: 16 }} /> : <IonIcon icon={playOutline} />}
                                &nbsp;Télécharger quand même
                              </IonButton>
                            )}
                          </IonLabel>
                        </IonItem>
                      ))}
                    </IonList>
                  )}
                </>
              ) : null}
            </div>
          </IonContent>
        </IonModal>

        <ShowDetailModal
          sub={detailSub}
          isOpen={detailSub !== null}
          onClose={() => setDetailSub(null)}
          onToast={setToast}
          onChanged={() => {
            const updated = detailSub ? loadSubscriptions().find((s) => s.id === detailSub.id) : undefined;
            if (updated) void pushSubscription(updated);
            refresh();
          }}
        />
        <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
        <IonToast isOpen={!!toast} message={toast} duration={3000} onDidDismiss={() => setToast('')} />
      </IonContent>
    </IonPage>
  );
};

/** Vérification silencieuse au lancement (si clé + throttle 6 h dépassé). */
export async function runLaunchCheck(): Promise<void> {
  try {
    if (!settings.tr4kerApiKey || !isGlobalCheckDue()) return;
    if (loadSubscriptions().every((s) => !s.enabled)) return;
    await checkAllSubscriptions(settings.tr4kerApiKey);
    void pushAllSubscriptions();
  } catch {
    /* silencieux */
  }
}

export default SeriesWatchTab;
