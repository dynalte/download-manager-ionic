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
  IonBadge,
  IonText,
} from '@ionic/react';
import {
  DESTINATION_FOLDERS,
  folderDisplayName,
  transmissionPath,
  type DestinationFolder,
} from '../services/settings';
import { predictedFolder, type PendingPayload } from '../services/destinationPredictor';

interface Props {
  isOpen: boolean;
  payload: PendingPayload | null;
  onCancel: () => void;
  onSelect: (folder: DestinationFolder) => void;
}

const FolderSheet: React.FC<Props> = ({ isOpen, payload, onCancel, onSelect }) => {
  const predicted = payload ? predictedFolder(payload) : null;
  const label = payload
    ? payload.kind === 'torrent'
      ? payload.filename || payload.sourceURL
      : payload.magnetURL
    : '';
  return (
    <IonModal isOpen={isOpen} onDidDismiss={onCancel} breakpoints={[0, 0.6, 1]} initialBreakpoint={0.6}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Dossier de destination</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onCancel}>Annuler</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList>
          <IonItem>
            <IonLabel>
              <h2>Fichier</h2>
              <IonText color="medium">
                <p style={{ wordBreak: 'break-all' }}>{label}</p>
              </IonText>
            </IonLabel>
          </IonItem>
          {DESTINATION_FOLDERS.map((folder) => (
            <IonItem key={folder} button onClick={() => onSelect(folder)}>
              <IonLabel>
                <h2>{folderDisplayName[folder]}</h2>
                <p>{transmissionPath(folder)}</p>
              </IonLabel>
              {folder === predicted && <IonBadge color="success">Recommande</IonBadge>}
            </IonItem>
          ))}
        </IonList>
      </IonContent>
    </IonModal>
  );
};

export default FolderSheet;
