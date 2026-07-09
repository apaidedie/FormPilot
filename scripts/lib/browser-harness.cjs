const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function chromeCandidates() {
  if (process.env.CHROME_PATH) return [process.env.CHROME_PATH];

  if (process.platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }

  return ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge'];
}

function findChrome() {
  for (const candidate of chromeCandidates()) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) return candidate;
  }
  throw new Error('Chrome or Edge was not found. Set CHROME_PATH to a Chromium-based browser executable.');
}

function extensionFlagUnsupported(stderr) {
  return /--(?:disable-extensions-except|load-extension).*not allowed/i.test(stderr);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
  const debugPort = process.env.FORMPILOT_CHROME_DEBUG_PORT;
  if (debugPort) {
    return Promise.resolve(Number(debugPort));
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitForBrowser(port) {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await sleep(400);
    }
  }
  throw new Error(`Chrome remote debugging endpoint did not start: ${lastError?.message || 'timeout'}`);
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
  }

  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      const connection = new CdpConnection(ws);

      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (!message.id || !connection.pending.has(message.id)) return;

        const pending = connection.pending.get(message.id);
        connection.pending.delete(message.id);
        clearTimeout(pending.timeout);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result || {});
        }
      };

      ws.onerror = event => {
        reject(new Error(`CDP websocket error: ${event.message || event.type || 'unknown error'}`));
      };

      ws.onopen = () => resolve(connection);
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.ws.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('CDP connection closed'));
      this.pending.delete(id);
    }
    this.ws.close();
  }
}

async function stopChrome(child) {
  if (!child || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    child.kill('SIGTERM');
  }

  const deadline = Date.now() + 8000;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(200);
  }
}

function createProfileDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertSafeProfileDir(profileDir) {
  const resolved = path.resolve(profileDir);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  const baseName = path.basename(resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !baseName.startsWith('formpilot-')) {
    throw new Error(`Refusing to remove unexpected temporary profile path: ${resolved}`);
  }
}

async function removeProfileDir(profileDir, options = {}) {
  const attempts = options.attempts || 10;
  const delayMs = options.delayMs || 500;
  assertSafeProfileDir(profileDir);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === attempts) {
        console.warn(`Warning: could not remove temporary Chrome profile ${profileDir}: ${error.message}`);
        return false;
      }
      await sleep(delayMs);
    }
  }

  return false;
}

async function cleanupBrowserRun(child, profileDir) {
  await stopChrome(child);
  await removeProfileDir(profileDir);
}

module.exports = {
  CdpConnection,
  cleanupBrowserRun,
  createProfileDir,
  extensionFlagUnsupported,
  findChrome,
  getFreePort,
  removeProfileDir,
  sleep,
  stopChrome,
  waitForBrowser
};
