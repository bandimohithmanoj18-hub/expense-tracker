import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const requiredAssets = [
  'index.html',
  'app.js',
  'styles.css',
  'favicon.svg',
  'manifest.webmanifest',
  'sw.js',
  'icons/apple-touch-icon.png',
  'icons/spendwise-192.png',
  'icons/spendwise-512.png',
];

for (const asset of requiredAssets) {
  const file = path.join(publicRoot, asset);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing public app asset: ${asset}`);
}

const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(publicRoot, 'manifest.webmanifest'), 'utf8'));
if (manifest.id !== '/' || manifest.scope !== '/' || manifest.display !== 'standalone') {
  throw new Error('The web app manifest is missing stable install settings.');
}
for (const size of [192, 512]) {
  if (!manifest.icons?.some(icon => icon.sizes === `${size}x${size}` && icon.type === 'image/png')) {
    throw new Error(`The web app manifest is missing its ${size}x${size} PNG icon.`);
  }
  const iconPath = path.join(publicRoot, `icons/spendwise-${size}.png`);
  const icon = await readFile(iconPath);
  if (icon.readUInt32BE(16) !== size || icon.readUInt32BE(20) !== size) {
    throw new Error(`The ${size}x${size} app icon has incorrect dimensions.`);
  }
}
const appleIcon = await readFile(path.join(publicRoot, 'icons/apple-touch-icon.png'));
if (appleIcon.readUInt32BE(16) !== 180 || appleIcon.readUInt32BE(20) !== 180) {
  throw new Error('The Apple Home Screen icon must be 180x180 pixels.');
}
const assetPaths = [...html.matchAll(/\b(?:href|src)=["'](\/(?!\/)[^"'#?]*)/g)].map(match => match[1]);
for (const assetPath of assetPaths) {
  const file = assetPath === '/'
    ? path.join(publicRoot, 'index.html')
    : path.resolve(publicRoot, `.${decodeURIComponent(assetPath)}`);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) throw new Error(`Asset escapes public directory: ${assetPath}`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`HTML references a missing asset: ${assetPath}`);
}

const css = await readFile(path.join(publicRoot, 'styles.css'), 'utf8');
const openingBraces = (css.match(/{/g) || []).length;
const closingBraces = (css.match(/}/g) || []).length;
if (openingBraces !== closingBraces) throw new Error('Stylesheet has unbalanced rule braces.');

console.log(`Static app build check passed (${requiredAssets.length} required assets, ${assetPaths.length} linked assets).`);
