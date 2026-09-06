/**
 * Notes Allociné automatiques (exe Windows uniquement).
 * Le renderer calcule la requête nettoyée (même logique que le bouton
 * Allociné) ; le processus main interroge l'autocomplete public + la fiche
 * SSR (pas de CORS côté main) avec cache 30 jours.
 */
import { buildAllocineQuery } from './torrentScripts';

export interface AllocineRatings {
  title: string;
  year: string;
  url: string;
  press: number | null;
  pressReviews: number | null;
  spectators: number | null;
  votes: number | null;
}

export async function fetchAllocineRatings(rawTitle: string, year?: number | string | null): Promise<AllocineRatings | null> {
  const d = typeof window !== 'undefined' ? window.desktop : undefined;
  if (!d?.isElectron || typeof d.allocineRatings !== 'function') return null;
  const query = buildAllocineQuery(rawTitle);
  if (!query) return null;
  try {
    const r = await d.allocineRatings({ query, year: year ?? undefined });
    if (!r || (r.press == null && r.spectators == null)) return null;
    return {
      title: String(r.title || ''),
      year: String(r.year || ''),
      url: String(r.url || ''),
      press: r.press ?? null,
      pressReviews: r.pressReviews ?? null,
      spectators: r.spectators ?? null,
      votes: r.votes ?? null,
    };
  } catch {
    return null;
  }
}

/** 4.2 -> "4,2" (format français Allociné). */
export function formatAllocineNote(v: number): string {
  return v.toFixed(1).replace('.', ',');
}
