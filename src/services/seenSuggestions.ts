/**
 * Suggestions IA marquées « déjà vu » par l'utilisateur.
 * Stockage : localStorage (même pattern que les slugs « Ajouté » TR4KER),
 * synchrone et suffisant pour quelques centaines de titres.
 * Les clés normalisées alimentent l'exclusion Gemini (prompt + filtre).
 */

export interface SeenSuggestion {
  /** Titre d'affichage original. */
  t: string;
  y?: string;
  at: number;
}

const SEEN_KEY = 'seen_suggestions_v1';
const SEEN_MAX = 500;

/** Même normalisation que l'anti-doublon Gemini (accents, casse, ponctuation). */
export function seenNorm(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function seenKeyFor(title: string): string {
  return seenNorm(title);
}

export function loadSeenSuggestions(): SeenSuggestion[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SeenSuggestion[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s && typeof s.t === 'string' && s.t.trim() !== '').slice(0, SEEN_MAX);
  } catch {
    return [];
  }
}

export function seenKeys(list: SeenSuggestion[]): Set<string> {
  return new Set(list.map((s) => seenKeyFor(s.t)));
}

function saveSeen(list: SeenSuggestion[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(0, SEEN_MAX)));
  } catch {
    /* stockage indisponible */
  }
}

/** Marque un titre comme déjà vu (en tête, dédupliqué, plafonné). Retourne la liste à jour. */
export function markSeenSuggestion(title: string, year?: string): SeenSuggestion[] {
  const t = (title || '').trim();
  if (!t) return loadSeenSuggestions();
  const key = seenKeyFor(t);
  const prev = loadSeenSuggestions().filter((s) => seenKeyFor(s.t) !== key);
  const next: SeenSuggestion[] = [{ t, y: (year || '').trim() || undefined, at: Date.now() }, ...prev].slice(0, SEEN_MAX);
  saveSeen(next);
  return next;
}

export function clearSeenSuggestions(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* ignore */
  }
}
