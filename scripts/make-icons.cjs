// Génère les déclinaisons d'icône depuis assets/icon.svg :
// icon.png (1024), tailles intermédiaires, icon.ico (multi-résolution Win),
// favicon web (public/), AppIcon iOS (Assets.xcassets). Usage : node scripts/make-icons.cjs
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = path.join(root, 'assets', 'icon.svg');

// Variante iOS : fond dégradé plein-bord (iOS applique son propre masque
// squircle et refuse la transparence).
function iosSvg() {
  const src = fs.readFileSync(svg, 'utf8');
  return src
    .replace('x="64" y="64" width="896" height="896" rx="230" fill="url(#bg)"', 'x="0" y="0" width="1024" height="1024" fill="url(#bg)"')
    .replace('x="64" y="64" width="896" height="896" rx="230" fill="url(#shine)"', 'x="0" y="0" width="1024" height="1024" fill="url(#shine)"');
}

// Jeu AppIcon iOS (iPhone + iPad + marketing 1024).
const IOS_ICONS = [
  { size: 180, idiom: 'iphone', scale: '3x', name: 'AppIcon-60@3x.png' },
  { size: 120, idiom: 'iphone', scale: '2x', name: 'AppIcon-60@2x.png' },
  { size: 87, idiom: 'iphone', scale: '3x', name: 'AppIcon-29@3x.png' },
  { size: 80, idiom: 'iphone', scale: '2x', name: 'AppIcon-40@2x.png' },
  { size: 58, idiom: 'iphone', scale: '2x', name: 'AppIcon-29@2x.png' },
  { size: 40, idiom: 'iphone', scale: '2x', name: 'AppIcon-20@2x.png' },
  { size: 167, idiom: 'ipad', scale: '2x', name: 'AppIcon-83.5@2x.png' },
  { size: 152, idiom: 'ipad', scale: '2x', name: 'AppIcon-76@2x.png' },
  { size: 80, idiom: 'ipad', scale: '2x', name: 'AppIcon-40@2x.png' },
  { size: 58, idiom: 'ipad', scale: '2x', name: 'AppIcon-29@2x.png' },
  { size: 40, idiom: 'ipad', scale: '2x', name: 'AppIcon-20@2x.png' },
  { size: 1024, idiom: 'ios-marketing', scale: '1x', name: 'AppIcon-1024.png' },
];

async function makeIosIcons(sharp) {
  const dir = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
  if (!fs.existsSync(dir)) {
    console.log('iOS : pas de dossier AppIcon (plateforme non ajoutée), ignoré.');
    return;
  }
  const src = Buffer.from(iosSvg());
  const images = [];
  for (const icon of IOS_ICONS) {
    const out = path.join(dir, icon.name);
    await sharp(src, { density: 256 }).resize(icon.size, icon.size).flatten({ background: '#4F46E5' }).png().toFile(out);
    const base = icon.size / parseInt(icon.scale, 10);
    images.push({ size: `${base}x${base}`, idiom: icon.idiom, filename: icon.name, scale: icon.scale });
  }
  // Nettoie l'ancien visuel Capacitor s'il reste.
  for (const f of fs.readdirSync(dir)) {
    if (f !== 'Contents.json' && !IOS_ICONS.some((i) => i.name === f)) fs.unlinkSync(path.join(dir, f));
  }
  fs.writeFileSync(
    path.join(dir, 'Contents.json'),
    JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n',
  );
  console.log(`iOS : ${IOS_ICONS.length} icônes AppIcon générées (fond plein, sans alpha).`);
}

async function main() {
  const sharp = require('sharp');
  const pngToIcoMod = require('png-to-ico');
  const pngToIco = pngToIcoMod.default || pngToIcoMod;

  const sizes = [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024];
  const tmp = [];
  for (const s of sizes) {
    const out = path.join(root, 'assets', `.icon-${s}.png`);
    await sharp(svg, { density: 512 }).resize(s, s).png().toFile(out);
    tmp.push(out);
  }
  // Master PNG + Apple touch + favicon PNG.
  fs.copyFileSync(path.join(root, 'assets', '.icon-1024.png'), path.join(root, 'assets', 'icon.png'));
  fs.copyFileSync(path.join(root, 'assets', '.icon-180.png'), path.join(root, 'public', 'apple-touch-icon.png'));
  fs.copyFileSync(path.join(root, 'assets', 'icon.svg'), path.join(root, 'public', 'favicon.svg'));

  // ICO Windows multi-résolutions.
  const ico = await pngToIco([
    path.join(root, 'assets', '.icon-16.png'),
    path.join(root, 'assets', '.icon-24.png'),
    path.join(root, 'assets', '.icon-32.png'),
    path.join(root, 'assets', '.icon-48.png'),
    path.join(root, 'assets', '.icon-64.png'),
    path.join(root, 'assets', '.icon-128.png'),
    path.join(root, 'assets', '.icon-256.png'),
  ]);
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);

  for (const f of tmp) fs.unlinkSync(f);
  console.log('icones OK : assets/icon.png, assets/icon.ico, public/favicon.svg, public/apple-touch-icon.png');
  await makeIosIcons(sharp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
