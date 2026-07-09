#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const notes = [];

function rel(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function existsWithExactCase(relativePath) {
  const parts = relativePath.split('/').filter(Boolean);
  let current = root;

  for (const part of parts) {
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch (error) {
      return false;
    }

    if (!entries.includes(part)) {
      return false;
    }
    current = path.join(current, part);
  }

  return fs.existsSync(current);
}

function walk(dir, predicate = () => true, results = []) {
  const absoluteDir = path.join(root, dir);
  if (!fs.existsSync(absoluteDir)) return results;

  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = rel(absolute);
    if (entry.isDirectory()) {
      walk(relative, predicate, results);
    } else if (predicate(relative, absolute)) {
      results.push(relative);
    }
  }

  return results;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyIdentityTerms() {
  return [
    ['Geo', 'Fill'],
    ['geo', 'fill'],
    ['GEO', 'FILL'],
    ['geo', 'Fill']
  ].map(parts => parts.join(''));
}

function legacyIdentityPattern() {
  return new RegExp(legacyIdentityTerms().map(escapeRegExp).join('|'));
}

function isExcludedIndependencePath(relativePath) {
  const parts = relativePath.split('/');
  return parts.some(part => ['.git', '.trellis', 'dist', 'output', 'node_modules'].includes(part)) || relativePath === 'AGENTS.md';
}

function isTextLikePath(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) return true;
  return new Set([
    '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.xml', '.yml', '.yaml'
  ]).has(ext);
}

function walkIndependenceFiles(relativeDir = '', results = []) {
  const absoluteDir = path.join(root, relativeDir || '.');
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const normalized = relative.replace(/\\/g, '/');
    if (isExcludedIndependencePath(normalized)) continue;

    const absolute = path.join(root, normalized);
    if (entry.isDirectory()) {
      walkIndependenceFiles(normalized, results);
    } else {
      results.push(normalized);
    }
  }
  return results;
}

function checkNoLegacyIdentityResidues() {
  const pattern = legacyIdentityPattern();
  const matches = [];

  for (const relativePath of walkIndependenceFiles()) {
    if (pattern.test(relativePath)) {
      matches.push(`${relativePath}: path contains legacy identity`);
    }
    if (!isTextLikePath(relativePath)) continue;

    let text;
    try {
      text = readText(relativePath);
    } catch (error) {
      continue;
    }

    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        matches.push(`${relativePath}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
  }

  assert(!matches.length, `legacy identity residues found outside excluded paths:\n${matches.slice(0, 40).join('\n')}${matches.length > 40 ? `\n...and ${matches.length - 40} more` : ''}`);
}

function parseZipEntriesWithData(zipPath) {
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
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, method, compressedData });
    offset = dataStart + compressedSize;
  }

  return entries;
}

function inflateZipEntry(entry, zipPath) {
  if (entry.method === 0) return entry.compressedData;
  if (entry.method === 8) return zlib.inflateRawSync(entry.compressedData);
  throw new Error(`${rel(zipPath)} contains unsupported compression method ${entry.method} in ${entry.name}`);
}

function checkPackageHasNoLegacyIdentity(manifest) {
  if (!manifest?.version) return;

  const zipPath = path.join(root, 'dist', `formpilot-${manifest.version}.zip`);
  if (!fs.existsSync(zipPath)) {
    notes.push('package text identity scan skipped because dist zip is not present yet');
    return;
  }

  const pattern = legacyIdentityPattern();
  const matches = [];
  const textEntryExts = new Set(['.css', '.html', '.js', '.json', '.md', '.txt', '.xml']);

  for (const entry of parseZipEntriesWithData(zipPath)) {
    if (!textEntryExts.has(path.extname(entry.name).toLowerCase())) continue;
    let text;
    try {
      text = inflateZipEntry(entry, zipPath).toString('utf8').replace(/^\uFEFF/, '');
    } catch (error) {
      fail(`${rel(zipPath)} ${entry.name} could not be inspected: ${error.message}`);
      continue;
    }
    if (pattern.test(entry.name) || pattern.test(text)) {
      matches.push(entry.name);
    }
  }

  assert(!matches.length, `${rel(zipPath)} contains packaged text entries with legacy identity residues: ${matches.join(', ')}`);
}

function checkFormPilotIndependenceContracts() {
  const constants = readText('popup/js/constants.js');
  const migration = readText('popup/js/storage-migration.js');
  const popup = readText('popup/popup.js');
  const popupHtml = readText('popup/popup.html');
  const background = readText('background.js');
  const content = readText('scripts/content.js');
  const commonSelectors = readText('scripts/selectors/common.js');
  const japanSelectors = readText('scripts/selectors/japan.js');
  const fixtureVerifier = readText('scripts/verify-fixture.cjs');
  const keyboardVerifier = readText('scripts/verify-popup-keyboard.cjs');

  for (const required of [
    "const STORAGE_KEY = 'formPilotCachedData'",
    "const THEME_KEY = 'formPilotTheme'",
    "const LOCKED_KEY = 'formPilotLockedFields'",
    "const SETTINGS_KEY = 'formPilotSettings'",
    "const ARCHIVES_KEY = 'formPilotArchives'",
    "const AUTO_CLEAR_KEY = 'formPilotAutoClear'",
    "const HISTORY_KEY = 'formPilotHistory'",
    "const GEOAPIFY_KEY = 'formPilotGeoapifyKey'",
    "const MY_PROFILE_KEY = 'formPilotMyProfile'",
    "const AI_MODE_KEY = 'formPilotUseAI'",
    "const FILL_EMPTY_ONLY_KEY = 'formPilotFillEmptyOnly'",
    "const ADDRESS_API_ENABLED_KEY = 'formPilotAddressApiEnabled'",
    "const PROFILE_SECTIONS_KEY = 'formPilotProfileSections'"
  ]) {
    assert(constants.includes(required), `popup/js/constants.js must use independent FormPilot storage key: ${required}`);
  }

  assert(migration.includes('LEGACY_STORAGE_KEYS') && migration.includes('NEW_STORAGE_KEYS') && migration.includes('function migrateLegacyStorageKeys') && migration.includes("['geo', 'Fill'].join('')"), 'storage migration must keep a split legacy-key map and shared migration function without source-level identity residue');
  assert(migration.includes('storageArea = root.chrome?.storage?.local') && migration.includes('storageArea.get') && migration.includes('storageArea.set') && migration.includes('storageArea.remove'), 'storage migration must copy missing new keys and remove legacy keys through an injectable storage area');
  assert(popupHtml.includes('js/storage-migration.js'), 'popup must load the shared storage migration helper');
  assert(popup.includes('await window.FormPilotStorageMigration.migrateLegacyStorageKeys()'), 'popup startup must migrate legacy storage before reading persisted state');
  assert(background.includes("importScripts('popup/js/storage-migration.js')") && background.includes('FormPilotStorageMigration.migrateLegacyStorageKeys()'), 'background service worker must run the shared storage migration before storage reads');

  assert(content.includes('window.__formPilotContentLoaded') && content.includes('window.FormPilotSelectors') && content.includes('formPilotLog'), 'content script must use FormPilot guard, selector namespace, and log helper');
  assert(commonSelectors.includes('window.FormPilotSelectors') && japanSelectors.includes('window.FormPilotSelectors'), 'selector files must publish FormPilotSelectors');
  assert(fixtureVerifier.includes('FormPilotSelectors'), 'fixture verifier must evaluate FormPilotSelectors');
  assert(keyboardVerifier.includes('formPilotCachedData') && keyboardVerifier.includes('__formPilotClipboardWrites') && keyboardVerifier.includes('__formPilotAIPathUsed'), 'popup keyboard verifier must use independent storage keys and helper globals');
}

async function checkStorageMigrationBehavior() {
  const source = readText('popup/js/storage-migration.js');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'popup/js/storage-migration.js' });

  const migration = context.FormPilotStorageMigration;
  assert(migration?.LEGACY_STORAGE_KEYS && migration?.NEW_STORAGE_KEYS && typeof migration.migrateLegacyStorageKeys === 'function', 'storage migration script must expose key maps and migrateLegacyStorageKeys');
  if (!migration?.LEGACY_STORAGE_KEYS || !migration?.NEW_STORAGE_KEYS) return;

  const legacyCache = migration.LEGACY_STORAGE_KEYS.storage;
  const legacyTheme = migration.LEGACY_STORAGE_KEYS.theme;
  const newCache = migration.NEW_STORAGE_KEYS.storage;
  const newTheme = migration.NEW_STORAGE_KEYS.theme;
  const store = {
    [legacyCache]: { version: 'v3', currentData: { firstName: 'Ada' } },
    [legacyTheme]: 'light',
    [newTheme]: 'dark'
  };

  const storageArea = {
    async get(keys) {
      const result = {};
      const normalized = Array.isArray(keys) ? keys : [keys];
      normalized.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
      });
      return result;
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      normalized.forEach(key => delete store[key]);
    }
  };

  const first = await migration.migrateLegacyStorageKeys(storageArea);
  assert(first.migrated === 1 && first.removed === 2, 'storage migration must copy only missing new keys and remove all legacy keys');
  assert(store[newCache]?.currentData?.firstName === 'Ada', 'storage migration must preserve cached generated data under the new key');
  assert(store[newTheme] === 'dark', 'storage migration must not overwrite existing new-key values');
  assert(!Object.prototype.hasOwnProperty.call(store, legacyCache) && !Object.prototype.hasOwnProperty.call(store, legacyTheme), 'storage migration must remove legacy keys after processing');

  const second = await migration.migrateLegacyStorageKeys(storageArea);
  assert(second.migrated === 0 && second.removed === 0, 'storage migration must be idempotent after legacy keys are removed');
}

function checkJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function checkJsSyntax(relativePath) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relativePath)], {
    cwd: root,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    fail(`${relativePath} failed node --check:\n${(result.stderr || result.stdout).trim()}`);
  }
}

function runScript(relativePath) {
  const result = spawnSync(process.execPath, [path.join(root, relativePath)], {
    cwd: root,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    fail(`${relativePath} failed:\n${(result.stderr || result.stdout).trim()}`);
  }
}

function readPng(relativePath) {
  const buffer = fs.readFileSync(path.join(root, relativePath));
  const signature = buffer.subarray(0, 8).toString('hex');
  assert(signature === '89504e470d0a1a0a', `${relativePath} is not a PNG file`);
  if (signature !== '89504e470d0a1a0a') return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const idatChunks = [];
  let offset = 8;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    if (type === 'IDAT') idatChunks.push(buffer.subarray(dataStart, dataStart + length));
    offset = dataStart + length + 4;
    if (type === 'IEND') break;
  }

  return { width, height, bitDepth, colorType, imageData: Buffer.concat(idatChunks) };
}

function bytesPerPixel(colorType) {
  if (colorType === 2) return 3;
  if (colorType === 6) return 4;
  return 0;
}

function hasPixelVariation(png, relativePath) {
  const channels = bytesPerPixel(png.colorType);
  assert(png.bitDepth === 8 && channels, `${relativePath} must be an 8-bit RGB or RGBA PNG for release verification`);
  if (png.bitDepth !== 8 || !channels) return false;

  let inflated;
  try {
    inflated = zlib.inflateSync(png.imageData);
  } catch (error) {
    fail(`${relativePath} PNG data could not be inflated: ${error.message}`);
    return false;
  }

  const stride = png.width * channels;
  const rowLength = stride + 1;
  const first = { r: null, g: null, b: null };
  let varied = false;

  for (let y = 0; y < png.height && !varied; y += Math.max(1, Math.floor(png.height / 16))) {
    const rowOffset = y * rowLength;
    const filter = inflated[rowOffset];
    assert(filter >= 0 && filter <= 4, `${relativePath} has an invalid PNG filter byte`);
    for (let x = 0; x < png.width; x += Math.max(1, Math.floor(png.width / 16))) {
      const pixel = rowOffset + 1 + x * channels;
      const sample = { r: inflated[pixel], g: inflated[pixel + 1], b: inflated[pixel + 2] };
      if (first.r === null) {
        first.r = sample.r;
        first.g = sample.g;
        first.b = sample.b;
      } else if (Math.abs(sample.r - first.r) + Math.abs(sample.g - first.g) + Math.abs(sample.b - first.b) > 24) {
        varied = true;
        break;
      }
    }
  }

  return varied;
}

function extractObjectLiteral(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) return null;

  const objectStart = source.indexOf('{', start);
  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let i = objectStart; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(objectStart, i + 1);
    }
  }

  return null;
}

function extractArrayLiteral(source, name) {
  const start = source.indexOf(`const ${name} = [`);
  if (start === -1) return null;

  const arrayStart = source.indexOf('[', start);
  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let i = arrayStart; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '[') depth++;
    if (char === ']') {
      depth--;
      if (depth === 0) return source.slice(arrayStart, i + 1);
    }
  }

  return null;
}

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return '';

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return '';
}

function evaluateGeneratorObject(source, name) {
  const literal = extractObjectLiteral(source, name);
  if (!literal) {
    fail(`scripts/generators.js is missing ${name}`);
    return {};
  }

  try {
    return vm.runInNewContext(`(${literal})`);
  } catch (error) {
    fail(`Could not evaluate ${name}: ${error.message}`);
    return {};
  }
}

function evaluateArray(source, name, relativePath) {
  const literal = extractArrayLiteral(source, name);
  if (!literal) {
    fail(`${relativePath} is missing ${name}`);
    return [];
  }

  try {
    const value = vm.runInNewContext(`(${literal})`);
    if (!Array.isArray(value)) {
      fail(`${relativePath} ${name} is not an array`);
      return [];
    }
    return value;
  } catch (error) {
    fail(`Could not evaluate ${name}: ${error.message}`);
    return [];
  }
}

function extractCountryOptions(html) {
  const selectMatch = html.match(/<select\s+id="country"[\s\S]*?<\/select>/i);
  if (!selectMatch) {
    fail('popup/popup.html is missing select#country');
    return [];
  }

  return [...selectMatch[0].matchAll(/<option\s+value="([^"]+)"/g)].map(match => match[1]);
}

function extractCountryCoverageItems(html) {
  const gridMatch = html.match(/<div\s+class="country-coverage-grid"\s+id="countryCoverageList"[\s\S]*?<\/div>/i);
  if (!gridMatch) {
    fail('popup/popup.html is missing #countryCoverageList');
    return [];
  }

  return [...gridMatch[0].matchAll(/data-country="([^"]+)"/g)].map(match => match[1]);
}

function checkRequiredFiles() {
  const required = [
    'manifest.json',
    'background.js',
    'popup/popup.html',
    'popup/popup.css',
    'popup/popup.js',
    'popup/js/constants.js',
    'popup/js/storage-migration.js',
    'popup/js/utils.js',
    'popup/js/form-fill.js',
    'scripts/content.js',
    'scripts/generators.js',
    'scripts/japan-generators.js',
    'scripts/lib/browser-harness.cjs',
    'scripts/render-hero.cjs',
    'scripts/verify-release.cjs',
    'scripts/verify-fixture.cjs',
    'scripts/verify-fixture-browser.cjs',
    'scripts/verify-popup-keyboard.cjs',
    'scripts/verify-extension-runtime.cjs',
    'scripts/verify-package.cjs',
    'scripts/package-extension.cjs',
    'scripts/selectors/common.js',
    'scripts/selectors/japan.js',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'PRIVACY.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    '.github/workflows/release-check.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'docs/store-listing.md',
    'docs/architecture.md',
    'docs/roadmap.md',
    'docs/release-audit.md',
    'assets/marketing/formpilot-hero.html',
    'assets/marketing/formpilot-hero.png',
    'assets/marketing/formpilot-store-promo.html',
    'assets/marketing/formpilot-store-promo.png',
    'assets/marketing/formpilot-workflow-demo.html',
    'assets/marketing/formpilot-workflow-demo.png',
    'output/playwright/popup-main.png',
    'output/playwright/popup-settings.png',
    'output/playwright/popup-profile.png',
    'output/playwright/form-fixture-mobile.png',
    'tests/manual/form-fixture.html'
  ];

  for (const file of required) {
    assert(exists(file), `Required file is missing: ${file}`);
    assert(existsWithExactCase(file), `Required file path has incorrect case for cross-platform CI: ${file}`);
  }
}

function checkVisualAssets() {
  const expected = {
    'assets/marketing/formpilot-hero.png': { width: 1600, height: 900 },
    'assets/marketing/formpilot-store-promo.png': { width: 1400, height: 560 },
    'assets/marketing/formpilot-workflow-demo.png': { width: 1600, height: 900 },
    'output/playwright/popup-main.png': { width: 460, height: 860 },
    'output/playwright/popup-settings.png': { width: 460, height: 860 },
    'output/playwright/popup-profile.png': { width: 460, height: 860 },
    'output/playwright/form-fixture-mobile.png': { width: 390, minHeight: 1200 }
  };

  for (const [file, dimensions] of Object.entries(expected)) {
    if (!exists(file)) continue;
    const png = readPng(file);
    if (!png) continue;

    assert(png.width === dimensions.width, `${file} width should be ${dimensions.width}px, found ${png.width}px`);
    if (dimensions.height) {
      assert(png.height === dimensions.height, `${file} height should be ${dimensions.height}px, found ${png.height}px`);
    }
    if (dimensions.minHeight) {
      assert(png.height >= dimensions.minHeight, `${file} height should be at least ${dimensions.minHeight}px, found ${png.height}px`);
    }
    assert(hasPixelVariation(png, file), `${file} appears blank or nearly blank`);
  }
}

function checkMarketingHeroSource() {
  const html = readText('assets/marketing/formpilot-hero.html');
  const promo = readText('assets/marketing/formpilot-store-promo.html');
  const workflowDemoPath = 'assets/marketing/formpilot-workflow-demo.html';
  const workflowDemo = exists(workflowDemoPath) ? readText(workflowDemoPath) : '';
  const renderer = readText('scripts/render-hero.cjs');

  assert(!html.includes('font-family: Inter,'), 'marketing hero must prefer installed system UI fonts before optional font names');
  assert(!promo.includes('font-family: Inter,'), 'store promo must prefer installed system UI fonts before optional font names');
  assert(!workflowDemo.includes('font-family: Inter,'), 'workflow demo must prefer installed system UI fonts before optional font names');

  for (const required of [
    'Generate test profiles. Fill forms deliberately.',
    'A local-first browser extension for developers and QA teams testing registration, checkout, onboarding, shipping, and profile flows.',
    '../../output/playwright/popup-main.png',
    '../../output/playwright/popup-settings.png',
    '../../output/playwright/popup-profile.png',
    '../../output/playwright/form-fixture-mobile.png',
    'Settings readiness',
    'No full card, CVV, or SSN autofill',
    'Payment storage is summary metadata only.'
  ]) {
    assert(html.includes(required), `assets/marketing/formpilot-hero.html must keep current product positioning: ${required}`);
  }

  for (const required of [
    'Profile data for real form QA.',
    'Generate local-looking test profiles, keep reusable contact details, and fill active-tab forms only when you ask.',
    '../../output/playwright/popup-main.png',
    '../../output/playwright/popup-settings.png',
    '../../output/playwright/popup-profile.png',
    '../../output/playwright/form-fixture-mobile.png',
    'Settings readiness',
    'No permanent all-site content script.',
    'No full card, CVV, or SSN autofill.'
  ]) {
    assert(promo.includes(required), `assets/marketing/formpilot-store-promo.html must keep current store positioning: ${required}`);
  }

  for (const required of [
    'Prepare. Scan. Review. Fill intentionally.',
    'Public profile payload only',
    'Sensitive fields stay skipped or manual',
    'No permanent content script',
    '../../output/playwright/popup-main.png',
    '../../output/playwright/popup-settings.png',
    '../../output/playwright/popup-profile.png',
    '../../output/playwright/form-fixture-mobile.png',
    'Prepare profile',
    'Scan active page',
    'Review fill plan',
    'Fill by explicit action'
  ]) {
    assert(workflowDemo.includes(required), `assets/marketing/formpilot-workflow-demo.html must explain the safe workflow: ${required}`);
  }

  for (const required of [
    "require('./lib/browser-harness.cjs')",
    'assets/marketing/formpilot-hero.html',
    'assets/marketing/formpilot-hero.png',
    'assets/marketing/formpilot-store-promo.html',
    'assets/marketing/formpilot-store-promo.png',
    'assets/marketing/formpilot-workflow-demo.html',
    'assets/marketing/formpilot-workflow-demo.png',
    'width: 1600',
    'width: 1400',
    'height: 900',
    'height: 560',
    "Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)",
    "layout.images.includes('../../output/playwright/popup-settings.png')",
    'Settings readiness screenshot',
    'layout should be exactly',
    'Page.captureScreenshot'
  ]) {
    assert(renderer.includes(required), `scripts/render-hero.cjs must keep reproducible hero rendering guard: ${required}`);
  }
}

function checkMarketingAssetReferences() {
  const readme = readText('README.md');
  const storeListing = readText('docs/store-listing.md');
  const audit = readText('docs/release-audit.md');
  const changelog = readText('CHANGELOG.md');

  for (const required of [
    'assets/marketing/formpilot-workflow-demo.png',
    'Prepare. Scan. Review. Fill intentionally.'
  ]) {
    assert(readme.includes(required), `README.md must reference the workflow demo asset and positioning: ${required}`);
  }

  for (const required of [
    'assets/marketing/formpilot-workflow-demo.png',
    'assets/marketing/formpilot-workflow-demo.html',
    'workflow demo'
  ]) {
    assert(storeListing.includes(required), `docs/store-listing.md must reference the workflow demo asset: ${required}`);
  }

  for (const [file, text] of [
    ['CHANGELOG.md', changelog],
    ['docs/release-audit.md', audit]
  ]) {
    assert(text.includes('workflow demo') && text.includes('assets/marketing/formpilot-workflow-demo.png'), `${file} must document the workflow demo marketing asset`);
  }
}

function checkManifest(manifest) {
  if (!manifest) return;

  assert(manifest.manifest_version === 3, 'manifest.json must be Manifest V3');
  assert(typeof manifest.name === 'string' && manifest.name.trim(), 'manifest.json must define name');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version || ''), 'manifest.json version must use x.y.z');
  assert(manifest.action?.default_popup === 'popup/popup.html', 'manifest action must point to popup/popup.html');
  assert(manifest.background?.service_worker === 'background.js', 'manifest background service worker must be background.js');

  const permissions = manifest.permissions || [];
  for (const permission of ['activeTab', 'scripting', 'storage', 'contextMenus']) {
    assert(permissions.includes(permission), `manifest permissions missing ${permission}`);
  }

  assert(!manifest.content_scripts, 'manifest must not register permanent content_scripts');
  assert(!(manifest.host_permissions || []).includes('<all_urls>'), 'manifest must not include permanent <all_urls> host permission');

  const expectedHosts = [
    'http://ip-api.com/*',
    'https://ipapi.co/*',
    'https://www.meiguodizhi.com/*',
    'https://api.mail.tm/*',
    'https://api.geoapify.com/*',
    'https://nominatim.openstreetmap.org/*',
    'https://api.openai.com/*'
  ];

  const hostPermissions = manifest.host_permissions || [];
  for (const host of expectedHosts) {
    assert(hostPermissions.includes(host), `manifest host_permissions missing ${host}`);
  }

  const optionalHosts = manifest.optional_host_permissions || [];
  assert(optionalHosts.includes('https://*/*'), 'manifest optional_host_permissions missing https://*/* for custom AI endpoints');
  assert(optionalHosts.includes('http://*/*'), 'manifest optional_host_permissions missing http://*/* for custom AI endpoints');

  for (const icon of Object.values(manifest.icons || {})) {
    assert(exists(icon), `manifest icon does not exist: ${icon}`);
  }

  for (const icon of Object.values(manifest.action?.default_icon || {})) {
    assert(exists(icon), `manifest action icon does not exist: ${icon}`);
  }
}

function checkSensitiveBoundary() {
  const constants = readText('popup/js/constants.js');
  const utils = readText('popup/js/utils.js');
  const storage = readText('popup/js/storage.js');
  const history = readText('popup/js/history.js');
  const archive = readText('popup/js/archive.js');
  const events = readText('popup/js/events.js');
  const formFill = readText('popup/js/form-fill.js');
  const content = readText('scripts/content.js');
  const html = readText('popup/popup.html');
  const background = readText('background.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');
  assert(publicFn.includes('profile = currentData') && publicFn.includes('sensitive') && publicFn.includes('publicData'), 'popup getPublicProfileData must strip sensitive data from current or supplied profile data');

  const backgroundPublicFn = extractFunctionSource(background, 'getPublicProfileData');
  assert(backgroundPublicFn.includes('sensitive') && backgroundPublicFn.includes('publicData'), 'background getPublicProfileData must strip sensitive data');

  const myProfileFn = extractFunctionSource(utils, 'buildMyProfileFillData');
  assert(myProfileFn, 'popup/js/utils.js must define buildMyProfileFillData');

  const forbidden = ['cardNumber', 'cardCvv', 'creditCardNumber', 'creditCardCvv', 'ssn', 'sensitive'];
  const hits = forbidden.filter(term => myProfileFn.includes(term));
  assert(!hits.length, `buildMyProfileFillData must not include forbidden sensitive fields: ${hits.join(', ')}`);

  const copyAllFn = extractFunctionSource(utils, 'copyAllToClipboard');
  assert(copyAllFn, 'popup/js/utils.js must define copyAllToClipboard');
  const copyAllForbidden = ['currentData.sensitive', 'creditCardNumber', 'creditCardCvv', 'ssn', 'monthlySalary'];
  const copyAllHits = copyAllForbidden.filter(term => copyAllFn.includes(term));
  assert(!copyAllHits.length, `copyAllToClipboard must stay public-only and not include sensitive fields: ${copyAllHits.join(', ')}`);
  const copyToClipboardFn = extractFunctionSource(utils, 'copyToClipboard');
  assert(copyToClipboardFn, 'popup/js/utils.js must define copyToClipboard');
  assert(copyToClipboardFn.includes('copyOriginalText') && copyToClipboardFn.includes('copyFeedbackTimer') && copyToClipboardFn.includes('clearTimeout(Number(btn.dataset.copyFeedbackTimer))'), 'shared copy feedback must preserve original labels and restart cleanly on repeated copy clicks');
  assert(copyToClipboardFn.includes("btn.setAttribute('aria-label', '已复制')") && copyToClipboardFn.includes("btn.setAttribute('title', '已复制')"), 'shared copy feedback must synchronize visible, accessible, and tooltip copied state');
  assert(copyAllFn.includes('copyToClipboard(text, btn') && copyAllFn.includes('已复制全部信息'), 'copyAllToClipboard must reuse shared copied-button feedback while staying public-only');

  const mailingFn = extractFunctionSource(utils, 'buildMailingAddressText');
  assert(mailingFn, 'popup/js/utils.js must define buildMailingAddressText');
  const mailingForbidden = ['sensitive', 'password', 'creditCardNumber', 'creditCardCvv', 'ssn', 'monthlySalary'];
  const mailingHits = mailingForbidden.filter(term => mailingFn.includes(term));
  assert(!mailingHits.length, `buildMailingAddressText must stay public contact/address only: ${mailingHits.join(', ')}`);

  assert(utils.includes('function compactLabeledLines') && utils.includes('function appendProfileSection'), 'popup/js/utils.js must keep compact My Profile copy helpers');
  const profileCopyFn = extractFunctionSource(utils, 'copyMyProfileToClipboard');
  assert(profileCopyFn, 'popup/js/utils.js must define copyMyProfileToClipboard');
  assert(profileCopyFn.includes('appendProfileSection') && profileCopyFn.includes('没有可复制的资料') && profileCopyFn.includes('我的资料已复制'), 'copyMyProfileToClipboard must copy compact filled sections and show empty-state feedback');
  const profileCopyForbidden = ['creditCardNumber', 'creditCardCvv', 'cardNumber', 'cardCvv', 'ssn', 'sensitive'];
  const profileCopyHits = profileCopyForbidden.filter(term => profileCopyFn.includes(term));
  assert(!profileCopyHits.length, `copyMyProfileToClipboard must not reference forbidden sensitive fields: ${profileCopyHits.join(', ')}`);

  assert(constants.includes('const MY_PROFILE_EXPORT_VERSION = 1;'), 'popup/js/constants.js must define MY_PROFILE_EXPORT_VERSION');
  assert(constants.includes('const SENSITIVE_FIELD_LABELS') && constants.includes("creditCardNumber: '卡号'"), 'sensitive display fields must keep localized copy labels separate from fill payloads');

  const myProfileFields = evaluateArray(constants, 'MY_PROFILE_FIELD_NAMES', 'popup/js/constants.js');
  const expectedMyProfileFields = [
    'profileFirstName', 'profileLastName', 'profileEmail', 'profilePhone',
    'shippingAddress', 'shippingCity', 'shippingState', 'shippingZipCode', 'shippingCountry',
    'billingAddress', 'billingCity', 'billingState', 'billingZipCode', 'billingCountry',
    'cardIssuer', 'cardNetwork', 'cardLast4', 'cardExpiry', 'billingNote'
  ];
  assert(myProfileFields.length === expectedMyProfileFields.length && expectedMyProfileFields.every(field => myProfileFields.includes(field)), 'MY_PROFILE_FIELD_NAMES must stay limited to approved contact, address, and payment-summary metadata fields');
  const fieldHits = forbidden.filter(term => myProfileFields.includes(term));
  assert(!fieldHits.length, `MY_PROFILE_FIELD_NAMES must not include forbidden sensitive fields: ${fieldHits.join(', ')}`);

  const sanitizeFn = extractFunctionSource(storage, 'sanitizeMyProfilePayload');
  const exportFn = extractFunctionSource(storage, 'exportMyProfileData');
  const importFn = extractFunctionSource(storage, 'importMyProfileFromFile');
  assert(sanitizeFn, 'popup/js/storage.js must define sanitizeMyProfilePayload');
  assert(exportFn, 'popup/js/storage.js must define exportMyProfileData');
  assert(importFn, 'popup/js/storage.js must define importMyProfileFromFile');
  assert(storage.includes('function normalizeCardLast4') && storage.includes('function normalizeCardExpiry') && storage.includes('digits.slice(-4)') && storage.includes('yearFirst') && storage.includes("allDigits.startsWith('20')"), 'My Profile payment summary must normalize pasted card metadata without storing full card values');
  assert(sanitizeFn.includes('MY_PROFILE_FIELD_NAMES') && sanitizeFn.includes('normalizeMyProfile'), 'sanitizeMyProfilePayload must whitelist MY_PROFILE_FIELD_NAMES and normalize imported values');
  assert(storage.includes('function summarizeMyProfileImportPayload') && storage.includes('function getMyProfileImportMessage') && storage.includes("setMyProfileStatus(getMyProfileImportMessage(summary), summary.dropped.length ? 'warning' : 'saved')"), 'My Profile import should summarize dropped fields without expanding the whitelist');
  assert(exportFn.includes('sanitizeMyProfilePayload') && exportFn.includes('MY_PROFILE_EXPORT_VERSION'), 'exportMyProfileData must sanitize data and include export version metadata');
  assert(importFn.includes('sanitizeMyProfilePayload') && importFn.includes('128 * 1024'), 'importMyProfileFromFile must sanitize imported data and enforce a small local JSON size cap');

  for (const [label, fnSource] of Object.entries({ sanitizeMyProfilePayload: sanitizeFn, exportMyProfileData: exportFn, importMyProfileFromFile: importFn })) {
    const fnHits = forbidden.filter(term => fnSource.includes(term));
    assert(!fnHits.length, `${label} must not reference forbidden sensitive fields: ${fnHits.join(', ')}`);
  }

  assert(html.includes('id="importMyProfile"') && html.includes('id="exportMyProfile"') && html.includes('id="myProfileImportFile"'), 'My Profile import/export controls must be present in popup markup');
  assert(events.includes('importMyProfileFromFile') && events.includes('exportMyProfileData'), 'My Profile import/export controls must be wired in popup events');
  assert(background.includes('data: getPublicProfileData(cached.currentData)'), 'keyboard shortcut path must send public profile data only');
  assert(storage.includes('currentData: getPublicProfileData()'), 'cached generated data must be stored public-only');
  assert(storage.includes('cached.currentData = getPublicProfileData(cached.currentData)') && storage.includes("await chrome.storage.local.set({ [STORAGE_KEY]: cached })"), 'legacy cached generated data must be migrated to public-only data on load');
  assert(history.includes('function sanitizeHistoryItem') && history.includes('data: getPublicProfileData(item?.data || {})'), 'history records must sanitize stored profile payloads');
  assert(history.includes('async function normalizeHistoryStorage') && history.includes('await chrome.storage.local.set({ [HISTORY_KEY]: normalized })'), 'history storage must migrate old sensitive records when read');
  assert(history.includes('const publicData = getPublicProfileData()') && history.includes('data: publicData') && !history.includes('data: { ...currentData }'), 'new history records must store public profile data only');
  assert(archive.includes('function sanitizeArchiveItem') && archive.includes('data: getPublicProfileData(item?.data || {})'), 'archive records must sanitize stored profile payloads');
  assert(archive.includes('async function normalizeArchiveStorage') && archive.includes('await chrome.storage.local.set({ [ARCHIVES_KEY]: normalized })'), 'archive storage must migrate old sensitive records when read');
  assert(archive.includes('const publicData = getPublicProfileData()') && archive.includes('data: publicData') && !archive.includes('data: { ...currentData }'), 'new archive records must store public profile data only');
  assert(archive.includes('currentData = getPublicProfileData(archives[index].data)'), 'loaded archive records must restore public profile data only');
  assert(keyboard.includes('verifyPublicStorageBoundary') && keyboard.includes('formPilotCachedData') && keyboard.includes('formPilotHistory') && keyboard.includes('formPilotArchives'), 'popup keyboard verifier must prove cache, history, and archives stay public-only');
  assert(keyboard.includes('verifyMyProfileCopyOutput') && keyboard.includes('profileCopy:compact/empty') && keyboard.includes('My Profile empty copy should not write to clipboard'), 'popup keyboard verifier must cover compact My Profile copy output and empty-state feedback');

  assert(formFill.includes('AI_FORBIDDEN_FIELD_TERMS') && formFill.includes('AI_FORBIDDEN_LOCALIZED_TERMS'), 'AI form fill must define forbidden sensitive field terms');
  assert(formFill.includes('isForbiddenAIFormField') && formFill.includes('delete mapping[key]'), 'AI form mapping sanitizer must remove forbidden sensitive field mappings');
  assert(!formFill.includes('Resident ID numbers') && formFill.includes('Do not generate resident ID numbers'), 'AI form prompt must not ask for generated government identifiers');
  for (const forbiddenPrompt of ['full card numbers', 'CVV/CVC', 'SSN', 'national IDs', 'bank account numbers', 'income', 'salary']) {
    assert(formFill.includes(forbiddenPrompt), `AI form prompt must mention forbidden sensitive category: ${forbiddenPrompt}`);
  }
  assert(content.includes('SMART_FILL_FORBIDDEN_FIELD_TERMS') && content.includes('SMART_FILL_FORBIDDEN_LOCALIZED_TERMS'), 'content smart fill must define forbidden sensitive field terms');
  assert(content.includes('isForbiddenSmartFillTarget'), 'content smart fill must reject sensitive field targets after popup sanitization');
  assert(content.includes('shouldSkipFilledField') && content.includes("'skipped filled'"), 'content fill must support fill-empty-only skips without overwriting existing values');
  assert(content.includes("results[key] = 'skipped empty'"), 'content smart fill must skip empty AI mapping values');
  assert(content.includes("results[key] = 'skipped sensitive'"), 'content smart fill must report skipped sensitive targets');
}

function checkFillEmptyOnlyMode() {
  const html = readText('popup/popup.html');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const utils = readText('popup/js/utils.js');
  const storage = readText('popup/js/storage.js');
  const events = readText('popup/js/events.js');
  const formFill = readText('popup/js/form-fill.js');
  const content = readText('scripts/content.js');
  const background = readText('background.js');
  const fixture = readText('tests/manual/form-fixture.html');
  const browserFixture = readText('scripts/verify-fixture-browser.cjs');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(html.includes('id="fillEmptyOnlyToggle"') && html.includes('id="fillEmptyOnlyWrapper"') && html.includes('只填写空白字段'), 'popup must expose the fill-empty-only toggle with localized copy');
  assert(html.includes('<span class="ai-toggle-label">地图<span class="ai-toggle-state" aria-hidden="true">开</span></span>') && html.includes('<span class="ai-toggle-label">空白<span class="ai-toggle-state" aria-hidden="true">关</span></span>'), 'command dock toggles must expose visible text states instead of relying on color alone');
  assert(constants.includes("const AI_MODE_KEY = 'formPilotUseAI'") && constants.includes("const FILL_EMPTY_ONLY_KEY = 'formPilotFillEmptyOnly'") && constants.includes("const ADDRESS_API_ENABLED_KEY = 'formPilotAddressApiEnabled'") && constants.includes('fillEmptyOnlyToggle: null'), 'command dock storage keys and DOM refs must be centralized');
  assert(popup.includes('AI_MODE_KEY') && popup.includes('FILL_EMPTY_ONLY_KEY') && popup.includes('ADDRESS_API_ENABLED_KEY') && popup.includes("elements.fillEmptyOnlyToggle = document.getElementById('fillEmptyOnlyToggle')") && popup.includes("document.getElementById('useAddressApiToggle')") && popup.includes('syncAIModeToggleAvailability()'), 'popup bootstrap must restore command toggles and sync AI mode availability');
  assert(events.includes('elements.fillEmptyOnlyToggle.addEventListener') && events.includes('[FILL_EMPTY_ONLY_KEY]: elements.fillEmptyOnlyToggle.checked'), 'fill-empty-only toggle must persist locally');
  assert(events.includes('syncAIModeToggleAvailability();') && events.includes('[AI_MODE_KEY]: elements.useAIToggle.checked && isAISettingsReady()'), 'AI mode toggle must persist only while AI settings are ready');
  assert(events.includes('[ADDRESS_API_ENABLED_KEY]: addressApiToggle.checked') && events.includes('updateSettingsOverview()'), 'address API toggle must persist locally and refresh overview state');
  assert(formFill.includes('function getFillOptions') && formFill.includes('fillEmptyOnly: elements.fillEmptyOnlyToggle?.checked === true'), 'popup fill commands must derive shared fill options');
  assert(utils.includes('function isAISettingsReady') && utils.includes('function syncAIModeToggleAvailability') && utils.includes('function isAIModeEnabled') && utils.includes('userSettings.enableAI') && utils.includes('elements.useAIToggle?.checked'), 'AI mode readiness helpers must stay centralized in popup utilities');
  assert(events.includes('if (isAIModeEnabled())') && formFill.includes('if (isAIModeEnabled())'), 'AI generation and AI smart fill must share the same readiness gate');
  assert(storage.includes('if (!syncAIModeToggleAvailability())') && storage.includes('[AI_MODE_KEY]: false'), 'saving disabled or incomplete AI settings must clear stored AI command mode');
  assert(formFill.includes("{ action: 'fillForm', data: getPublicProfileData(), options: fillOptions }") && formFill.includes("{ action: 'fillFormSmart', data: mapping, options: fillOptions }") && formFill.includes("{ action: 'fillForm', data, options: fillOptions }"), 'main, AI, and My Profile fills must pass fill-empty-only options');
  assert(background.includes('FILL_EMPTY_ONLY_KEY') && background.includes('options: { fillEmptyOnly: result[FILL_EMPTY_ONLY_KEY] === true }'), 'keyboard shortcut fill must pass fill-empty-only options');
  assert(content.includes('function shouldSkipFilledField') && content.includes("results[fieldName] = 'skipped filled'") && content.includes("results[key] = 'skipped filled'"), 'content script must skip filled standard and smart-fill targets');
  assert(fixture.includes('window.runEmbeddedCheck = runEmbeddedCheck') && fixture.includes('runEmbeddedEmptyOnlyCheck') && fixture.includes("options: { fillEmptyOnly: true }") && fixture.includes('reportsSkipped'), 'manual fixture must expose browser-callable checks and cover fill-empty-only behavior');
  assert(!fixture.includes('font-family: Inter,'), 'manual fixture must prefer installed system UI fonts before optional font names');
  for (const required of ['startStaticServer', 'runFixtureCheck', 'window.runEmbeddedCheck', 'window.runEmbeddedSmartSafetyCheck', 'window.runEmbeddedEmptyOnlyCheck', 'verifyMobileLayout', 'output/playwright/form-fixture-mobile.png']) {
    assert(browserFixture.includes(required), `browser fixture verifier must include ${required}`);
  }
  assert(keyboard.includes('verifyCommandTogglePersistence') && keyboard.includes('formPilotAddressApiEnabled') && keyboard.includes('addressSourceAfterReload') && keyboard.includes('addressOverviewAfterReload') && keyboard.includes('AI mode toggle should persist on only while settings are ready') && keyboard.includes('regenerate should not call AI after settings disable the hidden command toggle') && keyboard.includes('commandToggles:address/empty/AI/reload'), 'popup keyboard verifier must cover address, empty-only, and AI command toggle persistence plus reload restoration');
}

function checkPopupStyleBoundary() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  assert(!/\sstyle=/.test(html), 'popup markup must keep styling in popup/popup.css instead of inline style attributes');

  const popupScripts = [
    'popup/popup.js',
    ...walk('popup/js', relative => relative.endsWith('.js'))
  ];

  for (const file of popupScripts) {
    const source = readText(file);
    assert(!/\.style\.(display|position)\b/.test(source), `${file} should use CSS classes instead of direct display/position style mutation`);
  }

  assert(css.includes('@media (prefers-reduced-motion: reduce)') && css.includes('animation: none !important') && css.includes('transition: none !important') && css.includes('scroll-behavior: auto !important'), 'popup CSS must respect reduced-motion preferences by disabling animations, transitions, and smooth scrolling');
  assert(css.includes('.loading-spinner') && css.includes('.modal-overlay.show .modal') && css.includes('.pulse'), 'reduced-motion CSS must cover spinner, modal, and pulse animations');
  assert(css.includes('.ai-toggle-state') && css.includes('min-height: 38px') && css.includes("content: '开'") && css.includes("content: '关'") && css.includes('.ai-toggle input[type="checkbox"]') && !css.includes('.ai-toggle input[type="checkbox"] {\n  display: none;'), 'command dock toggles must keep visible text states, stable dimensions, and keyboard-focusable checkbox inputs');
  assert(keyboard.includes('verifyReducedMotionContract') && keyboard.includes('prefers-reduced-motion') && keyboard.includes('motion:reduced'), 'popup keyboard verifier must prove reduced-motion behavior in a real browser');
}

function checkPopupCopyPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const ui = readText('popup/js/ui.js');
  const utils = readText('popup/js/utils.js');
  const storage = readText('popup/js/storage.js');
  const popup = readText('popup/popup.js');

  for (const required of [
    '<span class="brand-mark" aria-hidden="true">FP</span>',
    '<p class="tagline">表单测试工作台</p>',
    '<span class="profile-btn-label">资料</span>',
    '>历史</button>',
    '>设置</button>',
    '>浅色</button>',
    '<span class="ip-info-label">当前位置</span>',
    '<span class="ai-toggle-label">地图<span class="ai-toggle-state" aria-hidden="true">开</span></span>',
    '<span>身份</span>',
    '<span>账号</span>',
    '<span>联系</span>',
    'id="copyMailingAddress"',
    '>邮寄</button>',
    '<span>来源</span>'
  ]) {
    assert(html.includes(required), `popup/popup.html should keep localized compact copy: ${required}`);
  }

  for (const required of [
    'aria-label="锁定字段"',
    'aria-pressed="false"',
    'title="复制字段"',
    'title="重新生成字段"',
    'title="复制卡号"',
    'aria-label="复制SSN"'
  ]) {
    assert(html.includes(required), `popup/popup.html should expose default field action accessibility metadata: ${required}`);
  }

  for (const required of [
    '--shadow-header',
    '.brand-mark',
    '.brand-copy',
    'backdrop-filter: blur(18px)',
    'grid-template-columns: auto minmax(0, 1fr) 28px',
    'body.light-theme .header',
    'body.light-theme .ip-info'
  ]) {
    assert(css.includes(required), `popup/popup.css should preserve header workbench polish: ${required}`);
  }

  for (const required of [
    '.lock-btn::before',
    '.lock-btn::after',
    '.lock-btn.locked::before',
    '.lock-btn.locked::after',
    'font-size: 0',
    'color: transparent'
  ]) {
    assert(css.includes(required), `popup/popup.css should render stable non-emoji lock controls: ${required}`);
  }

  for (const required of [
    'function syncFieldActionButton',
    'function syncFieldActionButtons',
    'function syncSensitiveCopyButton',
    'function syncSensitiveCopyButtons',
    "btn.setAttribute('aria-pressed', String(isLocked))",
    'FIELD_LABELS[fieldName]',
    'SENSITIVE_FIELD_LABELS[fieldName]',
    "btn.title = isLocked ? `解锁${label}` : `锁定${label}`",
    "btn.title = `复制${label}`",
    "btn.title = `重新生成${label}`"
  ]) {
    assert(utils.includes(required), `popup/js/utils.js should keep field action button semantics centralized: ${required}`);
  }

  assert(storage.includes('syncFieldActionButtons()') && !storage.includes("textContent = '●'"), 'locked-field loading must reuse centralized field action semantics');
  assert(ui.includes('syncFieldActionButtons()') && ui.includes('syncSensitiveCopyButtons()'), 'updateUI must refresh action button semantics after data changes');
  assert(popup.includes('syncFieldActionButtons()') && popup.includes('syncSensitiveCopyButtons()'), 'popup bootstrap must initialize action button semantics before first interaction');

  assert(ui.includes("textContent = '深色'") && ui.includes("textContent = '浅色'"), 'theme toggle runtime text should stay localized');

  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  assert(keyboard.includes('verifyHeaderWorkbenchPolish') && keyboard.includes('header workbench introduced horizontal overflow'), 'popup keyboard verifier must cover header workbench polish');
  assert(keyboard.includes('settlePopupScreenshotState') && keyboard.includes('screenshot must not include transient toast UI') && keyboard.includes('screenshot must not capture temporary copied button state'), 'popup keyboard verifier must settle transient UI before screenshot capture');
  assert(keyboard.includes('prepareMainScreenshotState') && keyboard.includes('mainScreenshotTop:') && keyboard.includes('main screenshot should show header, command dock, workflow guide, shortcut hint, fill readiness, and profile overview'), 'popup keyboard verifier must keep the main screenshot anchored on the top workbench');
  assert(keyboard.includes('verifyFieldActionButtonContract') && keyboard.includes('field action buttons should keep stable dimensions'), 'popup keyboard verifier must cover field action button accessibility and dimensions');
  assert(keyboard.includes('verifyCopyAllFeedback') && keyboard.includes('Copy All should show copied feedback') && keyboard.includes('Copy All leaked sensitive display data'), 'popup keyboard verifier must cover Copy All public-only copied feedback');
  assert(keyboard.includes('verifyCopyAllEmptyState') && keyboard.includes('Copy All empty state should not write to clipboard') && keyboard.includes('copyAllEmpty:guarded'), 'popup keyboard verifier must cover Copy All empty-state feedback without clipboard writes');
  assert(keyboard.includes('verifyMyProfileCopyOutput') && keyboard.includes('profileCopy:compact/empty'), 'popup keyboard verifier must cover My Profile compact copy and empty state');
  assert(keyboard.includes('verifyFillButtonLoadingState') && keyboard.includes('ariaBusy') && keyboard.includes('Fill button loading state should restore cleanly'), 'popup keyboard verifier must cover Fill button busy/loading accessibility');
}

function checkModalAccessibility() {
  const html = readText('popup/popup.html');
  const ui = readText('popup/js/ui.js');
  const events = readText('popup/js/events.js');

  const modalIds = ['settingsModal', 'historyModal', 'myProfileModal'];
  for (const id of modalIds) {
    const modalMatch = html.match(new RegExp(`<div class="modal-overlay" id="${id}"[\\s\\S]*?>`, 'i'));
    assert(modalMatch, `popup/popup.html must include modal overlay ${id}`);
    const tag = modalMatch?.[0] || '';
    assert(tag.includes('role="dialog"'), `${id} must use role="dialog"`);
    assert(tag.includes('aria-modal="true"'), `${id} must use aria-modal="true"`);
    assert(tag.includes('aria-labelledby="'), `${id} must point to a labelled heading`);
    assert(tag.includes('aria-hidden="true"'), `${id} must default to aria-hidden="true"`);
  }

  const openModalFn = extractFunctionSource(ui, 'openModal');
  const closeModalFn = extractFunctionSource(ui, 'closeModal');
  const trapFocusFn = extractFunctionSource(ui, 'trapModalFocus');
  assert(openModalFn.includes('modalReturnFocus') && openModalFn.includes('document.activeElement'), 'openModal must remember the element that opened the dialog');
  assert(openModalFn.includes("aria-hidden', 'false") || openModalFn.includes('aria-hidden", "false'), 'openModal must clear aria-hidden when showing a dialog');
  assert(closeModalFn.includes('modalReturnFocus.focus()') && closeModalFn.includes("aria-hidden', 'true"), 'closeModal must restore focus and aria-hidden when hiding a dialog');
  assert(trapFocusFn.includes("e.key !== 'Tab'") && trapFocusFn.includes('e.shiftKey') && trapFocusFn.includes('getModalFocusableElements'), 'trapModalFocus must keep Tab focus inside the active dialog');
  assert(trapFocusFn.includes('active === panel') && trapFocusFn.includes('!activeModal.contains(active)'), 'trapModalFocus must handle focus starting on the modal panel or outside the active dialog');
  assert(events.includes('trapModalFocus(e)') && events.includes("e.key === 'Escape'"), 'global keydown handler must wire modal Tab trapping and Escape close');
}

function checkSettingsKeyVisibilityControl() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const events = readText('popup/js/events.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(html.includes('id="openaiKey"') && html.includes('type="password"'), 'OpenAI API key input should default to password mode');
  assert(html.includes('id="toggleOpenAIKeyVisibility"') && html.includes('type="button"') && html.includes('aria-pressed="false"') && html.includes('aria-label="显示 API Key"') && html.includes('title="显示 API Key"') && html.includes('>显示</button>'), 'settings modal should expose an accessible API key visibility toggle');
  assert(constants.includes('toggleOpenAIKeyVisibility: null'), 'popup constants should centralize the API key visibility toggle DOM ref');
  assert(popup.includes("elements.toggleOpenAIKeyVisibility = document.getElementById('toggleOpenAIKeyVisibility')"), 'popup bootstrap should cache the API key visibility toggle');
  assert(events.includes('function toggleOpenAIKeyVisibility') && events.includes("elements.openaiKey.type === 'text'") && events.includes("elements.openaiKey.type = shouldShow ? 'text' : 'password'") && events.includes("textContent = shouldShow ? '隐藏' : '显示'") && events.includes("setAttribute('aria-pressed', String(shouldShow))"), 'settings events should toggle API key visibility and pressed state without changing settings data');
  assert(events.includes("setAttribute('aria-label', shouldShow ? '隐藏 API Key' : '显示 API Key')") && events.includes("title = shouldShow ? '隐藏 API Key' : '显示 API Key'"), 'API key visibility toggle should keep localized accessible labels in sync');
  assert(events.includes("elements.toggleOpenAIKeyVisibility.addEventListener('click', toggleOpenAIKeyVisibility)"), 'settings events should bind the API key visibility toggle click handler');
  assert(css.includes('.key-visibility-btn') && css.includes('min-width: 44px') && css.includes('align-items: stretch'), 'API key visibility button should keep stable compact dimensions');
  assert(keyboard.includes('verifySettingsKeyVisibilityControl') && keyboard.includes('keyVisibility:password/text') && keyboard.includes('should not mutate the key value'), 'popup keyboard verifier must cover API key visibility behavior');
}

function checkSettingsOverviewPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const events = readText('popup/js/events.js');
  const archive = readText('popup/js/archive.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(html.includes('class="modal-body settings-body"') && html.includes('class="settings-overview" id="settingsOverview"'), 'settings modal should expose a settings overview surface at the top');
  for (const key of ['password', 'ai', 'address', 'archive']) {
    assert(html.includes(`data-settings-overview="${key}"`), `settings overview should include ${key} status card`);
  }

  assert(constants.includes('settingsOverview: null') && constants.includes('settingsOverviewItems: {}'), 'settings overview DOM refs should be centralized in constants.js');
  assert(popup.includes("elements.settingsOverview = document.getElementById('settingsOverview')") && popup.includes("document.querySelectorAll('[data-settings-overview]')"), 'popup bootstrap should cache settings overview DOM references');
  assert(ui.includes('function updateSettingsOverview') && ui.includes('function setSettingsOverviewCard') && ui.includes("'password'") && ui.includes("'ai'") && ui.includes("'address'") && ui.includes("'archive'") && ui.includes("addressApiEnabled ? (hasGeoapifyKey ? 'on' : 'partial') : 'off'") && ui.includes("hasGeoapifyKey ? 'Geoapify' : 'OSM'") && ui.includes("'仅用本地地址'"), 'settings UI should render password, AI, address, and archive overview states, including OSM, Geoapify, and disabled address modes');
  assert(events.includes('await saveSettings();') && events.includes('updateSettingsOverview();') && events.includes("elements.geoapifyKey.addEventListener('input', updateSettingsOverview)"), 'settings overview should refresh after settings and Geoapify changes');
  assert(archive.includes('async function openSettingsModal') && archive.includes('await loadArchiveList();') && archive.includes('updateSettingsOverview();'), 'settings modal should load archives before refreshing overview counts');
  assert(css.includes('.settings-overview') && css.includes('.settings-overview-card') && css.includes('.settings-overview-card[data-state="on"]') && css.includes('body.light-theme .settings-overview'), 'settings overview should have dark and light theme styling');
  assert(keyboard.includes('verifySettingsOverviewPolish') && keyboard.includes('settingsOverview:') && keyboard.includes('keyless OSM enrichment') && keyboard.includes('overview should update after enabling AI and Geoapify'), 'popup keyboard verifier must cover settings overview rendering and live updates');
  assert(keyboard.includes('prepareSettingsScreenshotState') && keyboard.includes('settingsScreenshotTop:') && keyboard.includes('settings screenshot should show the settings overview'), 'popup keyboard verifier must keep the Settings screenshot anchored on the overview surface');
}

function checkCompactActionAccessibility() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(html.includes('class="inbox-refresh-btn"') && html.includes('id="refreshInbox"') && html.includes('type="button"') && html.includes('title="刷新收件箱"') && html.includes('aria-label="刷新收件箱"'), 'refresh inbox action must expose a localized accessible name, native button type, and compact inbox-specific style');
  assert(html.includes('id="testAI"') && html.includes('type="button"') && html.includes('title="测试 AI 连接"') && html.includes('aria-label="测试 AI 连接"'), 'AI test action must expose a localized accessible name and native button type');
  assert(css.includes('.inbox-group') && css.includes('grid-template-columns: 50px minmax(0, 1fr)') && css.includes('.inbox-refresh-btn') && css.includes('width: 34px') && css.includes('.inbox-refresh-btn:focus-visible') && css.includes('.inbox-refresh-btn.rotating'), 'inbox panel must keep a compact label column, readable message column, fixed refresh control, focus feedback, and refresh motion state');
  assert(css.includes('transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;'), 'refresh inbox focus ring must not animate box-shadow, so keyboard focus feedback appears immediately');
  assert(keyboard.includes('focusSelectorByTab') && keyboard.includes('verifyCompactActionAccessibility') && keyboard.includes('compactActions:refresh/testAI') && keyboard.includes('refresh inbox action should use its compact inbox style') && keyboard.includes('inbox panel should keep a compact label column') && keyboard.includes('AI test action should expose a localized accessible name'), 'popup keyboard verifier must cover compact action accessible names, real tab focus feedback, and inbox layout polish');
}

function checkPopupSectionToggles() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const events = readText('popup/js/events.js');
  const popup = readText('popup/popup.js');
  const constants = readText('popup/js/constants.js');

  const sections = [
    ['identity', 'identitySectionToggle', 'identitySectionBody'],
    ['account', 'accountSectionToggle', 'accountSectionBody'],
    ['contact', 'contactSectionToggle', 'contactSectionBody'],
    ['source', 'sourceSectionToggle', 'sourceSectionBody']
  ];

  for (const [name, toggleId, bodyId] of sections) {
    assert(html.includes(`data-profile-section="${name}"`), `popup/popup.html must include collapsible ${name} section wrapper`);
    assert(html.includes(`id="${toggleId}"`) && html.includes('data-section-toggle'), `${name} section must use a native toggle button`);
    assert(html.includes(`aria-expanded="true"`) && html.includes(`aria-controls="${bodyId}"`), `${name} section toggle must expose initial expanded state and controlled body`);
    assert(html.includes(`id="${bodyId}"`) && html.includes(`aria-labelledby="${toggleId}"`), `${name} section body must point back to its toggle`);
  }

  for (const [name, expected] of [['identity', '0/4'], ['account', '0/3'], ['contact', '0/6']]) {
    assert(html.includes(`data-section-completion="${name}"`) && html.includes(`>${expected}</span>`), `${name} section must expose a compact completion badge`);
  }

  assert(css.includes('.field-section.collapsed .section-body') && css.includes('.section-toggle'), 'popup/popup.css must style collapsible field sections');
  assert(css.includes('.section-completion') && css.includes('.section-completion[data-state="complete"]') && css.includes('.section-completion[data-state="partial"]'), 'popup/popup.css must style generated-profile section completion badges');
  assert(css.includes('.section-copy-btn') && css.includes('width: 42px') && css.includes('max-width: 42px') && css.includes('.section-copy-btn.copied'), 'section copy buttons must keep stable dimensions and copied feedback styling');
  assert(events.includes('bindProfileSectionToggles') && events.includes('updateSectionToggleState'), 'popup/js/events.js must wire generated-profile section toggles');
  assert(events.includes("setAttribute('aria-expanded'") && events.includes('body.hidden = collapsed'), 'section toggle wiring must keep ARIA state and hidden state synchronized');
  assert(constants.includes("const PROFILE_SECTIONS_KEY = 'formPilotProfileSections'"), 'popup/js/constants.js must centralize the generated-profile section preference key');
  assert(constants.includes('sectionCompletions: {}'), 'popup/js/constants.js must cache generated-profile section completion badges');
  assert(popup.includes("document.querySelectorAll('[data-section-completion]')") && popup.includes('elements.sectionCompletions'), 'popup bootstrap must populate generated-profile section completion badge references');
  assert(events.includes('function getProfileSectionStates') && events.includes('function saveProfileSectionStates') && events.includes('function loadProfileSectionStates'), 'popup/js/events.js must persist generated-profile section states through small UI-only helpers');
  assert(events.includes('[PROFILE_SECTIONS_KEY]: getProfileSectionStates()') && events.includes('chrome.storage.local.get(PROFILE_SECTIONS_KEY)'), 'profile section persistence must use the centralized storage key');
  assert(popup.includes('await bindEvents()'), 'popup bootstrap must wait for section preference restoration before continuing');
  assert(html.includes('id="toggleSensitive"') && html.includes('aria-expanded="false"') && html.includes('aria-controls="sensitiveGrid"'), 'sensitive toggle must expose collapsed ARIA state');
  assert(html.includes('id="sensitiveGrid" hidden'), 'sensitive grid must be hidden while collapsed by default');
  assert(constants.includes('sensitiveGrid: null') && popup.includes("elements.sensitiveGrid = document.getElementById('sensitiveGrid')"), 'popup bootstrap must cache sensitiveGrid for ARIA hidden sync');
  assert(events.includes('updateSensitiveToggleState') && events.includes('elements.sensitiveGrid.hidden = collapsed'), 'sensitive toggle must keep hidden state synchronized');

  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  assert(keyboard.includes('formPilotProfileSections') && keyboard.includes("Page.reload") && keyboard.includes('account section should restore collapsed state after reload'), 'popup keyboard verifier must prove generated-profile section preference persistence');
  assert(keyboard.includes('verifySectionCopyFeedback') && keyboard.includes('sectionCopy:stable/repeat feedback') && keyboard.includes('repeated section copy should keep temporary copied feedback') && keyboard.includes('section copy feedback should not shift button dimensions') && keyboard.includes('section copy should copy public section fields only'), 'popup keyboard verifier must prove section-copy feedback, repeated-copy restore behavior, stable dimensions, and public-only copy content');
}

function checkMyProfileVisualPolish() {
  const css = readText('popup/popup.css');
  const html = readText('popup/popup.html');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const storage = readText('popup/js/storage.js');
  const events = readText('popup/js/events.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  for (const required of [
    '.profile-modal',
    'linear-gradient(180deg, rgba(125, 211, 252, 0.06)',
    '.profile-body',
    'background: rgba(255, 255, 255, 0.015)',
    '.profile-grid input,',
    'min-height: 32px',
    'box-shadow: 0 0 0 3px var(--focus-ring)',
    '.profile-actions',
    'background: rgba(9, 14, 22, 0.98)',
    '.profile-actions-row',
    'grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(72px, 0.92fr)',
    'white-space: nowrap',
    '.profile-action-save',
    '.profile-action-danger',
    '.profile-actions .btn-primary',
    'body.light-theme .profile-actions',
    'body.light-theme .profile-actions .profile-action-save',
    'body.light-theme .profile-actions .profile-action-danger',
    '.profile-save-status',
    'max-width: 230px',
    'text-overflow: ellipsis',
    '.profile-save-status[data-state="saving"]',
    '.profile-save-status[data-state="warning"]',
    '.profile-save-status[data-state="error"]',
    '.profile-completeness',
    '.profile-progress span',
    '.profile-completeness-chip:hover',
    '.profile-completeness-chip[data-state="complete"]',
    '.profile-btn-status',
    '.profile-btn[data-state="complete"] .profile-btn-status',
    '.profile-copy-address:disabled',
    'cursor: not-allowed',
    'body.light-theme .profile-completeness'
  ]) {
    assert(css.includes(required), `popup/popup.css must preserve My Profile visual polish: ${required}`);
  }

  assert(html.includes('id="myProfileHeaderStatus"') && html.includes('class="profile-btn-status"'), 'My Profile header entry must show local completeness status');
  assert(html.includes('class="profile-actions" aria-label="我的资料操作"') && html.includes('class="profile-actions-row" aria-label="资料管理操作"'), 'My Profile action footer should expose grouped action labels');
  assert(html.includes('id="importMyProfile" type="button"') && html.includes('id="exportMyProfile" type="button"') && html.includes('id="copyMyProfile" type="button"') && html.includes('id="saveMyProfile" type="button"'), 'My Profile secondary actions should be explicit non-submit buttons');
  assert(html.indexOf('id="saveMyProfile"') < html.indexOf('id="clearMyProfile"'), 'My Profile clear action should stay visually after save as the isolated destructive action');
  assert(html.includes('id="myProfileStatus"') && html.includes('aria-live="polite"') && html.includes('data-state="saved"'), 'My Profile must include an accessible local save status');
  assert(html.includes('id="myProfileCompleteness"') && html.includes('id="myProfileCompletenessScore"') && html.includes('id="myProfileCompletenessBar"') && html.includes('id="myProfileCompletenessChips"'), 'My Profile must include a local completeness panel');
  assert(html.includes('id="paymentSummaryHint"') && html.includes('粘贴卡号时会只保留尾号') && html.includes('id="cardLast4" maxlength="4" inputmode="numeric" autocomplete="off" aria-describedby="paymentSummaryHint"') && html.includes('id="cardExpiry" maxlength="5" inputmode="numeric" autocomplete="off"'), 'My Profile payment summary inputs should state and enforce the metadata-only boundary');
  assert(html.includes('id="copyShippingToBilling"') && html.includes('aria-disabled="true"') && html.includes('title="先填写收货地址"') && html.includes('disabled>同收货地址</button>'), 'My Profile copy-shipping action should default disabled until shipping address exists');
  assert(constants.includes('MY_PROFILE_COMPLETENESS_GROUPS') && constants.includes("fields: ['profileFirstName', 'profileLastName', 'profileEmail', 'profilePhone']"), 'My Profile completeness groups must stay centralized with allowed fields');
  assert(constants.includes('myProfileHeaderStatus: null') && popup.includes("elements.myProfileHeaderStatus = document.getElementById('myProfileHeaderStatus')"), 'popup bootstrap must cache My Profile header completeness status');
  assert(constants.includes('myProfileStatus: null') && popup.includes("elements.myProfileStatus = document.getElementById('myProfileStatus')"), 'popup bootstrap must cache myProfileStatus for auto-save feedback');
  assert(constants.includes('myProfileCompletenessScore: null') && popup.includes("elements.myProfileCompletenessScore = document.getElementById('myProfileCompletenessScore')"), 'popup bootstrap must cache My Profile completeness elements');
  assert(storage.includes('function setMyProfileStatus') && storage.includes('function persistMyProfile') && storage.includes('function scheduleMyProfileAutoSave'), 'My Profile storage must keep shared status, persistence, and auto-save helpers');
  assert(storage.includes('function cancelMyProfileAutoSave') && storage.includes('clearMyProfileData()') && storage.includes('cancelMyProfileAutoSave();'), 'My Profile clear must cancel pending auto-save before removing local profile storage');
  assert(storage.includes('function hasShippingAddressInput') && storage.includes('function updateCopyShippingToBillingState') && storage.includes("title = enabled"), 'My Profile storage must keep copy-shipping action state centralized');
  assert(storage.includes('updateMyProfileCompleteness()'), 'My Profile storage path must refresh completeness after load and save');
  assert(events.includes('updateMyProfileCompleteness') && events.includes('syncProfileInput'), 'My Profile input events must refresh completeness while typing');
  assert(events.includes("name.startsWith('shipping')") && events.includes('updateCopyShippingToBillingState()'), 'shipping My Profile inputs must refresh copy-to-billing availability while typing');
  assert(ui.includes('function getMyProfileCompletenessSummary') && ui.includes('function updateMyProfileHeaderStatus') && ui.includes('elements.openMyProfile.dataset.state'), 'popup/js/ui.js must render My Profile header completeness from centralized groups');
  assert(ui.includes('function updateMyProfileCompleteness') && ui.includes('MY_PROFILE_COMPLETENESS_GROUPS.map'), 'popup/js/ui.js must render My Profile completeness from centralized groups');
  assert(ui.includes('function getFirstMissingMyProfileField') && ui.includes('data-missing-field') && ui.includes('点击定位缺失项') && ui.includes('type="button"'), 'My Profile completeness chips must expose first-missing-field focus targets');
  assert(storage.includes('sanitizeMyProfilePayload') && storage.includes('MY_PROFILE_FIELD_NAMES'), 'My Profile auto-save path must remain constrained by the whitelist helpers');
  assert(events.includes("addEventListener('paste'") && events.includes('normalizeCardLast4') && events.includes('normalizeCardExpiry'), 'My Profile payment summary input handlers must reuse shared normalization helpers and intercept paste before maxlength truncation');
  assert(events.includes('MY_PROFILE_FIELD_NAMES.forEach') && events.includes('scheduleMyProfileAutoSave'), 'My Profile inputs must be wired to local auto-save');
  assert(events.includes('elements.myProfileCompletenessChips.addEventListener') && events.includes('chip.dataset.missingField') && events.includes("'(prefers-reduced-motion: reduce)'") && events.includes('target.scrollIntoView'), 'My Profile completeness chips must focus missing fields with reduced-motion-aware scrolling');
  assert(keyboard.includes('verifyMyProfilePaymentSummaryNormalization') && keyboard.includes('paymentSummary:normalized') && keyboard.includes('粘贴卡号时会只保留尾号'), 'popup keyboard verifier must prove My Profile payment summary normalization and boundary copy');
  assert(html.includes('id="clearMyProfile"') && html.includes('aria-pressed="false"') && html.includes('aria-label="清空我的资料"') && html.includes('title="清空我的资料"'), 'My Profile clear action must expose an accessible idle state');
  assert(constants.includes('let clearMyProfileConfirmTimer = null'), 'My Profile clear confirmation timer must be centralized with popup state');
  assert(events.includes('function handleClearMyProfileClick') && events.includes("dataset.confirming === 'true'") && events.includes('resetClearMyProfileConfirmState') && events.includes('再次点击确认清空'), 'My Profile clear action must use an in-popup second-click confirmation');
  assert(!events.includes("confirm('确定要清空我的资料吗？')"), 'My Profile clear action must not use a blocking browser confirm dialog');
  assert(css.includes('.profile-actions .btn.confirming') && css.includes('body.light-theme .profile-actions .btn.confirming'), 'My Profile clear confirmation state must be styled in dark and light themes');
  assert(keyboard.includes('verifyMyProfileHeaderStatus') && keyboard.includes('header status should track incomplete profile state') && keyboard.includes('const profileHeaderSummary = await verifyMyProfileHeaderStatus') && keyboard.includes('await sleep(700);'), 'popup keyboard verifier must prove My Profile header completeness state and let autosave settle');
  assert(keyboard.includes('verifyMyProfileVisualContract'), 'popup keyboard verifier must include My Profile visual contract checks');
  assert(keyboard.includes('luminanceFromRgb') && keyboard.includes('primaryVisible') && keyboard.includes('bodyAboveActions') && keyboard.includes('actionButtonOrder') && keyboard.includes('profile-action-danger'), 'My Profile visual contract must check readability, primary visibility, footer separation, and action hierarchy');
  assert(keyboard.includes('verifyMyProfileAutoSave') && keyboard.includes('stored.formPilotMyProfile') && keyboard.includes('forbiddenStored'), 'popup keyboard verifier must prove My Profile auto-save and sensitive-field exclusions');
  assert(keyboard.includes('verifyMyProfileCopyShippingState') && keyboard.includes('copyShippingToBilling'), 'popup keyboard verifier must prove copy-shipping action disabled/enabled state');
  assert(keyboard.includes('verifyMyProfileClearConfirmation') && keyboard.includes('profileClear:confirmed') && keyboard.includes('should not clear stored data'), 'popup keyboard verifier must prove My Profile clear requires confirmation before deleting local data');
  assert(keyboard.includes('completenessText') && keyboard.includes('partialAfterPhone') && keyboard.includes('focusAfterChip') && keyboard.includes('profilePhone'), 'popup keyboard verifier must prove My Profile completeness updates live and focuses missing fields');
  assert(keyboard.includes('restoreMyProfileScreenshotState') && keyboard.includes('profileSnapshot:100%') && keyboard.includes("result.score === '100%'") && keyboard.includes("result.activeId !== 'profilePhone'"), 'popup keyboard verifier must restore My Profile to a complete clean state before screenshot capture');
  assert(keyboard.includes('await sleep(250)') && keyboard.includes("output/playwright/popup-profile.png"), 'popup profile screenshot should wait for modal animation before capture');
}

function checkFillResultFeedback() {
  const html = readText('popup/popup.html');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const formFill = readText('popup/js/form-fill.js');
  const history = readText('popup/js/history.js');
  const ui = readText('popup/js/ui.js');
  const utils = readText('popup/js/utils.js');
  const storage = readText('popup/js/storage.js');
  const css = readText('popup/popup.css');
  const readme = readText('README.md');
  const architecture = readText('docs/architecture.md');
  const changelog = readText('CHANGELOG.md');
  const audit = readText('docs/release-audit.md');
  const store = readText('docs/store-listing.md');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');
  const myProfileFn = extractFunctionSource(utils, 'buildMyProfileFillData');

  assert(formFill.includes('function summarizeFillResults') && formFill.includes('function formatFillResultToast') && formFill.includes('function buildFillHistorySummary'), 'popup fill flow must summarize content-script fill results');
  assert(formFill.includes('skipFilled') && formFill.includes('skipSensitive') && formFill.includes('skipEmpty') && formFill.includes('skipOther'), 'fill result summaries must break skipped fields into filled, sensitive, empty, and other reasons');
  assert(formFill.includes('showToast(formatFillResultToast(fillResult') && formFill.includes('const summary = buildFillHistorySummary(fillResult') && formFill.includes('saveToHistory(summary)'), 'popup fill flow must surface fill counts and persist a compact history summary');
  assert(formFill.includes("const loading = showLoading(btn, '填写中...')") && formFill.includes('loading.restore()') && !formFill.includes('const originalText = btn.textContent'), 'main Fill button must reuse shared loading state and restore through showLoading');
  assert(formFill.includes('const commandDockGuard = guardCommandDockDuringFill()') && formFill.includes('commandDockGuard.restore()'), 'main Fill must guard and restore command-dock controls while filling');
  assert(utils.includes("btn.setAttribute('aria-busy', 'true')") && utils.includes("btn.removeAttribute('aria-busy')") && utils.includes('originalAriaBusy'), 'showLoading must expose and restore aria-busy for busy controls');
  assert(utils.includes('function setControlsDisabled') && utils.includes('function guardCommandDockDuringFill') && utils.includes('elements.fillEmptyOnlyToggle'), 'utils must centralize temporary command-dock disabling');
  assert(history.includes('async function saveToHistory(fillSummary)') && history.includes('fillSummary: fillSummary || null'), 'history records must store compact fill summaries without changing profile payloads');
  assert(ui.includes('function formatHistoryFillSummary') && ui.includes('history-item-fill'), 'history UI must render fill result summaries');
  assert(css.includes('.history-item-fill') && css.includes('text-overflow: ellipsis'), 'history fill summaries must remain compact in the modal');

  for (const required of [
    'class="last-fill-result" id="lastFillResult"',
    'aria-label="上次填表结果"',
    'id="lastFillResultTitle"',
    'id="lastFillResultDetail"',
    'id="lastFillFilled"',
    'id="lastFillSkipped"',
    'id="lastFillMissed"',
    '填表后显示命中、跳过和未命中字段。'
  ]) {
    assert(html.includes(required), `popup/popup.html must expose the last-fill result workbench surface: ${required}`);
  }

  for (const required of [
    '.last-fill-result',
    '.last-fill-result[hidden]',
    '.last-fill-result[data-state="warning"]',
    '.last-fill-result-metrics',
    'grid-template-columns: repeat(3, 52px)',
    '.last-fill-result-metrics span[data-state="ready"]',
    '.last-fill-result-metrics span[data-state="warning"]',
    'body.light-theme .last-fill-result',
    '.last-fill-result,'
  ]) {
    assert(css.includes(required), `popup/popup.css must style the last-fill result as a stable compact surface: ${required}`);
  }

  for (const key of ['lastFillResult', 'lastFillResultTitle', 'lastFillResultDetail', 'lastFillFilled', 'lastFillSkipped', 'lastFillMissed']) {
    assert(constants.includes(`${key}: null`), `popup/js/constants.js must cache ${key}`);
    assert(popup.includes(`elements.${key} = document.getElementById('${key}')`), `popup/popup.js must populate ${key}`);
  }

  for (const required of [
    'function renderLastFillResult',
    'function setLastFillMetric',
    'function getFillResultModeLabel',
    'function formatSkipReasonSummary',
    '跳过 ${summary.skipped}${skipReason ? `（${skipReason}）` : \'\'}',
    'elements.lastFillResult.hidden = false',
    'elements.lastFillResult.dataset.state = state',
    'formatHistoryFillSummary(summary)',
    "summary.mode === 'myProfile'"
  ]) {
    assert(ui.includes(required), `popup/js/ui.js must render the last-fill result from compact fill summary state: ${required}`);
  }

  assert(formFill.includes('renderLastFillResult(summary)') && formFill.includes("renderLastFillResult(buildFillHistorySummary(fillResult, fillOptions, 'myProfile'))"), 'main Fill and My Profile fill must update the last-fill result surface');
  assert(!formFill.includes('window.close();'), 'successful fills should keep the popup open so the last-fill result is visible');
  assert(!saveDataFn.includes('lastFill') && !publicFn.includes('lastFill') && !myProfileFn.includes('lastFill'), 'last-fill result UI state must not enter storage or fill payload helpers');

  assert(keyboard.includes('verifyFillResultFeedback') && keyboard.includes('formatFillResultToast') && keyboard.includes('formatHistoryFillSummary') && keyboard.includes('renderLastFillResult') && keyboard.includes('skipFilled') && keyboard.includes('lastFill:AI/visible'), 'popup keyboard verifier must cover fill result feedback formatting, skip reasons, and the last-fill result surface');
  assert(keyboard.includes('verifyFillButtonLoadingState') && keyboard.includes('Fill button should expose a busy loading state'), 'popup keyboard verifier must cover fill button busy state feedback');
  assert(keyboard.includes('guardCommandDockDuringFill') && keyboard.includes('guardedBefore') && keyboard.includes('guardedBusy') && keyboard.includes('guardedRestored') && keyboard.includes('restore its previous disabled state'), 'popup keyboard verifier must prove command-dock controls are disabled and restored to their previous state during Fill busy state');

  for (const [file, text] of Object.entries({ readme, architecture, changelog, audit, store })) {
    assert(text.includes('last-fill') || text.includes('上次填表') || text.includes('last fill'), `${file} must document the last-fill result workflow`);
  }
}

function checkInboxVerificationCodeCopy() {
  const ui = readText('popup/js/ui.js');
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(ui.includes('<button class="verification-code" type="button"') && ui.includes('title="复制验证码"') && ui.includes('aria-label="复制验证码 ${code}"') && ui.includes('data-code="${code}"'), 'verification codes in the inbox must render as accessible copy buttons');
  assert(ui.includes('const copyVerificationCode') && ui.includes('btn.dataset.code') && ui.includes('navigator.clipboard.writeText(code)') && ui.includes("showToast('验证码已复制')"), 'verification code copy should use the button target and success toast');
  assert(ui.includes("el.addEventListener('keydown'") && ui.includes("e.key !== 'Enter'") && ui.includes("e.key !== ' '") && ui.includes('e.preventDefault()'), 'verification code copy buttons must share click and keyboard activation paths');
  assert(!ui.includes('<span class="verification-code"'), 'verification code copy controls must not regress to mouse-only spans');
  assert(css.includes('.verification-code:hover') && css.includes('.verification-code:focus-visible') && css.includes('min-width: 44px') && css.includes('min-height: 24px'), 'verification code buttons must keep hover, focus, and stable touch dimensions');
  assert(keyboard.includes('verifyInboxVerificationCodeCopy') && keyboard.includes('inboxCode:keyboard copy') && keyboard.includes('verification code button should copy through keyboard activation'), 'popup keyboard verifier must prove verification-code copy button accessibility and keyboard activation');
}

function checkInboxErrorState() {
  const mail = readText('popup/js/mail.js');
  const ui = readText('popup/js/ui.js');
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(ui.includes('function renderInboxError(error, options = {})') && ui.includes('data-state="error"') && ui.includes('role="alert"') && ui.includes('收件箱刷新失败') && ui.includes('data-role="recovery"'), 'Mail.tm inbox failures must render an inline accessible error state with optional recovery copy');
  assert(mail.includes('renderInboxError(e);') && mail.includes("showToast('收件箱刷新失败')"), 'Mail.tm refresh failures must update the inbox surface and toast, not only log to console');
  assert(mail.includes("title: '临时邮箱注册失败'") && mail.includes('已改用普通邮箱') && mail.includes('elements.inboxGroup.classList.remove') && mail.includes('稍后重新生成临时邮箱'), 'Mail.tm registration failures must keep a fallback email usable and leave inline recovery visible');
  assert(css.includes('.inbox-state') && css.includes('.inbox-state[data-state="error"]') && css.includes('.inbox-recovery') && css.includes('word-break: break-word') && css.includes('body.light-theme .inbox-state[data-state="error"]'), 'Mail.tm inline error state must have compact dark and light theme styling plus recovery copy styling');
  assert(keyboard.includes('verifyInboxErrorState') && keyboard.includes('inboxError:visible') && keyboard.includes('Mail.tm failure should render an inline error title'), 'popup keyboard verifier must cover the Mail.tm inline failure state');
  assert(keyboard.includes('verifyTempMailRegistrationRecovery') && keyboard.includes('tempMailRecovery:fallback visible') && keyboard.includes('Temp mail registration failure should keep fallback email usable'), 'popup keyboard verifier must cover Mail.tm registration recovery and fallback email behavior');
}

function checkExternalServiceRecoveryStates() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const events = readText('popup/js/events.js');
  const api = readText('popup/js/api.js');
  const storage = readText('popup/js/storage.js');
  const utils = readText('popup/js/utils.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const readme = readText('README.md');
  const architecture = readText('docs/architecture.md');
  const changelog = readText('CHANGELOG.md');
  const audit = readText('docs/release-audit.md');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');
  const myProfileFn = extractFunctionSource(utils, 'buildMyProfileFillData');
  const hasAddressNullFallback = source => /if \(realAddress && realAddress\.address\)[\s\S]*?}\s*else\s*{[\s\S]*?addressEnhancementState = 'fallback';[\s\S]*?setAddressServiceState\('fallback'\)/.test(source);

  assert(html.includes('id="addressServiceState"') && html.includes('class="field-note address-service-state"') && html.includes('role="status"') && html.includes('aria-live="polite"'), 'popup must expose an inline address service recovery status near the source controls');
  assert(constants.includes('addressServiceState: null') && popup.includes("elements.addressServiceState = document.getElementById('addressServiceState')"), 'address service status DOM ref must be centralized and bootstrapped');

  for (const required of [
    'const ADDRESS_SERVICE_COPY',
    'function setAddressServiceState',
    'function syncAddressServiceState',
    "title: '地址服务已降级'",
    "title: '地址增强已关闭'",
    "title: '正在检查地址服务'",
    "title: '地址服务可用'",
    'elements.addressServiceState',
    'panel.dataset.state = nextState',
    'syncAddressServiceState();'
  ]) {
    assert(ui.includes(required), `popup/js/ui.js must render derived address service recovery states: ${required}`);
  }

  for (const required of [
    '.address-service-state',
    '.address-service-state[data-state="ready"]',
    '.address-service-state[data-state="loading"]',
    '.address-service-state[data-state="fallback"]',
    '.address-service-state[data-state="off"]',
    'body.light-theme .address-service-state[data-state="fallback"]'
  ]) {
    assert(css.includes(required), `popup/popup.css must style address service recovery state: ${required}`);
  }

  assert(events.includes("setAddressServiceState('loading')") && events.includes("setAddressServiceState('fallback')") && events.includes("setAddressServiceState('ready'") && hasAddressNullFallback(events) && events.includes('syncAddressServiceState();'), 'regenerate flow must update address service status for checking, success, fallback, null fallback, and toggle changes');
  assert(api.includes("setAddressServiceState('loading')") && api.includes("setAddressServiceState('fallback')") && api.includes("setAddressServiceState('ready'") && hasAddressNullFallback(api) && api.includes("setAddressServiceState('off')"), 'initial IP/address flow must update address service status for checking, success, fallback, null fallback, and disabled states');
  assert(!saveDataFn.includes('addressService') && !publicFn.includes('addressService') && !myProfileFn.includes('addressService'), 'address service recovery UI state must not enter storage or fill payload helpers');
  assert(keyboard.includes('verifyAddressServiceRecoveryState') && keyboard.includes('addressRecovery:fallback visible') && keyboard.includes('Address service failure should render fallback state'), 'popup keyboard verifier must cover address service fallback recovery state');

  for (const [file, text] of Object.entries({ readme, architecture, changelog, audit })) {
    assert(text.includes('service recovery') || text.includes('服务恢复') || text.includes('外部服务恢复'), `${file} must document external service recovery states`);
  }
}

function checkHistoryClearConfirmation() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const events = readText('popup/js/events.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(html.includes('id="clearHistory"') && html.includes('aria-pressed="false"') && html.includes('aria-label="清空历史记录"') && html.includes('title="清空历史记录"'), 'History clear action must expose an accessible idle state');
  assert(constants.includes('let clearHistoryConfirmTimer = null'), 'History clear confirmation timer must be centralized with popup state');
  assert(events.includes('function handleClearHistoryClick') && events.includes("dataset.confirming === 'true'") && events.includes('resetClearHistoryConfirmState') && events.includes('再次点击确认清空历史'), 'History clear action must use an in-popup second-click confirmation');
  assert(!events.includes("confirm('确定要清空所有历史记录吗？')"), 'History clear action must not use a blocking browser confirm dialog');
  assert(css.includes('.history-actions .btn.confirming') && css.includes('flex: 0 0 104px') && css.includes('width: 104px') && css.includes('min-width: 104px') && css.includes('max-width: 104px'), 'History clear confirmation state must keep stable compact dimensions');
  assert(keyboard.includes('verifyHistoryClearConfirmation') && keyboard.includes('historyClear:confirmed') && keyboard.includes('should not delete history'), 'popup keyboard verifier must prove History clear requires confirmation before deleting local data');
}

function checkHistoryItemDeleteConfirmation() {
  const css = readText('popup/popup.css');
  const ui = readText('popup/js/ui.js');
  const history = readText('popup/js/history.js');
  const events = readText('popup/js/events.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(ui.includes('title="删除历史记录"') && ui.includes('aria-label="删除历史记录"') && ui.includes('aria-pressed="false"') && ui.includes('data-confirming="false"') && ui.includes('>删除</button>'), 'History item delete action must expose an accessible idle state');
  assert(ui.includes("btn.dataset.confirming === 'true'") && ui.includes('markHistoryItemDeleteConfirm(btn)') && ui.includes("showToast('再次点击确认删除历史')"), 'History item delete click handler must require a second in-popup click before deleting');
  assert(history.includes('function resetHistoryItemDeleteConfirmState') && history.includes('function markHistoryItemDeleteConfirm'), 'History module must own item delete confirmation state helpers');
  assert(history.includes("btn.textContent = '确认'") && history.includes("btn.title = '再次点击删除历史记录'") && history.includes("btn.setAttribute('aria-pressed', 'true')"), 'History item delete confirmation helper must expose second-click state and pressed feedback');
  assert(history.includes('resetHistoryItemDeleteConfirmState();') && history.includes('async function deleteHistoryItem'), 'History item deletion should reset confirmation state before mutating storage');
  assert(events.includes('resetHistoryItemDeleteConfirmState();') && events.includes('renderFilteredHistoryList()'), 'History search input should reset pending item-delete confirmation before filtering');
  assert(css.includes('.history-item-delete.confirming') && css.includes('min-width: 38px') && css.includes('width: 38px') && css.includes('max-width: 38px'), 'History item delete confirmation state must keep stable compact dimensions');
  assert(keyboard.includes('verifyHistoryItemDeleteConfirmation') && keyboard.includes('historyItemDelete:confirmed') && keyboard.includes('should not delete storage'), 'popup keyboard verifier must prove single History delete requires confirmation before deleting local data');
  assert(keyboard.includes('History search should reset pending item-delete confirmation'), 'popup keyboard verifier must prove History search resets pending item-delete confirmation');
}

function checkArchiveDeleteConfirmation() {
  const ui = readText('popup/js/ui.js');
  const archive = readText('popup/js/archive.js');
  const events = readText('popup/js/events.js');
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(ui.includes("escapeHtml(archive.name || '未命名存档')"), 'Archive names must be escaped before rendering in the settings modal');
  assert(ui.includes('title="加载存档"') && ui.includes('aria-label="加载存档"') && ui.includes('>加载</button>'), 'Archive load action must use localized visible and accessible labels');
  assert(ui.includes('title="删除存档"') && ui.includes('aria-label="删除存档"') && ui.includes('aria-pressed="false"') && ui.includes('data-confirming="false"') && ui.includes('>删除</button>'), 'Archive delete action must expose an accessible idle state');
  assert(archive.includes('function resetArchiveDeleteConfirmState') && archive.includes('function markArchiveDeleteConfirm'), 'Archive module must own delete confirmation state helpers');
  assert(archive.includes("btn.textContent = '确认'") && archive.includes("btn.title = '再次点击删除存档'") && archive.includes("btn.setAttribute('aria-pressed', 'true')"), 'Archive delete confirmation helper must expose second-click state and pressed feedback');
  assert(archive.includes('resetArchiveDeleteConfirmState();') && archive.includes('async function deleteArchive'), 'Archive deletion should reset confirmation state before mutating storage');
  assert(events.includes("btn.dataset.confirming === 'true'") && events.includes('markArchiveDeleteConfirm(btn)') && events.includes("showToast('再次点击确认删除存档')"), 'Archive delete click handler must require a second in-popup click before deleting');
  assert(css.includes('.archive-item-actions .delete-btn.confirming') && css.includes('min-width: 38px') && css.includes('width: 38px') && css.includes('max-width: 38px'), 'Archive delete confirmation state must keep stable compact dimensions');
  assert(keyboard.includes('verifyArchiveDeleteConfirmation') && keyboard.includes('archiveDelete:confirmed') && keyboard.includes('should not delete storage'), 'popup keyboard verifier must prove Archive delete requires confirmation before deleting local data');
}

function checkArchiveSearchPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const archive = readText('popup/js/archive.js');
  const events = readText('popup/js/events.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  for (const required of [
    'class="archive-toolbar"',
    'for="archiveSearch"',
    'id="archiveSearch"',
    'id="archiveInfo"',
    'aria-live="polite"'
  ]) {
    assert(html.includes(required), `popup/popup.html must preserve archive search markup: ${required}`);
  }

  for (const required of [
    '.archive-toolbar',
    '.archive-search-wrap',
    '.archive-search-wrap input:focus',
    '.archive-info'
  ]) {
    assert(css.includes(required), `popup/popup.css must preserve archive search polish: ${required}`);
  }

  assert(constants.includes('let archiveItems = []') && constants.includes('archiveSearch: null') && constants.includes('archiveInfo: null'), 'archive search state and DOM references must be centralized in constants.js');
  assert(popup.includes("elements.archiveSearch = document.getElementById('archiveSearch')") && popup.includes("elements.archiveInfo = document.getElementById('archiveInfo')"), 'popup.js must populate archive search DOM references');
  assert(ui.includes('function renderFilteredArchiveList') && ui.includes('function getArchiveSearchText') && ui.includes('function updateArchiveInfo') && ui.includes('没有匹配的存档'), 'archive UI must support local search and filtered empty state');
  assert(ui.includes('visibleArchives.map(({ archive, index })') && ui.includes('escapeHtml(archive.name'), 'archive search rendering must preserve original archive index and escape names');
  assert(archive.includes("if (elements.archiveSearch) elements.archiveSearch.value = ''") && archive.includes('loadArchiveList()'), 'archive save and settings-open flows should reset stale archive search before rendering');
  assert(events.includes('elements.archiveSearch.addEventListener') && events.includes('resetArchiveDeleteConfirmState();') && events.includes('renderFilteredArchiveList()'), 'archive search input must update live and reset pending delete confirmation');
  assert(keyboard.includes('verifyArchiveSearchContract') && keyboard.includes('archiveSearch:3/1/0') && keyboard.includes('filtered archive load should preserve original index'), 'popup keyboard verifier must cover archive search, empty results, original-index loading, and overflow');
}

function checkHistorySearchPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const events = readText('popup/js/events.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  for (const required of [
    'class="history-toolbar"',
    'for="historySearch"',
    'id="historySearch"',
    'id="historyInfo"',
    'aria-live="polite"'
  ]) {
    assert(html.includes(required), `popup/popup.html must preserve history search markup: ${required}`);
  }

  for (const required of [
    '.history-toolbar',
    '.history-search-wrap',
    '.history-search-wrap input:focus',
    '.history-info'
  ]) {
    assert(css.includes(required), `popup/popup.css must preserve history search polish: ${required}`);
  }

  assert(constants.includes('let historyItems = []') && constants.includes('historySearch: null') && constants.includes('historyInfo: null'), 'history search state and DOM references must be centralized in constants.js');
  assert(popup.includes("elements.historySearch = document.getElementById('historySearch')") && popup.includes("elements.historyInfo = document.getElementById('historyInfo')"), 'popup.js must populate history search DOM references');
  assert(ui.includes('function renderFilteredHistoryList') && ui.includes('function getHistorySearchText') && ui.includes('function updateHistoryInfo') && ui.includes('没有匹配的历史记录'), 'history UI must support local search and filtered empty state');
  assert(ui.includes('<button class="history-item-info" type="button"') && ui.includes('aria-label="${loadLabel}"') && ui.includes('title="加载此记录"'), 'history records must expose loading as a keyboard-focusable button with an accessible name');
  assert(ui.includes('const loadHistoryFromButton') && ui.includes("el.addEventListener('keydown'") && ui.includes("e.key !== 'Enter'") && ui.includes("e.key !== ' '") && ui.includes('e.preventDefault()'), 'history load button must share click and keyboard activation paths');
  assert(ui.includes('escapeHtml(`${data.firstName') && ui.includes('escapeHtml(formatHistoryFillSummary'), 'history search rendering must keep local history strings escaped');
  assert(events.includes("elements.historySearch.addEventListener('input'") && events.includes('resetHistoryItemDeleteConfirmState();') && events.includes('renderFilteredHistoryList()') && events.includes("elements.historySearch) elements.historySearch.value = ''"), 'history search input must update live, reset pending item-delete confirmation, and reset when the history modal opens');
  assert(css.includes('.history-item:focus-within') && css.includes('.history-item-info:focus-visible') && css.includes('box-shadow: 0 0 0 3px var(--focus-ring)'), 'history load button must keep visible focus feedback through popup CSS');
  assert(keyboard.includes('verifyHistorySearchContract') && keyboard.includes('historySearch:2/1/0') && keyboard.includes('没有匹配的历史记录'), 'popup keyboard verifier must cover history search, empty results, and overflow');
  assert(keyboard.includes('History load target should be a labelled focusable button') && keyboard.includes('keyboard activation'), 'popup keyboard verifier must prove history load button accessibility and keyboard activation');
}

function checkCommandDockPolish() {
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  for (const required of [
    '--shadow-command',
    '.actions',
    'grid-template-columns: 38px 44px 44px minmax(110px, 1fr) minmax(120px, 1.08fr)',
    'position: sticky',
    'top: 0',
    'z-index: 20',
    'backdrop-filter: blur(18px)',
    'body.light-theme .actions'
  ]) {
    assert(css.includes(required), `popup/popup.css must preserve sticky command dock polish: ${required}`);
  }

  assert(keyboard.includes('verifyCommandDockContract'), 'popup keyboard verifier must include sticky command dock checks');
  assert(keyboard.includes('stateText') && keyboard.includes('address API toggle should expose visible on text state') && keyboard.includes('empty-only toggle should expose visible off text state'), 'popup keyboard verifier must prove command dock toggle text states are visible and not color-only');
  assert(keyboard.includes('window.scrollTo(0, document.documentElement.scrollHeight)') && keyboard.includes('Fill action should remain visible after scrolling to the bottom'), 'sticky command dock verifier must prove primary actions remain visible after scroll');
  assert(keyboard.includes('sticky command dock introduced horizontal overflow'), 'sticky command dock verifier must guard against horizontal overflow');
}

function checkWorkflowGuidePolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const events = readText('popup/js/events.js');
  const storage = readText('popup/js/storage.js');
  const utils = readText('popup/js/utils.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const readme = readText('README.md');
  const architecture = readText('docs/architecture.md');
  const changelog = readText('CHANGELOG.md');
  const audit = readText('docs/release-audit.md');
  const store = readText('docs/store-listing.md');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');
  const myProfileFn = extractFunctionSource(utils, 'buildMyProfileFillData');

  for (const required of [
    'class="workflow-guide" id="workflowGuide"',
    'data-state="compact"',
    'aria-label="安全填表工作流"',
    'id="workflowGuideToggle"',
    'aria-expanded="false"',
    'aria-controls="workflowGuideDetails"',
    'id="workflowGuideDetails" hidden',
    '先看计划，再填表',
    '扫描只读可见字段',
    '敏感字段保持跳过或手动复制',
    'data-step="prepare"',
    'data-step="scan"',
    'data-step="fill"'
  ]) {
    assert(html.includes(required), `popup/popup.html must expose compact workflow guidance markup: ${required}`);
  }

  for (const required of [
    '.workflow-guide',
    '.workflow-guide[data-state="expanded"]',
    '.workflow-guide-main',
    '.workflow-guide-toggle',
    '.workflow-guide-steps',
    '.workflow-guide-steps span[data-step="prepare"]',
    '.workflow-guide-steps span[data-step="scan"]',
    '.workflow-guide-steps span[data-step="fill"]',
    '.workflow-guide-details',
    '.workflow-guide-details[hidden]',
    'body.light-theme .workflow-guide',
    'body.light-theme .workflow-guide-toggle'
  ]) {
    assert(css.includes(required), `popup/popup.css must style workflow guidance states: ${required}`);
  }

  for (const key of ['workflowGuide', 'workflowGuideToggle', 'workflowGuideDetails']) {
    assert(constants.includes(`${key}: null`), `popup/js/constants.js must cache ${key}`);
    assert(popup.includes(`elements.${key} = document.getElementById('${key}')`), `popup/popup.js must populate ${key}`);
  }

  assert(events.includes('function syncWorkflowGuideState') && events.includes('function toggleWorkflowGuide') && events.includes("workflowGuideToggle.addEventListener('click', toggleWorkflowGuide)") && events.includes("workflowGuideToggle.addEventListener('keydown'") && events.includes("e.key === 'Enter' || e.key === ' '") && events.includes("elements.workflowGuide.dataset.state = expanded ? 'expanded' : 'compact'") && events.includes('elements.workflowGuideDetails.hidden = !expanded'), 'popup events must own workflow guide temporary expand/collapse state with keyboard fallback');
  assert(!saveDataFn.includes('workflowGuide') && !publicFn.includes('workflowGuide') && !myProfileFn.includes('workflowGuide'), 'workflow guide state must not enter storage or fill payload helpers');
  assert(keyboard.includes('verifyWorkflowGuideContract') && keyboard.includes('workflowGuide:') && keyboard.includes('workflow guide should expand with Enter') && keyboard.includes('compact workflow guide introduced horizontal overflow'), 'popup keyboard verifier must cover workflow guide accessibility, keyboard expansion, dimensions, and overflow');
  assert(keyboard.includes('workflow guide, shortcut hint, fill readiness, and profile overview') || keyboard.includes('workflow guide, shortcut hint, fill readiness'), 'main screenshot verifier must require the workflow guide in the top viewport');

  for (const [file, text] of Object.entries({ readme, architecture, changelog, audit, store })) {
    assert(text.includes('workflow guidance') || text.includes('工作流提示') || text.includes('安全填表流程'), `${file} must document workflow guidance`);
  }
}

function checkShortcutConfidenceHint() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const events = readText('popup/js/events.js');
  const storage = readText('popup/js/storage.js');
  const utils = readText('popup/js/utils.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const manifest = checkJson('manifest.json');
  const readme = readText('README.md');
  const architecture = readText('docs/architecture.md');
  const changelog = readText('CHANGELOG.md');
  const audit = readText('docs/release-audit.md');
  const store = readText('docs/store-listing.md');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');
  const myProfileFn = extractFunctionSource(utils, 'buildMyProfileFillData');

  assert(manifest.commands && manifest.commands['fill-form'], 'manifest must define the fill-form keyboard command');
  assert(manifest.commands['fill-form'].suggested_key?.default === 'Ctrl+Shift+F', 'manifest default shortcut must stay Ctrl+Shift+F');

  for (const required of [
    'class="shortcut-hint" id="shortcutHint"',
    'aria-label="快捷键填表提示"',
    'id="shortcutHintKey"',
    'Ctrl+Shift+F',
    'id="shortcutHintDetail"',
    '公开资料',
    '空白优先'
  ]) {
    assert(html.includes(required), `popup/popup.html must expose shortcut confidence hint markup: ${required}`);
  }

  for (const required of [
    '.shortcut-hint',
    '.shortcut-hint-main',
    '.shortcut-hint-key',
    '.shortcut-hint-detail',
    'body.light-theme .shortcut-hint',
    'body.light-theme .shortcut-hint-key'
  ]) {
    assert(css.includes(required), `popup/popup.css must style shortcut confidence hint: ${required}`);
  }

  for (const key of ['shortcutHint', 'shortcutHintKey', 'shortcutHintDetail']) {
    assert(constants.includes(`${key}: null`), `popup/js/constants.js must cache ${key}`);
    assert(popup.includes(`elements.${key} = document.getElementById('${key}')`), `popup/popup.js must populate ${key}`);
  }

  assert(events.includes('function getDefaultShortcutLabel') && events.includes("return navigator.platform?.toLowerCase().includes('mac') ? 'Command+Shift+F' : 'Ctrl+Shift+F'"), 'events must provide a platform-aware shortcut fallback label');
  assert(events.includes('async function syncShortcutHint') && events.includes('chrome.commands.getAll') && events.includes("command.name === 'fill-form'") && events.includes('elements.shortcutHintKey.textContent = shortcut'), 'events must load the active fill-form shortcut through chrome.commands.getAll');
  assert(events.includes('快捷键未绑定') && events.includes('仍可使用填写表单按钮'), 'shortcut hint must handle an unbound command gracefully');
  assert(events.includes('syncShortcutHint();'), 'shortcut hint sync must be invoked during event binding');

  assert(!saveDataFn.includes('shortcutHint') && !publicFn.includes('shortcutHint') && !myProfileFn.includes('shortcutHint'), 'shortcut hint must not enter storage or fill payload helpers');
  assert(keyboard.includes('verifyShortcutHintContract') && keyboard.includes('shortcutHint:') && keyboard.includes('shortcut hint introduced horizontal overflow') && keyboard.includes('same safety boundary as Fill'), 'popup keyboard verifier must cover shortcut hint copy, command label, dimensions, and overflow');

  for (const [file, text] of Object.entries({ readme, architecture, changelog, audit, store })) {
    assert(text.includes('shortcut confidence') || text.includes('shortcut hint') || text.includes('快捷键提示') || text.includes('快捷键填表提示'), `${file} must document shortcut confidence hint`);
  }
}

function checkPageScanPreviewPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const formFill = readText('popup/js/form-fill.js');
  const events = readText('popup/js/events.js');
  const utils = readText('popup/js/utils.js');
  const storage = readText('popup/js/storage.js');
  const content = readText('scripts/content.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const scanFn = extractFunctionSource(formFill, 'scanCurrentPageForms');
  const scanFormFn = extractFunctionSource(content, 'scanForm');
  const matchPreviewFn = extractFunctionSource(content, 'buildScanMatchPreview');

  for (const required of [
    'class="page-scan-panel" id="pageScanPanel"',
    'aria-label="当前页面扫描预览"',
    'aria-live="polite"',
    'id="pageScanTitle"',
    'id="pageScanDetail"',
    'class="page-scan-meta" id="pageScanMeta"',
    'id="pageScanMatchChip"',
    'id="pageScanRequiredChip"',
    'id="pageScanSensitiveChip"',
    'class="page-scan-plan" id="pageScanPlan"',
    'id="pageScanPlanTitle"',
    'id="pageScanPlanMatched"',
    'id="pageScanPlanUnmatched"',
    'id="pageScanPlanSensitive"',
    'id="scanCurrentPage"',
    'title="扫描当前页表单"',
    'aria-label="扫描当前页表单"',
    '只读取当前标签页的可见表单字段，不填写、不保存。',
    '扫描后显示预计填表计划'
  ]) {
    assert(html.includes(required), `popup/popup.html must preserve page scan preview markup: ${required}`);
  }

  for (const required of [
    '.page-scan-panel',
    'grid-template-columns: minmax(0, 1fr) 58px',
    '.page-scan-panel[data-state="ready"]',
    '.page-scan-panel[data-state="loading"]',
    '.page-scan-panel[data-state="empty"]',
    '.page-scan-panel[data-state="error"]',
    '.page-scan-copy strong',
    '#pageScanDetail',
    '.page-scan-meta',
    '.page-scan-meta span[data-state="ready"]',
    '.page-scan-meta span[data-state="warning"]',
    '.page-scan-meta span[data-state="blocked"]',
    '.page-scan-plan',
    '.page-scan-plan[hidden]',
    '.page-scan-plan-title',
    '.page-scan-plan-grid',
    '.page-scan-plan-list',
    '.page-scan-plan-list span[data-state="matched"]',
    '.page-scan-plan-list span[data-state="unmatched"]',
    '.page-scan-plan-list span[data-state="blocked"]',
    '.page-scan-btn',
    'width: 58px',
    'height: 34px',
    'body.light-theme .page-scan-panel[data-state="ready"]',
    'body.light-theme .page-scan-plan',
    'body.light-theme .page-scan-meta span[data-state="blocked"]'
  ]) {
    assert(css.includes(required), `popup/popup.css must preserve page scan preview polish: ${required}`);
  }

  for (const key of ['scanCurrentPage', 'pageScanPanel', 'pageScanTitle', 'pageScanDetail', 'pageScanMeta', 'pageScanMatchChip', 'pageScanRequiredChip', 'pageScanSensitiveChip', 'pageScanPlan', 'pageScanPlanTitle', 'pageScanPlanMatched', 'pageScanPlanUnmatched', 'pageScanPlanSensitive']) {
    assert(constants.includes(`${key}: null`), `popup/js/constants.js must cache ${key}`);
    assert(popup.includes(`elements.${key} = document.getElementById('${key}')`), `popup/popup.js must populate ${key}`);
  }

  assert(content.includes('const PUBLIC_SCAN_PREVIEW_FIELDS') && content.includes('function getPreviewElementsForField') && content.includes('function isSensitiveScanPreviewItem') && content.includes('function buildScanMatchPreview'), 'content script must build a safe public-field match preview for page scans');
  assert(scanFormFn.includes('matchPreview: buildScanMatchPreview(scanItems)') && scanFormFn.includes('scanItems.push({ input, meta })'), 'scanForm must return matchPreview derived from visible field metadata and element references');
  assert(content.includes('SMART_FILL_FORBIDDEN_FIELD_TERMS') && content.includes('SMART_FILL_FORBIDDEN_LOCALIZED_TERMS') && content.includes('normalizeSmartFillText(rawText)'), 'scan match preview must reuse content-script sensitive target terms instead of drifting from smart-fill safety');
  assert(matchPreviewFn.includes('PUBLIC_SCAN_PREVIEW_FIELDS') && matchPreviewFn.includes('matchCount') && matchPreviewFn.includes('requiredMatchCount') && matchPreviewFn.includes('unmatchedRequiredLabels') && matchPreviewFn.includes('sensitiveRequiredCount') && matchPreviewFn.includes('sensitiveRequiredLabels'), 'match preview must expose bounded aggregate counts, unmatched required labels, and sensitive required labels');
  assert(!matchPreviewFn.includes('.value') && !scanFormFn.includes('value:'), 'scanForm match preview must not read or return page field values');
  assert(formFill.includes('function summarizePageScan') && formFill.includes('function formatPageScanDetail') && formFill.includes('function renderPageScanMeta') && formFill.includes('function renderPageScanPlan') && formFill.includes('function setPageScanChip') && formFill.includes('function renderPageScanState') && formFill.includes('async function scanCurrentPageForms'), 'popup form-fill module must own page scan summary, match-preview copy, chip rendering, plan rendering, and state helpers');
  assert(formFill.includes('function getScanPlanFieldLabel') && formFill.includes('FIELD_LABELS[fieldName]') && formFill.includes('function renderScanPlanList') && formFill.includes('pageScanPlanMatched') && formFill.includes('pageScanPlanUnmatched') && formFill.includes('pageScanPlanSensitive'), 'popup scan plan preview must map public field keys through shared labels and render bounded plan lists');
  assert(formFill.includes('matchPreview: matchPreview ?') && formFill.includes('预计命中') && formFill.includes('敏感必填') && formFill.includes('dataset.matchCount') && formFill.includes('pageScanSensitiveChip') && formFill.includes('敏感跳过') && formFill.includes('扫描计划') && formFill.includes('将填写') && formFill.includes('仍需手动确认') && formFill.includes('安全跳过'), 'popup scan preview must render value-free match preview, actionable plan copy, and sensitive skip counts into temporary UI state');
  assert(formFill.includes('renderPageScanPlan(state === \'ready\' ? preview : null)') && formFill.includes('elements.pageScanPlan.hidden = true'), 'page scan plan must render only for ready previews and reset outside ready state');
  assert(scanFn.includes("sendMessageToTab(tab.id, { action: 'scanForm' })"), 'page scan preview must reuse the existing scanForm content-script action');
  assert(scanFn.includes('renderPageScanState') && scanFn.includes('showToast') && scanFn.includes('loading.restore()'), 'page scan preview must show state feedback and restore loading state');
  assert(events.includes("elements.scanCurrentPage.addEventListener('click', scanCurrentPageForms)"), 'page scan button must bind to scanCurrentPageForms');
  assert(utils.includes('elements.scanCurrentPage') && utils.includes('function guardCommandDockDuringFill'), 'main Fill must temporarily guard the page scan action with the other command controls');
  assert(!saveDataFn.includes('pageScan') && !saveDataFn.includes('scanCurrentPage'), 'page scan preview state must remain popup-only and not enter cached storage');
  assert(keyboard.includes('verifyPageScanPreviewContract') && keyboard.includes('预计命中 2/3') && keyboard.includes('敏感跳过 1') && keyboard.includes('扫描计划') && keyboard.includes('pageScanPlanMatched') && keyboard.includes('安全跳过') && keyboard.includes('pageScan:ready/compact-plan') && keyboard.includes('page scan plan introduced horizontal overflow'), 'popup keyboard verifier must cover page scan match preview chips, actionable plan preview, sensitive skip preview, dimensions, and overflow');
}

function checkFillReadinessPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const formFill = readText('popup/js/form-fill.js');
  const events = readText('popup/js/events.js');
  const storage = readText('popup/js/storage.js');
  const utils = readText('popup/js/utils.js');
  const readme = readText('README.md');
  const architecture = readText('docs/architecture.md');
  const changelog = readText('CHANGELOG.md');
  const audit = readText('docs/release-audit.md');
  const store = readText('docs/store-listing.md');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');
  const myProfileFn = extractFunctionSource(utils, 'buildMyProfileFillData');

  for (const required of [
    'class="fill-readiness" id="fillReadiness"',
    'aria-label="填表准备度"',
    'id="fillReadinessTitle"',
    'id="fillReadinessScore"',
    'id="fillReadinessBar"',
    'id="fillReadinessHint"',
    'id="fillReadyProfile"',
    'id="fillReadyPage"',
    'id="fillReadyMode"',
    'id="fillReadyAI"',
    'id="fillReadyAddress"',
    'id="fillReadySavedProfile"'
  ]) {
    assert(html.includes(required), `popup/popup.html must expose fill-readiness markup: ${required}`);
  }

  for (const required of [
    '.fill-readiness',
    '.fill-readiness[data-state="ready"]',
    '.fill-readiness[data-state="warning"]',
    '.fill-readiness-head',
    '.fill-readiness-score',
    '.fill-readiness-track',
    '.fill-readiness-grid',
    'grid-template-columns: repeat(3, minmax(0, 1fr))',
    '.fill-readiness-grid span[data-state="empty-only"]',
    'body.light-theme .fill-readiness',
    '.fill-readiness-track span,'
  ]) {
    assert(css.includes(required), `popup/popup.css must style fill-readiness as a stable workbench surface: ${required}`);
  }

  for (const key of ['fillReadiness', 'fillReadinessTitle', 'fillReadinessScore', 'fillReadinessBar', 'fillReadinessHint', 'fillReadyProfile', 'fillReadyPage', 'fillReadyMode', 'fillReadyAI', 'fillReadyAddress', 'fillReadySavedProfile']) {
    assert(constants.includes(`${key}: null`), `popup/js/constants.js must cache ${key}`);
    assert(popup.includes(`elements.${key} = document.getElementById('${key}')`), `popup/popup.js must populate ${key}`);
  }

  for (const required of [
    'function getFillReadinessModel',
    'function updateFillReadiness',
    'function getReadinessPageState',
    'function getReadinessModeState',
    'function getReadinessAIState',
    'function getReadinessAddressState',
    'getMyProfileCompletenessSummary()',
    'getMissingProfileFields()',
    'elements.fillReadiness.dataset.state',
    'elements.fillReadinessScore.setAttribute',
    'elements.fillReadinessBar.dataset.state',
    'elements.pageScanPanel?.dataset.matchCount',
    'model.page.requiredMatchCount',
    'elements.fillReadyProfile',
    'elements.fillReadySavedProfile'
  ]) {
    assert(ui.includes(required), `popup/js/ui.js must render fill-readiness from derived state: ${required}`);
  }

  assert(formFill.includes('renderPageScanState') && formFill.includes('updateFillReadiness()'), 'page scan rendering must refresh fill readiness without storing scan data');
  assert(events.includes('elements.fillEmptyOnlyToggle.addEventListener') && events.includes('updateFillReadiness();') && events.includes('elements.useAIToggle.addEventListener'), 'command toggle changes must refresh fill readiness');
  assert(ui.includes('updateProfileOverview();') || ui.includes('updateFillReadiness();'), 'profile overview and My Profile completeness updates must refresh readiness state');
  assert(!saveDataFn.includes('fillReadiness') && !saveDataFn.includes('fillReady'), 'fill readiness must remain derived UI state and not enter cached storage payloads');
  assert(!publicFn.includes('fillReadiness') && !publicFn.includes('fillReady'), 'fill readiness must not enter standard public fill payloads');
  assert(!myProfileFn.includes('fillReadiness') && !myProfileFn.includes('fillReady'), 'fill readiness must not enter My Profile fill payloads');
  assert(keyboard.includes('verifyFillReadinessContract') && keyboard.includes('readiness:ready/emptyOnly/partial') && keyboard.includes('fill readiness introduced horizontal overflow'), 'popup keyboard verifier must cover fill-readiness state, mode updates, profile completeness updates, and overflow');

  for (const [file, text] of Object.entries({ readme, architecture, changelog, audit, store })) {
    assert(text.includes('fill-readiness') || text.includes('fill readiness') || text.includes('准备度'), `${file} must document the fill-readiness workflow`);
  }
}

function checkProfileOverviewPolish() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const constants = readText('popup/js/constants.js');
  const popup = readText('popup/popup.js');
  const ui = readText('popup/js/ui.js');
  const api = readText('popup/js/api.js');
  const events = readText('popup/js/events.js');
  const storage = readText('popup/js/storage.js');
  const utils = readText('popup/js/utils.js');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');
  const saveDataFn = extractFunctionSource(storage, 'saveDataToStorage');
  const publicFn = extractFunctionSource(utils, 'getPublicProfileData');

  for (const required of [
    'id="profileOverview"',
    'aria-label="当前生成资料概览"',
    'id="profileOverviewScore"',
    '<div class="profile-overview-track" aria-hidden="true">',
    'id="profileOverviewName"',
    'id="profileOverviewDetail"',
    'id="profileOverviewBar"',
    'id="profileOverviewMissing"',
    'id="profileOverviewLocked"',
    'id="profileOverviewSource"',
    'id="profileOverviewGap"'
  ]) {
    assert(html.includes(required), `popup/popup.html must keep generated profile overview markup: ${required}`);
  }

  for (const required of [
    '.profile-overview',
    'grid-template-columns: auto minmax(0, 1fr) auto',
    '.profile-overview-identity',
    '.profile-overview-identity strong',
    '.profile-overview-identity span',
    '.profile-overview-track',
    'width: 62px',
    'flex-direction: column',
    '.profile-overview-track span',
    'transition: width 0.2s ease',
    '.profile-overview-meta',
    'grid-template-columns: repeat(2, minmax(64px, 1fr))',
    'width: 142px',
    '.profile-overview-meta span:first-child',
    '.profile-overview-meta span:last-child',
    'grid-column: 1 / -1',
    '.profile-overview[data-state="complete"]',
    '.profile-overview-track span[data-state="partial"]',
    '.profile-overview-meta span[data-state="locked"]',
    '.profile-overview-meta span[data-state="fallback"]',
    '.profile-overview-meta span[data-state="meiguodizhi"]',
    '.profile-overview-gap',
    '.profile-overview-gap[data-state="complete"]',
    'body.light-theme .profile-overview-gap',
    'body.light-theme .profile-overview'
  ]) {
    assert(css.includes(required), `popup/popup.css must preserve generated profile overview polish: ${required}`);
  }

  for (const key of ['profileOverview', 'profileOverviewScore', 'profileOverviewName', 'profileOverviewDetail', 'profileOverviewBar', 'profileOverviewMissing', 'profileOverviewLocked', 'profileOverviewSource', 'profileOverviewGap']) {
    assert(constants.includes(`${key}: null`), `popup/js/constants.js must cache ${key}`);
    assert(popup.includes(`elements.${key} = document.getElementById('${key}')`), `popup/popup.js must populate ${key}`);
  }

  assert(ui.includes('function updateProfileOverview') && ui.includes('function getMissingProfileFields') && ui.includes('function getProfileFieldLabel') && ui.includes('lockedFields.size'), 'popup/js/ui.js must render generated profile overview from shared missing-field helpers and lockedFields');
  assert(ui.includes('function setOverviewPillState') && ui.includes("element.setAttribute('aria-label', title)") && ui.includes('elements.profileOverview.dataset.state') && ui.includes('profileOverviewBar.dataset.state') && ui.includes('profileOverviewScore.setAttribute'), 'generated profile overview must expose derived visual and accessibility state');
  assert(ui.includes('function updateProfileOverviewIdentity') && ui.includes('function getCompactProfileLocation') && ui.includes('profileOverviewDetail.textContent'), 'generated profile overview must show public name, email, and location summary');
  assert(ui.includes('function updateSectionCompletionBadges') && ui.includes('COPY_SECTION_FIELDS') && ui.includes('badge.dataset.state') && ui.includes('本节还差'), 'popup/js/ui.js must render generated-profile section completion badges from COPY_SECTION_FIELDS');
  assert(constants.includes("let addressEnhancementState = 'local'"), 'address enhancement source state should be centralized as UI-only popup state');
  assert(ui.includes('function getProfileOverviewSource') && ui.includes('function getProfileOverviewSourceState') && ui.includes("addressEnhancementState === 'geoapify'") && ui.includes("addressEnhancementState === 'openstreetmap'") && ui.includes("addressEnhancementState === 'fallback'") && ui.includes("currentData.source === 'meiguodizhi'") && ui.includes("currentData.source === 'ai'"), 'generated profile overview must describe map, fallback, US-location, and AI sources');
  assert(events.includes("showToast(realAddress.source === 'local'") && events.includes('地图服务不可用，已用本地地址') && events.includes("addressEnhancementState = realAddress.source || 'local'"), 'regenerate flow should distinguish map address success from local fallback');
  assert(api.includes("showToast(realAddress.source === 'local'") && api.includes('地图服务不可用，已用本地地址') && api.includes("addressEnhancementState = realAddress.source || 'local'"), 'IP refresh flow should distinguish map address success from local fallback');
  assert(events.includes('handleFieldRefresh') && events.includes("if (fieldName === 'address')") && events.includes('updateProfileOverview();\n    saveDataToStorage();'), 'single-field refresh must update the generated profile overview and reset address source before saving');
  assert(events.includes("elements.targetLocation.addEventListener('input', updateProfileOverview)") && events.includes('FIELD_NAMES.forEach'), 'profile overview must update while location and public fields change');
  assert(storage.includes('loadLockedFields') && storage.includes('updateProfileOverview()'), 'loaded locked fields must refresh the generated profile overview');
  assert(utils.includes('function toggleLock') && utils.includes('updateProfileOverview()'), 'lock toggles must refresh the generated profile overview');
  assert(!saveDataFn.includes('profileOverview') && !saveDataFn.includes('sectionCompletions'), 'generated profile overview must remain derived UI state and not enter cached storage payloads');
  assert(!saveDataFn.includes('addressEnhancementState'), 'address enhancement source state must remain UI-only and not enter cached storage payloads');
  assert(!publicFn.includes('profileOverview') && !publicFn.includes('sectionCompletions') && !publicFn.includes('addressEnhancementState'), 'generated profile overview and address enhancement state must not enter standard fill payloads');
  assert(keyboard.includes('verifyProfileOverviewContract'), 'popup keyboard verifier must include generated profile overview contract checks');
  assert(keyboard.includes('sourceStates') && keyboard.includes('来源 Geoapify') && keyboard.includes('来源 OSM') && keyboard.includes('来源 本地降级'), 'popup keyboard verifier must prove map-source and local-fallback overview states');
  assert(keyboard.includes('scoreAfterClear') && keyboard.includes('lockedStateAfterClick') && keyboard.includes('barStateAfterClear') && keyboard.includes('missingStateAfterClear') && keyboard.includes('gapAfterClear') && keyboard.includes('contactAfterClear') && keyboard.includes('track should stay scoped to the score block') && keyboard.includes('metaPills') && keyboard.includes('stable two-column grid') && keyboard.includes('sections:5/6') && keyboard.includes('Generated profile overview introduced horizontal overflow'), 'profile overview verifier must prove live score, stateful lock/missing feedback, gap hint, scoped progress track, section badges, meta layout, and overflow behavior');
}

function checkBrowserHarnessUsage() {
  const harness = readText('scripts/lib/browser-harness.cjs');
  const browserVerifierFiles = [
    'scripts/verify-fixture-browser.cjs',
    'scripts/verify-popup-keyboard.cjs',
    'scripts/verify-extension-runtime.cjs',
    'scripts/render-hero.cjs'
  ];

  for (const required of [
    'function findChrome()',
    'function getFreePort()',
    'async function waitForBrowser(port)',
    'class CdpConnection',
    'async function cleanupBrowserRun(child, profileDir)',
    'function assertSafeProfileDir(profileDir)',
    'module.exports = {'
  ]) {
    assert(harness.includes(required), `scripts/lib/browser-harness.cjs must keep shared browser helper: ${required}`);
  }

  for (const file of browserVerifierFiles) {
    const source = readText(file);
    assert(source.includes("require('./lib/browser-harness.cjs')"), `${file} must use the shared browser harness`);
    assert(source.includes('cleanupBrowserRun'), `${file} must use shared temporary-profile cleanup`);

    for (const duplicate of [
      'function chromeCandidates(',
      'function findChrome(',
      'function getFreePort(',
      'async function waitForBrowser(',
      'class CdpConnection',
      'async function stopChrome(',
      'async function cleanup('
    ]) {
      assert(!source.includes(duplicate), `${file} must not duplicate shared browser harness logic: ${duplicate}`);
    }

    for (const localDependency of ["require('net')", "require('os')", 'spawnSync']) {
      assert(!source.includes(localDependency), `${file} should not own browser-harness dependency ${localDependency}`);
    }
  }
}

function checkCountrySupport(manifest) {
  const html = readText('popup/popup.html');
  const generatorSource = readText('scripts/generators.js');
  const countries = extractCountryOptions(html);
  const coverageItems = extractCountryCoverageItems(html);

  assert(countries.length === 19, `country picker should include 19 entries, found ${countries.length}`);
  assert(coverageItems.length === countries.length, `country coverage panel should include ${countries.length} entries, found ${coverageItems.length}`);
  assert(countries.every((country, index) => coverageItems[index] === country), 'country coverage panel should mirror the country picker order and values');

  const countryLangMap = evaluateGeneratorObject(generatorSource, 'COUNTRY_LANG_MAP');
  const phoneFormats = evaluateGeneratorObject(generatorSource, 'PHONE_FORMATS');
  const streetNames = evaluateGeneratorObject(generatorSource, 'STREET_NAMES');
  const cityStateMap = evaluateGeneratorObject(generatorSource, 'CITY_STATE_MAP');

  for (const country of countries) {
    assert(countryLangMap[country], `COUNTRY_LANG_MAP missing ${country}`);
    assert(phoneFormats[country], `PHONE_FORMATS missing ${country}`);
    assert(Array.isArray(streetNames[country]) && streetNames[country].length >= 5, `STREET_NAMES missing usable data for ${country}`);
    assert(Array.isArray(cityStateMap[country]) && cityStateMap[country].length >= 3, `CITY_STATE_MAP missing usable data for ${country}`);
  }

  const unsupportedDocs = ['New Zealand', 'Austria', 'Switzerland', 'Belgium', 'Argentina', 'Colombia', 'Peru', 'Chile'];
  for (const country of unsupportedDocs) {
    assert(!countries.includes(country), `${country} is in generator aliases but should not appear in picker without full support`);
  }

  if (manifest?.version) {
    assert(!generatorSource.includes('FormPilot-Extension/1.7.1'), 'OSM User-Agent is stale and still references 1.7.1');
    assert(generatorSource.includes(`FormPilot-Extension/${manifest.version}`), `OSM User-Agent should reference manifest version ${manifest.version}`);
  }
}

function checkCountryScopeCopy() {
  const html = readText('popup/popup.html');
  const css = readText('popup/popup.css');
  const keyboard = readText('scripts/verify-popup-keyboard.cjs');

  assert(html.includes('<select id="country" aria-describedby="countryScopeNote">'), 'country picker should point to its generated-data scope note');
  assert(html.includes('id="countryScopeNote"') && html.includes('支持 19 个国家/地区生成资料') && html.includes('城市级定点生成目前仅限美国'), 'country scope note should distinguish country generation from US city-level generation');
  assert(html.includes('<details class="country-coverage" id="countryCoverage">') && html.includes('id="countryCoverageList"') && html.includes('查看支持的国家/地区'), 'country scope helper should expose an expandable supported-country panel');
  assert(html.includes('<small>美国定点地址</small>'), 'source section helper copy should identify the US location-only flow');
  assert(html.includes('<label for="targetLocation">美国位置</label>'), 'location input label should name the US-only scope');
  assert(html.includes('placeholder="州/城市，如 California 或 Seattle"') && html.includes('aria-describedby="usLocationHint"'), 'US location input should use concise examples and point to its hint');
  assert(html.includes('id="usLocationHint"') && html.includes('meiguodizhi.com') && html.includes('其它国家请用上方国家选择'), 'US location hint should explain the meiguodizhi.com boundary');
  assert(html.includes('title="按美国州或城市生成地址"') && html.includes('aria-label="按美国州或城市生成地址"') && html.includes('>生成</button>'), 'US location generate button should use descriptive visible and accessible copy');
  assert((html.match(/<option value="New York"><\/option>/g) || []).length === 1, 'US location suggestions should not include duplicate New York entries');

  assert(css.includes('.field-note') && css.includes('.location-source-group label') && css.includes('.location-scope-note'), 'popup CSS should style country and US-location helper notes');
  assert(css.includes('.country-coverage') && css.includes('.country-coverage-grid') && css.includes('.country-coverage-grid span.is-selected'), 'popup CSS should style the supported-country coverage panel and selected country state');
  assert(css.includes('width: 48px;') && css.includes('height: var(--control-height);'), 'US location generate button should keep a stable compact size');
  assert(keyboard.includes('verifyCountryScopeHelpContract') && keyboard.includes('countryCoverage') && keyboard.includes('selectedCoverage'), 'popup keyboard verifier must cover country scope helper copy, supported-country panel, and layout');
}

function checkDocsReferences() {
  const docs = ['README.md', 'CHANGELOG.md', 'docs/README.en.md', 'docs/store-listing.md', 'docs/architecture.md', 'docs/roadmap.md', 'docs/release-audit.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/PULL_REQUEST_TEMPLATE.md'];
  const markdownLink = /\]\(([^)]+)\)/g;

  for (const file of docs) {
    const text = readText(file);
    for (const match of text.matchAll(markdownLink)) {
      const link = match[1];
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      const target = path.resolve(path.join(root, path.dirname(file)), link);
      assert(fs.existsSync(target), `${file} references missing local asset ${link}`);
    }
  }
}

function checkReadmeReleaseCommands() {
  const readme = readText('README.md');
  const quickStartIndex = readme.indexOf('## 快速开始');
  const atAGlanceIndex = readme.indexOf('## 项目概览');
  const quickStartEnd = atAGlanceIndex === -1 ? -1 : atAGlanceIndex;
  const quickStart = quickStartIndex === -1 || quickStartEnd === -1
    ? ''
    : readme.slice(quickStartIndex, quickStartEnd);

  assert(quickStartIndex !== -1, 'README must include a Chinese Quick Start section near the top');
  assert(readme.includes('## 项目概览'), 'README must include a Chinese At a Glance section');
  assert(quickStartIndex !== -1 && atAGlanceIndex !== -1 && quickStartIndex < atAGlanceIndex, 'README quick start should appear before overview for first-time visitors');
  assert(quickStart.includes('chrome://extensions') && quickStart.includes('edge://extensions') && quickStart.includes('Load unpacked') && quickStart.includes('加载已解压'), 'README quick start must explain local unpacked install');
  assert(quickStart.includes('node scripts/verify-release.cjs'), 'README quick start must show the primary release gate command');
  assert(quickStart.includes('node scripts/package-extension.cjs') && quickStart.includes('node scripts/verify-package.cjs'), 'README quick start must show release packaging commands');
  assert(readme.includes('FormPilot 重点守住四个产品承诺：'), 'README product-promise count must match the four listed promises');
  assert(readme.includes('node scripts/verify-release.cjs'), 'README must document node scripts/verify-release.cjs');
  assert(readme.includes('node scripts/verify-fixture.cjs'), 'README must document node scripts/verify-fixture.cjs');
  assert(readme.includes('node scripts/verify-fixture-browser.cjs'), 'README must document node scripts/verify-fixture-browser.cjs');
  assert(readme.includes('node scripts/verify-popup-keyboard.cjs'), 'README must document node scripts/verify-popup-keyboard.cjs');
  assert(readme.includes('node scripts/render-hero.cjs'), 'README must document node scripts/render-hero.cjs');
  assert(readme.includes('node scripts/verify-package.cjs'), 'README must document node scripts/verify-package.cjs');
  assert(readme.includes('node scripts/verify-extension-runtime.cjs'), 'README must document node scripts/verify-extension-runtime.cjs');
  assert(readme.includes('node scripts/package-extension.cjs'), 'README must document node scripts/package-extension.cjs');
  assert(readme.includes('My Profile completeness feedback and missing-field focus'), 'README must document popup QA coverage for My Profile missing-field focus');
  assert(readme.includes('output/playwright/popup-settings.png'), 'README must include the Settings screenshot in Product Tour and visual QA docs');
  assert(readme.includes('Settings overview and API key show/hide control'), 'README must document popup QA coverage for the Settings overview');
  assert(readme.includes('当前 main、Settings、My Profile 和 fixture screenshots'), 'README must document that marketing assets include the Settings screenshot');
  assert(readme.includes('.github/workflows/release-check.yml'), 'README must mention the GitHub release-check workflow');
  assert(readme.includes('docs/architecture.md'), 'README must link docs/architecture.md');
  assert(readme.includes('docs/roadmap.md'), 'README must link docs/roadmap.md');
  assert(readme.includes('CHANGELOG.md'), 'README must link CHANGELOG.md');
  assert(readme.includes('docs/release-audit.md'), 'README must link docs/release-audit.md');

  for (const required of [
    'Chrome Manifest V3',
    'no build step',
    '19 个国家和地区',
    'on-demand script injection',
    '永久 `<all_urls>`',
    '永久 `content_scripts`',
    'unpacked-extension smoke test',
    'zip boundary inspection',
    'Ubuntu',
    'Windows'
  ]) {
    assert(readme.includes(required), `README overview must mention ${required}`);
  }

  assert(readme.includes('Generated-profile section collapse preferences、section completion badges、workflow guidance state、shortcut confidence state、active-page match preview、scan-based fill plan preview、sensitive skip preview、external service recovery states、fill-readiness surface 和 last-fill result surface 都是 UI-only state'), 'README must describe profile section collapse preferences, completion badges, workflow guidance, shortcut confidence, active-page match preview, scan-based fill plan preview, sensitive skip preview, external service recovery states, fill-readiness, and last-fill result as UI-only state');
  assert(readme.includes('生成资料里的敏感展示字段也会排除在 generated-profile cache、archives 和 recent fill history 之外'), 'README must document public-only cache, archive, and history storage for generated sensitive display fields');
}

function checkReleaseDocs(manifest) {
  const changelog = readText('CHANGELOG.md');
  const audit = readText('docs/release-audit.md');
  const prTemplate = readText('.github/PULL_REQUEST_TEMPLATE.md');

  if (manifest?.version) {
    assert(changelog.includes(`## ${manifest.version}`), `CHANGELOG.md must include manifest version ${manifest.version}`);
    assert(audit.includes(`Version: \`${manifest.version}\``), `docs/release-audit.md must include manifest version ${manifest.version}`);
    assert(audit.includes(`dist/formpilot-${manifest.version}.zip`), `docs/release-audit.md must mention dist/formpilot-${manifest.version}.zip`);
  }

  for (const required of [
    'node scripts/verify-release.cjs',
    'node scripts/verify-fixture.cjs',
    'node scripts/verify-fixture-browser.cjs',
    'node scripts/verify-popup-keyboard.cjs',
    'node scripts/render-hero.cjs',
    'node scripts/verify-package.cjs',
    'node scripts/verify-extension-runtime.cjs',
    'node scripts/package-extension.cjs',
    'full card numbers',
    'CVV',
    'SSN',
    'permanent `<all_urls>` host permission',
    'Generated sensitive fields',
    'Copy All',
    'import/export',
    'keyboard focus'
  ]) {
    assert(changelog.includes(required) || audit.includes(required), `release docs must mention ${required}`);
  }

  assert(changelog.includes('Ubuntu static/package verification') && changelog.includes('Windows real-browser popup and fixture QA'), 'CHANGELOG.md must mention the split GitHub release-check workflow');
  assert(audit.includes('static release checks and package inspection on Ubuntu') && audit.includes('popup and fixture browser QA on Windows'), 'docs/release-audit.md must describe the split GitHub release-check workflow');
  assert(changelog.includes('Reproducible marketing asset rendering') && audit.includes('reproducible marketing assets'), 'release docs must document the reproducible marketing asset renderer');
  assert(changelog.includes('scan-based fill plan preview') && audit.includes('scan-based fill plan preview'), 'release docs must document the scan-based fill plan preview');
  assert(changelog.includes('Generated-profile cache, archives, and recent fill history') && audit.includes('Generated-profile cache, archives, and recent fill history'), 'release docs must document public-only generated cache, archives, and history');

  assert(prTemplate.includes('CHANGELOG.md') && prTemplate.includes('docs/release-audit.md'), 'PR template must remind contributors to update release docs');
  assert(prTemplate.includes('node scripts/verify-popup-keyboard.cjs'), 'PR template must remind contributors to run popup keyboard verification for modal or keyboard changes');
  assert(prTemplate.includes('node scripts/verify-package.cjs'), 'PR template must remind contributors to run package verification');
}

function checkRoadmapDocs() {
  const roadmap = readText('docs/roadmap.md');
  for (const required of ['Current Focus', 'Near-Term Work', 'Later Work', 'Non-Goals', 'full card numbers', 'permanent `<all_urls>` content script', 'node scripts/verify-fixture.cjs', 'node scripts/verify-fixture-browser.cjs', 'node scripts/verify-popup-keyboard.cjs', 'import/export']) {
    assert(roadmap.includes(required), `docs/roadmap.md must mention ${required}`);
  }

  assert(!roadmap.includes('Optional import and export for non-sensitive My Profile data.'), 'docs/roadmap.md should not list completed My Profile import/export as later work');

  const prTemplate = readText('.github/PULL_REQUEST_TEMPLATE.md');
  assert(prTemplate.includes('Roadmap Fit'), 'PR template must include a Roadmap Fit section');

  const featureTemplate = readText('.github/ISSUE_TEMPLATE/feature_request.yml');
  assert(featureTemplate.includes('Roadmap fit'), 'feature request template must ask about roadmap fit');
}

function checkArchitectureDocs() {
  const architecture = readText('docs/architecture.md');
  for (const required of ['getPublicProfileData()', 'buildMyProfileFillData()', 'sanitizeMyProfilePayload()', 'MY_PROFILE_FIELD_NAMES', 'formPilotProfileSections', 'permanent `<all_urls>` content script', 'node scripts/verify-release.cjs', 'node scripts/verify-fixture-browser.cjs', 'node scripts/verify-popup-keyboard.cjs', 'node scripts/verify-package.cjs']) {
    assert(architecture.includes(required), `docs/architecture.md must mention ${required}`);
  }
  assert(architecture.includes('run on Ubuntu') && architecture.includes('Windows browser job') && architecture.includes('fixture browser verifier'), 'docs/architecture.md must document split CI release gates');
  assert(architecture.includes('The scan-based fill plan preview is derived popup-only state'), 'docs/architecture.md must document the scan-based fill plan preview as popup-only state');
  assert(architecture.includes('Generated-profile cache, archives, and recent fill history also pass through `getPublicProfileData()`'), 'docs/architecture.md must document public-only generated cache, archives, and history');
}

function checkPrivacyDocs() {
  const privacy = readText('PRIVACY.md');
  for (const required of ['import/export', 'local JSON', 'unknown fields', 'full card numbers', 'CVV', 'SSN']) {
    assert(privacy.includes(required), `PRIVACY.md must mention ${required}`);
  }
  assert(privacy.includes('Generated-profile cache, archives, and recent fill history also store public profile fields only'), 'PRIVACY.md must document public-only generated cache, archives, and history');
}

function checkGitHubCommunityFiles() {
  const workflow = readText('.github/workflows/release-check.yml');
  const contributing = readText('CONTRIBUTING.md');
  assert(workflow.includes('static:') && workflow.includes('runs-on: ubuntu-latest'), 'release-check workflow must run static release gates on ubuntu-latest for case-sensitive CI coverage');
  assert(workflow.includes('browser:') && workflow.includes('runs-on: windows-latest'), 'release-check workflow must keep browser popup QA on windows-latest');
  assert(workflow.includes('needs: static'), 'browser popup QA should wait for the static release gate');
  assert(workflow.includes('node scripts/verify-release.cjs'), 'release-check workflow must run the release verifier');
  assert(workflow.includes('node scripts/verify-fixture.cjs'), 'release-check workflow must run the fixture verifier');
  assert(workflow.includes('node scripts/verify-fixture-browser.cjs'), 'release-check workflow must run the browser fixture verifier');
  assert(workflow.includes('node scripts/verify-popup-keyboard.cjs'), 'release-check workflow must run the popup keyboard verifier');
  assert(workflow.includes('node scripts/render-hero.cjs'), 'release-check workflow must run the marketing hero renderer');
  assert(workflow.includes('node scripts/package-extension.cjs'), 'release-check workflow must package the extension');
  assert(workflow.includes('node scripts/verify-package.cjs'), 'release-check workflow must run package boundary verification');
  assert(workflow.includes('actions/upload-artifact@v4'), 'release-check workflow must upload the packaged extension artifact');

  assert(contributing.includes('node scripts/verify-fixture.cjs'), 'CONTRIBUTING must mention the static fixture verifier');
  assert(contributing.includes('node scripts/verify-fixture-browser.cjs'), 'CONTRIBUTING must mention the browser fixture verifier');

  const prTemplate = readText('.github/PULL_REQUEST_TEMPLATE.md');
  for (const required of ['full card numbers', 'CVV', 'SSN', 'node scripts/verify-release.cjs', 'node scripts/verify-package.cjs']) {
    assert(prTemplate.includes(required), `PR template must mention ${required}`);
  }

  const security = readText('SECURITY.md');
  assert(security.includes('Project Safety Boundary'), 'SECURITY.md must document the project safety boundary');
  assert(security.includes('node scripts/verify-release.cjs'), 'SECURITY.md must document the release verifier');
  assert(security.includes('Generated-profile cache, archives, and recent fill history must stay public-only'), 'SECURITY.md must document public-only generated cache, archives, and history');
}

function checkPackageScript() {
  const script = readText('scripts/package-extension.cjs');
  const verifier = readText('scripts/verify-package.cjs');
  const forbiddenIncludes = [
    ['.trellis', /\.trellis/],
    ['.agents', /\.agents/],
    ['.codex', /\.codex/],
    ['output/', /output\\\//],
    ['tests/', /tests\\\//],
    ['assets/marketing/', /assets\\\/marketing/],
    ['docs/', /docs\\\//]
  ];

  for (const [label, pattern] of forbiddenIncludes) {
    assert(pattern.test(script), `package script should explicitly exclude ${label}`);
    assert(pattern.test(verifier), `package verifier should explicitly reject ${label}`);
  }

  assert(verifier.includes('requiredEntries') && verifier.includes('parseZipEntries') && verifier.includes('Unsupported zip compression method'), 'package verifier must check required entries, parse zip entries, and reject unsupported compression methods');
}

async function main() {
  checkNoLegacyIdentityResidues();
  checkRequiredFiles();
  checkVisualAssets();
  checkMarketingHeroSource();
  checkMarketingAssetReferences();

  const manifest = checkJson('manifest.json');
  checkManifest(manifest);
  checkPackageHasNoLegacyIdentity(manifest);
  checkFormPilotIndependenceContracts();
  await checkStorageMigrationBehavior();

  const jsFiles = [
    'background.js',
    ...walk('popup', relative => relative.endsWith('.js')),
    ...walk('scripts', relative => /\.(?:js|cjs)$/.test(relative))
  ];

  for (const file of jsFiles) {
    checkJsSyntax(file);
  }

  checkSensitiveBoundary();
  checkFillEmptyOnlyMode();
  checkPopupStyleBoundary();
  checkPopupCopyPolish();
  checkModalAccessibility();
  checkSettingsKeyVisibilityControl();
  checkSettingsOverviewPolish();
  checkCompactActionAccessibility();
  checkPopupSectionToggles();
  checkMyProfileVisualPolish();
  checkFillResultFeedback();
  checkInboxVerificationCodeCopy();
  checkInboxErrorState();
  checkExternalServiceRecoveryStates();
  checkHistoryClearConfirmation();
  checkHistoryItemDeleteConfirmation();
  checkArchiveSearchPolish();
  checkArchiveDeleteConfirmation();
  checkHistorySearchPolish();
  checkCommandDockPolish();
  checkWorkflowGuidePolish();
  checkShortcutConfidenceHint();
  checkPageScanPreviewPolish();
  checkFillReadinessPolish();
  checkProfileOverviewPolish();
  checkBrowserHarnessUsage();
  checkCountrySupport(manifest);
  checkCountryScopeCopy();
  checkDocsReferences();
  checkReadmeReleaseCommands();
  checkReleaseDocs(manifest);
  checkArchitectureDocs();
  checkPrivacyDocs();
  checkRoadmapDocs();
  checkGitHubCommunityFiles();
  checkPackageScript();
  runScript('scripts/verify-fixture.cjs');

  if (failures.length) {
    console.error(`FormPilot release verification failed (${failures.length})`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  notes.push(`checked ${jsFiles.length} JavaScript files`);
  notes.push('manifest, permission boundary, country data, fixture contract, docs, and packaging script passed');
  console.log(`FormPilot release verification passed: ${notes.join('; ')}`);
}

main().catch(error => {
  console.error(`FormPilot release verification crashed: ${error.stack || error.message}`);
  process.exit(1);
});
