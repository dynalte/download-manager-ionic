/**
 * Notes Allociné automatiques (exe Windows + natif mobile).
 * - Exe : le processus main interroge l'autocomplete public + la fiche
 *   SSR (pas de CORS côté main) avec cache 30 jours.
 * - iOS/Android : même chaîne via CapacitorHttp (requêtes natives
 *   URLSession/OkHttp, non soumises au CORS de la WebView qui bloque
 *   fetch vers allocine.fr) avec cache mémoire + Preferences 30 jours.
 * - Web : indisponible (CORS), retourne null.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { buildAllocineQuery } from './torrentScripts';

export interface AllocineRatings {
  title: string;
  year: string;
  url: string;
  press: number | null;
  pressReviews: number | null;
  spectators: number | null;
  votes: number | null;
  /** Affiche de la fiche (og:image). Absent des entrées de cache v2. */
  posterURL?: string | null;
  /** Synopsis (JSON-LD puis og:description). Absent des entrées de cache v2. */
  synopsis?: string | null;
}

const ALLOCINE_TTL = 30 * 24 * 3600 * 1000;
const ALLOCINE_CACHE_KEY = 'allocine-ratings-cache-v3';
const ALLOCINE_CACHE_MAX = 500;

const nativeCache = new Map<string, { at: number; data: AllocineRatings }>();
let nativeCacheLoaded = false;

async function loadNativeCache(): Promise<void> {
  if (nativeCacheLoaded) return;
  nativeCacheLoaded = true;
  try {
    const { value } = await Preferences.get({ key: ALLOCINE_CACHE_KEY });
    if (!value) return;
    const obj = JSON.parse(value) as Record<string, { at: number; data: AllocineRatings }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && v.data) nativeCache.set(k, v);
    }
  } catch {
    /* premier lancement */
  }
}

function saveNativeCache(): void {
  try {
    const obj: Record<string, { at: number; data: AllocineRatings }> = {};
    for (const [k, v] of nativeCache) obj[k] = v;
    void Preferences.set({ key: ALLOCINE_CACHE_KEY, value: JSON.stringify(obj) }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function parseAllocineNote(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const v = parseFloat(String(raw).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > 5) return null;
  return Math.round(v * 10) / 10;
}

function parseAllocineVotes(txt: unknown): number | null {
  const m = /([\d\s]+)/.exec(String(txt ?? ''));
  if (!m) return null;
  const n = parseInt(m[1].replace(/\s/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** Décode les entités HTML (pas de DOM dispo partout : regex uniquement). */
function decodeHtmlEntities(s: string): string {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n: string) => {
      const c = parseInt(n, 10);
      return Number.isFinite(c) ? String.fromCharCode(c) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…');
}

function metaContent(html: string, property: string): string | null {
  const re1 = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
  const m = re1.exec(html) || re2.exec(html);
  return m ? m[1].trim() : null;
}

/** Affiche de la fiche (og:image), en écartant logos et images génériques. */
function parseAllocinePoster(html: string): string | null {
  const url = metaContent(html, 'og:image');
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (/logo/i.test(url)) return null;
  return url;
}

/** Synopsis : JSON-LD (schéma Movie/TVSeries) puis og:description. */
function parseAllocineSynopsis(html: string): string | null {
  const clean = (s: string): string | null => {
    const txt = decodeHtmlEntities(s).replace(/\s+/g, ' ').trim();
    if (txt.length < 40) return null;
    // Écarte les descriptions génériques du site (pas un synopsis).
    if (/allocin[ée].*(bandes-annonces|cinéma|films à l'affiche|séries du moment)/i.test(txt)) return null;
    return txt;
  };
  const ld = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  if (ld) {
    try {
      const txt = clean(JSON.parse(`"${ld[1]}"`) as string);
      if (txt) return txt;
    } catch {
      /* JSON invalide : suite */
    }
  }
  const og = metaContent(html, 'og:description');
  if (og) {
    const txt = clean(og);
    if (txt) return txt;
  }
  return null;
}

interface AllocineCandidate {
  entity_type?: string;
  entity_id?: number | string;
  label?: string;
  original_label?: string;
  data?: { year?: string | number };
}

function allocineNorm(s: unknown): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// L'autocomplete peut renvoyer en tête une promo sans rapport (même année).
// On score : ressemblance du titre + bonus millésime Plex. Repli : ancien
// comportement si rien ne ressemble.
function pickAllocineCandidate(cands: AllocineCandidate[], query: string, year?: number | string | null): AllocineCandidate {
  const q = allocineNorm(query);
  const wantYear = year !== undefined && year !== null ? String(year).trim() : '';
  let best: AllocineCandidate | null = null;
  let bestScore = 0;
  for (const r of cands) {
    // Score du meilleur libellé (pas de cumul : un titre approché
    // label + original ne doit pas battre un match exact).
    const labels = [r.label, r.original_label].map(allocineNorm).filter(Boolean);
    let t = 0;
    for (const n of labels) {
      let s = 0;
      if (n === q) s = 100;
      else if (n.startsWith(q) || q.startsWith(n)) s = 60;
      else if (n.includes(q) || q.includes(n)) s = 30;
      if (s > t) t = s;
    }
    if (wantYear && r.data && String(r.data.year || '') === wantYear) t += 25;
    if (t > bestScore) {
      bestScore = t;
      best = r;
    }
  }
  if (best) return best;
  let fallback = cands[0];
  if (wantYear) {
    const same = cands.find((r) => r.data && String(r.data.year || '') === wantYear);
    if (same) fallback = same;
  }
  return fallback;
}

/** GET natif (pas de CORS) ; rejette si statut non 2xx. */
async function nativeGet(url: string, timeoutMs: number): Promise<unknown> {
  const res = await CapacitorHttp.get({
    url,
    headers: { Accept: 'text/html,application/json', 'Accept-Language': 'fr-FR,fr;q=0.9' },
    responseType: 'text',
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.data;
}

/**
 * Portage de allocineRatingsFor (electron/main.cjs) pour le natif mobile :
 * autocomplete public -> fiche film/série SSR -> notes presse/spectateurs.
 */
async function nativeAllocineRatings(query: string, year?: number | string | null): Promise<AllocineRatings | null> {
  const key = `${query.trim().toLowerCase()}|${String(year ?? '').trim()}`;
  const now = Date.now();
  await loadNativeCache();
  const hit = nativeCache.get(key);
  if (hit && now - hit.at < ALLOCINE_TTL) return hit.data;
  let data: AllocineRatings | null = null;
  // 2 tentatives : un raté réseau ponctuel ne doit pas priver durablement
  // un film de ses notes (aucun retry visible côté UI).
  for (let attempt = 0; attempt < 2 && data === null; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 1500));
    try {
      data = await fetchAllocineRatingsAttempt(query, year);
    } catch {
      /* nouvel essai puis repli cache */
    }
  }
  if (data === null) {
    return (hit && hit.data) || null; // repli : cache périmé plutôt que rien
  }
  nativeCache.set(key, { at: now, data });
  if (nativeCache.size > ALLOCINE_CACHE_MAX) {
    const first = nativeCache.keys().next();
    if (!first.done) nativeCache.delete(first.value);
  }
  saveNativeCache();
  return data;
}

/** Une tentative réseau + parsing (levée en cas d'échec, pour retry). */
async function fetchAllocineRatingsAttempt(query: string, year?: number | string | null): Promise<AllocineRatings> {
  const raw = await nativeGet(`https://www.allocine.fr/_/autocomplete/${encodeURIComponent(query.trim())}`, 12000);
  const ac = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { results?: AllocineCandidate[] };
  const cands = ((ac && ac.results) || []).filter((r) => r && (r.entity_type === 'movie' || r.entity_type === 'series'));
  if (cands.length === 0) throw new Error('no result');
  // Meilleur candidat : ressemblance titre + millésime Plex (homonymes, remakes, promos).
  const best = pickAllocineCandidate(cands, query, year);
  const id = best.entity_id;
  const pageUrl =
    best.entity_type === 'series'
      ? `https://www.allocine.fr/series/ficheserie_gen_cserie=${id}.html`
      : `https://www.allocine.fr/film/fichefilm_gen_cfilm=${id}.html`;
  const htmlRaw = await nativeGet(pageUrl, 15000);
  const html = typeof htmlRaw === 'string' ? htmlRaw : String(htmlRaw ?? '');
  let press: number | null = null;
  let pressReviews: number | null = null;
  let spectators: number | null = null;
  let votes: number | null = null;
  const re =
    /stareval-small[\s\S]{0,500}?stareval-note">([^<]+)<\/span><span class="stareval-review light">\s*([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const val = parseAllocineNote(m[1]);
    const txt = (m[2] || '').trim();
    if (val === null) continue;
    if (/notes/i.test(txt)) {
      if (spectators === null) {
        spectators = val;
        votes = parseAllocineVotes(txt);
      }
    } else if (/critiques/i.test(txt)) {
      if (press === null) {
        press = val;
        pressReviews = parseAllocineVotes(txt);
      }
    }
    if (press !== null && spectators !== null) break;
  }
  if (spectators === null) {
    const ld = /"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*"([\d.]+)"[^}]*"ratingCount"\s*:\s*"(\d+)"/.exec(html);
    if (ld) {
      spectators = parseAllocineNote(ld[1]);
      const n = parseInt(ld[2], 10);
      votes = Number.isFinite(n) ? n : null;
    }
  }
    // Affiche + synopsis même sans notes (la fiche Films les veut dans tous
    // les cas) : on ne jette que si la page n'a rien livré du tout.
    const posterURL = parseAllocinePoster(html);
    const synopsis = parseAllocineSynopsis(html);
    if (press === null && spectators === null && posterURL === null && synopsis === null) {
      throw new Error('no rating');
    }
    return {
      title: best.label || best.original_label || '',
      year: String((best.data && best.data.year) || ''),
      url: pageUrl,
      press,
      pressReviews,
      spectators,
      votes,
      posterURL,
      synopsis,
    };
  }

export async function fetchAllocineRatings(rawTitle: string, year?: number | string | null): Promise<AllocineRatings | null> {
  const query = buildAllocineQuery(rawTitle);
  if (!query) return null;
  // 1) Exe Windows : scraping côté main.
  const d = typeof window !== 'undefined' ? window.desktop : undefined;
  if (d?.isElectron && typeof d.allocineRatings === 'function') {
    try {
      const r = await d.allocineRatings({ query, year: year ?? undefined });
      if (!r || (r.press == null && r.spectators == null && r.posterURL == null && r.synopsis == null)) return null;
      return {
        title: String(r.title || ''),
        year: String(r.year || ''),
        url: String(r.url || ''),
        press: r.press ?? null,
        pressReviews: r.pressReviews ?? null,
        spectators: r.spectators ?? null,
        votes: r.votes ?? null,
        posterURL: r.posterURL ?? null,
        synopsis: r.synopsis ?? null,
      };
    } catch {
      return null;
    }
  }
  // 2) Natif mobile : même chaîne via requêtes natives (pas de CORS).
  if (Capacitor.isNativePlatform()) {
    try {
      return await nativeAllocineRatings(query, year);
    } catch {
      return null;
    }
  }
  // 3) Web : CORS bloque allocine.fr.
  return null;
}

/** 4.2 -> "4,2" (format français Allociné). */
export function formatAllocineNote(v: number): string {
  return v.toFixed(1).replace('.', ',');
}
