// Génère les déclinaisons d'icône depuis assets/icon.svg :
// icon.png (1024), tailles intermédiaires, icon.ico (multi-résolution Win),
// favicon web (public/). Usage : node scripts/make-icons.cjs
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = path.join(root, 'assets', 'icon.svg');

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
