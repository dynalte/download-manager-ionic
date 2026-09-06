import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';
/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
/* Optional CSS utils */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';

/* Palette sombre Ionic (activée par classe via src/services/theme.ts) */
import '@ionic/react/css/palettes/dark.class.css';

import './theme/variables.css';

import { setupIonicReact } from '@ionic/react';
import { applyTheme, watchSystemTheme } from './services/theme';

setupIonicReact({ mode: 'ios' });

// Appliqué avant le rendu pour éviter tout flash clair/sombre.
applyTheme();
watchSystemTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
