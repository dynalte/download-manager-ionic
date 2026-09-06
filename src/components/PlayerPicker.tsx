import React from 'react';
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
} from '@ionic/react';
import type { PlexPlayerTarget } from '../services/plex';

interface Props {
  isOpen: boolean;
  title: string;
  players: PlexPlayerTarget[];
  onCancel: () => void;
  onSelect: (player: PlexPlayerTarget) => void;
}

const PlayerPicker: React.FC<Props> = ({ isOpen, title, players, onCancel, onSelect }) => (
  <IonModal isOpen={isOpen} onDidDismiss={onCancel}>
    <IonHeader>
      <IonToolbar>
        <IonTitle>Choisir un lecteur</IonTitle>
        <IonButtons slot="end">
          <IonButton onClick={onCancel}>Fermer</IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>
    <IonContent>
      <IonItem lines="none">
        <IonLabel>
          <p style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
        </IonLabel>
      </IonItem>
      <IonList>
        {players.map((p) => (
          <IonItem key={p.id} button onClick={() => onSelect(p)}>
            <IonLabel>
              <h2>{p.name || 'Lecteur Plex'}</h2>
              <p>{p.displayName}</p>
            </IonLabel>
          </IonItem>
        ))}
      </IonList>
    </IonContent>
  </IonModal>
);

export default PlayerPicker;
