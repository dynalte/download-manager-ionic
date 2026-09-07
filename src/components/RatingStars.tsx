import React from 'react';
import { IonIcon } from '@ionic/react';
import { star } from 'ionicons/icons';

interface Props {
  /** Note sur 5 (ex: 4,2). */
  value: number;
  size?: number;
}

/** 5 étoiles avec remplissage fractionnaire (façon Allociné).
    Rognage par étoile (pas par rangée) : aucun décalage cumulé possible,
    chaque étoile jaune est calée sur sa jumelle grise. */
const RatingStars: React.FC<Props> = ({ value, size = 18 }) => {
  const v = Math.max(0, Math.min(5, value));
  return (
    <span className="rating-stars" style={{ fontSize: size }} aria-label={`${value}/5`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, v - i));
        return (
          <span key={i} className="rs-one">
            <IonIcon icon={star} className="rs-one-bg" />
            <span className="rs-one-fg" style={{ width: `${fill * 100}%` }}>
              <IonIcon icon={star} />
            </span>
          </span>
        );
      })}
    </span>
  );
};

export default RatingStars;
