# Déploiement — Download Manager Ionic

Serveur : `photos2` (SSH : `ssh photos2`).
URL publique : `http://photos2.dynaspirit.com:8080`.

## API PHP (`api-download-manager.php`)

- Source : `api-download-manager.php` à la racine du repo.
- Cible : `/srv/web/photos/api-download-manager.php` (monté dans le conteneur `php-php-1` en `/var/www/html/api-download-manager.php`).
- Commande : `scp api-download-manager.php photos2:/srv/web/photos/api-download-manager.php`
- Le conteneur n'a pas de PHP en PATH sur l'hôte : valider la syntaxe via
  `ssh photos2 'docker exec php-php-1 php -l /var/www/html/api-download-manager.php'`.
- Token auth : env `API_TOKEN` dans `/data/compose/11/.env` (jamais commité).
  Fumée : `curl -H "X-API-Token: $TOKEN" http://127.0.0.1:8080/api-download-manager.php?action=ping`
  (sur l'hôte ; en `$TOKEN=$(grep API_TOKEN /data/compose/11/.env | cut -d= -f2)`).

## PWA (onglet Catalogue / app web)

- Build : `npm run build` → `dist/` (le `.htaccess` vient de `public/.htaccess`,
  fallback SPA `RewriteBase /download-manager/`).
- Cible : `/srv/web/photos/download-manager/` — URL `http://photos2.dynaspirit.com:8080/download-manager/`.
- Pas de rsync côté serveur : purger les vieux bundles hashés puis copier :
  ```bash
  ssh photos2 'rm -rf /srv/web/photos/download-manager/assets && mkdir -p /srv/web/photos/download-manager/assets'
  scp -r dist/assets photos2:/srv/web/photos/download-manager/
  scp dist/index.html dist/sw.js dist/manifest.webmanifest dist/favicon.svg dist/apple-touch-icon.png dist/pwa-192x192.png dist/pwa-512x512.png dist/pwa-maskable-512x512.png dist/.htaccess photos2:/srv/web/photos/download-manager/
  ```
  (`dist/*` seul oublierait `.htaccess`, fichier caché.)
- Vérif : la page servie doit référencer le même bundle que `dist/index.html`
  (`curl -s http://photos2.dynaspirit.com:8080/download-manager/ | grep -o 'assets/index-[^"]*\.js'`).

## Notes

- Ne déployer la PWA qu'après `npx tsc --noEmit` + `npm run build` verts.
- Ne committer ni token ni clé API (C411/TR4KER/TMDB/Gemini restent côté app / Réglages).
