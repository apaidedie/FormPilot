#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  CdpConnection,
  cleanupBrowserRun,
  createProfileDir,
  extensionFlagUnsupported,
  findChrome,
  getFreePort,
  sleep,
  waitForBrowser
} = require('./lib/browser-harness.cjs');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const profileDir = createProfileDir('formpilot-runtime-');

function extensionServiceWorkers(targets) {
  return targets.filter(target => (
    target.type === 'service_worker' && target.url?.startsWith('chrome-extension://')
  ));
}

function serviceWorkerSummary(targets) {
  return extensionServiceWorkers(targets)
    .map(target => `${target.url || '(no url)'} (${target.targetId})`)
    .join('\n') || '(none)';
}

function getExtensionId(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.protocol === 'chrome-extension:' ? parsed.hostname : '';
  } catch (error) {
    return '';
  }
}

function findFormPilotServiceWorker(targets) {
  const serviceWorkerPath = `/${manifest.background?.service_worker || 'background.js'}`;
  return extensionServiceWorkers(targets).find(target => {
    try {
      return new URL(target.url).pathname === serviceWorkerPath;
    } catch (error) {
      return false;
    }
  });
}

async function waitForFormPilotServiceWorker(cdp) {
  const deadline = Date.now() + 15000;
  let lastTargets = [];

  while (Date.now() < deadline) {
    const result = await cdp.send('Target.getTargets');
    lastTargets = result.targetInfos || [];
    const serviceWorker = findFormPilotServiceWorker(lastTargets);
    if (serviceWorker) {
      return { serviceWorker, targets: lastTargets };
    }
    await sleep(500);
  }

  return { serviceWorker: null, targets: lastTargets };
}

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--window-size=460,760',
    'about:blank'
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
    const version = await waitForBrowser(port);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
    await sleep(2500);
    const { serviceWorker: formPilotWorker, targets } = await waitForFormPilotServiceWorker(cdp);

    if (!formPilotWorker) {
      const summary = serviceWorkerSummary(targets);
      if (extensionFlagUnsupported(stderr)) {
        throw new Error(`The selected browser rejected unpacked-extension flags. Set CHROME_PATH to Microsoft Edge, Chromium, Chrome for Testing, or another browser that allows --load-extension. Inspected extension service workers:\n${summary}`);
      }
      throw new Error(`FormPilot service worker target was not found. Inspected extension service workers:\n${summary}`);
    }

    console.log(`FormPilot runtime verification passed: ${manifest.name} ${manifest.version} loaded in ${version.Browser}; extension id ${getExtensionId(formPilotWorker.url)}; ${targets.length} CDP targets inspected`);
  } catch (error) {
    const chromeErrors = stderr
      .split(/\r?\n/)
      .filter(line => /ERROR|Failed|error/i.test(line))
      .slice(0, 8)
      .join('\n');
    throw new Error(`${error.message}${chromeErrors ? `\nChrome diagnostics:\n${chromeErrors}` : ''}`);
  } finally {
    if (cdp) cdp.close();
    await cleanupBrowserRun(child, profileDir);
  }
}

main().catch(error => {
  console.error(`FormPilot runtime verification failed: ${error.message}`);
  process.exit(1);
});
