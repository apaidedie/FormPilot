#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const stagingDir = path.join(distDir, 'formpilot-extension');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, ''));
}

function rel(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertSafeGeneratedPath(target) {
  const resolved = path.resolve(target);
  if (!isInside(distDir, resolved)) {
    throw new Error(`Refusing to touch path outside dist: ${resolved}`);
  }
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    assertSafeGeneratedPath(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(stagingDir, relativePath);
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function walk(relativeDir, visitor) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return;

  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = rel(absolute);
    if (entry.isDirectory()) {
      walk(relative, visitor);
    } else {
      visitor(relative);
    }
  }
}

const includeRoots = [
  'manifest.json',
  'background.js',
  'icons',
  'popup',
  'scripts'
];

const excludedPatterns = [
  /^\.git\//,
  /^\.trellis\//,
  /^\.agents\//,
  /^\.codex\//,
  /^\.playwright-cli\//,
  /^output\//,
  /^tests\//,
  /^assets\/marketing\//,
  /^docs\//,
  /^dist\//,
  /^node_modules\//,
  /^scripts\/.*\.cjs$/,
  /\.map$/,
  /\.log$/
];

function shouldExclude(relativePath) {
  return excludedPatterns.some(pattern => pattern.test(relativePath));
}

function collectFiles() {
  const files = [];

  for (const item of includeRoots) {
    const absolute = path.join(root, item);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Package input missing: ${item}`);
    }

    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      walk(item, relativePath => {
        if (!shouldExclude(relativePath)) files.push(relativePath);
      });
    } else if (!shouldExclude(item)) {
      files.push(item);
    }
  }

  return files.sort();
}

function runPowerShellCompress(shellName, zipPath) {
  const command = [
    '$ErrorActionPreference = "Stop";',
    'if (Test-Path -LiteralPath $env:ZIP_PATH) { Remove-Item -LiteralPath $env:ZIP_PATH -Force }',
    'Compress-Archive -Path (Join-Path $env:STAGING_DIR "*") -DestinationPath $env:ZIP_PATH -Force'
  ].join(' ');

  return spawnSync(shellName, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root,
    env: {
      ...process.env,
      STAGING_DIR: stagingDir,
      ZIP_PATH: zipPath
    },
    encoding: 'utf8'
  });
}

function runZipCli(zipPath) {
  const result = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: stagingDir,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(`zip CLI failed:\n${(result.stderr || result.stdout).trim()}`);
  }
}

function compressStaging(zipPath) {
  assertSafeGeneratedPath(zipPath);

  const powershellErrors = [];
  for (const shellName of ['powershell', 'pwsh']) {
    const result = runPowerShellCompress(shellName, zipPath);
    if (result.status === 0) return;
    powershellErrors.push(`${shellName}: ${(result.stderr || result.stdout || result.error?.message || 'not available').trim()}`);
  }

  try {
    runZipCli(zipPath);
    return;
  } catch (error) {
    throw new Error(`No supported zip tool succeeded. PowerShell attempts: ${powershellErrors.join(' | ')}. ${error.message}`);
  }
}

function cleanupStaging() {
  try {
    removeDir(stagingDir);
  } catch (error) {
    console.warn(`Warning: could not remove staging directory: ${error.message}`);
  }
}

function main() {
  const manifest = readJson('manifest.json');
  const packageName = `formpilot-${manifest.version}.zip`;
  const zipPath = path.join(distDir, packageName);

  removeDir(stagingDir);
  ensureDir(stagingDir);
  ensureDir(distDir);

  try {
    const files = collectFiles();
    for (const file of files) {
      copyFile(file);
    }

    compressStaging(zipPath);

    const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
    console.log(`Packaged ${files.length} files into ${rel(zipPath)} (${sizeKb} KB)`);
  } finally {
    cleanupStaging();
  }
}

try {
  main();
} catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  process.exit(1);
}
