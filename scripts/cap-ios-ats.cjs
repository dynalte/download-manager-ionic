/**
 * Exceptions ATS (App Transport Security) pour le serveur perso + LAN.
 *
 * Transmission (:9091) et Plex (:32400) sont servis en HTTP clair sur
 * photos2.dynaspirit.com. Sans exception, iOS bloque tout HTTP (le fetch
 * échoue avec "Load failed"). `server.cleartext` de Capacitor ne couvre
 * qu'Android : ce script injecte NSExceptionDomains dans
 * ios/App/App/Info.plist (idempotent, préservé par `cap sync` mais pas
 * par `cap add` -> d'où son exécution après chaque sync).
 *
 * NSAllowsLocalNetworking (iOS 14+) autorise en plus le HTTP clair vers
 * les adresses locales (192.168.x.x, 10.x, etc.) : indispensable pour
 * piloter les lecteurs Plex en direct (Fire TV :32500, Roku :8324).
 * Sans ça, le repli direct est bloqué par ATS et seule la commande
 * relayée par le serveur peut fonctionner.
 */
const fs = require('fs');
const path = require('path');

const PLIST = path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist');
const DOMAIN = 'photos2.dynaspirit.com';

const ATS_BLOCK = [
  '\t<key>NSAppTransportSecurity</key>',
  '\t<dict>',
  '\t\t<key>NSAllowsLocalNetworking</key>',
  '\t\t<true/>',
  '\t\t<key>NSExceptionDomains</key>',
  '\t\t<dict>',
  `\t\t\t<key>${DOMAIN}</key>`,
  '\t\t\t<dict>',
  '\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>',
  '\t\t\t\t<true/>',
  '\t\t\t\t<key>NSIncludesSubdomains</key>',
  '\t\t\t\t<true/>',
  '\t\t\t</dict>',
  '\t\t</dict>',
  '\t</dict>',
].join('\n');

function main() {
  if (!fs.existsSync(PLIST)) {
    console.log(`[ats] ${PLIST} introuvable (plateforme iOS non ajoutée ?) : rien à faire.`);
    return;
  }
  const src = fs.readFileSync(PLIST, 'utf8');
  if (src.includes('NSAppTransportSecurity') && src.includes(DOMAIN)) {
    if (!src.includes('NSAllowsLocalNetworking')) {
      const out = src.replace(
        '<key>NSAppTransportSecurity</key>\n\t<dict>',
        '<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>',
      );
      if (out !== src) {
        fs.writeFileSync(PLIST, out);
        console.log('[ats] NSAllowsLocalNetworking ajouté (commande directe Fire TV en LAN).');
        return;
      }
    }
    console.log('[ats] Exceptions ATS déjà présentes.');
    return;
  }
  if (src.includes('NSAppTransportSecurity')) {
    console.error('[ats] NSAppTransportSecurity existe déjà sans le domaine : édition manuelle requise.');
    process.exit(1);
  }
  const idx = src.lastIndexOf('</dict>');
  if (idx === -1) {
    console.error('[ats] Info.plist invalide (pas de </dict>).');
    process.exit(1);
  }
  const out = `${src.slice(0, idx)}${ATS_BLOCK}\n${src.slice(idx)}`;
  fs.writeFileSync(PLIST, out);
  console.log(`[ats] Exception ATS ajoutée pour ${DOMAIN}.`);
}

main();
