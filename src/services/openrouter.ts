/**
 * Recommandations films/séries via OpenRouter (API OpenAI-compatible),
 * modèles gratuits `:free` — alternative à Gemini.
 *
 * - Clé : https://openrouter.ai/keys (sans CB sur les modèles :free),
 *   stockée dans les Réglages (settings.openrouterApiKey).
 * - Endpoint : https://openrouter.ai/api/v1/chat/completions (CORS OK).
 * - Même contrat que gemini.ts : JSON { recommendations: [...] },
 *   anti-doublon collection + historique + « déjà vu ».
 */
import {
  buildGeminiPrompt,
  extractJson,
  normalizeRecommendation,
  normTitle,
  summarizeLibraryForPrompt,
  type GeminiLibraryEntry,
  type GeminiRecommendation,
  type GeminiSuggestOptions,
} from './gemini';

/** Modèle gratuit par défaut (bon suivi d'instructions JSON). */
export const DEFAULT_OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it:free';
/** Ordre d'essai si le modèle demandé répond 404 (renommé / retiré du catalogue :free). */
const OPENROUTER_MODEL_FALLBACKS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/free',
];
const OPENROUTER_TIMEOUT_MS = 60000;

/** Modèles ayant répondu 404 (mémorisés 24 h pour ne pas brûler le quota :free). */
const DEAD_MODELS_KEY = 'openrouter_dead_models_v1';
const DEAD_TTL_MS = 24 * 3600 * 1000;

function loadDeadModels(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DEAD_MODELS_KEY);
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

function markModelDead(model: string): void {
  try {
    const dead = loadDeadModels();
    dead[model] = Date.now();
    const keys = Object.keys(dead);
    // Plafond : garde les 20 plus récents.
    if (keys.length > 20) {
      keys
        .sort((a, b) => (dead[a] ?? 0) - (dead[b] ?? 0))
        .slice(0, keys.length - 20)
        .forEach((k) => delete dead[k]);
    }
    localStorage.setItem(DEAD_MODELS_KEY, JSON.stringify(dead));
  } catch {
    /* stockage indisponible */
  }
}

export class OpenRouterError extends Error {}

/**
 * Échec récupérable : passer au modèle suivant au lieu d'échouer la génération.
 * - dead : modèle indisponible au catalogue → mémorisé 24 h (comme un 404).
 * - truncated : réponse coupée → un autre modèle (sans raisonnement) peut passer.
 * - sinon : amont transitoire (saturé, timeout) → autre fournisseur.
 */
class OpenRouterRetryable extends OpenRouterError {
  dead: boolean;
  truncated: boolean;
  constructor(message: string, opts: { dead?: boolean; truncated?: boolean } = {}) {
    super(message);
    this.dead = opts.dead ?? false;
    this.truncated = opts.truncated ?? false;
  }
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

export async function fetchOpenRouterRecommendations(
  apiKey: string,
  library: GeminiLibraryEntry[],
  options: GeminiSuggestOptions = {},
): Promise<GeminiRecommendation[]> {
  const key = (apiKey || '').trim();
  if (!key) throw new OpenRouterError('Clé API OpenRouter manquante (Réglages > IA OpenRouter).');
  if (library.length === 0) throw new OpenRouterError('Librairie Plex vide : impossible de générer des suggestions.');
  const t0 = Date.now();

  const requested = (options.model || DEFAULT_OPENROUTER_MODEL).trim() || DEFAULT_OPENROUTER_MODEL;
  const summary = summarizeLibraryForPrompt(library);
  const prompt = buildGeminiPrompt(summary, library.length, options);
  // Plafond de sortie proportionné au nombre demandé : borne le pire cas (latence)
  // tout en laissant la marge pour le raisonnement interne (thinking) + 10 recs.
  const outTokens = Math.min(8192, Math.max(2048, (options.count ?? 10) * 350));
  const candidates = [requested, ...OPENROUTER_MODEL_FALLBACKS.filter((m) => m !== requested)];
  // Évite de re-brûler le quota :free sur des modèles déjà vus en 404 (24 h).
  const dead = loadDeadModels();
  const live = candidates.filter((m) => !(m in dead));
  const toTry = live.length > 0 ? live : candidates;
  let last404 = '';
  let last429 = '';
  let lastUpstream = '';
  let lastTruncated = '';

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const buildBody = (model: string, jsonMode: boolean) =>
    JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: outTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

  const callModel = async (model: string, jsonMode: boolean): Promise<Response> => {
    try {
      return await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'X-Title': 'DownloadManager',
          },
          body: buildBody(model, jsonMode),
        },
        OPENROUTER_TIMEOUT_MS,
      );
    } catch (e) {
      throw new OpenRouterError(
        e instanceof Error && e.name === 'AbortError'
          ? 'OpenRouter ne répond pas (délai 60 s dépassé).'
          : `Réseau OpenRouter injoignable : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const textFrom = (data: {
    choices?: Array<{ message?: { content?: string | null; reasoning?: string | null }; finish_reason?: string }>;
    error?: { message?: string; code?: number | string };
  }, model: string): string => {
    if (data.error) {
      const msg = data.error.message || 'erreur inconnue';
      if (/overload|temporar|timeout|timed out|capacity|try again|rate limit|5\d\d|internal error|upstream/i.test(msg)) {
        throw new OpenRouterRetryable(`Amont saturé (${model}) : ${msg}`, {});
      }
      if (/no endpoints|not found|not available|disabled/i.test(msg)) {
        throw new OpenRouterRetryable(`Modèle indisponible (${model}) : ${msg}`, { dead: true });
      }
      throw new OpenRouterError(`OpenRouter : ${msg}.`);
    }
    const choice = data.choices?.[0];
    const text = (choice?.message?.content || '').trim();
    if (choice?.finish_reason === 'length') {
      throw new OpenRouterRetryable(
        `Réponse OpenRouter tronquée par ${model} (limite de longueur atteinte).`,
        { truncated: true },
      );
    }
    if (!text) {
      if (choice?.finish_reason && choice.finish_reason !== 'stop') {
        throw new OpenRouterError(`OpenRouter n’a renvoyé aucun texte (arrêt : ${choice.finish_reason}). Relance la génération.`);
      }
      throw new OpenRouterError('OpenRouter n’a renvoyé aucun texte.');
    }
    return text;
  };

  for (const model of toTry) {
    try {
    let res = await callModel(model, true);
    // 429 transitoire (limite minute / fournisseur saturé) : un seul retry honorant Retry-After.
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
      await res.text().catch(() => '');
      if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60) {
        await wait(retryAfter * 1000);
        res = await callModel(model, true);
      }
    }
    if (res.status === 404) {
      last404 = model; // modèle inconnu / retiré du catalogue :free
      markModelDead(model);
      await res.text().catch(() => '');
      continue;
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new OpenRouterError('Clé API OpenRouter invalide. Vérifie-la dans Réglages > IA OpenRouter.');
      }
      if (res.status === 402) {
        throw new OpenRouterError('Crédits OpenRouter insuffisants (402) : utilise un modèle :free.');
      }
      if (res.status === 429) {
        // Quota journalier OU fournisseur amont saturé :
        // on essaie le modèle suivant (autre fournisseur = autre capacité).
        last429 = model;
        continue;
      }
      if (res.status >= 500) {
        // Passerelle amont en erreur → modèle suivant.
        lastUpstream = model;
        continue;
      }
      throw new OpenRouterError(`OpenRouter a retourné HTTP ${res.status}. ${errBody.slice(0, 300)}`);
    }
    let data = (await res.json()) as Parameters<typeof textFrom>[0];
    let text = textFrom(data, model);
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      // Repli : certains modèles ignorent response_format → retente en texte libre.
      res = await callModel(model, false);
      if (!res.ok) throw new OpenRouterError(`OpenRouter a retourné HTTP ${res.status}.`);
      data = (await res.json()) as typeof data;
      text = textFrom(data, model);
      parsed = extractJson(text);
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { recommendations?: unknown })['recommendations'];
    if (!Array.isArray(list)) throw new OpenRouterError('Format inattendu de la réponse OpenRouter.');
    const out: GeminiRecommendation[] = [];
    // Anti-doublon : collection présente + historique + « déjà vu ».
    const owned = new Set(library.map((e) => normTitle(e.title)));
    for (const h of options.history ?? []) owned.add(normTitle(h.title));
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = normalizeRecommendation(item as Record<string, unknown>);
      if (!rec) continue;
      if (owned.has(normTitle(rec.title))) continue;
      out.push(rec);
    }
    if (out.length === 0) throw new OpenRouterError('OpenRouter n’a proposé que des titres déjà dans ta collection ou déjà vus. Relance la génération.');
    try {
      if (typeof console !== 'undefined') console.info(`[openrouter] suggestions via ${model} en ${Date.now() - t0} ms`);
    } catch {
      /* ignore */
    }
    return out;
    } catch (e) {
      if (e instanceof OpenRouterRetryable) {
        if (e.dead) {
          last404 = model;
          markModelDead(model);
        } else if (e.truncated) {
          lastTruncated = model;
        } else {
          lastUpstream = model;
        }
        continue;
      }
      throw e;
    }
  }
  if (!last404 && !last429 && !lastUpstream && lastTruncated) {
    throw new OpenRouterError(
      `Réponse OpenRouter tronquée par ${lastTruncated} (limite de longueur atteinte). Relance en demandant moins de suggestions (5 au lieu de 10).`,
    );
  }
  if ((last429 || lastUpstream) && !last404) {
    throw new OpenRouterError(
      `Tous les modèles OpenRouter sont saturés ou quota :free épuisé (429 / amont sur : ${toTry.join(', ')}). ` +
        `Soit le quota (50 requêtes/jour sans crédits, voir openrouter.ai/activity), soit les fournisseurs amont sont pleins — ` +
        `réessaie dans quelques minutes, ou renseigne une clé Gemini en repli automatique.`,
    );
  }
  throw new OpenRouterError(
    `Aucun modèle OpenRouter joignable (dernier essai "${last404 || last429}" → ${last404 ? '404' : '429'}). Modèles testés : ${toTry.join(', ')}. ` +
      `Mets à jour le champ "Modèle OpenRouter" dans Réglages (ex : ${DEFAULT_OPENROUTER_MODEL}).`,
  );
}
