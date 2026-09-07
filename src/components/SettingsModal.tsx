import React, { useState } from 'react';
import {
  IonModal,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonInput,
  IonToggle,
  IonRange,
  IonText,
  IonSegment,
  IonSegmentButton,
} from '@ionic/react';
import { AppConfig } from '../config/appConfig';
import {
  Keys,
  DEFAULT_FOLDER_FILMS,
  DEFAULT_FOLDER_SERIES,
  DEFAULT_FOLDER_MUSIQUE,
  DEFAULT_FOLDER_LIVRES,
  DEFAULT_POLL_INTERVAL,
  setSetting,
} from '../services/settings';
import { requestAuthorizationIfNeeded } from '../services/completionMonitor';
import { getThemeMode, setThemeMode, type ThemeMode } from '../services/theme';

function useStored(key: string, fallback: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? fallback);
  const update = (v: string) => {
    setValue(v);
    setSetting(key, v);
  };
  return [value, update] as const;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const SettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [rpcURL, setRpcURL] = useStored(Keys.transmissionRPCURL, AppConfig.transmissionRPCURL);
  const [username, setUsername] = useStored(Keys.transmissionUsername, AppConfig.transmissionUsername);
  const [password, setPassword] = useStored(Keys.transmissionPassword, AppConfig.transmissionPassword);
  const [filmsPath, setFilmsPath] = useStored(Keys.folderFilmsPath, DEFAULT_FOLDER_FILMS);
  const [seriesPath, setSeriesPath] = useStored(Keys.folderSeriesPath, DEFAULT_FOLDER_SERIES);
  const [musiquePath, setMusiquePath] = useStored(Keys.folderMusiquePath, DEFAULT_FOLDER_MUSIQUE);
  const [livresPath, setLivresPath] = useStored(Keys.folderLivresPath, DEFAULT_FOLDER_LIVRES);
  const [fileServerURL, setFileServerURL] = useStored(Keys.fileServerBaseURL, AppConfig.fileServerBaseURL);
  const [fileServerUser, setFileServerUser] = useStored(Keys.fileServerUsername, AppConfig.fileServerUsername);
  const [fileServerPass, setFileServerPass] = useStored(Keys.fileServerPassword, AppConfig.fileServerPassword);
  const [tr4kerApiKey, setTr4kerApiKey] = useStored(Keys.tr4kerApiKey, AppConfig.tr4kerApiKey);
  const [plexBaseURL, setPlexBaseURL] = useStored(Keys.plexBaseURL, AppConfig.plexBaseURL);
  const [plexToken, setPlexToken] = useStored(Keys.plexToken, AppConfig.plexToken);
  const [plexSectionKeysCSV, setPlexSectionKeysCSV] = useStored(Keys.plexSectionKeysCSV, '');
  const [plexUseCloud, setPlexUseCloudState] = useState(() => (localStorage.getItem(Keys.plexUseCloud) ?? '') === '1');
  const [notificationsEnabled, setNotificationsEnabledState] = useState(
    () => (localStorage.getItem(Keys.downloadNotificationsEnabled) ?? '1') !== '0',
  );
  const [pollInterval, setPollInterval] = useState(() =>
    parseInt(localStorage.getItem(Keys.downloadPollIntervalSeconds) ?? String(DEFAULT_POLL_INTERVAL), 10) || DEFAULT_POLL_INTERVAL,
  );
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onClose}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Reglages</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>Fermer</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList>
          <IonItem>
            <IonLabel>
              <h2>Transmission RPC</h2>
              <p>L'URL doit pointer vers l'endpoint /transmission/rpc.</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonInput label="URL RPC" labelPlacement="stacked" value={rpcURL} autocapitalize="off" autocorrect="off" spellcheck={false} onIonInput={(e) => setRpcURL(String(e.detail.value ?? ''))} placeholder="http://IP:9091/transmission/rpc" />
          </IonItem>
          <IonItem>
            <IonInput label="Nom d'utilisateur" labelPlacement="stacked" value={username} autocapitalize="off" autocorrect="off" spellcheck={false} onIonInput={(e) => setUsername(String(e.detail.value ?? ''))} />
          </IonItem>
          <IonItem>
            <IonInput label="Mot de passe" labelPlacement="stacked" type="password" value={password} onIonInput={(e) => setPassword(String(e.detail.value ?? ''))} />
          </IonItem>

          <IonItem>
            <IonLabel>
              <h2>Dossiers de destination</h2>
              <p>Ces chemins sont envoyes a Transmission dans download-dir.</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonInput label="Films" labelPlacement="stacked" value={filmsPath} placeholder={DEFAULT_FOLDER_FILMS} onIonInput={(e) => setFilmsPath(String(e.detail.value ?? ''))} />
          </IonItem>
          <IonItem>
            <IonInput label="Series" labelPlacement="stacked" value={seriesPath} placeholder={DEFAULT_FOLDER_SERIES} onIonInput={(e) => setSeriesPath(String(e.detail.value ?? ''))} />
          </IonItem>
          <IonItem>
            <IonInput label="Musique" labelPlacement="stacked" value={musiquePath} placeholder={DEFAULT_FOLDER_MUSIQUE} onIonInput={(e) => setMusiquePath(String(e.detail.value ?? ''))} />
          </IonItem>
          <IonItem>
            <IonInput label="Livres" labelPlacement="stacked" value={livresPath} placeholder={DEFAULT_FOLDER_LIVRES} onIonInput={(e) => setLivresPath(String(e.detail.value ?? ''))} />
          </IonItem>

          <IonItem>
            <IonLabel>
              <h2>Serveur de fichiers</h2>
              <p>Accès HTTP aux fichiers téléchargés (envoi e-books par e-mail).</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonInput label="URL de base" labelPlacement="stacked" value={fileServerURL} autocapitalize="off" autocorrect="off" spellcheck={false} onIonInput={(e) => setFileServerURL(String(e.detail.value ?? ''))} placeholder="http://serveur:8080" />
          </IonItem>
          <IonItem>
            <IonInput label="Nom d'utilisateur" labelPlacement="stacked" value={fileServerUser} autocapitalize="off" autocorrect="off" spellcheck={false} onIonInput={(e) => setFileServerUser(String(e.detail.value ?? ''))} />
          </IonItem>
          <IonItem>
            <IonInput label="Mot de passe" labelPlacement="stacked" type="password" value={fileServerPass} onIonInput={(e) => setFileServerPass(String(e.detail.value ?? ''))} />
          </IonItem>

          <IonItem>
            <IonLabel>
              <h2>Suivi de séries</h2>
              <p>Clé API personnelle TR4KER (réglages du compte TR4KER). Sans elle, pas de vérification auto.</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonInput label="Clé API TR4KER" labelPlacement="stacked" type="password" value={tr4kerApiKey} autocapitalize="off" autocorrect="off" spellcheck={false} onIonInput={(e) => setTr4kerApiKey(String(e.detail.value ?? ''))} />
          </IonItem>

          <IonItem>
            <IonLabel>
              <h2>Plex</h2>
              <p>{plexUseCloud ? 'Mode cloud actif: detection automatique via plex.tv.' : "Mode local actif: l'URL Plex est utilisee directement."}</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonToggle
              checked={plexUseCloud}
              onIonChange={(e) => {
                setPlexUseCloudState(e.detail.checked);
                setSetting(Keys.plexUseCloud, e.detail.checked ? '1' : '0');
              }}
            >
              Utiliser Plex Cloud (auto-discovery)
            </IonToggle>
          </IonItem>
          <IonItem>
            <IonInput label="URL Plex" labelPlacement="stacked" value={plexBaseURL} disabled={plexUseCloud} autocapitalize="off" autocorrect="off" spellcheck={false} onIonInput={(e) => setPlexBaseURL(String(e.detail.value ?? ''))} placeholder="http://192.168.1.10:32400" />
          </IonItem>
          <IonItem>
            <IonInput label="Token Plex" labelPlacement="stacked" type="password" value={plexToken} onIonInput={(e) => setPlexToken(String(e.detail.value ?? ''))} />
          </IonItem>
          <IonItem>
            <IonInput label="IDs sections (ex: 1,2) - vide = auto" labelPlacement="stacked" value={plexSectionKeysCSV} onIonInput={(e) => setPlexSectionKeysCSV(String(e.detail.value ?? ''))} />
          </IonItem>

          <IonItem>
            <IonLabel>
              <h2>Apparence</h2>
            </IonLabel>
          </IonItem>
          <div style={{ padding: '4px 16px 8px' }}>
            <IonSegment
              value={themeMode}
              onIonChange={(e) => {
                const v = String(e.detail.value) as ThemeMode;
                setThemeModeState(v);
                setThemeMode(v);
              }}
            >
              <IonSegmentButton value="system">
                <IonLabel>Système</IonLabel>
              </IonSegmentButton>
              <IonSegmentButton value="light">
                <IonLabel>Clair</IonLabel>
              </IonSegmentButton>
              <IonSegmentButton value="dark">
                <IonLabel>Sombre</IonLabel>
              </IonSegmentButton>
            </IonSegment>
          </div>

          <IonItem>
            <IonLabel>
              <h2>Telechargements</h2>
              <IonText color="medium">
                <p>Tu peux aussi tirer la liste vers le bas pour forcer un refresh.</p>
              </IonText>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonToggle
              checked={notificationsEnabled}
              onIonChange={(e) => {
                setNotificationsEnabledState(e.detail.checked);
                setSetting(Keys.downloadNotificationsEnabled, e.detail.checked ? '1' : '0');
                if (e.detail.checked) void requestAuthorizationIfNeeded();
              }}
            >
              Notifier quand un telechargement se termine
            </IonToggle>
          </IonItem>
          <IonItem>
            <IonLabel>
              Rafraichissement auto: {pollInterval}s
              <IonRange min={10} max={120} step={5} value={pollInterval} onIonChange={(e) => {
                const v = Number(e.detail.value);
                setPollInterval(v);
                setSetting(Keys.downloadPollIntervalSeconds, String(v));
              }} />
            </IonLabel>
          </IonItem>
        </IonList>
      </IonContent>
    </IonModal>
  );
};

export default SettingsModal;
