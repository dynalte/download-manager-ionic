import React from 'react';
import { IonApp, IonRouterOutlet, IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Redirect, Route } from 'react-router-dom';
import { globeOutline, arrowDownCircleOutline, layersOutline, compassOutline } from 'ionicons/icons';

import SiteTab from './pages/SiteTab';
import TransmissionTab from './pages/TransmissionTab';
import PlexTab from './pages/PlexTab';
import BrowserTab from './pages/BrowserTab';

const App: React.FC = () => (
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
          <Route exact path="/browser">
            <BrowserTab />
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
          <IonTabButton tab="browser" href="/browser">
            <IonIcon icon={compassOutline} />
            <IonLabel>Navigateur</IonLabel>
          </IonTabButton>
        </IonTabBar>
      </IonTabs>
    </IonReactRouter>
  </IonApp>
);

export default App;
