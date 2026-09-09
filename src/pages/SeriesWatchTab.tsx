import React, { useCallback, useEffect, useState } from 'react';
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
  RefresherEventDetail,
} from '@ionic/react';
import { refreshOutline, trashOutline, playOutline, searchOutline, settingsOutline } from 'ionicons/icons';
import {
  checkAllSubscriptions,
  checkSubscription,
  forceDownloadCandidate,
  inspectSubscription,
  isGlobalCheckDue,
  loadSubscriptions,
  noteDeletedSubscription,
  removeSubscription,
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

function fmtSE(sub: SeriesSubscription): string {
  if (sub.lastSeason <= 0) return 'aucun épisode repéré';
  return `S${String(sub.lastSeason).padStart(2, '0')}E${String(sub.lastEpisode).padStart(2, '0')}`;
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

  const refresh = useCallback(() => {
    // Recharge + fusionne avec le serveur (repousse la fusion) ; repli local si hors ligne.
    void loadSubscriptionsMerged().then(setSubs);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
    await runCheckAll();
    event.detail.complete();
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
            <IonButton onClick={() => setShowSettings(true)}>
              <IonIcon icon={settingsOutline} />
            </IonButton>
            <IonButton onClick={() => void runCheckAll()} disabled={checking || !hasKey}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
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
        {!isServerConfigured() && subs.length > 0 && (
          <div style={{ padding: '0 16px 8px' }}>
            <IonText color="warning">
              <small>
                Synchro serveur inactive sur cet appareil : renseigne URL + token (Réglages &gt; Synchro vus) pour retrouver ces suivis sur iPhone/bureau.
              </small>
            </IonText>
          </div>
        )}

        {checking && subs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
          </div>
        ) : subs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonText color="medium">Aucune série suivie. Abonne-toi depuis la fiche d’une série dans Plex.</IonText>
          </div>
        ) : (
          <IonList>
            {subs.map((sub) => (
              <IonItem key={sub.id}>
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
                    }
                    refresh();
                  }}
                />
                <IonLabel>
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
                <IonButton
                  fill="clear"
                  slot="end"
                  disabled={checking || checkingId !== null || !hasKey}
                  onClick={() => void runCheckOne(sub)}
                >
                  {checkingId === sub.id ? <IonSpinner style={{ width: 18, height: 18 }} /> : <IonIcon icon={playOutline} />}
                </IonButton>
                <IonButton
                  fill="clear"
                  slot="end"
                  disabled={!hasKey}
                  onClick={() => void openInspect(sub)}
                >
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
