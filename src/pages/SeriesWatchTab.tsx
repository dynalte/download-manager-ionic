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
  RefresherEventDetail,
} from '@ionic/react';
import { refreshOutline, trashOutline, playOutline, settingsOutline } from 'ionicons/icons';
import {
  checkAllSubscriptions,
  checkSubscription,
  isGlobalCheckDue,
  loadSubscriptions,
  removeSubscription,
  upsertSubscription,
  type SeriesSubscription,
} from '../services/seriesWatch';
import { settings } from '../services/settings';
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

  const refresh = useCallback(() => setSubs(loadSubscriptions()), []);

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

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    await runCheckAll();
    event.detail.complete();
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
                    if (updated) upsertSubscription(updated);
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
                  color="danger"
                  slot="end"
                  onClick={() => {
                    removeSubscription(sub.id);
                    refresh();
                  }}
                >
                  <IonIcon icon={trashOutline} />
                </IonButton>
              </IonItem>
            ))}
          </IonList>
        )}

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
  } catch {
    /* silencieux */
  }
}

export default SeriesWatchTab;
