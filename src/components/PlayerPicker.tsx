import React, { useMemo, useState } from 'react';
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
  IonBadge,
  IonSegment,
  IonSegmentButton,
  IonInput,
} from '@ionic/react';
import type { PlexPlayerTarget } from '../services/plex';

interface Props {
  isOpen: boolean;
  title: string;
  players: PlexPlayerTarget[];
  debug?: string;
  /** Dump complet (compte + appareils bruts) pour copier-coller au support. */
  diagnostic?: string;
  onCancel: () => void;
  onSelect: (player: PlexPlayerTarget) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Ajout manuel par IP (Fire TV invisible sur plex.tv). */
  onAddManual?: (host: string, port: string) => void;
  onRemoveManual?: (baseURL: string) => void;
}

type Filter = 'all' | 'online' | 'firetv';

function isFireTV(p: PlexPlayerTarget): boolean {
  const s = `${p.product} ${p.platform} ${p.name}`.toLowerCase();
  return s.includes('fire') || s.includes('aft') || s.includes('android (tv)') || s.includes('android tv');
}

function presenceLabel(p: PlexPlayerTarget): { text: string; color: string } {
  if (p.presence === true) return { text: 'En ligne', color: 'success' };
  if (p.presence === false) return { text: 'Hors ligne', color: 'medium' };
  return { text: p.source, color: 'medium' };
}

const PlayerPicker: React.FC<Props> = ({ isOpen, title, players, debug, diagnostic, onCancel, onSelect, onRefresh, refreshing, onAddManual, onRemoveManual }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualPort, setManualPort] = useState('32500');
  const shown = useMemo(() => {
    if (filter === 'online') return players.filter((p) => p.presence !== false);
    if (filter === 'firetv') return players.filter(isFireTV);
    return players;
  }, [players, filter]);

  async function copyDiagnostic() {
    const text = diagnostic || debug || 'pas de diagnostic';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* presse-papiers indisponible */
    }
  }
  return (
  <IonModal isOpen={isOpen} onDidDismiss={onCancel}>
    <IonHeader>
      <IonToolbar>
        <IonTitle>Choisir un lecteur ({shown.length}/{players.length})</IonTitle>
        <IonButtons slot="end">
          {onRefresh && (
            <IonButton onClick={onRefresh} disabled={refreshing}>
              Actualiser
            </IonButton>
          )}
          {diagnostic && (
            <IonButton onClick={() => void copyDiagnostic()}>
              {copied ? 'Copié !' : 'Copier diag'}
            </IonButton>
          )}
          <IonButton onClick={onCancel}>Fermer</IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>
    <IonContent>
      <IonItem lines="none">
        <IonLabel>
          <p style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
          {debug && <p style={{ whiteSpace: 'normal', fontSize: 12, opacity: 0.7 }}>{debug}</p>}
          <p style={{ whiteSpace: 'normal' }}>
            Fire TV absente ? Ouvre l’app Plex sur la TV (même compte, même Wi-Fi), puis Actualiser.
            Choisis un lecteur « En ligne ».
          </p>
        </IonLabel>
      </IonItem>
      <div style={{ padding: '0 12px' }}>
        <IonSegment value={filter} onIonChange={(e) => setFilter(String(e.detail.value) as Filter)}>
          <IonSegmentButton value="all">
            <IonLabel>Tous</IonLabel>
          </IonSegmentButton>
          <IonSegmentButton value="online">
            <IonLabel>En ligne</IonLabel>
          </IonSegmentButton>
          <IonSegmentButton value="firetv">
            <IonLabel>Fire TV</IonLabel>
          </IonSegmentButton>
        </IonSegment>
      </div>
      <IonList>
        {shown.map((p) => {
          const presence = presenceLabel(p);
          const isManual = p.source.includes('manual');
          return (
            <IonItem key={p.id} button onClick={() => onSelect(p)}>
              <IonLabel>
                <h2>{p.name || 'Lecteur Plex'}</h2>
                <p style={{ whiteSpace: 'normal' }}>{p.displayName}</p>
                <p>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{presence.text}</span>
                  {p.presence === false && (
                    <span style={{ fontSize: 12, opacity: 0.8 }}> — ouvre l’app Plex pour le réveiller</span>
                  )}
                </p>
              </IonLabel>
              <IonBadge color={presence.color as never} slot="end">
                {presence.text}
              </IonBadge>
              {isManual && onRemoveManual && (
                <IonButton
                  fill="clear"
                  size="small"
                  slot="end"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.baseURL) onRemoveManual(p.baseURL);
                  }}
                >
                  Retirer
                </IonButton>
              )}
            </IonItem>
          );
        })}
        {shown.length === 0 && (
          <IonItem lines="none">
            <IonLabel>
              <p style={{ whiteSpace: 'normal' }}>
                {filter === 'firetv'
                  ? 'Aucune Fire TV dans la liste. Passe en « Tous », ouvre Plex sur la TV puis Actualiser.'
                  : 'Aucun lecteur détecté. Ouvre Plex sur ta Fire TV, vérifie le même compte Plex et le même réseau Wi-Fi, puis Actualiser.'}
              </p>
            </IonLabel>
          </IonItem>
        )}
      </IonList>
      {onAddManual && (
        <div style={{ padding: '8px 12px 16px' }}>
          <IonItem lines="none">
            <IonLabel>
              <p style={{ whiteSpace: 'normal' }}>
                <strong>Fire TV introuvable ?</strong> Ajoute-la par son IP (Réglages réseau de la Fire TV, ex 192.168.10.50).
              </p>
            </IonLabel>
          </IonItem>
          <div style={{ display: 'flex', gap: 8 }}>
            <IonInput
              label="IP Fire TV"
              labelPlacement="stacked"
              placeholder="192.168.10.50"
              value={manualHost}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              onIonInput={(e) => setManualHost(String(e.detail.value ?? ''))}
            />
            <IonInput
              label="Port"
              labelPlacement="stacked"
              placeholder="32500"
              value={manualPort}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              style={{ maxWidth: 110 }}
              onIonInput={(e) => setManualPort(String(e.detail.value ?? ''))}
            />
            <IonButton
              disabled={!manualHost.trim() || refreshing}
              onClick={() => onAddManual(manualHost.trim(), manualPort.trim() || '32500')}
              style={{ alignSelf: 'end' }}
            >
              Ajouter
            </IonButton>
          </div>
        </div>
      )}
    </IonContent>
  </IonModal>
  );
};

export default PlayerPicker;
