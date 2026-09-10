/**
 * Recommandations films/séries via l'API Gemini, basées sur la librairie Plex.
 *
 * - Clé API : Google AI Studio (https://aistudio.google.com/apikey), stockée
 *   dans les Réglages (settings.geminiApiKey).
 * - Endpoint : generativelanguage.googleapis.com (CORS OK, fetch direct
 *   depuis WebView / web / Electron).
 *
 * Adapter mince : tout le moteur (prompt, JSON, replis, anti-doublon)
 * vit dans aiSuggest.ts.
 */
import {
  AiRetryable,
  runSuggest,
  type AiLibraryEntry,
  type AiMediaType,
  type AiRecommendation,
  type AiSuggestOptions,
  type SuggestProvider,
} from './aiSuggest';

export type GeminiLibraryEntry = AiLibraryEntry;
export type GeminiMediaType = AiMediaType;
export type GeminiRecommendation = AiRecommendation;
export type GeminiSuggestOptions = AiSuggestOptions;

/** Modèle par défaut (stable, large dispo). */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
/** Modèles retirés par Google → bascule auto vers le défaut. */
export const RETIRED_GEMINI_MODELS = new Set([
  'gemini-3-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-pro',
]);
/** Ordre d'essai si le modèle demandé répond 404 (retiré / renommé). */
const GEMINI_MODEL_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];

export class GeminiError extends Error {}

const provider: SuggestProvider = {
  tag: 'gemini',
  display: 'Gemini',
  settingsHint: 'Réglages > IA Gemini',
  defaultModel: DEFAULT_GEMINI_MODEL,
  fallbacks: GEMINI_MODEL_FALLBACKS,
  retiredModels: RETIRED_GEMINI_MODELS,
  cacheDeadModels: false,
  makeError: (message: string) => new GeminiError(message),

  buildRequest(apiKey: string, model: string, prompt: string, jsonMode: boolean, maxTokens: number) {
    // Pas de raisonnement interne : la tâche est un JSON direct, le thinking
    // consomme le budget de sortie (troncatures) et ralentit. Supporté par 2.5-flash/lite.
    const noThinking = model.startsWith('gemini-2.5-flash');
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: maxTokens,
            ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
      },
    };
  },

  extractText(
    data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    },
    model: string,
  ): string {
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
      throw new AiRetryable(`Réponse Gemini tronquée par ${model} (limite de longueur atteinte).`, 'truncated');
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
  },

  onHttpError(status: number, body: string) {
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(body)) {
      return { fatal: 'Clé API Gemini invalide. Vérifie-la dans Réglages > IA Gemini.' };
    }
    // thinkingBudget refusé par ce modèle → suivant (sans thinking forcé).
    if (status === 400 && /thinking/i.test(body)) return 'next-model';
    if (status === 429 || status >= 500) return 'next-model';
    return { fatal: `Gemini a retourné HTTP ${status}. ${body.slice(0, 300)}` };
  },

  truncatedMessage: (model: string) =>
    `Réponse Gemini tronquée par ${model} (limite de longueur atteinte). Relance en demandant moins de suggestions (5 au lieu de 10).`,

  allFailedMessage: (tried: string[], lastDead: string) =>
    `Aucun modèle Gemini joignable (dernier essai "${lastDead}" → 404). Modèles testés : ${tried.join(', ')}. ` +
    `Mets à jour le champ "Modèle Gemini" dans Réglages (ex : ${DEFAULT_GEMINI_MODEL}).`,
};

export async function fetchGeminiRecommendations(
  apiKey: string,
  library: GeminiLibraryEntry[],
  options: GeminiSuggestOptions = {},
): Promise<GeminiRecommendation[]> {
  return runSuggest(provider, apiKey, library, options);
}
