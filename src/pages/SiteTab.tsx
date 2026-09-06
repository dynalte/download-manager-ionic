import React, { useEffect, useRef, useState } from 'react';
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonItem,
  IonInput,
  IonButton,
  IonText,
  IonIcon,
  IonButtons,
  IonToast,
  IonCard,
  IonCardContent,
  useIonViewDidEnter,
  useIonViewWillLeave,
} from '@ionic/react';
import { openOutline, downloadOutline, magnetOutline, filmOutline, phonePortraitOutline } from 'ionicons/icons';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { TR4KER_URL } from '../config/appConfig';
import { transmissionPath, type DestinationFolder } from '../services/settings';
import { autoConfirmedFolder, type PendingPayload } from '../services/destinationPredictor';
import { uploadMagnet, uploadTorrentData, downloadTorrentBytes } from '../services/transmission';
import { buildAllocineUrl, isMagnetUrl, normalizeTorrentFilename, shouldHandleAsTorrentUrl } from '../services/torrentScripts';
import {
  base64ToBytes,
  openTr4kerEmbedded,
  isDesktopElectron,
  TR4KER_WEBVIEW_INTERCEPTOR_JS,
  handleGuestTorrentMessage,
} from '../services/embeddedBrowser';
import FolderSheet from '../components/FolderSheet';

const SiteTab: React.FC = () => {
  const [statusMessage, setStatusMessage] = useState('Pret');
  const [errorMessage, setErrorMessage] = useState('');
  const [pending, setPending] = useState<PendingPayload | null>(null);
  const [pendingBytes, setPendingBytes] = useState<Uint8Array | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [toast, setToast] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const browserRef = useRef<{ close: () => Promise<void> } | null>(null);
  // Exe Windows : le site est affiché inline dans l'onglet (balise <webview>).
  const isElectron = useRef(isDesktopElectron()).current;
  const webviewRef = useRef<any>(null);
  const [tr4kerPreloadPath, setTr4kerPreloadPath] = useState<string | null>(null);
  const autoOpenRef = useRef(false);
  const domReadyToastRef = useRef(false);

  useIonViewWillLeave(() => {
    setPending(null);
    autoOpenRef.current = false;
    void browserRef.current?.close().catch(() => {});
    browserRef.current = null;
  });

  async function sendToTransmission(payload: PendingPayload, bytes: Uint8Array | null, folder: DestinationFolder, auto = false) {
    try {
      setStatusMessage(auto ? `Dossier detecte automatiquement: ${folder}` : `Ajout vers ${folder}...`);
      if (payload.kind === 'torrent' && bytes) {
        const res = await uploadTorrentData(bytes, transmissionPath(folder));
        const info = res.duplicate ?? res.added;
        setStatusMessage(res.duplicate ? `Deja present : ${info?.name ?? payload.filename}` : `Torrent ajoute dans ${folder}`);
        setErrorMessage('');
        setToast(res.duplicate ? `Deja dans Transmission : ${info?.name ?? payload.filename}` : `Ajoute : ${info?.name ?? payload.filename}`);
      } else if (payload.kind === 'magnet') {
        const res = await uploadMagnet(payload.magnetURL, transmissionPath(folder));
        const info = res.duplicate ?? res.added;
        setStatusMessage(res.duplicate ? `Deja present : ${info?.name ?? 'magnet'}` : `Magnet ajoute dans ${folder}`);
        setErrorMessage('');
        setToast(res.duplicate ? `Deja dans Transmission : ${info?.name ?? 'magnet'}` : `Ajoute : ${info?.name ?? 'magnet'}`);
      } else {
        throw new Error('Rien à envoyer (données manquantes).');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMessage(msg);
      setStatusMessage('Erreur');
    } finally {
      setPending(null);
      setPendingBytes(null);
    }
  }

  function handleIncoming(payload: PendingPayload, bytes: Uint8Array | null) {
    const auto = autoConfirmedFolder(payload);
    if (auto) {
      void sendToTransmission(payload, bytes, auto, true);
      return;
    }
    setPending(payload);
    setPendingBytes(bytes);
    setStatusMessage('Selection du dossier de destination...');
  }

  async function handleUrlSubmit() {
    const raw = urlInput.trim();
    if (!raw) return;
    setErrorMessage('');
    if (isMagnetUrl(raw)) {
      handleIncoming({ kind: 'magnet', filename: '', sourceURL: raw, pageURL: '', magnetURL: raw }, null);
      return;
    }
    if (!shouldHandleAsTorrentUrl(raw)) {
      setErrorMessage("L'URL ne ressemble pas a un .torrent (ni magnet). Ajout magnet possible quand meme via la fiche.");
      handleIncoming({ kind: 'magnet', filename: '', sourceURL: raw, pageURL: '', magnetURL: raw }, null);
      return;
    }
    try {
      setStatusMessage('Telechargement du torrent...');
      const { bytes, filename } = await downloadTorrentBytes(raw, TR4KER_URL);
      handleIncoming({ kind: 'torrent', filename, sourceURL: raw, pageURL: '', magnetURL: '' }, bytes);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setStatusMessage('Erreur');
    }
  }

  async function handleFilePicked(file: File) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      handleIncoming(
        { kind: 'torrent', filename: normalizeTorrentFilename(file.name), sourceURL: '', pageURL: '', magnetURL: '' },
        buf,
      );
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  }

  /** Ouvre TR4KER dans une WebView native plein écran (pas d'iframe -> pas de blocage). */
  async function openEmbedded() {
    if (browserBusy) return;
    setBrowserBusy(true);
    setErrorMessage('');
    try {
      // Referme un éventuel browser précédent avant d'en ouvrir un nouveau.
      try {
        await browserRef.current?.close();
      } catch {
        /* ignore */
      }
      browserRef.current = await openTr4kerEmbedded(TR4KER_URL, {
        onMagnet: (magnetURL, pageURL) => {
          // Mobile : on referme la WebView plein écran pour révéler la fiche.
          // Desktop (fenêtre dédiée) : on la garde ouverte.
          if (Capacitor.isNativePlatform()) void browserRef.current?.close().catch(() => {});
          setToast('Magnet intercepté');
          handleIncoming({ kind: 'magnet', filename: '', sourceURL: '', pageURL, magnetURL }, null);
        },
        onTorrentBytes: (t) => {
          if (Capacitor.isNativePlatform()) void browserRef.current?.close().catch(() => {});
          try {
            const bytes = base64ToBytes(t.bytesBase64);
            setToast('Torrent intercepté');
            handleIncoming(
              { kind: 'torrent', filename: normalizeTorrentFilename(t.filename), sourceURL: t.sourceURL, pageURL: t.pageURL, magnetURL: '' },
              bytes,
            );
          } catch (e) {
            setErrorMessage(e instanceof Error ? e.message : String(e));
          }
        },
        onTorrentUrl: (url, pageURL) => {
          // Le fetch intra-page a échoué (ex: 401) : on retente en fetch direct
          // puis on rend la main à l'utilisateur via la fiche dossier.
          if (Capacitor.isNativePlatform()) void browserRef.current?.close().catch(() => {});
          void (async () => {
            try {
              setStatusMessage('Telechargement du torrent...');
              const { bytes, filename } = await downloadTorrentBytes(url, TR4KER_URL);
              handleIncoming({ kind: 'torrent', filename, sourceURL: url, pageURL, magnetURL: '' }, bytes);
            } catch (e) {
              setErrorMessage(
                `Lien intercepté mais téléchargement impossible (${e instanceof Error ? e.message : String(e)}). ` +
                  `Colle-le manuellement ci-dessous ou vérifie ta session TR4KER.`,
              );
              setStatusMessage('Erreur');
              setUrlInput(url);
            }
          })();
        },
        onClose: () => {
          browserRef.current = null;
        },
      });
      if (!Capacitor.isNativePlatform()) {
        setStatusMessage('TR4KER ouvert dans un nouvel onglet (mode web)');
      } else {
        setStatusMessage('TR4KER ouvert : touche un lien .torrent / magnet pour l’intercepter');
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setStatusMessage('Erreur');
    } finally {
      setBrowserBusy(false);
    }
  }

  // Mobile : le site s'ouvre directement à l'entrée sur l'onglet, sans bouton.
  useIonViewDidEnter(() => {
    if (isElectron || !Capacitor.isNativePlatform()) return;
    if (autoOpenRef.current || pending) return;
    autoOpenRef.current = true;
    void openEmbedded();
  });

  // Exe Windows : chemin du preload minimal de la <webview> inline.
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    window.desktop
      ?.getTr4kerPreloadPath()
      .then((p) => {
        if (!cancelled) setTr4kerPreloadPath(p);
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('Bridge desktop indisponible');
      });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  // Exe Windows : câblage de la <webview> TR4KER inline (interception +
  // téléchargement via la session invité, jamais d'iframe).
  useEffect(() => {
    if (!isElectron || !tr4kerPreloadPath) return;
    const wv = webviewRef.current;
    if (!wv) return;

    const submitMagnet = (magnetURL: string, pageURL: string) => {
      setToast('Magnet intercepté');
      handleIncoming({ kind: 'magnet', filename: '', sourceURL: '', pageURL, magnetURL }, null);
    };
    const submitTorrentBytes = (t: { bytesBase64: string; filename: string; sourceURL: string; pageURL: string }) => {
      try {
        const bytes = base64ToBytes(t.bytesBase64);
        setToast('Torrent intercepté');
        handleIncoming(
          { kind: 'torrent', filename: normalizeTorrentFilename(t.filename), sourceURL: t.sourceURL, pageURL: t.pageURL, magnetURL: '' },
          bytes,
        );
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    };
    const downloadViaGuest = (url: string) => {
      // Téléchargement avec les cookies de la session invité -> will-download (main).
      try {
        wv.downloadURL(url);
      } catch {
        setErrorMessage('Téléchargement impossible depuis la page TR4KER.');
      }
    };

    const onIpcMessage = (e: any) => {
      handleGuestTorrentMessage(e?.args?.[0], {
        onMagnet: (magnetURL, pageURL) => submitMagnet(magnetURL, pageURL),
        onTorrentBytes: (t) => submitTorrentBytes(t),
        // Échec du fetch intra-page : retente via la session invité.
        onTorrentUrl: (url) => downloadViaGuest(url),
        onClose: () => {},
      });
    };
    // Filet côté main (will-download / will-navigate de la fenêtre dédiée
    // n'existe pas en inline : le main renvoie tout sur ces canaux).
    // Sans ces abonnements, les téléchargements interceptés partaient dans le vide.
    const offMagnet = window.desktop!.onTr4kerMagnet((p) => submitMagnet(p.url, p.pageURL || ''));
    const offBytes = window.desktop!.onTr4kerTorrentBytes((p) =>
      submitTorrentBytes({
        bytesBase64: p.bytesBase64,
        filename: p.filename || 'download.torrent',
        sourceURL: p.sourceURL || '',
        pageURL: p.pageURL || '',
      }),
    );
    const offUrl = window.desktop!.onTr4kerTorrentUrl((p) => downloadViaGuest(p.url));
    const onDomReady = () => {
      try {
        const id = wv.getWebContentsId();
        void window.desktop?.attachTr4kerDownloads(id).catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        void wv.executeJavaScript(TR4KER_WEBVIEW_INTERCEPTOR_JS);
      } catch {
        /* ignore */
      }
      // Preuve de vie (diagnostic + UX) : l'injection a eu lieu.
      if (!domReadyToastRef.current) {
        domReadyToastRef.current = true;
        setToast('TR4KER chargé — cliquez un téléchargement');
      }
    };
    const onWillNavigate = (e: any) => {
      const url: string = e?.url || '';
      if (!url) return;
      if (isMagnetUrl(url)) {
        e.preventDefault();
        submitMagnet(url, wv.getURL?.() || '');
      } else if (/^https?:/i.test(url) && shouldHandleAsTorrentUrl(url)) {
        e.preventDefault();
        downloadViaGuest(url);
      }
    };
    const onNewWindow = (e: any) => {
      const url: string = e?.url || '';
      if (!url) return;
      e.preventDefault();
      if (isMagnetUrl(url)) {
        submitMagnet(url, wv.getURL?.() || '');
      } else if (/^https?:/i.test(url)) {
        if (shouldHandleAsTorrentUrl(url)) downloadViaGuest(url);
        else {
          try {
            wv.loadURL(url);
          } catch {
            /* ignore */
          }
        }
      }
    };

    wv.addEventListener('ipc-message', onIpcMessage);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('will-navigate', onWillNavigate);
    wv.addEventListener('new-window', onNewWindow);
    return () => {
      try {
        offMagnet();
        offBytes();
        offUrl();
      } catch {
        /* ignore */
      }
      try {
        wv.removeEventListener('ipc-message', onIpcMessage);
        wv.removeEventListener('dom-ready', onDomReady);
        wv.removeEventListener('will-navigate', onWillNavigate);
        wv.removeEventListener('new-window', onNewWindow);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isElectron, tr4kerPreloadPath]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Site</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => void openEmbedded()}>
              <IonIcon icon={phonePortraitOutline} />
            </IonButton>
            <IonButton onClick={() => void Browser.open({ url: TR4KER_URL })}>
              <IonIcon icon={openOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        {isElectron ? (
          /* Exe Windows : TR4KER seul, plein onglet (pas de formulaire dessous).
             La fiche dossier + toast restent (overlays). Les erreurs s'affichent
             dans un bandeau fin (sinon échec Transmission = silence total). */
          <div className="webview-wrap" style={{ height: '100%' }}>
            {errorMessage && (
              <div className="error-banner">
                <IonText color="danger" style={{ flex: 1 }}>
                  <small>{errorMessage}</small>
                </IonText>
                <IonButton size="small" fill="clear" color="danger" onClick={() => setErrorMessage('')}>
                  OK
                </IonButton>
              </div>
            )}
            {tr4kerPreloadPath ? (
              <webview
                ref={webviewRef}
                src={TR4KER_URL}
                partition="persist:tr4ker"
                preload={tr4kerPreloadPath}
                allowpopups
                style={{ width: '100%', height: '100%' }}
              />
            ) : (
              <IonItem lines="none">
                <IonText color="medium">Chargement de TR4KER…</IonText>
              </IonItem>
            )}
          </div>
        ) : (
          <>
            {/* Mobile : ouverture auto à l'entrée ; bouton compact pour rouvrir.
                Web : ouverture dans un onglet (pas de WebView native). */}
            <IonCard>
              <IonCardContent style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <p style={{ flex: 1, margin: 0 }}>
                  {Capacitor.isNativePlatform()
                    ? "TR4KER s'ouvre directement dans l'appli. Touche un .torrent / magnet pour l'envoyer vers Transmission."
                    : 'TR4KER ne peut pas s’embarquer dans un onglet web : il s’ouvre à côté.'}
                </p>
                <IonButton
                  size="small"
                  onClick={() => {
                    if (Capacitor.isNativePlatform()) autoOpenRef.current = true;
                    void openEmbedded();
                  }}
                  disabled={browserBusy}
                >
                  <IonIcon icon={phonePortraitOutline} slot="start" />
                  {Capacitor.isNativePlatform() ? 'Rouvrir' : 'Ouvrir'}
                </IonButton>
              </IonCardContent>
            </IonCard>

            <IonItem>
              <IonInput
                label="Lien .torrent ou magnet"
                labelPlacement="stacked"
                placeholder="https://.../download.torrent ou magnet:?xt=..."
                value={urlInput}
                onIonInput={(e) => setUrlInput(String(e.detail.value ?? ''))}
              />
            </IonItem>
            <IonItem lines="none">
              <IonButton expand="block" onClick={() => void handleUrlSubmit()} style={{ flex: 1 }}>
                <IonIcon icon={downloadOutline} slot="start" />
                Intercepter / Ajouter
              </IonButton>
              <IonButton fill="outline" onClick={() => fileRef.current?.click()}>
                <IonIcon icon={magnetOutline} slot="start" />
                Fichier .torrent
              </IonButton>
            </IonItem>
            <input
              ref={fileRef}
              type="file"
              accept=".torrent,application/x-bittorrent"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFilePicked(f);
                e.target.value = '';
              }}
            />

            <IonItem>
              <IonInput
                label="Titre du film / serie (bouton Allocine)"
                labelPlacement="stacked"
                placeholder="Ex: Dune Deuxieme partie"
                value={titleInput}
                onIonInput={(e) => setTitleInput(String(e.detail.value ?? ''))}
              />
            </IonItem>
            <IonItem lines="none">
              <IonButton
                fill="outline"
                disabled={!titleInput.trim()}
                onClick={() => void Browser.open({ url: buildAllocineUrl(titleInput) })}
                style={{ flex: 1 }}
              >
                <IonIcon icon={filmOutline} slot="start" />
                Ouvrir Allocine
              </IonButton>
            </IonItem>

            <div className="status-bar">
              <div>Statut: {statusMessage}</div>
              {errorMessage && (
                <IonText color="danger">
                  <div>Detail: {errorMessage}</div>
                </IonText>
              )}
            </div>
          </>
        )}

        <FolderSheet
          isOpen={pending !== null}
          payload={pending}
          onCancel={() => {
            setPending(null);
            setPendingBytes(null);
            setStatusMessage('Ajout annule');
          }}
          onSelect={(folder) => {
            if (pending) void sendToTransmission(pending, pendingBytes, folder);
          }}
        />
        <IonToast isOpen={!!toast} message={toast} duration={2000} onDidDismiss={() => setToast('')} />
      </IonContent>
    </IonPage>
  );
};

export default SiteTab;
