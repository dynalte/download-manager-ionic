import React, { useRef, useState } from 'react';
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
  IonIcon,
  IonItem,
  IonInput,
  IonText,
} from '@ionic/react';
import { arrowBackOutline, arrowForwardOutline, refreshOutline, shareOutline, openOutline } from 'ionicons/icons';
import { Browser } from '@capacitor/browser';
import { Share } from '@capacitor/share';
import { ALLOCINE_URL } from '../config/appConfig';

const BrowserTab: React.FC = () => {
  const [url, setUrl] = useState(ALLOCINE_URL);
  const [input, setInput] = useState(ALLOCINE_URL);
  const [canGo, setCanGo] = useState({ back: false, forward: false });
  const history = useRef<string[]>([ALLOCINE_URL]);
  const index = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  function navigate(next: string) {
    let normalized = next.trim();
    if (!normalized) return;
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
    history.current = history.current.slice(0, index.current + 1);
    history.current.push(normalized);
    index.current = history.current.length - 1;
    setUrl(normalized);
    setInput(normalized);
    setCanGo({ back: index.current > 0, forward: false });
  }

  function goBack() {
    if (index.current > 0) {
      index.current -= 1;
      setUrl(history.current[index.current]);
      setInput(history.current[index.current]);
      setCanGo({ back: index.current > 0, forward: true });
    }
  }

  function goForward() {
    if (index.current < history.current.length - 1) {
      index.current += 1;
      setUrl(history.current[index.current]);
      setInput(history.current[index.current]);
      setCanGo({ back: true, forward: index.current < history.current.length - 1 });
    }
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Navigateur</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={goBack} disabled={!canGo.back}>
              <IonIcon icon={arrowBackOutline} />
            </IonButton>
            <IonButton onClick={goForward} disabled={!canGo.forward}>
              <IonIcon icon={arrowForwardOutline} />
            </IonButton>
            <IonButton onClick={() => setReloadKey((k) => k + 1)}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
            <IonButton
              onClick={() => void Share.share({ title: 'Lien', text: url, url }).catch(() => {})}
            >
              <IonIcon icon={shareOutline} />
            </IonButton>
            <IonButton onClick={() => void Browser.open({ url })}>
              <IonIcon icon={openOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonItem lines="none">
            <IonInput value={input} onIonInput={(e) => setInput(String(e.detail.value ?? ''))} onIonChange={(e) => navigate(String(e.detail.value ?? url))} placeholder="https://..." />
            <IonButton fill="solid" onClick={() => void Browser.open({ url })}>
              <IonIcon icon={openOutline} slot="start" />
              Ouvrir
            </IonButton>
          </IonItem>
          <div style={{ padding: '0 12px 6px' }}>
            <IonText color="medium">
              <small style={{ wordBreak: 'break-all' }}>{url || 'Aucune page chargee'}</small>
            </IonText>
            <IonText color="medium">
              <small>
                Si la page affiche &quot;n&apos;autorise pas la connexion&quot;, le site refuse l&apos;affichage
                embarqué (X-Frame-Options / CSP). Utilise le bouton Ouvrir pour le voir dans le
                navigateur système.
              </small>
            </IonText>
          </div>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <iframe key={reloadKey} title="Navigateur" src={url} className="torrent-iframe" style={{ height: '100%' }} />
      </IonContent>
    </IonPage>
  );
};

export default BrowserTab;
