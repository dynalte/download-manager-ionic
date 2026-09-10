/**
 * Noyau partagé des suggestions IA (films/séries absents de la collection).
 *
 * Un seul moteur pour tous les providers (Gemini, OpenRouter...) :
 * construction du prompt, extraction JSON tolérante, anti-doublon
 * (collection + historique + « déjà vu »), boucle de replis modèles,
 * timeouts et messages d'erreur en français.
 *
 * Chaque provider ne fournit que ses hooks (endpoint, format de réponse,
 * mapping d'erreurs) dans ~60 lignes. Voir gemini.ts / openrouter.ts.
 */

export interface AiLibraryEntry {
  title: string;
  year?: string;
  /** 'movie' | 'show' (type Plex normalisé) */
  type: string;
}

export type AiMediaType = 'movie' | 'series' | 'unknown';

export interface AiRecommendation {
  title: string;
  year?: string;
  type: AiMediaType;
  /** Pourquoi ce choix colle à la collection (1-2 phrases). */
  reason: string;
}

export interface AiSuggestOptions {
  /** Nombre de propositions demandées (défaut 10). */
  count?: number;
  /** Restreint les propositions : 'all' | 'movies' | 'series'. */
  want?: 'all' | 'movies' | 'series';
  /** Modèle (défaut selon provider). */
  model?: string;
  /** Langue de la réponse (défaut français). */
  language?: string;
  /** Intention libre (ex : "film d'action") : biaise les nouveautés vers cette envie. */
  intent?: string;
  /** Historique de visionnage (vus même supprimés) : exclus + utilisés comme goût. */
  history?: AiLibraryEntry[];
}

export class AiError extends Error {}

/**
 * Échec récupérable : passer au modèle suivant au lieu d'échouer.
 * - dead : modèle inconnu/retiré → mémorisé 24 h (ne pas re-brûler de quota).
 * - truncated : réponse coupée → un autre modèle peut passer.
 * - transient : amont saturé/timeout → autre fournisseur.
 */
export class AiRetryable extends AiError {
  kind: 'dead' | 'truncated' | 'transient';
  constructor(message: string, kind: 'dead' | 'truncated' | 'transient') {
    super(message);
    this.kind = kind;
  }
}

export const AI_TIMEOUT_MS = 60000;
const MAX_TITLES_IN_PROMPT = 150;
const MAX_HISTORY_IN_PROMPT = 100;

/** Plafond de sortie proportionné au nombre demandé (marge thinking + N recs). */
export function outTokensForCount(count?: number): number {
  return Math.min(8192, Math.max(2048, (count ?? 10) * 350));
}

/** Déduplique + tronque la collection pour tenir dans le prompt. */
export function summarizeLibraryForPrompt(entries: AiLibraryEntry[]): string {
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

/** Déduplique + tronque l'historique de visionnage (vus même supprimés). */
export function summarizeHistoryForPrompt(entries: AiLibraryEntry[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const e of entries) {
    const title = (e.title || '').trim();
    if (!title) continue;
    const key = `${(e.type || '').toLowerCase()}|${title.toLowerCase()}|${(e.year || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(e.year ? `${title} (${e.year})` : title);
    if (labels.length >= MAX_HISTORY_IN_PROMPT) break;
  }
  if (labels.length === 0) return '';
  return `DÉJÀ VUS (même supprimés, ${labels.length}) :\n- ${labels.join('\n- ')}`;
}

export function buildSuggestPrompt(
  librarySummary: string,
  totalCount: number,
  options: AiSuggestOptions,
): string {
  const count = Math.min(Math.max(options.count ?? 10, 1), 30);
  const want = options.want ?? 'all';
  const language = options.language ?? 'français';
  const wantLabel =
    want === 'movies' ? 'des FILMS uniquement' : want === 'series' ? 'des SÉRIES uniquement' : 'des films et séries (panachés)';
  const intent = (options.intent || '').trim();
  const intentLine = intent
    ? `L'utilisateur cherche en priorité : « ${intent} ». Propose des œuvres ABSENTES qui correspondent à cette intention, tout en restant cohérentes avec ses goûts apparents.\n`
    : '';
  const historySummary = summarizeHistoryForPrompt(options.history ?? []);
  const historyLine = historySummary
    ? `\n\nHistorique de visionnage (titres déjà vus, même s'ils ont été supprimés du serveur — à ne JAMAIS proposer, mais utiles pour cerner les goûts) :\n\n${historySummary}`
    : '';
  return (
    `Tu es un expert cinéma/séries. Voici la collection Plex d'un utilisateur ` +
    `(${totalCount} éléments au total, extrait ci-dessous).\n\n${librarySummary}${historyLine}\n\n` +
    intentLine +
    `Propose ${count} ${wantLabel} que l'utilisateur n'a NI en collection NI déjà vus (ne propose aucun titre listé ci-dessus, même avec une année différente) ` +
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
 * à l'intérieur des chaînes JSON. Les modèles renvoient souvent des "reason"
 * sur plusieurs lignes avec des \n littéraux, invalides en JSON strict.
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

/** Extrait le JSON même si le modèle ajoute du texte / un bloc ```json autour. */
export function extractJson(text: string, displayName: string): unknown {
  const clean = (text || '').trim();
  if (!clean) throw new AiError(`Réponse vide de ${displayName}.`);
  // 1) Blocs ```json ... ``` (les modèles en mettent souvent malgré la consigne).
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
    if (typeof console !== 'undefined') console.warn(`[${displayName}] réponse non-JSON :`, clean.slice(0, 2000));
  } catch {
    /* ignore */
  }
  throw new AiError(
    `Réponse ${displayName} illisible (JSON invalide). Extrait reçu : « ${clean.slice(0, 300)}${clean.length > 300 ? '…' : ''} »` +
      ` Astuce : relance la génération (réponse tronquée ou mise en forme ?) ou change de modèle dans Réglages.`,
  );
}

/** Normalise un titre pour l'anti-doublon (accents, casse, ponctuation, &/and). */
export function normTitle(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeRecommendation(raw: Record<string, unknown>): AiRecommendation | null {
  const title = String(raw['title'] ?? raw['titre'] ?? '').trim();
  if (!title) return null;
  const yearRaw = String(raw['year'] ?? raw['annee'] ?? raw['année'] ?? '').trim();
  const year = /^\d{4}$/.test(yearRaw) ? yearRaw : yearRaw.match(/\d{4}/)?.[0];
  const t = String(raw['type'] ?? '').toLowerCase();
  const type: AiMediaType = t.includes('serie') || t.includes('series') || t === 'show' || t === 'tv'
    ? 'series'
    : t.includes('movie') || t.includes('film') || t === 'movies'
      ? 'movie'
      : 'unknown';
  return { title, year, type, reason: String(raw['reason'] ?? raw['pourquoi'] ?? '').trim() };
}

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- Cache des modèles morts (404) : ne pas re-brûler de quota ----------

const DEAD_TTL_MS = 24 * 3600 * 1000;
const DEAD_MAX = 20;

function deadKey(namespace: string): string {
  return `ai_dead_models_${namespace}_v1`;
}

export function loadDeadModels(namespace: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(deadKey(namespace));
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    const fresh: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && now - v < DEAD_TTL_MS) fresh[k] = v;
    }
    return fresh;
  } catch {
    return {};
  }
}

export function markModelDead(namespace: string, model: string): void {
  try {
    const dead = loadDeadModels(namespace);
    dead[model] = Date.now();
    const keys = Object.keys(dead);
    if (keys.length > DEAD_MAX) {
      keys
        .sort((a, b) => (dead[a] ?? 0) - (dead[b] ?? 0))
        .slice(0, keys.length - DEAD_MAX)
        .forEach((k) => delete dead[k]);
    }
    localStorage.setItem(deadKey(namespace), JSON.stringify(dead));
  } catch {
    /* stockage indisponible */
  }
}

// ---------- Moteur générique ----------

export interface SuggestProvider {
  /** Tag court (logs, cache). Ex : 'gemini', 'openrouter'. */
  tag: string;
  /** Nom affiché (messages). Ex : 'Gemini', 'OpenRouter'. */
  display: string;
  /** Indication réglages. Ex : 'Réglages > IA Gemini'. */
  settingsHint: string;
  defaultModel: string;
  fallbacks: string[];
  /** Modèles retirés migrés vers le défaut (optionnel). */
  retiredModels?: Set<string>;
  /** Mémorise les 404 24 h (quotas :free). Sinon false. */
  cacheDeadModels: boolean;
  /** Construit l'erreur typée du provider (les messages restent français). */
  makeError(message: string): Error;
  /** Requête HTTP pour un modèle (jsonMode = true d'abord, texte libre en repli). */
  buildRequest(apiKey: string, model: string, prompt: string, jsonMode: boolean, maxTokens: number): {
    url: string;
    init: RequestInit;
  };
  /** Extrait le texte utile d'une réponse JSON (lève AiRetryable si récupérable). */
  extractText(data: any, model: string): string;
  /**
   * Classe un statut HTTP non-OK :
   * - 'next-model' : passer au modèle suivant (404 géré à part, 429, 5xx…).
   * - { fatal } : échec définitif (clé invalide…).
   * Note : le 429 transitoire est d'abord rejoué une fois (Retry-After) par le moteur.
   */
  onHttpError(status: number, body: string): 'next-model' | { fatal: string };
  /** Message final quand tous les modèles échouent en 404 (catalogue). */
  allFailedMessage(tried: string[], lastDead: string): string;
  /** Message quand tous les modèles tronquent. */
  truncatedMessage(model: string): string;
  /** Détail ajouté au message de saturation (ex : quota chiffré). Optionnel. */
  saturatedDetail?: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Génère des suggestions via un provider, avec replis automatiques :
 * modèle demandé → fallbacks (404/429/saturation/troncature → suivant),
 * retry texte libre si le mode JSON échoue, anti-doublon collection +
 * historique + « déjà vu ».
 */
export async function runSuggest(
  provider: SuggestProvider,
  apiKey: string,
  library: AiLibraryEntry[],
  options: AiSuggestOptions = {},
): Promise<AiRecommendation[]> {
  const key = (apiKey || '').trim();
  if (!key) throw provider.makeError(`Clé API ${provider.display} manquante (${provider.settingsHint}).`);
  if (library.length === 0) throw provider.makeError('Librairie Plex vide : impossible de générer des suggestions.');
  const t0 = Date.now();

  let requested = (options.model || provider.defaultModel).trim() || provider.defaultModel;
  if (provider.retiredModels?.has(requested)) requested = provider.defaultModel;
  const summary = summarizeLibraryForPrompt(library);
  const prompt = buildSuggestPrompt(summary, library.length, options);
  const maxTokens = outTokensForCount(options.count);

  const candidates = [requested, ...provider.fallbacks.filter((m) => m !== requested)];
  const dead = provider.cacheDeadModels ? loadDeadModels(provider.tag) : {};
  const live = candidates.filter((m) => !(m in dead));
  const toTry = live.length > 0 ? live : candidates;
  let lastDead = '';
  let lastTruncated = '';
  let lastTransient = '';
  let saturated = false;

  const callModel = async (model: string, jsonMode: boolean): Promise<Response> => {
    const { url, init } = provider.buildRequest(key, model, prompt, jsonMode, maxTokens);
    try {
      return await fetchWithTimeout(url, init, AI_TIMEOUT_MS);
    } catch (e) {
      throw provider.makeError(
        e instanceof Error && e.name === 'AbortError'
          ? `${provider.display} ne répond pas (délai 60 s dépassé).`
          : `Réseau ${provider.display} injoignable : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  for (const model of toTry) {
    try {
      let res = await callModel(model, true);
      // 429 transitoire : un seul retry honorant Retry-After.
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
        await res.text().catch(() => '');
        if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60) {
          await wait(retryAfter * 1000);
          res = await callModel(model, true);
        }
      }
      if (res.status === 404) {
        lastDead = model;
        if (provider.cacheDeadModels) markModelDead(provider.tag, model);
        await res.text().catch(() => '');
        continue;
      }
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const decision = provider.onHttpError(res.status, errBody);
        if (decision === 'next-model') {
          if (res.status === 429) saturated = true;
          else lastTransient = model;
          continue;
        }
        throw provider.makeError(decision.fatal);
      }
      let data = (await res.json()) as unknown;
      let text = provider.extractText(data, model);
      let parsed: unknown;
      try {
        parsed = extractJson(text, provider.display);
      } catch {
        // Repli : certains modèles ignorent le mode JSON → retente en texte libre.
        res = await callModel(model, false);
        if (!res.ok) throw provider.makeError(`${provider.display} a retourné HTTP ${res.status}.`);
        data = (await res.json()) as unknown;
        text = provider.extractText(data, model);
        parsed = extractJson(text, provider.display); // si ça échoue, l'erreur contient un extrait
      }
      const list = Array.isArray(parsed) ? parsed : (parsed as { recommendations?: unknown })['recommendations'];
      if (!Array.isArray(list)) throw provider.makeError(`Format inattendu de la réponse ${provider.display}.`);
      const out: AiRecommendation[] = [];
      // Anti-doublon normalisé : collection + historique + « déjà vu ».
      const owned = new Set(library.map((e) => normTitle(e.title)));
      for (const h of options.history ?? []) owned.add(normTitle(h.title));
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const rec = normalizeRecommendation(item as Record<string, unknown>);
        if (!rec) continue;
        if (owned.has(normTitle(rec.title))) continue;
        out.push(rec);
      }
      if (out.length === 0) {
        throw provider.makeError(
          `${provider.display} n’a proposé que des titres déjà dans ta collection ou déjà vus. Relance la génération.`,
        );
      }
      try {
        if (typeof console !== 'undefined') console.info(`[${provider.tag}] suggestions via ${model} en ${Date.now() - t0} ms`);
      } catch {
        /* ignore */
      }
      return out;
    } catch (e) {
      if (e instanceof AiRetryable) {
        if (e.kind === 'dead') {
          lastDead = model;
          if (provider.cacheDeadModels) markModelDead(provider.tag, model);
        } else if (e.kind === 'truncated') {
          lastTruncated = model;
        } else {
          lastTransient = model;
        }
        continue;
      }
      throw e;
    }
  }
  if (lastTruncated && !lastDead && !saturated && !lastTransient) {
    throw provider.makeError(provider.truncatedMessage(lastTruncated));
  }
  if (saturated && !lastDead) {
    throw provider.makeError(
      `Tous les modèles ${provider.display} sont saturés ou quota épuisé (429 / amont sur : ${toTry.join(', ')}). ` +
        (provider.saturatedDetail ? provider.saturatedDetail + ' ' : '') +
        `Réessaie dans quelques minutes.`,
    );
  }
  if (lastTransient && !lastDead && !saturated) {
    throw provider.makeError(
      `Fournisseurs ${provider.display} temporairement indisponibles (amont saturé sur : ${toTry.join(', ')}). ` +
        `Réessaie dans quelques minutes.`,
    );
  }
  throw provider.makeError(provider.allFailedMessage(toTry, lastDead));
}
