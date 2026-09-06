# Download Manager — Ionic React

Clone Ionic React de l'application iOS SwiftUI `download-manager`.

## Fonctionnalités (parité avec l'app iOS)

| iOS (SwiftUI) | Ionic React |
|---|---|
| `ContentView` — 4 onglets | `src/App.tsx` — `IonTabs` : Site / Transmission / Plex / Navigateur |
| `SiteTabView` + `WebView.swift` (TR4KER, interception torrent/magnet, credentials, bouton Allociné) | `src/pages/SiteTab.tsx` + `src/services/torrentScripts.ts` : iframe TR4KER + ajout manuel lien/fichier + prédiction dossier + bouton Allociné |
| `TransmissionDownloadsView` (filtres, progression, suppression, labels Plex vu/non-vu, poll auto, pull-to-refresh) | `src/pages/TransmissionTab.tsx` |
| `PlexLibrariesView` (filtres Tous/Films/Series, Vus/Non vus, Liste/Grille, détail, saisons, épisodes, player picker, lecture distante) | `src/pages/PlexTab.tsx` |
| `ExternalBrowserTabView` (back/forward/reload/share/open) | `src/pages/BrowserTab.tsx` |
| `AppSettingsView` + `AppSettings` + `AppConfig` | `src/components/SettingsModal.tsx` + `src/services/settings.ts` + `src/config/appConfig.ts` |
| `TorrentUploadService` (RPC + session-id) | `src/services/transmission.ts` |
| `PlexService` (sections, bibliothèques, saisons, épisodes, players, play, refresh, link records, cloud discovery) | `src/services/plex.ts` |
| `DestinationFolderPredictor` | `src/services/destinationPredictor.ts` |
| `DownloadCompletionMonitor` (notifications) | `src/services/completionMonitor.ts` (Capacitor LocalNotifications) |
| `CredentialsStore` (Keychain) | `src/services/credentials.ts` (Capacitor Preferences) |

## Différence assumée : WebView

Sur iOS, `WKWebView` permet d'intercepter nativement les clics/fetch `.torrent`
et les magnets. En Ionic web, l'iframe `tr4ker.net` est **cross-origin** : le JS
ne peut pas y être injecté. L'onglet Site affiche donc le site + propose :
1. coller un lien `.torrent` / `magnet:` → téléchargement → choix du dossier
   (avec prédiction auto Films/Series/Musique comme sur iOS) → envoi Transmission ;
2. picker de fichier `.torrent` ;
3. champ titre → bouton « Ouvrir Allocine » (même nettoyage de titre que le script iOS).

Les scripts d'origine sont conservés dans `torrentScripts.ts` pour un WebView
natif Capacitor (ex. plugin Browser personnalisé avec bridge).

## Configuration

Écran Réglages (icône ⚙️ dans Transmission et Plex), ou `localStorage` :
- URL RPC Transmission (défaut `http://photos2.dynaspirit.com:9091/transmission/rpc`)
- login / mot de passe Transmission
- dossiers Films / Series / Musique (`download-dir`)
- URL Plex + token + IDs sections + mode cloud
- notifications + intervalle de refresh

## Lancer

```bash
npm install
npm run dev      # http://localhost:8100
npm run build    # dist/
npx cap sync     # iOS / Android (webDir: dist)
```

## Notes réseau

- Transmission en `http://` : prévoir `cleartext: true` (déjà dans `capacitor.config.ts`)
  et une exception ATS côté iOS / `usesCleartextTraffic` côté Android.
- Plex / Transmission distants : si CORS bloque le navigateur, tester via
  `npx cap open ios` (le WebView natif n'applique pas les mêmes restrictions
  que le dev-server) ou via un petit proxy.
