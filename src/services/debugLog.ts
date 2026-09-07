/**
 * Logs applicatifs avec relais vers la console Xcode sur iOS.
 *
 * Les `console.*` d'une WKWebView n'apparaissent pas dans Xcode :
 * `appLog` duplique donc chaque entrée vers le natif via
 * `InlineBrowser.log` (NSLog côté Swift). Sur web/desktop le pont
 * est absent : on se replie silencieusement sur la console JS.
 */
import { InlineBrowser } from './inlineBrowser';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  tag: string;
  msg: string;
}

const MAX_ENTRIES = 400;
const buffer: LogEntry[] = [];
let nativeBroken = false;

function now(): string {
  try {
    return new Date().toISOString().slice(11, 19);
  } catch {
    return '';
  }
}

export function appLog(level: LogLevel, tag: string, msg: string): void {
  const entry: LogEntry = { at: now(), level, tag, msg };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);

  const line = `[${entry.at}][${tag}] ${msg}`;
  try {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'info' && 'info' in console) console.info(line);
    else console.log(line);
  } catch {
    /* console indisponible */
  }

  // Relais Xcode (iOS). Échec silencieux ailleurs (web/desktop).
  if (!nativeBroken) {
    try {
      void InlineBrowser.log({ level, tag, message: msg.slice(0, 2000) }).catch(() => {
        nativeBroken = true;
      });
    } catch {
      nativeBroken = true;
    }
  }
}

/** Raccourci pour les logs Plex (détection + lecture). */
export function plexLog(level: LogLevel, msg: string): void {
  appLog(level, 'plex', msg);
}

export function getRecentLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogs(): void {
  buffer.length = 0;
}
