import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.tr4ker.downloadmanager',
  appName: 'Download Manager',
  webDir: 'dist',
  server: {
    // Autorise la navigation vers TR4KER / Plex / Transmission.
    // En dev, Capacitor autorise http local ; en prod le WebView charge dist/.
    allowNavigation: [
      'tr4ker.net',
      '*.tr4ker.net',
      'www.allocine.fr',
      'photos2.dynaspirit.com',
    ],
    cleartext: true,
    // L'app parle à des services en http:// (Transmission, Plex, synchro).
    // Avec le scheme https par défaut, la WebView bloque ces appels en
    // "mixed content" (Failed to fetch) malgré usesCleartextTraffic.
    // En http, http://localhost reste un contexte sécurisé et les appels
    // http:// redeviennent même-scheme. iOS non concerné (iosScheme séparé).
    androidScheme: 'http',
  },
};

export default config;
