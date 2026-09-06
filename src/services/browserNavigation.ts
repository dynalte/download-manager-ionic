/**
 * Navigation inter-onglets vers le Navigateur intégré.
 * requestBrowserOpen(url) mémorise l'URL et émet un événement :
 * - si l'onglet Navigateur est déjà monté, il navigue aussitôt ;
 * - sinon il consomme l'URL mémorisée à son montage.
 */
const EVENT = 'app:open-in-browser';

let pendingUrl: string | null = null;

export function requestBrowserOpen(url: string): void {
  pendingUrl = url;
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { url } }));
  } catch {
    /* ignore */
  }
}

export function consumePendingBrowserUrl(): string | null {
  const u = pendingUrl;
  pendingUrl = null;
  return u;
}

export function subscribeBrowserOpen(cb: (url: string) => void): () => void {
  const fn = (e: Event) => {
    const url = (e as CustomEvent<{ url?: string }>).detail?.url;
    if (url) cb(url);
  };
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
