<?php
/*
    API « DownloadManager » — persistance serveur des suggestions IA marquées « déjà vu ».

    Déploiement :  ssh photos2
                    cp api-download-manager.php /srv/web/photos/api-download-manager.php
    URL :           http://photos2.dynaspirit.com:8080/api-download-manager.php

    Prérequis serveur : php-sqlite3 (extension pdo_sqlite) + dossier writable
                        (la base download-manager.sqlite est créée à côté du script).

    SÉCURITÉ :
      1. Token via variable d'env docker (compose: environment API_TOKEN,
         valeur dans /data/compose/11/.env, jamais commitée) ; à recopier
         dans l'app : Réglages > Synchro vus > Token.
      2. HTTP clair + token = OK en perso/LAN (même hôte que Plex/Transmission,
         déjà exempté ATS côté iOS), mais passe en HTTPS si exposé sur internet.

    Actions (token via header X-API-Token, ou ?token= en repli) :
      GET  ?action=ping                          → {ok:true, time}
      GET  ?action=list                          → {ok:true, seen:[{t,y,at}]}
      POST ?action=add   {title, year?}          → {ok:true}
      POST ?action=clear                         → {ok:true}
      Séries suivies :
      GET  ?action=subs_list                     → {ok:true, subs:[{id,title,query,year,enabled,lastSeason,lastEpisode,addedKeys,createdAt,lastCheckAt,lastResult}]}
      POST ?action=subs_upsert {sub:{...}}       → {ok:true} (last-writer-wins, fusion côté app)
      POST ?action=subs_remove {id}              → {ok:true}
      Fichiers (rattrapage si Transmission oublie des données) :
      POST ?action=files_wipe {location, name}   → {ok:true, deleted:bool}
        location = downloadDir de session (ex /downloads/films),
        name = racine du torrent (fichier ou dossier, sans slash).
        Cage stricte : seuls les dossiers montés sont autorisés.
      Espace disque (barre d'état onglet Transmission) :
      GET  ?action=disk_space[&path=/downloads/series]
                                             → {ok:true, free, total, path}
        free/total en octets (disk_free_space/disk_total_space).
        path = location session (défaut /downloads) ; cage WIPE_MAP.
      Config centralisée (Réglages app : 1 token synchro → tout récupéré) :
      GET  ?action=config_get                  → {ok:true, config:{clé:valeur}, updatedAt}
      POST ?action=config_set {config:{...}}   → {ok:true, saved:n}
        Seules les clés de CONFIG_KEYS sont acceptées/stockées (table
        app_config : clé → valeur + updated_at). Volontairement exclus :
        seen_sync_url (l'app connaît déjà l'URL qu'elle appelle) et
        seen_sync_token (c'est le secret d'auth lui-même).
*/
declare(strict_types=1);

// ================= CONFIG =================
// Token lu depuis l'env docker (compose: API_TOKEN), repli sur la
// constante ci-dessous pour un hébergement sans docker. Ne laisse JAMAIS
// le placeholder actif : l'API refuse de démarrer dans ce cas.
const API_TOKEN = 'CHANGE-MOI-par-une-chaine-aleatoire-longue';
const DB_FILE = __DIR__ . '/data/download-manager.sqlite';
const SEEN_MAX = 500;
// ==========================================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-API-Token');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function out(array $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    out(['ok' => false, 'error' => $msg], $code);
}

/** Même normalisation que l'app (accents, casse, ponctuation, &/and). */
function seen_norm(string $s): string
{
    $s = str_replace('&', ' and ', $s);
    $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
    $s = $t === false ? $s : $t;
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9]+/', ' ', $s) ?? '';
    return trim($s);
}

// ---- Auth (toutes les actions, lecture incluse : l'historique est privé) ----
$token = '';
if (function_exists('getallheaders')) {
    $headers = getallheaders();
    foreach ($headers as $k => $v) {
        if (strtolower((string) $k) === 'x-api-token') {
            $token = (string) $v;
            break;
        }
    }
}
if ($token === '') {
    $token = (string) ($_GET['token'] ?? '');
}
$envToken = getenv('API_TOKEN');
$expected = ($envToken !== false && $envToken !== '') ? $envToken : API_TOKEN;
if ($expected === '' || $expected === 'CHANGE-MOI-par-une-chaine-aleatoire-longue') {
    fail('API non configurée (API_TOKEN manquant).', 500);
}
if (!hash_equals($expected, $token)) {
    fail('Token invalide.', 401);
}

// ---- Base SQLite (créée au 1er appel) ----
try {
    $db = new PDO('sqlite:' . DB_FILE);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec(
        'CREATE TABLE IF NOT EXISTS seen_suggestions (
            key TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            year TEXT NOT NULL DEFAULT \'\',
            seen_at INTEGER NOT NULL
        )'
    );
    $db->exec('CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_suggestions(seen_at)');
    $db->exec(
        'CREATE TABLE IF NOT EXISTS series_subs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            query TEXT NOT NULL,
            year TEXT NOT NULL DEFAULT \'\',
            enabled INTEGER NOT NULL DEFAULT 1,
            last_season INTEGER NOT NULL DEFAULT 0,
            last_episode INTEGER NOT NULL DEFAULT 0,
            added_keys TEXT NOT NULL DEFAULT \'[]\',
            created_at INTEGER NOT NULL DEFAULT 0,
            last_check_at INTEGER NOT NULL DEFAULT 0,
            last_result TEXT NOT NULL DEFAULT \'\'
        )'
    );
    // Migration douce : colonne ajoutée après coup (ignore si déjà là).
    try {
        $db->exec('ALTER TABLE series_subs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    } catch (Throwable $e) {
        /* colonne déjà présente */
    }
    // Config centralisée : paramètres app (transmission, plex, clés API...).
    $db->exec(
        'CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT \'\',
            updated_at INTEGER NOT NULL DEFAULT 0
        )'
    );
} catch (Throwable $e) {
    fail('SQLite indisponible (php-sqlite3 ? dossier writable ?) : ' . $e->getMessage(), 500);
}

$action = (string) ($_GET['action'] ?? 'ping');

if ($action === 'ping') {
    out(['ok' => true, 'time' => time()]);
}

if ($action === 'list') {
    $stmt = $db->prepare('SELECT title, year, seen_at FROM seen_suggestions ORDER BY seen_at DESC LIMIT ' . (int) SEEN_MAX);
    $stmt->execute();
    $seen = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $seen[] = ['t' => (string) $row['title'], 'y' => (string) $row['year'], 'at' => (int) $row['seen_at']];
    }
    out(['ok' => true, 'seen' => $seen]);
}

if ($action === 'add') {
    $input = json_decode(file_get_contents('php://input') ?: 'null', true);
    if (!is_array($input)) {
        fail('Corps JSON invalide.', 400);
    }
    $title = trim((string) ($input['title'] ?? ''));
    $year = trim((string) ($input['year'] ?? ''));
    if ($title === '') {
        fail('Titre manquant.', 400);
    }
    $key = seen_norm($title);
    if ($key === '') {
        fail('Titre invalide.', 400);
    }
    $stmt = $db->prepare('INSERT OR REPLACE INTO seen_suggestions (key, title, year, seen_at) VALUES (:k, :t, :y, :at)');
    $stmt->execute([':k' => $key, ':t' => $title, ':y' => $year, ':at' => time()]);
    // Plafond : garde les plus récents.
    $db->exec(
        'DELETE FROM seen_suggestions WHERE key NOT IN ' .
        '(SELECT key FROM seen_suggestions ORDER BY seen_at DESC LIMIT ' . (int) SEEN_MAX . ')'
    );
    out(['ok' => true]);
}

if ($action === 'clear') {
    $db->exec('DELETE FROM seen_suggestions');
    out(['ok' => true]);
}

// ---------- Séries suivies ----------

function row_to_sub(array $row): array
{
    $keys = json_decode((string) ($row['added_keys'] ?? '[]'), true);
    if (!is_array($keys)) {
        $keys = [];
    }
    return [
        'id' => (string) $row['id'],
        'title' => (string) $row['title'],
        'query' => (string) $row['query'],
        'year' => (string) $row['year'],
        'enabled' => ((int) $row['enabled']) === 1,
        'lastSeason' => (int) $row['last_season'],
        'lastEpisode' => (int) $row['last_episode'],
        'addedKeys' => array_values(array_filter(array_map('strval', $keys))),
        'createdAt' => (int) $row['created_at'],
        'lastCheckAt' => (int) $row['last_check_at'],
        'lastResult' => (string) $row['last_result'],
        'updatedAt' => isset($row['updated_at']) ? (int) $row['updated_at'] : 0,
    ];
}

if ($action === 'subs_list') {
    $stmt = $db->query('SELECT * FROM series_subs ORDER BY title ASC');
    $subs = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $subs[] = row_to_sub($row);
    }
    out(['ok' => true, 'subs' => $subs]);
}

if ($action === 'subs_upsert') {
    $input = json_decode(file_get_contents('php://input') ?: 'null', true);
    $sub = (is_array($input) ? $input['sub'] : null);
    if (!is_array($sub)) {
        fail('Champ sub manquant.', 400);
    }
    $id = trim((string) ($sub['id'] ?? ''));
    $title = trim((string) ($sub['title'] ?? ''));
    if ($id === '' || $title === '') {
        fail('Abonnement invalide (id/titre requis).', 400);
    }
    $keys = $sub['addedKeys'] ?? [];
    if (!is_array($keys)) {
        $keys = [];
    }
    $keys = array_values(array_slice(array_filter(array_map('strval', $keys)), 0, 500));
    $stmt = $db->prepare(
        'INSERT OR REPLACE INTO series_subs
         (id, title, query, year, enabled, last_season, last_episode, added_keys, created_at, last_check_at, last_result, updated_at)
         VALUES (:id, :title, :query, :year, :enabled, :ls, :le, :keys, :ca, :lca, :lr, :ua)'
    );
    $stmt->execute([
        ':id' => $id,
        ':title' => $title,
        ':query' => trim((string) ($sub['query'] ?? $title)),
        ':year' => trim((string) ($sub['year'] ?? '')),
        ':enabled' => !empty($sub['enabled']) ? 1 : 0,
        ':ls' => (int) ($sub['lastSeason'] ?? 0),
        ':le' => (int) ($sub['lastEpisode'] ?? 0),
        ':keys' => json_encode($keys, JSON_UNESCAPED_UNICODE),
        ':ca' => (int) ($sub['createdAt'] ?? time()),
        ':lca' => (int) ($sub['lastCheckAt'] ?? 0),
        ':lr' => trim((string) ($sub['lastResult'] ?? '')),
        ':ua' => (int) ($sub['updatedAt'] ?? time()),
    ]);
    out(['ok' => true]);
}

if ($action === 'subs_remove') {
    $input = json_decode(file_get_contents('php://input') ?: 'null', true);
    $id = trim((string) ((is_array($input) ? $input['id'] : null) ?? ''));
    if ($id === '') {
        fail('Id manquant.', 400);
    }
    $stmt = $db->prepare('DELETE FROM series_subs WHERE id = :id');
    $stmt->execute([':id' => $id]);
    out(['ok' => true]);
}

// ---------- Fichiers (rattrapage effacement Transmission) ----------

// Chemins session Transmission → chemins conteneur (montages docker).
// Toute location hors de cette liste est refusée (403).
const WIPE_MAP = [
    '/downloads/films' => '/var/www/html/dl-films',
    '/downloads/series' => '/var/www/html/dl-series',
    '/downloads/complete' => '/var/www/html/dl-complete',
    '/downloads/incomplete' => '/var/www/html/dl-incomplete',
    '/downloads/musique' => '/var/www/html/dl-musique',
    '/downloads/oculus' => '/var/www/html/oculus',
    '/downloads/livres' => '/var/www/html/livres',
];

/** Suppression récursive sans suivre les liens symboliques. */
function rm_rf(string $path): void
{
    if (is_link($path) || is_file($path)) {
        @unlink($path);
        return;
    }
    if (!is_dir($path)) {
        return;
    }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $f) {
        if ($f->isLink() || $f->isFile()) {
            @unlink($f->getPathname());
        } elseif ($f->isDir()) {
            @rmdir($f->getPathname());
        }
    }
    @rmdir($path);
}

if ($action === 'files_wipe') {
    $input = json_decode(file_get_contents('php://input') ?: 'null', true);
    $location = trim((string) ((is_array($input) ? $input['location'] : null) ?? ''));
    $name = trim((string) ((is_array($input) ? $input['name'] : null) ?? ''));
    // name = racine du torrent uniquement : aucun slash, aucun traversal.
    if ($name === '' || str_contains($name, '/') || str_contains($name, "\0") || $name === '.' || $name === '..') {
        fail('Nom invalide.', 400);
    }
    $base = null;
    foreach (WIPE_MAP as $prefix => $dir) {
        if ($location === $prefix || str_starts_with($location, $prefix . '/')) {
            $base = $dir . substr($location, strlen($prefix));
            break;
        }
    }
    if ($base === null) {
        fail('Emplacement non autorisé.', 403);
    }
    $target = $base . '/' . $name;
    // Cage : le parent réel doit exister et rester sous la racine autorisée.
    $realParent = realpath(dirname($target));
    $realBase = realpath($base);
    if ($realParent === false || $realBase === false || ($realParent !== $realBase && !str_starts_with($realParent, $realBase . '/'))) {
        fail('Emplacement non autorisé.', 403);
    }
    if (!file_exists($target) && !is_link($target)) {
        out(['ok' => true, 'deleted' => false]); // déjà parti (daemon OK)
    }
    rm_rf($target);
    out(['ok' => true, 'deleted' => !file_exists($target) && !is_link($target)]);
}

// ---------- Espace disque (barre d'état onglet Transmission) ----------

if ($action === 'disk_space') {
    $location = trim((string) ($_GET['path'] ?? ''));
    if ($location === '' || $location === '/downloads') {
        // Racine commune : même filesystem que tous les dl-*.
        $dir = '/var/www/html';
        $location = '/downloads';
    } else {
        // Même cage que files_wipe : préfixes WIPE_MAP uniquement.
        $dir = null;
        foreach (WIPE_MAP as $prefix => $cdir) {
            if ($location === $prefix || str_starts_with($location, $prefix . '/')) {
                $dir = $cdir . substr($location, strlen($prefix));
                break;
            }
        }
        if ($dir === null) {
            fail('Emplacement non autorisé.', 403);
        }
    }
    $free = @disk_free_space($dir);
    $total = @disk_total_space($dir);
    if ($free === false || $total === false) {
        fail('Lecture espace disque impossible.', 500);
    }
    out(['ok' => true, 'free' => (int) $free, 'total' => (int) $total, 'path' => $location]);
}

// ---------- Config centralisée (1 token synchro → tous les paramètres) ----------

// Noms = clés localStorage de l'app (services/settings.ts > Keys).
// seen_sync_url / seen_sync_token volontairement exclus (bootstrap/auth).
const CONFIG_KEYS = [
    'transmission_rpc_url_string',
    'transmission_username',
    'transmission_password',
    'transmission_folder_films_path',
    'transmission_folder_series_path',
    'transmission_folder_musique_path',
    'transmission_folder_livres_path',
    'file_server_base_url',
    'file_server_username',
    'file_server_password',
    'tr4ker_api_key',
    'gemini_api_key',
    'gemini_model',
    'plex_use_cloud',
    'plex_base_url',
    'plex_token',
    'plex_section_keys_csv',
    'plex_media_filter',
    'plex_watch_filter',
    'plex_display_mode',
    'download_notifications_enabled',
    'download_poll_interval_seconds',
];
const CONFIG_VALUE_MAX = 4000;

if ($action === 'config_get') {
    $placeholders = implode(',', array_fill(0, count(CONFIG_KEYS), '?'));
    $stmt = $db->prepare("SELECT key, value FROM app_config WHERE key IN ($placeholders)");
    $stmt->execute(CONFIG_KEYS);
    $config = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $config[(string) $row['key']] = (string) $row['value'];
    }
    $updatedAt = 0;
    try {
        $updatedAt = (int) $db->query('SELECT COALESCE(MAX(updated_at), 0) FROM app_config')->fetchColumn();
    } catch (Throwable $e) {
        /* ignore */
    }
    out(['ok' => true, 'config' => $config, 'updatedAt' => $updatedAt]);
}

if ($action === 'config_set') {
    $input = json_decode(file_get_contents('php://input') ?: 'null', true);
    $config = (is_array($input) ? $input['config'] : null);
    if (!is_array($config)) {
        fail('Champ config manquant.', 400);
    }
    $allowed = array_flip(CONFIG_KEYS);
    $stmt = $db->prepare(
        'INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (:k, :v, :at)'
    );
    $now = time();
    $saved = 0;
    foreach ($config as $k => $v) {
        $k = (string) $k;
        if (!isset($allowed[$k])) {
            continue; // clé inconnue : ignorée (pas d'erreur, compat ascendante)
        }
        $v = trim((string) (is_scalar($v) ? $v : ''));
        if (strlen($v) > CONFIG_VALUE_MAX) {
            $v = substr($v, 0, CONFIG_VALUE_MAX);
        }
        $stmt->execute([':k' => $k, ':v' => $v, ':at' => $now]);
        $saved++;
    }
    out(['ok' => true, 'saved' => $saved]);
}

fail('Action inconnue (ping, list, add, clear, subs_list, subs_upsert, subs_remove, files_wipe, disk_space, config_get, config_set).', 400);
