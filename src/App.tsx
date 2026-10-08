import React, { useEffect } from 'react';
import { IonApp, IonRouterOutlet, IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Redirect, Route } from 'react-router-dom';
import { globeOutline, arrowDownCircleOutline, layersOutline, compassOutline, notificationsOutline, libraryOutline } from 'ionicons/icons';

import SiteTab from './pages/SiteTab';
import TransmissionTab from './pages/TransmissionTab';
import PlexTab from './pages/PlexTab';
import FilmsTab from './pages/FilmsTab';
import BrowserTab from './pages/BrowserTab';
import SeriesWatchTab, { runLaunchCheck } from './pages/SeriesWatchTab';

/**
 * Base du routeur selon l'hébergement : la PWA est servie sous
 * /download-manager/ (sans rewrite serveur), donc les routes /films…
 * ne matcheraient jamais sans basename. Natif (capacitor://) et Electron
 * (file://) gardent une base vide (comportement inchangé).
 */
function routerBasename(): string | undefined {
  try {
    const p = window.location.protocol;
    if (p !== 'http:' && p !== 'https:') return undefined;
    return /^\/download-manager(\/|$)/.test(window.location.pathname) ? '/download-manager' : undefined;
  } catch {
    return undefined;
  }
}

const App: React.FC = () => {
  // Suivi de séries : vérification silencieuse au lancement (throttle 6 h).
  useEffect(() => {
    void runLaunchCheck();
  }, []);
  return (
    <IonApp>
      <IonReactRouter basename={routerBasename()}>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/films">
              <FilmsTab />
            </Route>
            <Route exact path="/plex">
              <PlexTab />
            </Route>
            <Route exact path="/transmission">
              <TransmissionTab />
            </Route>
            <Route exact path="/site">
              <SiteTab />
            </Route>
            <Route exact path="/browser">
              <BrowserTab />
            </Route>
            <Route exact path="/watch">
              <SeriesWatchTab />
            </Route>
            <Route exact path="/">
              <Redirect to="/films" />
            </Route>
          </IonRouterOutlet>
          <IonTabBar slot="bottom">
            <IonTabButton tab="films" href="/films">
              <IonIcon icon={libraryOutline} />
              <IonLabel>Catalogue</IonLabel>
            </IonTabButton>
            <IonTabButton tab="plex" href="/plex">
              <IonIcon icon={layersOutline} />
              <IonLabel>Plex</IonLabel>
            </IonTabButton>
            <IonTabButton tab="transmission" href="/transmission">
              <IonIcon icon={arrowDownCircleOutline} />
              <IonLabel>Transmission</IonLabel>
            </IonTabButton>
            <IonTabButton tab="site" href="/site">
              <IonIcon icon={globeOutline} />
              <IonLabel>Site</IonLabel>
            </IonTabButton>
            <IonTabButton tab="browser" href="/browser">
              <IonIcon icon={compassOutline} />
              <IonLabel>Navigateur</IonLabel>
            </IonTabButton>
            <IonTabButton tab="watch" href="/watch">
              <IonIcon icon={notificationsOutline} />
              <IonLabel>Suivis</IonLabel>
            </IonTabButton>
          </IonTabBar>
        </IonTabs>
      </IonReactRouter>
    </IonApp>
  );
};

export default App;
