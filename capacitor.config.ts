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
  },
};

export default config;
