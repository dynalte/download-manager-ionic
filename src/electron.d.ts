/** Pont Electron exposé par electron/preload.cjs (fenêtre principale uniquement). */
export interface DesktopTr4kerMagnet {
  url: string;
  pageURL: string;
}

export interface DesktopTr4kerTorrentBytes {
  bytesBase64: string;
  filename: string;
  sourceURL: string;
  pageURL: string;
}

export interface DesktopTr4kerTorrentUrl {
  url: string;
  pageURL: string;
}

export interface DesktopBridge {
  platform: string;
  isElectron: boolean;
  openTr4ker: (url?: string) => Promise<{ opened: boolean }>;
  closeTr4ker: () => Promise<{ closed: boolean }>;
  onTr4kerMagnet: (cb: (p: DesktopTr4kerMagnet) => void) => () => void;
  onTr4kerTorrentBytes: (cb: (p: DesktopTr4kerTorrentBytes) => void) => () => void;
  onTr4kerTorrentUrl: (cb: (p: DesktopTr4kerTorrentUrl) => void) => () => void;
  onTr4kerClosed: (cb: () => void) => () => void;
  /** Chemin du preload minimal de la <webview> TR4KER inline. */
  getTr4kerPreloadPath: () => Promise<string>;
  /** Attache will-download (main) à la session d'une <webview> TR4KER. */
  attachTr4kerDownloads: (contentsId: number) => Promise<{ attached: boolean }>;
  /** Appel RPC Transmission via le main (sans CORS). */
  transmissionRpc: (args: {
    url: string;
    username: string;
    password: string;
    payload: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
}

/** Message posté par le script invité TR4KER (page distante). */
export interface Tr4kerGuestMessage {
  type: 'tr4ker-magnet' | 'tr4ker-torrent-bytes' | 'tr4ker-torrent-url';
  url?: string;
  bytesBase64?: string;
  filename?: string;
  sourceURL?: string;
  pageURL?: string;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

// Balise Electron <webview> (rendu inline du site distant, pas une iframe).
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webview: any;
    }
  }
}

export {};
