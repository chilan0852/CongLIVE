#!/usr/bin/env node
/**
 * Structural verification of the cross-built Windows portable package.
 *
 * Checks performed without Windows / without Wine:
 *  - dist folder + CongLive.exe exist and are a PE32+ x86-64 executable;
 *  - the executable carries an RT_ICON/RT_ICON_GROUP resource and Chinese
 *    FileDescription / ProductName version strings (set by @electron/packager's
 *    resedit step);
 *  - resources/app.asar contains main.js, launcher.html, preload.js, picker.html
 *    and package.json (main field + version), and no dev/build folders;
 *  - the portable zip has valid ZIP structure and contains CongLive.exe and
 *    resources/app.asar;
 *  - build/icon.ico is a valid multi-size ICO with PNG entries.
 *
 * Windows runtime behaviour (camera/mic, screen picker, shortcuts) cannot be
 * executed on this Linux/ARM64 build host — see README "验证与限制".
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FOLDER = join(DIST, 'CongLive-win32-x64');
const EXE = join(FOLDER, 'CongLive.exe');
const ASAR = join(FOLDER, 'resources', 'app.asar');
const ZIP = join(DIST, 'CongLive-win32-x64-portable.zip');
const ICO = join(ROOT, 'build', 'icon.ico');
const BUILD_INFO = join(DIST, 'BUILD-INFO.json');

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail || '' });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL  ${name}  (${checks[checks.length - 1].detail})`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(absolute);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function readPeInfo(file) {
  const buffer = readFileSync(file);
  assert(buffer.length > 0x100, 'file is too small to be a PE executable');
  assert(buffer.readUInt16LE(0) === 0x5A4D, 'missing MZ signature');
  const peOffset = buffer.readUInt32LE(0x3C);
  assert(peOffset + 0x18 < buffer.length, 'PE header offset out of range');
  assert(buffer.readUInt32LE(peOffset) === 0x00004550, 'missing PE\\0\\0 signature');
  const machine = buffer.readUInt16LE(peOffset + 4);
  const characteristic = buffer.readUInt16LE(peOffset + 22);
  return { machine, characteristic, size: buffer.length };
}

function readZipEntries(file) {
  const buffer = readFileSync(file);
  assert(buffer.readUInt32LE(0) === 0x04034B50, 'missing local file header signature');
  let eocd = -1;
  const start = Math.max(0, buffer.length - 22 - 0xFFFF);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  assert(eocd >= 0, 'missing end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert(buffer.readUInt32LE(offset) === 0x02014B50, `bad central directory entry #${i}`);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, size: buffer.length, count };
}

function readIcoInfo(file) {
  const buffer = readFileSync(file);
  assert(buffer.readUInt16LE(0) === 0, 'bad ICO reserved field');
  assert(buffer.readUInt16LE(2) === 1, 'ICO type must be 1 (icon)');
  const count = buffer.readUInt16LE(4);
  assert(count >= 5, `expected multiple icon sizes, found ${count}`);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const width = buffer[base] === 0 ? 256 : buffer[base];
    const height = buffer[base + 1] === 0 ? 256 : buffer[base + 1];
    const bytes = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    assert(buffer.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), `icon entry ${i} is not a PNG`);
    assert(width === height, `icon entry ${i} is not square`);
    assert(bytes > 0, `icon entry ${i} is empty`);
    sizes.push(width);
  }
  return sizes;
}

/* ---------------------------------------------------------------- checks */

check('portable folder and CongLive.exe exist', () => {
  assert(existsSync(DIST), `${DIST} does not exist — run npm run pack:win first`);
  assert(existsSync(FOLDER), `${FOLDER} does not exist`);
  assert(existsSync(EXE), `${EXE} does not exist`);
  return `exe ${formatBytes(statSync(EXE).size)}`;
});

check('CongLive.exe is a PE32+ x86-64 executable', () => {
  const pe = readPeInfo(EXE);
  assert(pe.machine === 0x8664, `machine 0x${pe.machine.toString(16)} is not x86-64 (0x8664)`);
  assert((pe.characteristic & 0x0020) !== 0, 'expected IMAGE_FILE_LARGE_ADDRESS_AWARE');
  return `machine 0x8664, ${formatBytes(pe.size)}`;
});

check('exe icon resources applied', () => {
  const buffer = readFileSync(EXE);
  const executable = NtExecutable.from(buffer, { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  assert(groups.length > 0, 'no RT_GROUP_ICON resource found');
  const sizes = groups[0].icons.map((icon) => `${icon.width || 256}x${icon.height || 256}`).join(',');
  assert(groups[0].icons.length >= 5, `expected multiple icon sizes, found ${groups[0].icons.length}`);
  return sizes;
});

check('exe version information applied', () => {
  const buffer = readFileSync(EXE);
  const executable = NtExecutable.from(buffer, { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  assert(versions.length > 0, 'no VS_VERSION_INFO resource found');
  const languages = versions[0].getAllLanguagesForStringValues();
  assert(languages.length > 0, 'version info has no string tables');
  const strings = versions[0].getStringValues(languages[0]);
  assert(strings.ProductName === '葱直播 CongLive', `unexpected ProductName: ${strings.ProductName}`);
  assert(String(strings.FileDescription || '').includes('CongLive'), `unexpected FileDescription: ${strings.FileDescription}`);
  return `ProductName="${strings.ProductName}" FileDescription="${strings.FileDescription}"`;
});

check('resources/app.asar exists', () => {
  assert(existsSync(ASAR), `${ASAR} does not exist`);
  return formatBytes(statSync(ASAR).size);
});

check('app.asar contains the shell sources and no dev/build folders', () => {
  const entries = listPackage(ASAR).map((entry) => entry.replace(/^\/+/, ''));
  for (const required of ['package.json', 'src/main.js', 'src/config.js', 'src/preload.js', 'src/launcher.html', 'src/launcher.js', 'src/launcher.css', 'src/picker.html', 'src/picker.js', 'src/assets/icon.png', 'src/assets/icon.ico']) {
    assert(entries.includes(required), `missing ${required} in app.asar`);
  }
  for (const entry of entries) {
    assert(!entry.startsWith('dist/'), `dev folder dist/ leaked into app.asar: ${entry}`);
    assert(!entry.startsWith('test/'), `dev folder test/ leaked into app.asar: ${entry}`);
    assert(!entry.startsWith('scripts/'), `dev folder scripts/ leaked into app.asar: ${entry}`);
  }
  const pkg = JSON.parse(extractFile(ASAR, 'package.json').toString('utf8'));
  assert(pkg.main === 'src/main.js', `unexpected main entry: ${pkg.main}`);
  assert(typeof pkg.version === 'string' && pkg.version.length > 0, 'missing app version');
  assert(!(pkg.devDependencies && Object.keys(pkg.devDependencies).length), 'devDependencies leaked into the packaged package.json');
  return `${entries.length} entries, version ${pkg.version}`;
});

check('portable zip exists and its entries mirror the packaged folder', () => {
  assert(existsSync(ZIP), `${ZIP} does not exist`);
  const zip = readZipEntries(ZIP);
  // Every packaged file plus the locales/ and resources/ directory entries.
  const expectedFiles = countFiles(FOLDER);
  const zipFiles = zip.entries.filter((entry) => !entry.endsWith('/'));
  assert(zipFiles.length === expectedFiles, `zip has ${zipFiles.length} files but the packaged folder has ${expectedFiles}`);
  for (const required of ['CongLive-win32-x64/CongLive.exe', 'CongLive-win32-x64/resources/app.asar']) {
    assert(zip.entries.includes(required), `missing ${required} in portable zip`);
  }
  return `${zip.count} entries / ${zipFiles.length} files, ${formatBytes(zip.size)}`;
});

check('build/icon.ico is a valid multi-size ICO', () => {
  assert(existsSync(ICO), `${ICO} does not exist`);
  const sizes = readIcoInfo(ICO);
  for (const size of [16, 32, 48, 256]) assert(sizes.includes(size), `missing ${size}px icon`);
  return `sizes ${sizes.join(',')}`;
});

check('BUILD-INFO.json matches the artifacts', () => {
  assert(existsSync(BUILD_INFO), `${BUILD_INFO} does not exist`);
  const info = JSON.parse(readFileSync(BUILD_INFO, 'utf8'));
  assert(info.platform === 'win32' && info.arch === 'x64', 'unexpected build target');
  assert(info.exeSha256 === createHash('sha256').update(readFileSync(EXE)).digest('hex'), 'exe sha256 mismatch');
  assert(info.zipSha256 === createHash('sha256').update(readFileSync(ZIP)).digest('hex'), 'zip sha256 mismatch');
  assert(info.zip === basename(ZIP), 'zip filename mismatch');
  return `v${info.version} · electron ${info.electronVersion}`;
});

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} build checks passed`);
if (failed.length) {
  console.log(JSON.stringify({ ok: false, failed: failed.map((item) => item.name) }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checks: checks.length }));
