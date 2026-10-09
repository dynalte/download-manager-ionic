/**
 * Envoi d'e-books (dossier "livres") par e-mail : liseuses Kindle de
 * Stéphanie / Anaïs / Timéa + adresse de test de Nicolas.
 *
 * Chaîne : fichier rapatrié depuis le serveur https même origine (Basic Auth,
 * pas de mixed-content ni CORS) -> écrit dans le cache -> composeur Mail
 * natif (cordova-plugin-email, destinataire + pièce jointe) avec repli
 * feuille de partage iOS.
 * Hors natif (PWA/web) : Web Share API avec fichier (vrai PJ vers Mail/Gmail)
 * quand dispo, sinon téléchargement navigateur + mailto pré-rempli (sans PJ).
 *
 * Multi-fichiers : si le torrent est un dossier, le fichier interne est
 * choisi via fetchTorrentFiles (transmission.ts) puis téléchargé sous
 * <base>/livres/<Dossier>/<fichier> (même racine que le single-file).
 *
 * Note : le serveur de fichiers n'envoie pas de headers CORS, donc le
 * fetch WebView est bloqué ("Load failed"). En natif on passe par
 * CapacitorHttp (requête URLSession, non soumise à la SOP).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { folderForDownloadDir, settings } from './settings';
import { isServerConfigured, serverApi } from './serverApi';

export interface BookRecipient {
  id: string;
  name: string;
  email: string;
}

export const BOOK_RECIPIENTS: BookRecipient[] = [
  { id: 'stephanie', name: 'Stéphanie (Kindle)', email: 'steph.royer_48@kindle.com' },
  { id: 'anais', name: 'Anaïs (Kindle)', email: 'royer91.a_ekjnju@kindle.com' },
  { id: 'timea', name: 'Timéa (Kindle)', email: 'royer.timea_gbdHFl@kindle.com' },
  { id: 'nicolas', name: 'Nicolas (test)', email: 'royer.nicolas@gmail.com' },
];

export type BookSendResult = 'sent' | 'cancelled' | 'shared';

export class BookShareError extends Error {}

/** Extensions envoyables vers Kindle (Send-to-Kindle : epub, pdf, mobi, azw...). */
export const BOOK_EBOOK_EXTENSIONS = ['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.kfx', '.txt'] as const;

/** Vrai si le chemin se termine par une extension d'e-book envoyable. */
export function isEbookFileName(path: string): boolean {
  const lower = path.trim().toLowerCase();
  return BOOK_EBOOK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Vrai si le nom du torrent est déjà un fichier envoyable en direct
 * (single-file). Sinon c'est un dossier -> torrent multi-fichiers : il faut
 * choisir un fichier interne via fetchTorrentFiles + isEbookFileName.
 */
export function isSingleEbookFile(torrentName: string): boolean {
  return isEbookFileName(torrentName);
}

/** Ne garde que les fichiers internes envoyables, triés par nom. */
export function filterEbookFiles(names: string[]): string[] {
  return names.filter(isEbookFileName).sort((a, b) => a.localeCompare(b));
}

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
  return buildFileServerURLForRelativePath(downloadDir, name.trim());
}

/**
 * Construit l'URL d'un chemin relatif au download-dir Transmission.
 * - single-file : relativePath = nom du torrent ("Mon Livre.epub").
 * - multi-fichiers : relativePath = chemin interne Transmission
 *   ("Mon.Dossier/file.epub", inclut en général le dossier racine). Si le
 *   chemin inclut déjà le nom du torrent on l'utilise tel quel, sinon on le
 *   préfixe (vieilles versions / cas limites).
 */
export function buildFileServerURLForRelativePath(
  downloadDir: string,
  relativePath: string,
  torrentName?: string,
): string | null {
  const base = settings.fileServerBaseURL;
  if (!base) return null;
  const dir = downloadDir.trim().replace(/\/+$/, '');
  let rel: string;
  if (dir === DOWNLOADS_PREFIX) rel = '/';
  else if (dir.startsWith(`${DOWNLOADS_PREFIX}/`)) rel = dir.slice(DOWNLOADS_PREFIX.length);
  else return null;
  const relPath = relativePath.trim().replace(/^\/+/, '');
  if (!relPath) return null;
  const tName = (torrentName ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  let full = `${rel}/${relPath}`;
  if (tName !== '' && !relPath.startsWith(`${tName}/`) && relPath !== tName) {
    full = `${rel}/${tName}/${relPath}`;
  }
  const segs = full
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

function checkBookStatus(status: number, targetLabel?: string): void {
  if (status === 401) {
    throw new BookShareError('Serveur de fichiers : accès refusé (identifiants dans Réglages).');
  }
  if (status === 403) {
    // Apache interdit le listage des dossiers : un 403 sur une cible sans
    // extension d'e-book = torrent multi-fichiers (on a visé le dossier).
    if (targetLabel && !isEbookFileName(targetLabel)) {
      throw new BookShareError(
        'Cible invalide : c’est un dossier, pas un fichier (torrent multi-fichiers). Choisis un .epub/.pdf à l’intérieur.',
      );
    }
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
async function downloadBookBytesNative(url: string, targetLabel?: string): Promise<{ bytes: Uint8Array; contentType: string }> {
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
  checkBookStatus(res.status, targetLabel);
  const contentType =
    (Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] as string) ?? '';
  const bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data ?? []);
  checkBookBytes(bytes, contentType);
  return { bytes, contentType };
}

async function downloadBookBytes(url: string, targetLabel?: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (Capacitor.isNativePlatform()) return downloadBookBytesNative(url, targetLabel);
  const res = await fetch(url, { headers: basicAuthHeader() });
  checkBookStatus(res.status, targetLabel);
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

/** Type MIME pour la pièce jointe partagée (défaut générique). */
function guessBookMimeType(filename: string, contentType: string): string {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct && ct !== 'application/octet-stream') return ct;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.epub')) return 'application/epub+zip';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mobi') || lower.endsWith('.azw') || lower.endsWith('.azw3') || lower.endsWith('.kfx')) {
    return 'application/x-mobipocket-ebook';
  }
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * Partage web avec fichier (PWA/mobile) : null si indisponible (repli
 * download + mailto par l'appelant), 'cancelled' si l'utilisateur annule.
 * Un refus du navigateur (ex: geste utilisateur expiré) vaut aussi null.
 */
async function shareBookFileWeb(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
  displayName: string,
  recipient: BookRecipient,
): Promise<BookSendResult | null> {
  try {
    if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return null;
    const file = new File([bytes.buffer as ArrayBuffer], filename, { type: guessBookMimeType(filename, contentType) });
    if (!navigator.canShare({ files: [file] })) return null;
    await navigator.share({
      title: `[Livre] ${displayName}`,
      text: `Pour ${recipient.name} (${recipient.email}) : ${displayName}`,
      files: [file],
    });
    return 'shared';
  } catch (e) {
    // Annulation utilisateur -> on ne bascule pas sur le repli download.
    if (e instanceof Error && (e.name === 'AbortError' || /abort|cancel/i.test(e.message))) return 'cancelled';
    return null;
  }
}

/**
 * Envoie le fichier d'un téléchargement terminé par e-mail au destinataire.
 * Natif : composeur Mail (PJ) ou feuille de partage en repli.
 * Web/exe : téléchargement navigateur + mailto pré-rempli (sans PJ possible).
 *
 * Multi-fichiers : si le torrent est un dossier, passe `innerFile` = chemin
 * interne Transmission (ex: "Mon.Dossier/file.epub", cf. fetchTorrentFiles).
 * Sans innerFile et avec un nom de dossier -> erreur explicite (pas de 403
 * "accès refusé" trompeur).
 */
export async function sendBookByEmail(
  item: { name: string; downloadDir: string },
  recipient: BookRecipient,
  opts?: { innerFile?: string },
): Promise<BookSendResult> {
  const inner = opts?.innerFile?.trim() ?? '';
  if (!inner && !isSingleEbookFile(item.name)) {
    throw new BookShareError(
      'Cible invalide : c’est un dossier, pas un fichier (torrent multi-fichiers). Choisis un .epub/.pdf à l’intérieur.',
    );
  }
  const targetLabel = inner !== '' ? inner : item.name;
  // Envoi côté serveur en priorité (synchro configurée) : le PHP joint le
  // fichier et l'envoie en SMTP (indispensable sur PWA où mailto: ne peut
  // pas joindre de PJ). Repli local si le PHP est trop vieux pour book_send.
  if (isServerConfigured()) {
    try {
      await serverApi('book_send', {
        downloadDir: item.downloadDir,
        name: item.name,
        innerFile: inner !== '' ? inner : undefined,
        to: recipient.email,
      });
      return 'sent';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/action inconnue/i.test(msg)) throw new BookShareError(`Envoi serveur : ${msg}`);
    }
  }
  const url = inner !== ''
    ? buildFileServerURLForRelativePath(item.downloadDir, inner, item.name)
    : buildFileServerURL(item.downloadDir, item.name);
  if (!url) {
    throw new BookShareError('Dossier hors de l’arborescence du serveur de fichiers (/downloads).');
  }
  const { bytes, contentType } = await downloadBookBytes(url, targetLabel);
  // Nom de PJ = nom du fichier réel (pas du dossier racine).
  const filename = sanitizeFileName(targetLabel.split('/').pop() ?? item.name);
  const displayName = filename;

  if (!Capacitor.isNativePlatform()) {
    // Web/PWA : Web Share API niveau 2 (Safari iOS 15+, Chrome Android) ->
    // vraie pièce jointe vers Mail/Gmail. Le destinataire n'est pas
    // pré-remplissable : on le rappelle dans le texte.
    const shared = await shareBookFileWeb(bytes, contentType, filename, displayName, recipient);
    if (shared !== null) return shared;
    // Repli : téléchargement navigateur + mailto pré-rempli (PJ à la main).
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
    const mailto = `mailto:${encodeURIComponent(recipient.email)}?subject=${encodeURIComponent(`[Livre] ${displayName}`)}&body=${encodeURIComponent(`Ci-joint : ${displayName} (fichier téléchargé à part, à joindre).`)}`;
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
            subject: `[Livre] ${displayName}`,
            body: `Envoi depuis Download Manager : ${displayName}`,
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
      title: displayName,
      text: `Pour ${recipient.name} (${recipient.email})`,
      files: [uri],
    });
  } finally {
    await cleanupCacheFile(path);
  }
  return 'shared';
}
