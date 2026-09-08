/**
 * Recommandations films/séries via l'API Gemini, basées sur la librairie Plex.
 *
 * - Clé API : Google AI Studio (https://aistudio.google.com/apikey), stockée
 *   dans les Réglages (settings.geminiApiKey).
 * - Endpoint : generativelanguage.googleapis.com (CORS OK, fetch direct
 *   depuis WebView / web / Electron).
 * - Réponse attendue : JSON strict { recommendations: [...] } parsé avec
 *   extraction tolérante (blocs ```json, texte autour).
 */

export interface GeminiLibraryEntry {
  title: string;
  year?: string;
  /** 'movie' | 'show' (type Plex normalisé : movie/show) */
  type: string;
  isWatched?: boolean;
}

export type GeminiMediaType = 'movie' | 'series' | 'unknown';

export interface GeminiRecommendation {
  title: string;
  year?: string;
  type: GeminiMediaType;
  /** Pourquoi ce choix colle à la collection (1-2 phrases). */
  reason: string;
}

export interface GeminiSuggestOptions {
  /** Nombre de propositions demandées (défaut 10). */
  count?: number;
  /** Restreint les propositions : 'all' | 'movies' | 'series'. */
  want?: 'all' | 'movies' | 'series';
  /** Modèle Gemini (défaut gemini-2.5-flash, rapide et pas cher). */
  model?: string;
  /** Langue de la réponse (défaut français). */
  language?: string;
}

/** Modèle par défaut (stable, large dispo). */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
/** Modèles retirés par Google → bascule auto vers le défaut. */
export const RETIRED_GEMINI_MODELS = new Set([
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-pro',
]);
/** Ordre d'essai si le modèle demandé répond 404 (retiré / renommé). */
const GEMINI_MODEL_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash'];
const GEMINI_TIMEOUT_MS = 60000;
const MAX_TITLES_IN_PROMPT = 400;

export class GeminiError extends Error {}

function normalizeType(t: string): string {
  const v = (t || '').toLowerCase();
  if (v === 'movie') return 'Film';
  if (v === 'show' || v === 'series') return 'Série';
  return v || '?';
}

/** Déduplique + tronque la collection pour tenir dans le prompt. */
export function summarizeLibraryForPrompt(entries: GeminiLibraryEntry[]): string {
  const seen = new Set<string>();
  const movies: string[] = [];
  const shows: string[] = [];
  for (const e of entries) {
    const title = (e.title || '').trim();
    if (!title) continue;
    const key = `${(e.type || '').toLowerCase()}|${title.toLowerCase()}|${(e.year || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = e.year ? `${title} (${e.year})` : title;
    if ((e.type || '').toLowerCase() === 'show') shows.push(label);
    else movies.push(label);
    if (movies.length + shows.length >= MAX_TITLES_IN_PROMPT) break;
  }
  const parts: string[] = [];
  if (movies.length > 0) parts.push(`FILMS (${movies.length}) :\n- ${movies.join('\n- ')}`);
  if (shows.length > 0) parts.push(`SÉRIES (${shows.length}) :\n- ${shows.join('\n- ')}`);
  return parts.join('\n\n');
}

export function buildGeminiPrompt(
  librarySummary: string,
  totalCount: number,
  options: GeminiSuggestOptions,
): string {
  const count = Math.min(Math.max(options.count ?? 10, 1), 30);
  const want = options.want ?? 'all';
  const language = options.language ?? 'français';
  const wantLabel =
    want === 'movies' ? 'des FILMS uniquement' : want === 'series' ? 'des SÉRIES uniquement' : 'des films et séries (panachés)';
  return (
    `Tu es un expert cinéma/séries. Voici la collection Plex d'un utilisateur ` +
    `(${totalCount} éléments au total, extrait ci-dessous).\n\n${librarySummary}\n\n` +
    `Propose ${count} ${wantLabel} que l'utilisateur n'a PAS déjà (ne propose aucun titre listé ci-dessus, même avec une année différente) ` +
    `et qui correspondent à ses goûts apparents (genres, époques, styles). Privilégie des œuvres reconnues et disponibles en VOD/streaming.\n\n` +
    `Réponds en ${language}, UNIQUEMENT avec un objet JSON valide (sans markdown, sans texte autour) de cette forme exacte :\n` +
    `{"recommendations": [{"title": "...", "year": "2023", "type": "movie" | "series", "reason": "1-2 phrases en ${language}"}]}\n` +
    `"year" peut être "" si inconnue. Chaque "reason" tient sur une seule ligne (aucun saut de ligne) ` +
    `et n'utilise jamais de guillemets doubles à l'intérieur des valeurs (apostrophes ' uniquement).`
  );
}

/** Répare les défauts JSON les plus fréquents (virgules finales, BOM). */
function repairJson(s: string): string {
  return s
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * Échappe les caractères de contrôle bruts (sauts de ligne, tabulations)
 * à l'intérieur des chaînes JSON. Gemini renvoie souvent des "reason" sur
 * plusieurs lignes avec des \n littéraux, invalides en JSON strict.
 * Seul le contenu entre guillemets doubles est modifié ; la structure
 * (indentation, retours hors chaînes) est préservée.
 */
function escapeControlsInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) {
        out += c;
        escaped = false;
      } else if (c === '\\') {
        out += c;
        escaped = true;
      } else if (c === '"') {
        out += c;
        inStr = false;
      } else if (c === '\n') {
        out += '\\n';
      } else if (c === '\r') {
        out += '\\r';
      } else if (c === '\t') {
        out += '\\t';
      } else if (c < ' ') {
        out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else {
        out += c;
      }
    } else {
      out += c;
      if (c === '"') inStr = true;
    }
  }
  return out;
}

function tryParseJson(s: string): unknown | null {
  const t = (s || '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* tentative réparée */
  }
  try {
    return JSON.parse(repairJson(t));
  } catch {
    /* tentative avec échappement des retours ligne dans les chaînes */
  }
  try {
    return JSON.parse(repairJson(escapeControlsInStrings(t)));
  } catch {
    return null;
  }
}

/**
 * Extrait toutes les sous-chaînes équilibrées {…} / […] en respectant
 * les chaînes entre guillemets (avec échappements). Permet de retrouver
 * le JSON même noyé dans du texte ou du markdown.
 */
function extractBalanced(text: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let start = -1;
  let inStr: string | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      // Un apostrophe française dans du texte (c'est, l'homme) n'ouvre pas
      // une chaîne JSON : seules les " comptent hors texte déjà ouvert.
      if (c === '"' && stack.length > 0) inStr = c;
      else if (c === '"' && stack.length === 0) {
        // " isolé hors JSON : ignore (évite de casser le scan).
      }
      continue;
    }
    if (c === '{' || c === '[') {
      if (stack.length === 0) start = i;
      stack.push(c);
    } else if (c === '}' || c === ']') {
      const open = stack.pop();
      if (!open) continue;
      if ((open === '{' && c !== '}') || (open === '[' && c !== ']')) {
        stack.length = 0;
        start = -1;
        continue;
      }
      if (stack.length === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Plus grands d'abord (l'objet racine contient les recommandations).
  return out.sort((a, b) => b.length - a.length);
}

/** Extrait le JSON même si Gemini ajoute du texte / un bloc ```json autour. */
function extractJson(text: string): unknown {
  const clean = (text || '').trim();
  if (!clean) throw new GeminiError('Réponse vide de Gemini.');
  // 1) Blocs ```json ... ``` (le modèle en met souvent malgré la consigne).
  const fenced: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(clean)) !== null) {
    if (m[1]?.trim()) fenced.push(m[1].trim());
  }
  // 2) Texte brut + sous-chaînes équilibrées {…} / […].
  const candidates = [...fenced, clean, ...extractBalanced(clean)];
  for (const c of candidates) {
    const parsed = tryParseJson(c);
    if (parsed !== null && parsed !== undefined) return parsed;
  }
  try {
    if (typeof console !== 'undefined') console.warn('[gemini] réponse non-JSON :', clean.slice(0, 2000));
  } catch {
    /* ignore */
  }
  throw new GeminiError(
    `Réponse Gemini illisible (JSON invalide). Extrait reçu : « ${clean.slice(0, 300)}${clean.length > 300 ? '…' : ''} »` +
      ` Astuce : relance la génération (réponse tronquée ou mise en forme ?) ou change de modèle dans Réglages.`,
  );
}

function normalizeRecommendation(raw: Record<string, unknown>): GeminiRecommendation | null {
  const title = String(raw['title'] ?? raw['titre'] ?? '').trim();
  if (!title) return null;
  const yearRaw = String(raw['year'] ?? raw['annee'] ?? raw['année'] ?? '').trim();
  const year = /^\d{4}$/.test(yearRaw) ? yearRaw : yearRaw.match(/\d{4}/)?.[0];
  const t = String(raw['type'] ?? '').toLowerCase();
  const type: GeminiMediaType = t.includes('serie') || t.includes('series') || t === 'show' || t === 'tv'
    ? 'series'
    : t.includes('movie') || t.includes('film') || t === 'movies'
      ? 'movie'
      : 'unknown';
  return { title, year, type, reason: String(raw['reason'] ?? raw['pourquoi'] ?? '').trim() };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchGeminiRecommendations(
  apiKey: string,
  library: GeminiLibraryEntry[],
  options: GeminiSuggestOptions = {},
): Promise<GeminiRecommendation[]> {
  const key = (apiKey || '').trim();
  if (!key) throw new GeminiError('Clé API Gemini manquante (Réglages > IA Gemini).');
  if (library.length === 0) throw new GeminiError('Librairie Plex vide : impossible de générer des suggestions.');
  let requested = (options.model || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  // Migration auto : un modèle retiré stocké en réglages bascule sur le défaut.
  if (RETIRED_GEMINI_MODELS.has(requested)) requested = DEFAULT_GEMINI_MODEL;
  const summary = summarizeLibraryForPrompt(library);
  const prompt = buildGeminiPrompt(summary, library.length, options);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 2048, responseMimeType: 'application/json' },
  });
  // Modèle demandé + replis, sans doublon.
  const candidates = [requested, ...GEMINI_MODEL_FALLBACKS.filter((m) => m !== requested)];
  let last404 = '';
  const buildBody = (jsonMode: boolean) =>
    JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: jsonMode
        ? { temperature: 0.8, maxOutputTokens: 4096, responseMimeType: 'application/json' }
        : { temperature: 0.8, maxOutputTokens: 4096 },
    });
  const callModel = async (model: string, jsonMode: boolean): Promise<Response> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      return await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: buildBody(jsonMode) },
        GEMINI_TIMEOUT_MS,
      );
    } catch (e) {
      throw new GeminiError(
        e instanceof Error && e.name === 'AbortError'
          ? 'Gemini ne répond pas (délai 60 s dépassé).'
          : `Réseau Gemini injoignable : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  interface GeminiPart {
    text?: string;
    thought?: boolean;
  }
  const textFrom = (data: {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  }): string => {
    const block = data.promptFeedback?.blockReason;
    if (block) throw new GeminiError(`Gemini a bloqué la demande (${block}). Réessaie avec une collection plus petite.`);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    // Les modèles récents mélangent parfois des parties "thought" (raisonnement)
    // au texte : on les exclut, elles cassent le JSON.
    const texts = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text as string);
    const text = texts.join('').trim();
    const finish = cand?.finishReason;
    if (finish === 'MAX_TOKENS') {
      throw new GeminiError(
        'Réponse Gemini tronquée (limite de longueur atteinte). Relance en demandant moins de suggestions (5 au lieu de 10/20).',
      );
    }
    if (!text) {
      if (finish && finish !== 'STOP') {
        throw new GeminiError(
          `Gemini n’a renvoyé aucun texte (arrêt : ${finish}). Relance la génération ou réduis la taille de la collection.`,
        );
      }
      throw new GeminiError('Gemini n’a renvoyé aucun texte.');
    }
    return text;
  };
  for (const model of candidates) {
    let res = await callModel(model, true);
    if (res.status === 404) {
      last404 = model;
      continue; // modèle retiré/renommé : essaie le suivant
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(errBody)) {
        throw new GeminiError('Clé API Gemini invalide. Vérifie-la dans Réglages > IA Gemini.');
      }
      if (res.status === 429) {
        throw new GeminiError('Quota Gemini dépassé (429). Réessaie dans quelques minutes.');
      }
      throw new GeminiError(`Gemini a retourné HTTP ${res.status}. ${errBody.slice(0, 300)}`);
    }
    let data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    let text = textFrom(data);
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      // Repli : certains modèles renvoient du markdown malgré responseMimeType.
      // On retente une fois en mode texte libre, plus tolérant.
      res = await callModel(model, false);
      if (!res.ok) throw new GeminiError(`Gemini a retourné HTTP ${res.status}.`);
      data = (await res.json()) as typeof data;
      text = textFrom(data);
      parsed = extractJson(text); // si ça échoue, l'erreur contient un extrait
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { recommendations?: unknown })['recommendations'];
    if (!Array.isArray(list)) throw new GeminiError('Format inattendu de la réponse Gemini.');
    const out: GeminiRecommendation[] = [];
    const owned = new Set(library.map((e) => e.title.trim().toLowerCase()));
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = normalizeRecommendation(item as Record<string, unknown>);
      if (!rec) continue;
      // Filtre anti-doublon : ne jamais proposer un titre déjà possédé.
      if (owned.has(rec.title.toLowerCase())) continue;
      out.push(rec);
    }
    if (out.length === 0) throw new GeminiError('Gemini n’a proposé que des titres déjà dans ta collection. Relance la génération.');
    return out;
  }
  throw new GeminiError(
    `Aucun modèle Gemini joignable (dernier essai "${last404}" → 404). Modèles testés : ${candidates.join(', ')}. ` +
      `Mets à jour le champ "Modèle Gemini" dans Réglages (ex : ${DEFAULT_GEMINI_MODEL}).`,
  );
}

export { normalizeType };
