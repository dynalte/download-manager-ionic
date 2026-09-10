/**
 * Recommandations films/séries via OpenRouter (API OpenAI-compatible),
 * modèles gratuits `:free` — alternative à Gemini.
 *
 * Clé : https://openrouter.ai/keys (sans CB sur les modèles :free).
 * Adapter mince : tout le moteur (prompt, JSON, replis, anti-doublon)
 * vit dans aiSuggest.ts.
 */
import {
  AiRetryable,
  outTokensForCount,
  runSuggest,
  type AiLibraryEntry,
  type AiRecommendation,
  type AiSuggestOptions,
  type SuggestProvider,
} from './aiSuggest';

export type GeminiLibraryEntry = AiLibraryEntry;
export type GeminiRecommendation = AiRecommendation;
export type GeminiSuggestOptions = AiSuggestOptions;

/** Modèle gratuit par défaut (bon suivi d'instructions JSON). */
export const DEFAULT_OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it:free';
/** Ordre d'essai si le modèle demandé répond 404 (renommé / retiré du catalogue :free). */
const OPENROUTER_MODEL_FALLBACKS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/free',
];

export class OpenRouterError extends Error {}

const provider: SuggestProvider = {
  tag: 'openrouter',
  display: 'OpenRouter',
  settingsHint: 'Réglages > IA OpenRouter',
  defaultModel: DEFAULT_OPENROUTER_MODEL,
  fallbacks: OPENROUTER_MODEL_FALLBACKS,
  cacheDeadModels: true,
  makeError: (message: string) => new OpenRouterError(message),

  buildRequest(apiKey: string, model: string, prompt: string, jsonMode: boolean, maxTokens: number) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Title': 'DownloadManager',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.8,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      },
    };
  },

  extractText(
    data: {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null }; finish_reason?: string }>;
      error?: { message?: string; code?: number | string };
    },
    model: string,
  ): string {
    if (data.error) {
      const msg = data.error.message || 'erreur inconnue';
      if (/overload|temporar|timeout|timed out|capacity|try again|rate limit|5\d\d|internal error|upstream/i.test(msg)) {
        throw new AiRetryable(`Amont saturé (${model}) : ${msg}`, 'transient');
      }
      if (/no endpoints|not found|not available|disabled/i.test(msg)) {
        throw new AiRetryable(`Modèle indisponible (${model}) : ${msg}`, 'dead');
      }
      throw new OpenRouterError(`OpenRouter : ${msg}.`);
    }
    const choice = data.choices?.[0];
    const text = (choice?.message?.content || '').trim();
    if (choice?.finish_reason === 'length') {
      throw new AiRetryable(`Réponse OpenRouter tronquée par ${model} (limite de longueur atteinte).`, 'truncated');
    }
    if (!text) {
      if (choice?.finish_reason && choice.finish_reason !== 'stop') {
        throw new OpenRouterError(`OpenRouter n’a renvoyé aucun texte (arrêt : ${choice.finish_reason}). Relance la génération.`);
      }
      throw new OpenRouterError('OpenRouter n’a renvoyé aucun texte.');
    }
    return text;
  },

  onHttpError(status: number, body: string) {
    if (status === 401) return { fatal: 'Clé API OpenRouter invalide. Vérifie-la dans Réglages > IA OpenRouter.' };
    if (status === 402) return { fatal: 'Crédits OpenRouter insuffisants (402) : utilise un modèle :free.' };
    if (status === 429 || status >= 500) return 'next-model';
    return { fatal: `OpenRouter a retourné HTTP ${status}. ${body.slice(0, 300)}` };
  },

  truncatedMessage: (model: string) =>
    `Réponse OpenRouter tronquée par ${model} (limite de longueur atteinte). Relance en demandant moins de suggestions (5 au lieu de 10).`,

  saturatedDetail:
    'Soit le quota (50 requêtes/jour sans crédits, voir openrouter.ai/activity), soit les fournisseurs amont sont pleins.',

  allFailedMessage: (tried: string[], lastDead: string) =>
    `Aucun modèle OpenRouter joignable (dernier essai "${lastDead}" → 404). Modèles testés : ${tried.join(', ')}. ` +
    `Mets à jour le champ "Modèle OpenRouter" dans Réglages (ex : ${DEFAULT_OPENROUTER_MODEL}).`,
};

export async function fetchOpenRouterRecommendations(
  apiKey: string,
  library: GeminiLibraryEntry[],
  options: GeminiSuggestOptions = {},
): Promise<GeminiRecommendation[]> {
  return runSuggest(provider, apiKey, library, options);
}
