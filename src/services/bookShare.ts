/**
 * Envoi d'e-books (dossier "livres") par e-mail : liseuses Kindle de
 * Stéphanie / Anaïs + adresse de test de Nicolas.
 *
 * Chaîne : fichier rapatrié depuis le serveur HTTP (port 8080, Basic Auth)
 * -> écrit dans le cache -> composeur Mail natif (cordova-plugin-email,
 * destinataire + pièce jointe) avec repli feuille de partage iOS.
 * Hors natif : téléchargement navigateur + mailto pré-rempli (sans PJ).
 *
 * Note : le serveur de fichiers n'envoie pas de headers CORS, donc le
 * fetch WebView est bloqué ("Load failed"). En natif on passe par
 * CapacitorHttp (requête URLSession, non soumise à la SOP).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { folderForDownloadDir, settings } from './settings';

export interface BookRecipient {
  id: string;
  name: string;
  email: string;
}

export const BOOK_RECIPIENTS: BookRecipient[] = [
  { id: 'stephanie', name: 'Stéphanie (Kindle)', email: 'steph.royer_48@kindle.com' },
  { id: 'anais', name: 'Anaïs (Kindle)', email: 'royer91.a_ekjnju@kindle.com' },
  { id: 'nicolas', name: 'Nicolas (test)', email: 'royer.nicolas@gmail.com' },
];

export type BookSendResult = 'sent' | 'cancelled' | 'shared';

export class BookShareError extends Error {}

/** Vrai si le téléchargement vient du dossier livres (bouton d'envoi affiché). */
export function isBookDownload(downloadDir: string): boolean {
  try {
    return folderForDownloadDir(downloadDir) === 'livres';
  } catch {
    return false;
  }
}

const DOWNLOADS_PREFIX = '/downloads';

/**
 * /downloads/livres/Mon Livre.epub -> <base>/livres/Mon%20Livre.epub
 * (le serveur HTTP expose l'arborescence sous /downloads).
 */
export function buildFileServerURL(downloadDir: string, name: string): string | null {
  const base = settings.fileServerBaseURL;
  if (!base) return null;
  const dir = downloadDir.trim().replace(/\/+$/, '');
  let rel: string;
  if (dir === DOWNLOADS_PREFIX) rel = '/';
  else if (dir.startsWith(`${DOWNLOADS_PREFIX}/`)) rel = dir.slice(DOWNLOADS_PREFIX.length);
  else return null;
  if (!name.trim()) return null;
  const segs = `${rel}/${name.trim()}`
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => encodeURIComponent(s));
  if (segs.length === 0) return null;
  return `${base}/${segs.join('/')}`;
}

function basicAuthHeader(): Record<string, string> {
  const u = settings.fileServerUsername;
  const p = settings.fileServerPassword;
  if (!u && !p) return {};
  return { Authorization: `Basic ${btoa(`${u}:${p}`)}` };
}

function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:%*"|<>?]/g, '_').trim();
  return clean === '' ? 'livre' : clean;
}

function checkBookBytes(buf: Uint8Array, contentType: string): void {
  if (buf.length === 0) throw new BookShareError('Fichier vide reçu du serveur.');
  if (buf.length > 200 * 1024 * 1024) throw new BookShareError('Fichier trop volumineux pour un envoi (> 200 Mo).');
  if (contentType.toLowerCase().includes('text/html')) {
    const head = new TextDecoder().decode(buf.slice(0, 200)).toLowerCase();
    if (head.includes('<html')) {
      throw new BookShareError("Le lien pointe vers une page/dossier, pas vers un fichier (torrent multi-fichiers ?).");
    }
  }
}

function checkBookStatus(status: number): void {
  if (status === 401 || status === 403) {
    throw new BookShareError('Serveur de fichiers : accès refusé (identifiants dans Réglages).');
  }
  if (status === 404) {
    throw new BookShareError('Fichier introuvable sur le serveur (torrent multi-fichiers ?).');
  }
  if (status < 200 || status >= 300) {
    throw new BookShareError(`Serveur de fichiers : HTTP ${status}.`);
  }
}

/** Requête native (pas de CORS) : les binaires arrivent en base64. */
async function downloadBookBytesNative(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  let res;
  try {
    res = await CapacitorHttp.get({
      url,
      headers: { ...basicAuthHeader(), Accept: '*/*' },
      responseType: 'arraybuffer',
      connectTimeout: 15000,
      readTimeout: 120000,
    });
  } catch (e) {
    throw new BookShareError(`Serveur de fichiers injoignable (${e instanceof Error ? e.message : String(e)}).`);
  }
  checkBookStatus(res.status);
  const contentType =
    (Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] as string) ?? '';
  const bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data ?? []);
  checkBookBytes(bytes, contentType);
  return { bytes, contentType };
}

async function downloadBookBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (Capacitor.isNativePlatform()) return downloadBookBytesNative(url);
  const res = await fetch(url, { headers: basicAuthHeader() });
  checkBookStatus(res.status);
  const contentType = res.headers.get('content-type') ?? '';
  const buf = new Uint8Array(await res.arrayBuffer());
  checkBookBytes(buf, contentType);
  return { bytes: buf, contentType };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface CordovaEmailComposer {
  open: (draft: Record<string, unknown>, callback?: (result?: unknown) => void) => void;
  hasAccount?: (callback: (has: unknown) => void) => void;
}

function cordovaEmail(): CordovaEmailComposer | null {
  try {
    const c = (window as unknown as { cordova?: { plugins?: { email?: CordovaEmailComposer } } }).cordova;
    const email = c?.plugins?.email;
    return email && typeof email.open === 'function' ? email : null;
  } catch {
    return null;
  }
}

function hasMailAccount(email: CordovaEmailComposer, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    try {
      if (typeof email.hasAccount === 'function') {
        email.hasAccount((has) => {
          if (!done) {
            done = true;
            window.clearTimeout(timer);
            resolve(!!has);
          }
        });
      } else {
        if (!done) {
          done = true;
          window.clearTimeout(timer);
          resolve(true);
        }
      }
    } catch {
      if (!done) {
        done = true;
        window.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

async function cleanupCacheFile(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Cache });
  } catch {
    /* ignore */
  }
}

/**
 * Filesystem.getUri() renvoie une URI percent-encodée
 * (ex: file:///.../Mon%20Livre.epub). Or cordova-plugin-email-composer
 * (iOS dataForAbsolutePath / Android getUriForAbsolutePath) fait
 * `new File(path)` SANS décoder : le fichier n'est pas trouvé, `data`
 * vaut nil et la PJ est ignorée silencieusement (`if (!data) continue`).
 * D'où un mail qui s'ouvre sans pièce jointe dès que le nom contient un
 * espace/accent. On décode donc avant de passer au composeur.
 */
export function toEmailAttachmentPath(uri: string): string {
  const clean = uri.split('#')[0].split('?')[0];
  try {
    return decodeURI(clean);
  } catch {
    return clean;
  }
}

/**
 * Envoie le fichier d'un téléchargement terminé par e-mail au destinataire.
 * Natif : composeur Mail (PJ) ou feuille de partage en repli.
 * Web/exe : téléchargement navigateur + mailto pré-rempli (sans PJ possible).
 */
export async function sendBookByEmail(
  item: { name: string; downloadDir: string },
  recipient: BookRecipient,
): Promise<BookSendResult> {
  const url = buildFileServerURL(item.downloadDir, item.name);
  if (!url) {
    throw new BookShareError('Dossier hors de l’arborescence du serveur de fichiers (/downloads).');
  }
  const { bytes } = await downloadBookBytes(url);
  const filename = sanitizeFileName(item.name);

  if (!Capacitor.isNativePlatform()) {
    // Web/exe : pas de composeur natif -> on télécharge le fichier et on
    // pré-remplit un mailto (pièce jointe à ajouter à la main).
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 20000);
    }
    const mailto = `mailto:${encodeURIComponent(recipient.email)}?subject=${encodeURIComponent(`[Livre] ${item.name}`)}&body=${encodeURIComponent(`Ci-joint : ${item.name} (fichier téléchargé à part, à joindre).`)}`;
    window.location.href = mailto;
    return 'shared';
  }

  const path = `ebooks/${Date.now()}-${filename}`;
  await Filesystem.writeFile({ path, data: bytesToBase64(bytes), directory: Directory.Cache, recursive: true });
  let uri: string;
  try {
    uri = (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
    // Échec d'écriture silencieux -> le composeur ouvrirait un mail sans PJ.
    await Filesystem.stat({ path, directory: Directory.Cache });
  } catch {
    await cleanupCacheFile(path);
    throw new BookShareError('Impossible de préparer la pièce jointe.');
  }

  const email = cordovaEmail();
  if (email && (await hasMailAccount(email))) {
    const outcome = await new Promise<string>((resolve) => {
      try {
        email.open(
          {
            to: [recipient.email],
            subject: `[Livre] ${item.name}`,
            body: `Envoi depuis Download Manager : ${item.name}`,
            isHtml: false,
            // Chemin décodé : voir toEmailAttachmentPath (espaces/accents).
            attachments: [toEmailAttachmentPath(uri)],
          },
          (result) => resolve(String(result ?? 'closed')),
        );
      } catch {
        resolve('error');
      }
    });
    await cleanupCacheFile(path);
    const lower = outcome.toLowerCase();
    if (lower.includes('cancel')) return 'cancelled';
    if (lower.includes('error')) {
      throw new BookShareError("Le composeur e-mail n'a pas pu s'ouvrir.");
    }
    return 'sent';
  }

  // Repli : feuille de partage iOS (choisir Mail, adresse à saisir).
  try {
    await Share.share({
      title: item.name,
      text: `Pour ${recipient.name} (${recipient.email})`,
      files: [uri],
    });
  } finally {
    await cleanupCacheFile(path);
  }
  return 'shared';
}
