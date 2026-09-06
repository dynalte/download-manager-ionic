/**
 * Wrapper du plugin natif InlineBrowser (iOS uniquement).
 *
 * Affiche TR4KER dans une WKWebView positionnée sur le conteneur de
 * l'onglet Site, au lieu d'une modale plein écran par-dessus l'app.
 * Les messages de l'intercepteur JS (INTERCEPTOR_WKWEBVIEW_JS) arrivent
 * via l'event "browserMessage", les navigations magnet:/.torrent via
 * "urlChange", chaque fin de chargement via "load".
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface InlineBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InlineBrowserState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface UrlChangeEvent {
  url: string;
  /** 'magnet' | 'torrent' */
  navigation: string;
}

export interface InlineBrowserPlugin {
  open(options: { url: string } & InlineBrowserRect): Promise<void>;
  setRect(options: InlineBrowserRect): Promise<void>;
  loadUrl(options: { url: string }): Promise<void>;
  goBack(): Promise<InlineBrowserState>;
  goForward(): Promise<InlineBrowserState>;
  reload(): Promise<void>;
  executeScript(options: { code: string }): Promise<void>;
  close(): Promise<void>;
  addListener(
    eventName: 'browserMessage',
    listenerFunc: (msg: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'urlChange',
    listenerFunc: (state: UrlChangeEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'load',
    listenerFunc: (state: InlineBrowserState) => void,
  ): Promise<PluginListenerHandle>;
}

export const InlineBrowser = registerPlugin<InlineBrowserPlugin>('InlineBrowser');
