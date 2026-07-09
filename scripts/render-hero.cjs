#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  CdpConnection,
  cleanupBrowserRun,
  createProfileDir,
  findChrome,
  getFreePort,
  sleep,
  waitForBrowser
} = require('./lib/browser-harness.cjs');

const root = path.resolve(__dirname, '..');
const profileDir = createProfileDir('formpilot-marketing-');

const marketingAssets = [
  {
    label: 'README hero',
    source: 'assets/marketing/formpilot-hero.html',
    output: 'assets/marketing/formpilot-hero.png',
    width: 1600,
    height: 900,
    title: 'Generate test profiles. Fill forms deliberately.'
  },
  {
    label: 'store promo',
    source: 'assets/marketing/formpilot-store-promo.html',
    output: 'assets/marketing/formpilot-store-promo.png',
    width: 1400,
    height: 560,
    title: 'Profile data for real form QA.'
  },
  {
    label: 'workflow demo',
    source: 'assets/marketing/formpilot-workflow-demo.html',
    output: 'assets/marketing/formpilot-workflow-demo.png',
    width: 1600,
    height: 900,
    title: 'Prepare. Scan. Review. Fill intentionally.'
  }
];

function fileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`;
}

async function attachToTarget(cdp, targetId) {
  const result = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return result.sessionId;
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown evaluation error';
    throw new Error(text);
  }

  return result.result?.value;
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, sessionId, expression);
    if (lastValue) return lastValue;
    await sleep(150);
  }

  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function renderAsset(cdp, asset, browserName) {
  const source = path.join(root, asset.source);
  const output = path.join(root, asset.output);

  if (!fs.existsSync(source)) {
    throw new Error(`Missing marketing source: ${asset.source}`);
  }

  const target = await cdp.send('Target.createTarget', { url: fileUrl(source) });
  const sessionId = await attachToTarget(cdp, target.targetId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: asset.width,
    height: asset.height,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);

  await waitFor(cdp, sessionId, `document.readyState === 'complete'`, `${asset.label} document readiness`);
  await waitFor(cdp, sessionId, `Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)`, `${asset.label} images`);
  const layout = await evaluate(cdp, sessionId, `(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    title: (document.querySelector('h1')?.textContent || '').trim(),
    images: Array.from(document.images).map(img => img.getAttribute('src') || '')
  }))()`);

  if (layout.width !== asset.width || layout.height !== asset.height || layout.scrollWidth !== asset.width || layout.scrollHeight !== asset.height) {
    throw new Error(`${asset.label} layout should be exactly ${asset.width}x${asset.height} without overflow, got ${JSON.stringify(layout)}`);
  }
  if (layout.title !== asset.title) {
    throw new Error(`${asset.label} title mismatch: ${layout.title}`);
  }
  if (!layout.images.includes('../../output/playwright/popup-settings.png')) {
    throw new Error(`${asset.label} must include the Settings readiness screenshot`);
  }

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
  console.log(`FormPilot ${asset.label} rendered in ${browserName}: ${asset.output}`);
}

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--window-size=1600,900',
    'about:blank'
  ];

  const child = spawn(chrome, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let cdp;
  try {
    const version = await waitForBrowser(port);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);

    for (const asset of marketingAssets) {
      await renderAsset(cdp, asset, version.Browser);
    }
  } finally {
    if (cdp) cdp.close();
    await cleanupBrowserRun(child, profileDir);
  }
}

main().catch(error => {
  console.error(`FormPilot marketing render failed: ${error.message}`);
  process.exit(1);
});
