#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const failures = [];

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, '');
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function extractObjectLiteral(source, declaration) {
  const start = source.indexOf(declaration);
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

function evaluateObject(source, declaration, context = {}) {
  const literal = extractObjectLiteral(source, declaration);
  assert(literal, `Could not find ${declaration}`);
  if (!literal) return {};

  try {
    return vm.runInNewContext(`(${literal})`, context);
  } catch (error) {
    failures.push(`Could not evaluate ${declaration}: ${error.message}`);
    return {};
  }
}

function evaluateArray(source, declaration) {
  const pattern = new RegExp(`${declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\\[[^;]+\\])`);
  const match = source.match(pattern);
  assert(match, `Could not find ${declaration}`);
  if (!match) return [];

  try {
    return vm.runInNewContext(match[1]);
  } catch (error) {
    failures.push(`Could not evaluate ${declaration}: ${error.message}`);
    return [];
  }
}

function evaluateSelectors(source) {
  const context = { window: {} };
  context.window.FormPilotSelectors = {};
  try {
    vm.runInNewContext(source, context);
  } catch (error) {
    failures.push(`Could not evaluate scripts/selectors/common.js: ${error.message}`);
  }
  return context.window.FormPilotSelectors || {};
}

function checkFixtureContract() {
  const fixture = readText('tests/manual/form-fixture.html');
  const selectorsSource = readText('scripts/selectors/common.js');
  const contentSource = readText('scripts/content.js');
  const readme = readText('README.md');
  const contributing = readText('CONTRIBUTING.md');
  const workflow = readText('.github/workflows/release-check.yml');

  const fixtureProfile = evaluateObject(fixture, 'const fixtureProfile =');
  const expectedFields = evaluateObject(fixture, 'const expectedFields =', { fixtureProfile });
  const decoyFields = evaluateArray(fixture, 'const decoyFields');
  const selectors = evaluateSelectors(selectorsSource);

  assert(Object.keys(expectedFields).length >= 25, `fixture should verify at least 25 expected fields, found ${Object.keys(expectedFields).length}`);
  assert(decoyFields.includes('cardNumber'), 'fixture decoys must include cardNumber');
  assert(decoyFields.includes('cardCvv'), 'fixture decoys must include cardCvv');
  assert(decoyFields.includes('ssn'), 'fixture decoys must include ssn');

  for (const field of Object.keys(expectedFields)) {
    assert(fixture.includes(`id="${field}"`), `fixture is missing input id for expected field ${field}`);
    if (field !== 'fullName' && field !== 'confirmPassword') {
      assert(Object.prototype.hasOwnProperty.call(fixtureProfile, field), `fixtureProfile missing data for expected field ${field}`);
    }
  }

  const selectorRequiredFields = Object.keys(expectedFields).filter(field => !['fullName', 'confirmPassword'].includes(field));
  for (const field of selectorRequiredFields) {
    assert(Array.isArray(selectors.common?.[field]) && selectors.common[field].length > 0, `common selectors missing ${field}`);
    assert(Array.isArray(selectors.commonLabels?.[field]) && selectors.commonLabels[field].length > 0, `common label keywords missing ${field}`);
  }

  assert(Array.isArray(selectors.fullNames) && selectors.fullNames.length > 0, 'full name selectors must be defined');
  assert(contentSource.includes('hasSpecificAddressData'), 'content script must preserve specific shipping/billing address handling');
  assert(contentSource.includes('fillGenericAddressFallback'), 'content script must keep generic address fallback');
  assert(contentSource.includes('findAllFields(\'password\')'), 'content script must fill password confirmation fields');
  assert(contentSource.includes('SMART_FILL_FORBIDDEN_FIELD_TERMS'), 'content script smart fill must define forbidden sensitive field terms');
  assert(contentSource.includes('isForbiddenSmartFillTarget'), 'content script smart fill must reject sensitive field targets');
  assert(contentSource.includes('shouldSkipFilledField') && contentSource.includes("results[fieldName] = 'skipped filled'"), 'content script must support fill-empty-only without overwriting existing fields');
  assert(contentSource.includes("results[key] = 'skipped empty'"), 'content script smart fill must skip empty AI mapping values');
  assert(contentSource.includes("results[key] = 'skipped sensitive'"), 'content script smart fill must report skipped sensitive targets');
  assert(contentSource.includes("results[key] = 'skipped filled'"), 'content script smart fill must report fill-empty-only skips');

  for (const decoy of decoyFields) {
    assert(!selectors.common?.[decoy], `common selectors must not include sensitive decoy ${decoy}`);
    assert(!selectors.commonLabels?.[decoy], `common label keywords must not include sensitive decoy ${decoy}`);
  }

  assert(fixture.includes('Sensitive decoys'), 'fixture must visibly identify sensitive decoys');
  assert(fixture.includes('decoyLeaks.length === 0'), 'fixture audit must fail if sensitive decoys are filled');
  assert(fixture.includes('runEmbeddedSmartSafetyCheck'), 'fixture must include AI smart fill safety check');
  assert(fixture.includes('runEmbeddedEmptyOnlyCheck'), 'fixture must include fill-empty-only regression check');
  assert(fixture.includes("{ action: 'fillFormSmart', data: mapping }"), 'fixture smart safety check must exercise fillFormSmart');
  assert(fixture.includes("options: { fillEmptyOnly: true }") && fixture.includes('reportsSkipped'), 'fixture empty-only check must pass fillEmptyOnly and prove skipped filled fields');
  assert(fixture.includes('emailPreserved') && fixture.includes('keep@example.com'), 'fixture smart safety check must prove empty mappings do not overwrite existing values');
  assert(readme.includes('node scripts/verify-fixture.cjs'), 'README must document node scripts/verify-fixture.cjs');
  assert(contributing.includes('node scripts/verify-fixture.cjs'), 'CONTRIBUTING must document node scripts/verify-fixture.cjs');
  assert(workflow.includes('node scripts/verify-fixture.cjs'), 'release workflow must run node scripts/verify-fixture.cjs');
}

checkFixtureContract();

if (failures.length) {
  console.error(`FormPilot fixture verification failed (${failures.length})`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('FormPilot fixture verification passed: expected fields, selector coverage, and sensitive decoys are aligned');
