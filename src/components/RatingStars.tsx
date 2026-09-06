import React from 'react';
import { IonIcon } from '@ionic/react';
import { star, starOutline } from 'ionicons/icons';

interface Props {
  /** Note sur 5 (ex: 4,2). */
  value: number;
  size?: number;
}

/** 5 étoiles avec remplissage fractionnaire (façon Allociné). */
const RatingStars: React.FC<Props> = ({ value, size = 18 }) => {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span className="rating-stars" style={{ fontSize: size }} aria-label={`${value}/5`}>
      <span className="rs-bg">
        {[0, 1, 2, 3, 4].map((i) => (
          <IonIcon key={i} icon={starOutline} />
        ))}
      </span>
      <span className="rs-fg" style={{ width: `${pct}%` }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <IonIcon key={i} icon={star} />
        ))}
      </span>
    </span>
  );
};

export default RatingStars;
