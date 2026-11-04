#!/usr/bin/env node
/**
 * Minimal, dependency-free ZIP writer used to produce the portable Windows zip.
 *
 * Only what a portable Electron distribution needs is implemented: deflate
 * (method 8) with a stored fallback, UTF-8 names, directory entries, DOS
 * timestamps and CRC32. ZIP64 / encryption / >4GB archives are rejected.
 */
import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

function walk(root) {
  const files = [];
  const dirs = new Set();
  const visit = (dir, relativeDir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // Portable app: never follow links.
      if (entry.isDirectory()) {
        dirs.add(`${relPath}/`);
        visit(absolute, relPath);
      } else if (entry.isFile()) {
        files.push({ absolute, name: relPath });
      }
    }
  };
  visit(root, '');
  return { files, dirs: [...dirs].sort() };
}

/**
 * @param {string} srcDir directory whose *contents* become the archive root
 * @param {string} outFile output .zip path
 * @param {{ rootName?: string, onProgress?: (done:number,total:number)=>void }} [options]
 */
export function zipDirectory(srcDir, outFile, options = {}) {
  const rootName = options.rootName === undefined ? '' : options.rootName;
  const { files: foundFiles, dirs: foundDirs } = walk(srcDir);

  const entries = [];
  const now = new Date();
  if (rootName) {
    const prefix = rootName.replace(/\/+$/, '');
    for (const dir of foundDirs) entries.push({ name: `${prefix}/${dir}`, directory: true });
    for (const file of foundFiles) entries.push({ name: `${prefix}/${file.name}`, file });
  } else {
    for (const dir of foundDirs) entries.push({ name: dir, directory: true });
    for (const file of foundFiles) entries.push({ name: file.name, file });
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let done = 0;
  const total = entries.length;

  for (const entry of entries) {
    const { dosDate, dosTime } = dosDateTime(now);
    let nameBuffer = Buffer.from(entry.name, 'utf8');
    let data = Buffer.alloc(0);
    let method = 0;
    let compressed = data;
    let mtime = now;

    if (!entry.directory) {
      data = readFileSync(entry.file.absolute);
      mtime = statSync(entry.file.absolute).mtime;
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        compressed = deflated;
      } else {
        compressed = data;
      }
      const stamp = dosDateTime(mtime);
      // Use the file's own timestamp in the local header.
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6); // UTF-8 names
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(stamp.dosTime, 10);
      localHeader.writeUInt16LE(stamp.dosDate, 12);
      localHeader.writeUInt32LE(crc32(data), 14);
      localHeader.writeUInt32LE(compressed.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);
      localParts.push(localHeader, nameBuffer, compressed);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4); // made by
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(stamp.dosTime, 12);
      central.writeUInt16LE(stamp.dosDate, 14);
      central.writeUInt32LE(crc32(data), 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuffer.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);
      centralParts.push(central, nameBuffer);
      offset += localHeader.length + nameBuffer.length + compressed.length;
    } else {
      // Directory entry: zero-length, trailing slash.
      nameBuffer = Buffer.from(entry.name, 'utf8');
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(0, 14);
      localHeader.writeUInt32LE(0, 18);
      localHeader.writeUInt32LE(0, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);
      localParts.push(localHeader, nameBuffer);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(0, 16);
      central.writeUInt32LE(0, 20);
      central.writeUInt32LE(0, 24);
      central.writeUInt16LE(nameBuffer.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);
      centralParts.push(central, nameBuffer);
      offset += localHeader.length + nameBuffer.length;
    }

    done += 1;
    if (options.onProgress) options.onProgress(done, total);
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  if (offset > 0xFFFFFFFF || centralDirectory.length > 0xFFFFFFFF) {
    throw new Error('zip-dir: archive exceeds the 4GB ZIP32 limit');
  }
  if (entries.length > 0xFFFF) throw new Error('zip-dir: too many entries for ZIP32');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  eocd.writeUInt16LE(0, 20);

  mkdirSync(join(outFile, '..'), { recursive: true });
  writeFileSync(outFile, Buffer.concat([localData, centralDirectory, eocd]));
  return {
    entries: entries.length,
    files: foundFiles.length,
    bytes: offset + centralDirectory.length + eocd.length,
    path: outFile,
  };
}

if (process.argv[1] && process.argv[1].endsWith('zip-dir.mjs')) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: node scripts/zip-dir.mjs <source-dir> <out.zip> [root-name]');
    process.exit(1);
  }
  const rootName = process.argv[5] || '';
  const result = zipDirectory(src, out, { rootName });
  console.log(JSON.stringify(result, null, 2));
}

export default zipDirectory;
