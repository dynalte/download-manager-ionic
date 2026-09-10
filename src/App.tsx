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

const App: React.FC = () => {
  // Suivi de séries : vérification silencieuse au lancement (throttle 6 h).
  useEffect(() => {
    void runLaunchCheck();
  }, []);
  return (
    <IonApp>
      <IonReactRouter>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/site">
              <SiteTab />
            </Route>
            <Route exact path="/transmission">
              <TransmissionTab />
            </Route>
            <Route exact path="/plex">
              <PlexTab />
            </Route>
            <Route exact path="/films">
              <FilmsTab />
            </Route>
            <Route exact path="/browser">
              <BrowserTab />
            </Route>
            <Route exact path="/watch">
              <SeriesWatchTab />
            </Route>
            <Route exact path="/">
              <Redirect to="/site" />
            </Route>
          </IonRouterOutlet>
          <IonTabBar slot="bottom">
            <IonTabButton tab="site" href="/site">
              <IonIcon icon={globeOutline} />
              <IonLabel>Site</IonLabel>
            </IonTabButton>
            <IonTabButton tab="transmission" href="/transmission">
              <IonIcon icon={arrowDownCircleOutline} />
              <IonLabel>Transmission</IonLabel>
            </IonTabButton>
            <IonTabButton tab="plex" href="/plex">
              <IonIcon icon={layersOutline} />
              <IonLabel>Plex</IonLabel>
            </IonTabButton>
            <IonTabButton tab="films" href="/films">
              <IonIcon icon={libraryOutline} />
              <IonLabel>Catalogue</IonLabel>
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
