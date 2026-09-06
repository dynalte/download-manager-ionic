/**
 * Port de DestinationFolderPredictor (SiteTabView.swift).
 */
import type { DestinationFolder } from './settings';

export interface PendingPayload {
  kind: 'torrent' | 'magnet';
  filename: string;
  sourceURL: string;
  pageURL: string;
  magnetURL: string;
}

export interface DestinationPrediction {
  folder: DestinationFolder;
  score: number;
  secondScore: number;
}

export function destinationPrediction(p: PendingPayload): DestinationPrediction | null {
  const sources: string[] = [];
  if (p.kind === 'torrent') {
    sources.push(p.filename, p.sourceURL, p.pageURL);
  } else {
    sources.push(p.magnetURL, p.pageURL);
    try {
      const dn = new URL(p.magnetURL).searchParams.get('dn');
      if (dn) sources.push(dn);
    } catch {
      /* ignore */
    }
  }
  const normalized = sources
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const scores: Record<DestinationFolder, number> = { films: 0, series: 0, musique: 0 };

  const add = (folder: DestinationFolder, keywords: string[], weight: number) => {
    for (const k of keywords) if (normalized.includes(k)) scores[folder] += weight;
  };
  add('films', ['/films', 'film', 'movie', 'cinema', 'bluray', 'bdrip', 'dvdrip'], 3);
  add('series', ['/series', 'serie', 'season', 'saison', 'episode', 'tv show', 's0', 'e0'], 3);
  add('musique', ['/musique', 'musique', 'music', 'mp3', 'flac', 'album', 'discography'], 3);
  if (/(1080p|2160p|x264|x265)/.test(normalized)) scores.films += 1;
  if (/(s01|s02|episode)/.test(normalized)) scores.series += 1;

  const sorted = (Object.entries(scores) as Array<[DestinationFolder, number]>).sort((a, b) => {
    if (a[1] === b[1]) return a[0].localeCompare(b[0]);
    return b[1] - a[1];
  });
  const top = sorted[0];
  if (!top || top[1] <= 0) return null;
  if (sorted.length > 1 && sorted[1][1] === top[1]) return null; // égalité -> pas de prédiction
  return { folder: top[0], score: top[1], secondScore: sorted[1]?.[1] ?? 0 };
}

export function predictedFolder(p: PendingPayload): DestinationFolder | null {
  return destinationPrediction(p)?.folder ?? null;
}

/** Auto-confirmation si score >= 4 et écart >= 2 (comme Swift). */
export function autoConfirmedFolder(p: PendingPayload): DestinationFolder | null {
  const pred = destinationPrediction(p);
  if (!pred) return null;
  if (pred.score >= 4 && pred.score - pred.secondScore >= 2) return pred.folder;
  return null;
}
