#!/usr/bin/env node
/**
 * Cross-packages the Windows x64 portable build on Linux/macOS:
 *
 *   dist/CongLive-win32-x64/                       unpacked portable app (CongLive.exe)
 *   dist/CongLive-win32-x64-portable.zip           zipped portable app
 *   dist/BUILD-INFO.json                           hashes / versions for verification
 *
 * @electron/packager uses the pure-JS `resedit` implementation for Windows icon
 * and version resources when cross-building, so Wine is not required.
 */
import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './make-icon.mjs';
import { zipDirectory } from './zip-dir.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const electronVersion = String((pkg.devDependencies && pkg.devDependencies.electron) || '').replace(/^[^0-9]*/, '');
if (!electronVersion) {
  console.error('pack-win: the electron devDependency version could not be detected');
  process.exit(1);
}

const OUT_DIR = join(ROOT, 'dist');
const ICON = join(ROOT, 'build', 'icon.ico');
if (!existsSync(ICON)) makeIcons({ quiet: true });

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(absolute);
    else if (entry.isFile()) total += statSync(absolute).size;
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

console.log(`pack-win: electron ${electronVersion} → win32 x64 (portable, no installer)`);
console.log(`pack-win: electron mirror ${process.env.ELECTRON_MIRROR}`);

let appPaths;
try {
  appPaths = await packager({
    dir: ROOT,
    out: OUT_DIR,
    platform: 'win32',
    arch: 'x64',
    name: 'CongLive',
    executableName: 'CongLive',
    appVersion: pkg.version,
    buildVersion: pkg.version,
    electronVersion,
    icon: ICON,
    asar: true,
    prune: true,
    overwrite: true,
    quiet: false,
    appCopyright: `Copyright © ${new Date().getFullYear()} CongLive`,
    win32metadata: {
      CompanyName: 'CongLive',
      FileDescription: '葱直播 CongLive 客户端',
      OriginalFilename: 'CongLive.exe',
      ProductName: '葱直播 CongLive',
      InternalName: 'CongLive',
      'requested-execution-level': 'asInvoker',
    },
    // Keep only the runtime shell in app.asar — never ship dev/build material.
    ignore: [
      /^\/node_modules($|\/)/, // app has no runtime dependencies (prune also removes devDeps)
      /^\/dist($|\/)/,
      /^\/build($|\/)/,
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/README\.md$/,
      /^\/\.gitignore$/,
      /^\/package-lock\.json$/,
      /^\/node_modules\/\.cache($|\/)/,
      /^\/node_modules\/\.bin($|\/)/,
    ],
  });
} catch (error) {
  console.error('pack-win: packaging failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}

const folder = appPaths[0];
const exePath = join(folder, 'CongLive.exe');
if (!existsSync(exePath)) {
  console.error(`pack-win: packaged directory has no CongLive.exe: ${folder}`);
  process.exit(1);
}

const zipPath = join(OUT_DIR, 'CongLive-win32-x64-portable.zip');
console.log('pack-win: zipping portable build…');
const zip = zipDirectory(folder, zipPath, {
  rootName: basename(folder),
  onProgress: (done, total) => {
    if (done % 250 === 0 || done === total) process.stdout.write(`\r  ${done}/${total} files`);
  },
});
process.stdout.write('\n');

const folderBytes = directorySize(folder);
const info = {
  product: 'CongLive',
  version: pkg.version,
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  builtAt: new Date().toISOString(),
  portableFolder: basename(folder),
  exe: 'CongLive.exe',
  exeSha256: sha256(exePath),
  exeBytes: statSync(exePath).size,
  appAsarSha256: sha256(join(folder, 'resources', 'app.asar')),
  iconSha256: sha256(ICON),
  folderBytes,
  zip: basename(zipPath),
  zipBytes: zip.bytes,
  zipSha256: sha256(zipPath),
  zipEntries: zip.entries,
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'BUILD-INFO.json'), `${JSON.stringify(info, null, 2)}\n`);

console.log('\npack-win: done');
console.log(`  folder  ${folder}  (${formatBytes(folderBytes)})`);
console.log(`  zip     ${zipPath}  (${formatBytes(zip.bytes)})`);
console.log(`  exe sha256      ${info.exeSha256}`);
console.log(`  zip sha256      ${info.zipSha256}`);
console.log(`  app.asar sha256 ${info.appAsarSha256}`);
