#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
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
const profileDir = createProfileDir('formpilot-fixture-');
const screenshotPath = 'output/playwright/form-fixture-mobile.png';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }

    const normalized = path.normalize(decodedPath).replace(/^[/\\]+/, '');
    const filePath = path.resolve(root, normalized || 'tests/manual/form-fixture.html');
    if (!isInside(root, filePath)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
        return;
      }
      response.writeHead(200, { 'Content-Type': contentTypeFor(filePath), 'Cache-Control': 'no-store' });
      response.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

async function attachToTarget(cdp, targetId) {
  const result = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return result.sessionId;
}

async function evaluate(cdp, sessionId, expression, timeoutMs = 15000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId, timeoutMs);

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

async function captureScreenshot(cdp, sessionId, relativePath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(result.data, 'base64'));
}

async function runFixtureCheck(cdp, sessionId, functionName, label) {
  const result = await evaluate(cdp, sessionId, `window.${functionName}()`, 30000);
  assert(result && result.passed === true, `${label} failed: ${JSON.stringify(result)}`);
  assert(!result.decoyLeaks || result.decoyLeaks.length === 0, `${label} leaked sensitive decoys: ${JSON.stringify(result.decoyLeaks)}`);
  return result;
}

async function verifyMobileLayout(cdp, sessionId) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: true
  }, sessionId);
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0); true');
  await sleep(250);

  const layout = await evaluate(cdp, sessionId, `(() => {
    const shell = document.querySelector('.shell');
    const form = document.querySelector('#fixtureForm');
    const report = document.querySelector('aside');
    const actionButtons = Array.from(document.querySelectorAll('.actions .button'));
    const shellRect = shell?.getBoundingClientRect();
    const formRect = form?.getBoundingClientRect();
    const reportRect = report?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      shellWidth: Math.round(shellRect?.width || 0),
      formWidth: Math.round(formRect?.width || 0),
      reportWidth: Math.round(reportRect?.width || 0),
      buttonCount: actionButtons.length,
      buttonsVisible: actionButtons.every(button => {
        const rect = button.getBoundingClientRect();
        return rect.width >= 120 && rect.height >= 38 && rect.left >= 0 && rect.right <= window.innerWidth;
      }),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(layout.width === 390, `mobile fixture viewport should be 390px, got ${layout.width}`);
  assert(layout.shellWidth >= 360 && layout.shellWidth <= 390, `mobile fixture shell width is unstable: ${JSON.stringify(layout)}`);
  assert(layout.formWidth >= 360 && layout.reportWidth >= 360, `mobile fixture panels should use available width: ${JSON.stringify(layout)}`);
  assert(layout.buttonCount === 4 && layout.buttonsVisible, `mobile fixture action buttons should be visible: ${JSON.stringify(layout)}`);
  assert(!layout.horizontalOverflow, `mobile fixture introduced horizontal overflow: ${JSON.stringify(layout)}`);

  await captureScreenshot(cdp, sessionId, screenshotPath);
  return layout;
}

async function main() {
  const chrome = findChrome();
  const debugPort = await getFreePort();
  const { server, port: serverPort } = await startStaticServer();
  const fixtureUrl = `http://127.0.0.1:${serverPort}/tests/manual/form-fixture.html`;
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--window-size=390,1200',
    fixtureUrl
  ];

  const child = spawn(chrome, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  let cdp;
  try {
    const version = await waitForBrowser(debugPort);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
    const target = await cdp.send('Target.createTarget', { url: fixtureUrl });
    const sessionId = await attachToTarget(cdp, target.targetId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: true
    }, sessionId);

    await waitFor(cdp, sessionId, `document.readyState === 'complete' || document.readyState === 'interactive'`, 'fixture document readiness');
    await waitFor(cdp, sessionId, `typeof window.runEmbeddedCheck === 'function' && typeof window.runEmbeddedSmartSafetyCheck === 'function' && typeof window.runEmbeddedEmptyOnlyCheck === 'function'`, 'embedded fixture functions');

    const fill = await runFixtureCheck(cdp, sessionId, 'runEmbeddedCheck', 'embedded fill check');
    const smart = await runFixtureCheck(cdp, sessionId, 'runEmbeddedSmartSafetyCheck', 'smart-fill safety check');
    const emptyOnly = await runFixtureCheck(cdp, sessionId, 'runEmbeddedEmptyOnlyCheck', 'empty-fields-only check');
    const layout = await verifyMobileLayout(cdp, sessionId);

    console.log(`FormPilot browser fixture verification passed in ${version.Browser}: fill ${fill.result?.filledCount || 0}; smart ${smart.result?.filledCount || 0}; emptyOnly ${emptyOnly.result?.filledCount || 0}; mobile ${layout.shellWidth}px; screenshot ${screenshotPath}`);
  } catch (error) {
    const browserErrors = stderr
      .split(/\r?\n/)
      .filter(line => /ERROR|Failed|error/i.test(line))
      .slice(0, 8)
      .join('\n');
    throw new Error(`${error.message}${browserErrors ? `\nBrowser diagnostics:\n${browserErrors}` : ''}`);
  } finally {
    if (cdp) cdp.close();
    await cleanupBrowserRun(child, profileDir);
    await closeServer(server);
  }
}

main().catch(error => {
  console.error(`FormPilot browser fixture verification failed: ${error.message}`);
  process.exit(1);
});
