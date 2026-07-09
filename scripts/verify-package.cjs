#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

const requiredEntries = [
  'manifest.json',
  'background.js',
  'popup/popup.html',
  'scripts/content.js',
  'scripts/generators.js'
];

const forbiddenEntryPatterns = [
  /^\.trellis\//,
  /^\.agents\//,
  /^\.codex\//,
  /^output\//,
  /^tests\//,
  /^assets\/marketing\//,
  /^docs\//,
  /^dist\//,
  /^node_modules\//,
  /^scripts\/.*\.cjs$/
];

function parseZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = [];
  let offset = 0;

  while (offset <= buffer.length - 30) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    entries.push({ name, method });
    offset = dataStart + compressedSize;
  }

  if (!entries.length) {
    throw new Error(`${path.relative(root, zipPath)} does not contain readable local zip entries`);
  }

  return entries;
}

function findPackageZip() {
  if (!fs.existsSync(distDir)) {
    throw new Error('No dist/ directory found. Run node scripts/package-extension.cjs first.');
  }

  const candidates = fs.readdirSync(distDir)
    .filter(name => /^formpilot-.*\.zip$/.test(name))
    .sort();

  if (!candidates.length) {
    throw new Error('No packaged extension zip found under dist/. Run node scripts/package-extension.cjs first.');
  }

  return path.join(distDir, candidates[candidates.length - 1]);
}

function verifyPackage(zipPath) {
  const entries = parseZipEntries(zipPath);
  const names = new Set(entries.map(entry => entry.name));

  for (const required of requiredEntries) {
    if (!names.has(required)) {
      throw new Error(`Missing required package entry: ${required}`);
    }
  }

  const forbidden = [...names].filter(name => forbiddenEntryPatterns.some(pattern => pattern.test(name)));
  if (forbidden.length) {
    throw new Error(`Packaged zip contains non-runtime files: ${forbidden.join(', ')}`);
  }

  const unsupported = entries.filter(entry => entry.method !== 0 && entry.method !== 8);
  if (unsupported.length) {
    throw new Error(`Unsupported zip compression method in: ${unsupported.map(entry => entry.name).join(', ')}`);
  }

  return { zipPath, entries };
}

function main() {
  const zipPath = process.argv[2] ? path.resolve(process.argv[2]) : findPackageZip();
  const result = verifyPackage(zipPath);
  console.log(`FormPilot package verification passed: ${path.relative(root, result.zipPath).replace(/\\/g, '/')} contains ${result.entries.length} runtime entries`);
}

try {
  main();
} catch (error) {
  console.error(`FormPilot package verification failed: ${error.message}`);
  process.exit(1);
}
