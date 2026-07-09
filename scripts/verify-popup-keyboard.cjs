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
const profileDir = createProfileDir('formpilot-popup-');

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

function getExtensionId(targetUrl) {
  const parsed = new URL(targetUrl);
  return parsed.hostname;
}

async function waitForFormPilotServiceWorker(cdp) {
  const deadline = Date.now() + 15000;
  let lastTargets = [];

  while (Date.now() < deadline) {
    const result = await cdp.send('Target.getTargets');
    lastTargets = result.targetInfos || [];
    const serviceWorker = findFormPilotServiceWorker(lastTargets);
    if (serviceWorker) return { serviceWorker, targets: lastTargets };
    await sleep(500);
  }

  return { serviceWorker: null, targets: lastTargets };
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

async function dispatchKey(cdp, sessionId, key, options = {}) {
  const definitions = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }
  };
  const definition = definitions[key];
  if (!definition) throw new Error(`Unsupported key: ${key}`);

  const event = {
    ...definition,
    modifiers: options.shift ? 8 : 0
  };

  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, sessionId);
}

async function focusSelectorByTab(cdp, sessionId, selector, options = {}) {
  const startSelector = options.startSelector || 'body';
  const maxTabs = options.maxTabs || 80;
  const prepared = await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const start = document.querySelector(${JSON.stringify(startSelector)});
    if (!target || !start) {
      return { targetFound: Boolean(target), startFound: Boolean(start) };
    }
    if (start === document.body && !start.hasAttribute('tabindex')) {
      start.setAttribute('tabindex', '-1');
    }
    start.focus({ preventScroll: true });
    return { targetFound: true, startFound: true };
  })()`);

  assert(prepared.targetFound && prepared.startFound, `keyboard focus target setup failed for ${selector}: ${JSON.stringify(prepared)}`);

  let state = null;
  for (let index = 0; index < maxTabs; index += 1) {
    await dispatchKey(cdp, sessionId, 'Tab', { shift: options.shift === true });
    await sleep(35);
    state = await evaluate(cdp, sessionId, `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const active = document.activeElement;
      const style = target ? getComputedStyle(target) : null;
      return {
        focused: active === target,
        activeId: active?.id || '',
        activeClass: active?.className || '',
        focusShadow: style?.boxShadow || '',
        outlineStyle: style?.outlineStyle || '',
        outlineWidth: style?.outlineWidth || '',
        borderColor: style?.borderColor || ''
      };
    })()`);
    if (state.focused) return state;
  }

  throw new Error(`Timed out tabbing to ${selector}. Last focus state: ${JSON.stringify(state)}`);
}

async function captureScreenshot(cdp, sessionId, relativePath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(result.data, 'base64'));
}

async function settlePopupScreenshotState(cdp, sessionId, label) {
  const result = await waitFor(cdp, sessionId, `(() => {
    const toast = document.querySelector('#toast');
    const toastRect = toast?.getBoundingClientRect();
    const toastStyle = toast ? getComputedStyle(toast) : null;
    const toastOpacity = Number.parseFloat(toastStyle?.opacity || '0');
    const toastInViewport = Boolean(toastRect && toastRect.width > 0 && toastRect.height > 0 && toastRect.bottom > 0 && toastRect.top < window.innerHeight);
    const copiedButtons = Array.from(document.querySelectorAll('.copied')).map(node => node.id || node.className || node.textContent || 'unknown');
    const state = {
      toastShown: Boolean(toast?.classList.contains('show')),
      toastText: (toast?.textContent || '').trim(),
      toastVisible: Boolean(toastInViewport && toastOpacity > 0.01),
      toastOpacity,
      toastTransform: toastStyle?.transform || '',
      copiedButtons,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
    return (!state.toastShown && !state.toastVisible && state.copiedButtons.length === 0 && !state.horizontalOverflow) ? state : false;
  })()`, `${label} screenshot transient UI to settle`, 4500);

  assert(!result.toastShown && !result.toastVisible, `${label} screenshot must not include transient toast UI, got ${JSON.stringify(result)}`);
  assert(result.copiedButtons.length === 0, `${label} screenshot must not capture temporary copied button state, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, `${label} screenshot state introduced horizontal overflow`);

  return `${label}:settled`;
}

async function prepareMainScreenshotState(cdp, sessionId) {
  const result = await waitFor(cdp, sessionId, `(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const header = document.querySelector('.header');
    const guide = document.querySelector('#workflowGuide');
    const shortcut = document.querySelector('#shortcutHint');
    const readiness = document.querySelector('#fillReadiness');
    const overview = document.querySelector('#profileOverview');
    const commandDock = document.querySelector('.actions');
    const headerRect = header?.getBoundingClientRect();
    const guideRect = guide?.getBoundingClientRect();
    const shortcutRect = shortcut?.getBoundingClientRect();
    const readinessRect = readiness?.getBoundingClientRect();
    const overviewRect = overview?.getBoundingClientRect();
    const commandRect = commandDock?.getBoundingClientRect();
    const state = {
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0),
      headerTop: Math.round(headerRect?.top || 0),
      headerBottom: Math.round(headerRect?.bottom || 0),
      guideTop: Math.round(guideRect?.top || 0),
      guideBottom: Math.round(guideRect?.bottom || 0),
      shortcutTop: Math.round(shortcutRect?.top || 0),
      shortcutBottom: Math.round(shortcutRect?.bottom || 0),
      readinessTop: Math.round(readinessRect?.top || 0),
      readinessBottom: Math.round(readinessRect?.bottom || 0),
      overviewTop: Math.round(overviewRect?.top || 0),
      overviewBottom: Math.round(overviewRect?.bottom || 0),
      commandTop: Math.round(commandRect?.top || 0),
      commandBottom: Math.round(commandRect?.bottom || 0),
      viewportBottom: window.innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
    state.topWorkbenchVisible = Boolean(
      headerRect &&
      guideRect &&
      shortcutRect &&
      readinessRect &&
      overviewRect &&
      commandRect &&
      state.scrollY === 0 &&
      headerRect.top >= 0 &&
      headerRect.bottom < commandRect.top &&
      commandRect.top >= 0 &&
      commandRect.bottom <= window.innerHeight &&
      commandRect.bottom < guideRect.top &&
      guideRect.top >= 0 &&
      guideRect.bottom <= window.innerHeight &&
      guideRect.bottom < shortcutRect.top &&
      shortcutRect.top >= 0 &&
      shortcutRect.bottom <= window.innerHeight &&
      shortcutRect.bottom < readinessRect.top &&
      readinessRect.top >= 0 &&
      readinessRect.bottom <= window.innerHeight &&
      readinessRect.bottom < overviewRect.top &&
      overviewRect.top >= 0 &&
      overviewRect.bottom <= window.innerHeight &&
      !state.horizontalOverflow
    );
    return state.topWorkbenchVisible ? state : false;
  })()`, 'main screenshot top workbench visible', 2500);

  assert(result.scrollY === 0, `main screenshot should start at the top of the popup, got ${JSON.stringify(result)}`);
  assert(result.topWorkbenchVisible && !result.horizontalOverflow, `main screenshot should show header, command dock, workflow guide, shortcut hint, fill readiness, and profile overview without overflow, got ${JSON.stringify(result)}`);

  return `mainScreenshotTop:${result.headerTop}/${result.guideTop}/${result.shortcutTop}/${result.overviewTop}`;
}

async function prepareSettingsScreenshotState(cdp, sessionId) {
  const result = await waitFor(cdp, sessionId, `(() => {
    const modal = document.querySelector('#settingsModal');
    const body = modal?.querySelector('.settings-body');
    const overview = document.querySelector('#settingsOverview');
    if (body) body.scrollTop = 0;
    const bodyRect = body?.getBoundingClientRect();
    const overviewRect = overview?.getBoundingClientRect();
    const state = {
      modalShown: Boolean(modal?.classList.contains('show')),
      bodyScrollTop: Math.round(body?.scrollTop || 0),
      overviewTop: Math.round(overviewRect?.top || 0),
      overviewBottom: Math.round(overviewRect?.bottom || 0),
      bodyTop: Math.round(bodyRect?.top || 0),
      bodyBottom: Math.round(bodyRect?.bottom || 0),
      viewportBottom: window.innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
    state.overviewVisible = Boolean(
      state.modalShown &&
      overviewRect &&
      bodyRect &&
      state.bodyScrollTop === 0 &&
      overviewRect.top >= bodyRect.top - 1 &&
      overviewRect.bottom <= Math.min(bodyRect.bottom, window.innerHeight) + 1 &&
      !state.horizontalOverflow
    );
    return state.overviewVisible ? state : false;
  })()`, 'settings screenshot overview visible at top', 2500);

  assert(result.modalShown && result.bodyScrollTop === 0, `settings screenshot should start at the top of the modal, got ${JSON.stringify(result)}`);
  assert(result.overviewVisible && !result.horizontalOverflow, `settings screenshot should show the settings overview without overflow, got ${JSON.stringify(result)}`);

  return `settingsScreenshotTop:${result.overviewTop}`;
}

function luminanceFromRgb(value) {
  const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return 0;
  const [, r, g, b] = match.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function seedStorageExpression() {
  const cachedData = {
    version: 'v3',
    currentData: {
      firstName: 'Avery',
      lastName: 'Stone',
      gender: 'female',
      birthday: '1992-04-18',
      username: 'avery.stone',
      email: 'avery@example.com',
      password: 'Pass1234!',
      phone: '+1 212-555-0198',
      address: '120 Madison Ave',
      city: 'New York',
      state: 'NY',
      zipCode: '10016',
      country: 'United States',
      sensitive: { creditCardNumber: '4111111111111111', ssn: '123-45-6789' }
    },
    ipData: { country: 'United States', city: 'New York', region: 'NY' },
    emailDomain: 'gmail.com',
    customDomain: '',
    targetLocation: ''
  };

  const myProfile = {
    profileFirstName: 'Jordan',
    profileLastName: 'Lee',
    profileEmail: 'jordan.lee@example.com',
    profilePhone: '+1 415-555-0184',
    shippingAddress: '88 Market St',
    shippingCity: 'San Francisco',
    shippingState: 'CA',
    shippingZipCode: '94105',
    shippingCountry: 'United States',
    billingAddress: '88 Market St',
    billingCity: 'San Francisco',
    billingState: 'CA',
    billingZipCode: '94105',
    billingCountry: 'United States',
    cardIssuer: 'Chase',
    cardNetwork: 'Visa',
    cardLast4: '4242',
    cardExpiry: '12/28',
    billingNote: 'Use office billing address'
  };

  const archives = [{
    name: 'Legacy sensitive archive',
    timestamp: Date.now(),
    data: {
      firstName: 'Avery',
      lastName: 'Stone',
      email: 'avery@example.com',
      phone: '+1 212-555-0198',
      address: '120 Madison Ave',
      city: 'New York',
      state: 'NY',
      zipCode: '10016',
      country: 'United States',
      sensitive: { creditCardNumber: '4111111111111111', ssn: '123-45-6789' }
    }
  }];

  return `(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      formPilotCachedData: ${JSON.stringify(cachedData)},
      formPilotMyProfile: ${JSON.stringify(myProfile)},
      formPilotArchives: ${JSON.stringify(archives)},
      formPilotTheme: 'dark'
    });
    return true;
  })()`;
}

function modalCheckExpression(modalId) {
  return `(() => {
    const modal = document.querySelector(${JSON.stringify(`#${modalId}`)});
    const focusable = getModalFocusableElements(modal);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    return {
      modalId: ${JSON.stringify(modalId)},
      activeId: active?.id || '',
      activeClass: active?.className || '',
      activeText: (active?.textContent || '').trim(),
      firstId: first?.id || '',
      lastId: last?.id || '',
      activeInside: modal ? modal.contains(active) : false,
      ariaHidden: modal?.getAttribute('aria-hidden') || '',
      shown: modal?.classList.contains('show') || false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyModalKeyboard(cdp, sessionId, config) {
  await evaluate(cdp, sessionId, `document.querySelector(${JSON.stringify(`#${config.trigger}`)}).focus(); true`);
  await evaluate(cdp, sessionId, `document.querySelector(${JSON.stringify(`#${config.trigger}`)}).click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector(${JSON.stringify(`#${config.modal}`)})?.classList.contains('show')`, `${config.modal} to open`);
  await waitFor(cdp, sessionId, `document.activeElement?.classList.contains('modal')`, `${config.modal} panel focus`);

  const afterOpen = await evaluate(cdp, sessionId, modalCheckExpression(config.modal));
  assert(afterOpen.ariaHidden === 'false', `${config.modal} should clear aria-hidden when opened`);
  assert(afterOpen.activeClass.includes('modal'), `${config.modal} should focus the modal panel after opening`);

  await dispatchKey(cdp, sessionId, 'Tab', { shift: true });
  const afterShiftTab = await evaluate(cdp, sessionId, modalCheckExpression(config.modal));
  assert(afterShiftTab.activeInside, `${config.modal} Shift+Tab escaped the dialog`);
  assert(afterShiftTab.activeId === afterShiftTab.lastId, `${config.modal} Shift+Tab should wrap to ${afterShiftTab.lastId}, got ${afterShiftTab.activeId}`);

  await dispatchKey(cdp, sessionId, 'Tab');
  const afterTab = await evaluate(cdp, sessionId, modalCheckExpression(config.modal));
  assert(afterTab.activeInside, `${config.modal} Tab escaped the dialog`);
  assert(afterTab.activeId === afterTab.firstId, `${config.modal} Tab should wrap to ${afterTab.firstId}, got ${afterTab.activeId}`);

  await dispatchKey(cdp, sessionId, 'Escape');
  await waitFor(cdp, sessionId, `!document.querySelector(${JSON.stringify(`#${config.modal}`)})?.classList.contains('show')`, `${config.modal} to close`);
  const afterEscape = await evaluate(cdp, sessionId, modalCheckExpression(config.modal));
  assert(afterEscape.ariaHidden === 'true', `${config.modal} should restore aria-hidden when closed`);
  assert(afterEscape.activeId === config.trigger, `${config.modal} should return focus to ${config.trigger}, got ${afterEscape.activeId}`);
  assert(!afterEscape.horizontalOverflow, `${config.modal} introduced horizontal overflow`);

  return { modal: config.modal, first: afterTab.firstId, last: afterShiftTab.lastId, trigger: afterEscape.activeId };
}

async function verifySettingsKeyVisibilityControl(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openSettings')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#settingsModal')?.classList.contains('show')`, 'settings modal for API key visibility check');

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#settingsModal');
    const input = document.querySelector('#openaiKey');
    const button = document.querySelector('#toggleOpenAIKeyVisibility');
    input.value = 'sk-test-visible-control';
    const buttonRectBefore = button?.getBoundingClientRect();
    const inputValueBefore = input.value;
    const before = {
      type: input?.type || '',
      text: (button?.textContent || '').trim(),
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      title: button?.title || '',
      width: Math.round(buttonRectBefore?.width || 0),
      height: Math.round(buttonRectBefore?.height || 0)
    };

    button?.click();
    const buttonRectVisible = button?.getBoundingClientRect();
    const visible = {
      type: input?.type || '',
      text: (button?.textContent || '').trim(),
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      title: button?.title || '',
      width: Math.round(buttonRectVisible?.width || 0),
      height: Math.round(buttonRectVisible?.height || 0),
      value: input?.value || ''
    };

    button?.click();
    const buttonRectAfter = button?.getBoundingClientRect();
    const restored = {
      type: input?.type || '',
      text: (button?.textContent || '').trim(),
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      title: button?.title || '',
      width: Math.round(buttonRectAfter?.width || 0),
      height: Math.round(buttonRectAfter?.height || 0),
      value: input?.value || ''
    };

    closeModal(modal);
    return {
      before,
      visible,
      restored,
      inputValueBefore,
      modalClosed: !modal?.classList.contains('show'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.type === 'password' && result.before.text === '显示' && result.before.label === '显示 API Key' && result.before.pressed === 'false' && result.before.title === '显示 API Key', `API key visibility control should start hidden, got ${JSON.stringify(result.before)}`);
  assert(result.visible.type === 'text' && result.visible.text === '隐藏' && result.visible.label === '隐藏 API Key' && result.visible.pressed === 'true' && result.visible.title === '隐藏 API Key', `API key visibility control should reveal the key with accessible state, got ${JSON.stringify(result.visible)}`);
  assert(result.restored.type === 'password' && result.restored.text === '显示' && result.restored.label === '显示 API Key' && result.restored.pressed === 'false' && result.restored.title === '显示 API Key', `API key visibility control should restore password state, got ${JSON.stringify(result.restored)}`);
  assert(result.visible.value === result.inputValueBefore && result.restored.value === result.inputValueBefore, 'API key visibility toggle should not mutate the key value');
  assert(result.before.width >= 44 && result.visible.width === result.before.width && result.restored.width === result.before.width && result.before.height >= 31, `API key visibility button should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(result.modalClosed, 'API key visibility check should close the settings modal before later popup QA');
  assert(!result.horizontalOverflow, 'API key visibility control introduced horizontal overflow');

  return 'keyVisibility:password/text';
}

async function verifySettingsOverviewPolish(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openSettings')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#settingsModal')?.classList.contains('show')`, 'settings modal for overview polish check');
  await waitFor(cdp, sessionId, `document.querySelectorAll('[data-settings-overview]').length === 4`, 'settings overview cards');

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#settingsModal');
    const overview = document.querySelector('#settingsOverview');
    const cards = Array.from(document.querySelectorAll('[data-settings-overview]'));
    const readCard = key => {
      const card = document.querySelector('[data-settings-overview="' + key + '"]');
      const rect = card?.getBoundingClientRect();
      return {
        key,
        state: card?.dataset.state || '',
        label: (card?.querySelector('span')?.textContent || '').trim(),
        title: (card?.querySelector('strong')?.textContent || '').trim(),
        detail: (card?.querySelector('small')?.textContent || '').trim(),
        width: Math.round(rect?.width || 0),
        height: Math.round(rect?.height || 0)
      };
    };
    const rect = overview?.getBoundingClientRect();
    const style = overview ? getComputedStyle(overview) : null;
    const initial = {
      count: cards.length,
      display: style?.display || '',
      columns: style?.gridTemplateColumns || '',
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      password: readCard('password'),
      ai: readCard('ai'),
      address: readCard('address'),
      archive: readCard('archive'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    const enableAI = document.querySelector('#enableAI');
    const openaiKey = document.querySelector('#openaiKey');
    const openaiModel = document.querySelector('#openaiModel');
    const geoapify = document.querySelector('#geoapifyKey');
    enableAI.checked = true;
    openaiKey.value = 'sk-overview-test';
    openaiModel.value = 'gpt-4.1-mini';
    geoapify.value = 'geoapify-overview-test';
    enableAI.dispatchEvent(new Event('change', { bubbles: true }));
    openaiKey.dispatchEvent(new Event('change', { bubbles: true }));
    openaiModel.dispatchEvent(new Event('change', { bubbles: true }));
    geoapify.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 120));
    const updated = {
      ai: readCard('ai'),
      address: readCard('address'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    closeModal(modal);
    return {
      initial,
      updated,
      modalClosed: !modal?.classList.contains('show')
    };
  })()`);

  assert(result.initial.count === 4 && result.initial.display === 'grid' && result.initial.columns.split(' ').length === 2 && result.initial.width >= 320, `settings overview should render a stable two-column grid, got ${JSON.stringify(result.initial)}`);
  assert(result.initial.password.label === '密码规则' && result.initial.password.title.includes('位') && result.initial.password.detail.includes('/4'), `settings password overview should summarize password rules, got ${JSON.stringify(result.initial.password)}`);
  assert(result.initial.ai.label === 'AI 辅助' && result.initial.ai.state === 'off', `settings AI overview should start disabled in seeded storage, got ${JSON.stringify(result.initial.ai)}`);
  assert(result.initial.address.label === '地址增强' && result.initial.address.state === 'partial' && result.initial.address.title === 'OSM' && result.initial.address.detail === '无需 API Key', `settings address overview should start with keyless OSM enrichment before Geoapify is entered, got ${JSON.stringify(result.initial.address)}`);
  assert(result.initial.archive.label === '配置存档' && /^\d+ 个$/.test(result.initial.archive.title), `settings archive overview should show stored archive count, got ${JSON.stringify(result.initial.archive)}`);
  assert(result.initial.password.height >= 64 && result.initial.ai.width >= 150, `settings overview cards should keep stable dimensions, got ${JSON.stringify(result.initial)}`);
  assert(result.updated.ai.state === 'on' && result.updated.ai.title === '可用' && result.updated.ai.detail === 'gpt-4.1-mini', `overview should update after enabling AI and entering a model, got ${JSON.stringify(result.updated.ai)}`);
  assert(result.updated.address.state === 'on' && result.updated.address.title === 'Geoapify' && result.updated.address.detail === '优先地图地址', `overview should update after enabling AI and Geoapify, got ${JSON.stringify(result.updated.address)}`);
  assert(result.modalClosed && !result.initial.horizontalOverflow && !result.updated.horizontalOverflow, `settings overview polish introduced overflow or did not close, got ${JSON.stringify(result)}`);

  return `settingsOverview:${result.initial.count}/${result.updated.ai.state}/${result.updated.address.state}`;
}

async function verifyCompactActionAccessibility(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#inboxGroup')?.classList.remove('is-hidden'); true`);
  const inboxFocus = await focusSelectorByTab(cdp, sessionId, '#refreshInbox', { maxTabs: 80 });
  const inbox = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('#refreshInbox');
    const group = document.querySelector('#inboxGroup');
    const list = document.querySelector('#inboxList');
    const rect = button?.getBoundingClientRect();
    const groupRect = group?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    const groupStyle = group ? getComputedStyle(group) : null;
    return {
      className: button?.className || '',
      text: (button?.textContent || '').trim(),
      type: button?.getAttribute('type') || '',
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      focused: document.activeElement === button,
      focusShadow: style?.boxShadow || '',
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      groupDisplay: groupStyle?.display || '',
      groupColumns: groupStyle?.gridTemplateColumns || '',
      groupWidth: Math.round(groupRect?.width || 0),
      listWidth: Math.round(listRect?.width || 0),
      listLeft: Math.round(listRect?.left || 0),
      buttonLeft: Math.round(rect?.left || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(inbox.className.includes('inbox-refresh-btn') && !inbox.className.includes('btn-small'), `refresh inbox action should use its compact inbox style instead of the gradient CTA style, got ${JSON.stringify(inbox)}`);
  assert(inbox.text === '↻' && inbox.type === 'button', `refresh inbox action should stay a native icon button, got ${JSON.stringify(inbox)}`);
  assert(inbox.title === '刷新收件箱' && inbox.label === '刷新收件箱', `refresh inbox action should expose a localized accessible name, got ${JSON.stringify(inbox)}`);
  assert(inbox.focused && inboxFocus.focused && inbox.focusShadow !== 'none', `refresh inbox action should be keyboard focusable with visible focus feedback, got ${JSON.stringify({ ...inbox, inboxFocus })}`);
  assert(inbox.width === 34 && inbox.height === 34, `refresh inbox action should keep fixed compact dimensions, got ${JSON.stringify(inbox)}`);
  assert(inbox.groupDisplay === 'grid' && inbox.groupColumns.includes('50px') && inbox.listWidth > 250 && inbox.listLeft > inbox.buttonLeft, `inbox panel should keep a compact label column and a readable message column, got ${JSON.stringify(inbox)}`);
  assert(!inbox.horizontalOverflow, `inbox panel polish introduced horizontal overflow, got ${JSON.stringify(inbox)}`);

  await evaluate(cdp, sessionId, `document.querySelector('#openSettings')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#settingsModal')?.classList.contains('show')`, 'settings modal for compact action accessibility check');
  await waitFor(cdp, sessionId, `document.activeElement?.classList.contains('modal')`, 'settings modal panel focus before compact action tab check');
  const settingsFocus = await focusSelectorByTab(cdp, sessionId, '#testAI', { startSelector: '#settingsModal .modal', maxTabs: 80 });

  const settings = await evaluate(cdp, sessionId, `(() => {
    const modal = document.querySelector('#settingsModal');
    const button = document.querySelector('#testAI');
    const rect = button?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    const result = {
      text: (button?.textContent || '').trim(),
      type: button?.getAttribute('type') || '',
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      focused: document.activeElement === button,
      focusShadow: style?.boxShadow || '',
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
    closeModal(modal);
    return {
      ...result,
      modalClosed: !modal?.classList.contains('show')
    };
  })()`);

  assert(settings.text === '测试' && settings.type === 'button', `AI test action should stay a native compact button, got ${JSON.stringify(settings)}`);
  assert(settings.title === '测试 AI 连接' && settings.label === '测试 AI 连接', `AI test action should expose a localized accessible name, got ${JSON.stringify(settings)}`);
  assert(settings.focused && settingsFocus.focused && settings.focusShadow !== 'none', `AI test action should be keyboard focusable with visible focus feedback, got ${JSON.stringify({ ...settings, settingsFocus })}`);
  assert(settings.width >= 44 && settings.height >= 31 && settings.modalClosed && !settings.horizontalOverflow, `AI test action should keep stable dimensions and close cleanly, got ${JSON.stringify(settings)}`);

  return 'compactActions:refresh/testAI';
}

async function verifyHistoryClearConfirmation(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openHistory')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#historyModal')?.classList.contains('show')`, 'history modal for clear confirmation check');
  await sleep(250);

  const result = await evaluate(cdp, sessionId, `(async () => {
    const button = document.querySelector('#clearHistory');
    const modal = document.querySelector('#historyModal');
    const history = [{
      id: 9901,
      timestamp: Date.now(),
      country: 'United States',
      data: {
        firstName: 'History',
        lastName: 'Tester',
        email: 'history@example.com',
        phone: '+1 212-555-0198',
        address: '120 Madison Ave',
        city: 'New York',
        state: 'NY',
        zipCode: '10016',
        country: 'United States'
      },
      fillSummary: { mode: 'form', filled: 4, skipped: 1, missed: 0 }
    }];
    await chrome.storage.local.set({ formPilotHistory: history });
    renderHistoryList(history);

    const beforeRect = button?.getBoundingClientRect();
    const before = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      itemCount: document.querySelectorAll('.history-item').length,
      width: Math.round(beforeRect?.width || 0),
      height: Math.round(beforeRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterFirstStorage = await chrome.storage.local.get('formPilotHistory');
    const firstRect = button?.getBoundingClientRect();
    const afterFirst = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      classed: Boolean(button?.classList.contains('confirming')),
      storedCount: (afterFirstStorage.formPilotHistory || []).length,
      itemCount: document.querySelectorAll('.history-item').length,
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(firstRect?.width || 0),
      height: Math.round(firstRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterSecondStorage = await chrome.storage.local.get('formPilotHistory');
    const secondRect = button?.getBoundingClientRect();
    const afterSecond = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      classed: Boolean(button?.classList.contains('confirming')),
      storedExists: Boolean(afterSecondStorage.formPilotHistory),
      itemCount: document.querySelectorAll('.history-item').length,
      emptyText: (document.querySelector('.history-empty')?.textContent || '').trim(),
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(secondRect?.width || 0),
      height: Math.round(secondRect?.height || 0)
    };

    closeModal(modal);
    return {
      before,
      afterFirst,
      afterSecond,
      modalClosed: !modal?.classList.contains('show'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.text === '清空历史' && result.before.title === '清空历史记录' && result.before.label === '清空历史记录' && result.before.pressed === 'false' && result.before.itemCount === 1, `History clear action should start idle with history data, got ${JSON.stringify(result.before)}`);
  assert(result.afterFirst.text === '确认清空' && result.afterFirst.title === '再次点击清空历史记录' && result.afterFirst.label === '再次点击清空历史记录' && result.afterFirst.pressed === 'true' && result.afterFirst.confirming === 'true' && result.afterFirst.classed, `History clear first click should enter confirmation state, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterFirst.storedCount === 1 && result.afterFirst.itemCount === 1 && result.afterFirst.toast === '再次点击确认清空历史', `History clear first click should not delete history, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterSecond.text === '清空历史' && result.afterSecond.title === '清空历史记录' && result.afterSecond.label === '清空历史记录' && result.afterSecond.pressed === 'false' && result.afterSecond.confirming === 'false' && !result.afterSecond.classed, `History clear second click should restore idle button state, got ${JSON.stringify(result.afterSecond)}`);
  assert(!result.afterSecond.storedExists && result.afterSecond.itemCount === 0 && result.afterSecond.emptyText === '暂无历史记录' && result.afterSecond.toast === '历史记录已清空', `History clear confirmation should clear storage and render empty state, got ${JSON.stringify(result.afterSecond)}`);
  assert(result.before.width === result.afterFirst.width && result.before.width === result.afterSecond.width && result.before.height === result.afterFirst.height && result.before.height === result.afterSecond.height, `History clear confirmation should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(result.modalClosed, 'History clear confirmation check should close the history modal before later popup QA');
  assert(!result.horizontalOverflow, 'History clear confirmation introduced horizontal overflow');

  return 'historyClear:confirmed';
}

async function verifyHistorySearchContract(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openHistory')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#historyModal')?.classList.contains('show')`, 'history modal for search check');
  await sleep(250);

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#historyModal');
    const search = document.querySelector('#historySearch');
    const info = document.querySelector('#historyInfo');
    const history = [
      {
        id: 9911,
        timestamp: new Date().toISOString(),
        country: 'United States',
        data: {
          firstName: 'Avery',
          lastName: 'Stone',
          email: 'avery@example.com',
          phone: '+1 212-555-0198',
          address: '120 Madison Ave',
          city: 'New York',
          state: 'NY',
          zipCode: '10016',
          country: 'United States'
        },
        fillSummary: { mode: 'generated', filled: 5, skipped: 0, missed: 1 }
      },
      {
        id: 9912,
        timestamp: new Date().toISOString(),
        country: 'Japan',
        data: {
          firstName: 'Yuki',
          lastName: 'Tanaka',
          email: 'yuki@example.jp',
          phone: '080-3928-4719',
          address: 'Ginza 1-1',
          city: 'Tokyo',
          state: 'Tokyo',
          zipCode: '100-0001',
          country: 'Japan'
        },
        fillSummary: { mode: 'AI', filled: 7, skipped: 2, missed: 0 }
      }
    ];
    await chrome.storage.local.set({ formPilotHistory: history });
    renderHistoryList(history);
    const firstDelete = document.querySelector('.history-item-delete');
    const firstDeleteRect = firstDelete?.getBoundingClientRect();
    const firstLoad = document.querySelector('.history-item-info');
    firstLoad?.focus();
    const firstLoadStyle = firstLoad ? getComputedStyle(firstLoad) : null;
    const initial = {
      count: document.querySelectorAll('.history-item').length,
      info: (info?.textContent || '').trim(),
      searchLabel: document.querySelector('label[for="historySearch"]')?.textContent.trim() || '',
      placeholder: search?.getAttribute('placeholder') || '',
      activeInside: modal?.contains(document.activeElement) || false,
      loadTag: firstLoad?.tagName || '',
      loadType: firstLoad?.getAttribute('type') || '',
      loadTitle: firstLoad?.title || '',
      loadLabel: firstLoad?.getAttribute('aria-label') || '',
      loadFocused: document.activeElement === firstLoad,
      loadFocusShadow: firstLoadStyle?.boxShadow || '',
      deleteText: (firstDelete?.textContent || '').trim(),
      deleteTitle: firstDelete?.title || '',
      deleteLabel: firstDelete?.getAttribute('aria-label') || '',
      deletePressed: firstDelete?.getAttribute('aria-pressed') || '',
      deleteConfirming: firstDelete?.dataset.confirming || '',
      deleteWidth: Math.round(firstDeleteRect?.width || 0),
      deleteHeight: Math.round(firstDeleteRect?.height || 0)
    };

    firstDelete?.click();
    search.value = 'tokyo';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const tokyoDelete = document.querySelector('.history-item-delete');
    const tokyoLoad = document.querySelector('.history-item-info');
    const tokyo = {
      count: document.querySelectorAll('.history-item').length,
      info: (info?.textContent || '').trim(),
      itemText: (document.querySelector('.history-item')?.textContent || '').trim(),
      loadTag: tokyoLoad?.tagName || '',
      loadLabel: tokyoLoad?.getAttribute('aria-label') || '',
      deleteText: (tokyoDelete?.textContent || '').trim(),
      deletePressed: tokyoDelete?.getAttribute('aria-pressed') || '',
      deleteConfirming: tokyoDelete?.dataset.confirming || ''
    };

    search.value = 'missing city';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const none = {
      count: document.querySelectorAll('.history-item').length,
      info: (info?.textContent || '').trim(),
      empty: (document.querySelector('.history-empty')?.textContent || '').trim()
    };

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const restored = {
      count: document.querySelectorAll('.history-item').length,
      info: (info?.textContent || '').trim()
    };

    search.value = 'tokyo';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.history-item-info')?.focus();

    return {
      initial,
      tokyo,
      none,
      restored,
      keyboardTargetFocused: document.activeElement === document.querySelector('.history-item-info'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  }, sessionId);
  await sleep(150);

  const loaded = await evaluate(cdp, sessionId, `(() => {
    const modal = document.querySelector('#historyModal');
    const result = {
      firstName: document.querySelector('#firstName')?.value || '',
      lastName: document.querySelector('#lastName')?.value || '',
      country: document.querySelector('#country')?.value || '',
      modalClosed: !modal?.classList.contains('show'),
      toast: (document.querySelector('#toast')?.textContent || '').trim()
    };
    if (modal?.classList.contains('show')) closeModal(modal);
    result.finalModalClosed = !modal?.classList.contains('show');
    return result;
  })()`);

  assert(result.initial.count === 2 && result.initial.info === '最近使用的 2 组数据', `History search should start with the full list, got ${JSON.stringify(result.initial)}`);
  assert(result.initial.searchLabel === '搜索历史' && result.initial.placeholder.includes('姓名') && result.initial.activeInside, `History search control should be labelled and stay inside the modal focus scope, got ${JSON.stringify(result.initial)}`);
  assert(result.initial.loadTag === 'BUTTON' && result.initial.loadType === 'button' && result.initial.loadTitle === '加载此记录' && result.initial.loadLabel.includes('加载历史记录') && result.initial.loadFocused && result.initial.loadFocusShadow !== 'none', `History load target should be a labelled focusable button with visible focus feedback, got ${JSON.stringify(result.initial)}`);
  assert(result.initial.deleteText === '删除' && result.initial.deleteTitle === '删除历史记录' && result.initial.deleteLabel === '删除历史记录' && result.initial.deletePressed === 'false' && result.initial.deleteConfirming === 'false', `History item delete action should start idle and accessible, got ${JSON.stringify(result.initial)}`);
  assert(result.initial.deleteWidth >= 38 && result.initial.deleteHeight >= 24, `History item delete action should keep stable compact dimensions, got ${JSON.stringify(result.initial)}`);
  assert(result.tokyo.count === 1 && result.tokyo.info === '显示 1 / 2 条' && result.tokyo.itemText.includes('Yuki') && result.tokyo.itemText.includes('AI'), `History search should filter by location and summary text, got ${JSON.stringify(result.tokyo)}`);
  assert(result.tokyo.loadTag === 'BUTTON' && result.tokyo.loadLabel.includes('Yuki'), `Filtered history load target should stay a labelled button, got ${JSON.stringify(result.tokyo)}`);
  assert(result.tokyo.deleteText === '删除' && result.tokyo.deletePressed === 'false' && result.tokyo.deleteConfirming === 'false', `History search should reset pending item-delete confirmation while filtering, got ${JSON.stringify(result.tokyo)}`);
  assert(result.none.count === 0 && result.none.info === '显示 0 / 2 条' && result.none.empty === '没有匹配的历史记录', `History search should show a filtered empty state, got ${JSON.stringify(result.none)}`);
  assert(result.restored.count === 2 && result.restored.info === '最近使用的 2 组数据', `History search should restore the full list after clearing query, got ${JSON.stringify(result.restored)}`);
  assert(result.keyboardTargetFocused, `History load button should keep focus before keyboard activation, got ${JSON.stringify(result)}`);
  assert(loaded.firstName === 'Yuki' && loaded.lastName === 'Tanaka' && loaded.country === 'Japan' && loaded.modalClosed && loaded.toast.includes('已加载历史记录'), `History load button should support keyboard activation and close the modal, got ${JSON.stringify(loaded)}`);
  assert(loaded.finalModalClosed, 'History search check should close the history modal before later popup QA');
  assert(!result.horizontalOverflow, 'History search introduced horizontal overflow');

  return 'historySearch:2/1/0';
}

async function verifyHistoryItemDeleteConfirmation(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openHistory')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#historyModal')?.classList.contains('show')`, 'history modal for item delete confirmation check');
  await sleep(250);

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#historyModal');
    const history = [
      {
        id: 9921,
        timestamp: new Date().toISOString(),
        country: 'United States',
        data: {
          firstName: 'Avery',
          lastName: 'Stone',
          email: 'avery@example.com',
          phone: '+1 212-555-0198',
          address: '120 Madison Ave',
          city: 'New York',
          state: 'NY',
          zipCode: '10016',
          country: 'United States'
        }
      }
    ];
    await chrome.storage.local.set({ formPilotHistory: history });
    renderHistoryList(history);
    const button = document.querySelector('.history-item-delete');
    const beforeRect = button?.getBoundingClientRect();
    const before = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      count: document.querySelectorAll('.history-item').length,
      width: Math.round(beforeRect?.width || 0),
      height: Math.round(beforeRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterFirstStorage = await chrome.storage.local.get('formPilotHistory');
    const firstRect = button?.getBoundingClientRect();
    const afterFirst = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      classed: Boolean(button?.classList.contains('confirming')),
      storedCount: (afterFirstStorage.formPilotHistory || []).length,
      count: document.querySelectorAll('.history-item').length,
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(firstRect?.width || 0),
      height: Math.round(firstRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterSecondStorage = await chrome.storage.local.get('formPilotHistory');
    const afterSecond = {
      storedCount: (afterSecondStorage.formPilotHistory || []).length,
      count: document.querySelectorAll('.history-item').length,
      emptyText: (document.querySelector('.history-empty')?.textContent || '').trim(),
      toast: (document.querySelector('#toast')?.textContent || '').trim()
    };

    closeModal(modal);
    return {
      before,
      afterFirst,
      afterSecond,
      modalClosed: !modal?.classList.contains('show'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.text === '删除' && result.before.title === '删除历史记录' && result.before.label === '删除历史记录' && result.before.pressed === 'false' && result.before.confirming === 'false' && result.before.count === 1, `History item delete action should start idle, got ${JSON.stringify(result.before)}`);
  assert(result.afterFirst.text === '确认' && result.afterFirst.title === '再次点击删除历史记录' && result.afterFirst.label === '再次点击删除历史记录' && result.afterFirst.pressed === 'true' && result.afterFirst.confirming === 'true' && result.afterFirst.classed, `History item delete first click should enter confirmation state, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterFirst.storedCount === 1 && result.afterFirst.count === 1 && result.afterFirst.toast === '再次点击确认删除历史', `History item delete first click should not delete storage, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterSecond.storedCount === 0 && result.afterSecond.count === 0 && result.afterSecond.emptyText === '暂无历史记录' && result.afterSecond.toast === '已删除', `History item delete second click should delete and render empty state, got ${JSON.stringify(result.afterSecond)}`);
  assert(result.before.width === result.afterFirst.width && result.before.height === result.afterFirst.height && result.before.width >= 38, `History item delete confirmation should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(result.modalClosed, 'History item delete confirmation check should close the history modal before later popup QA');
  assert(!result.horizontalOverflow, 'History item delete confirmation introduced horizontal overflow');

  return 'historyItemDelete:confirmed';
}

async function verifyReducedMotionContract(cdp, sessionId) {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  }, sessionId);

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#settingsModal');
    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';
    document.body.appendChild(spinner);

    document.querySelector('#openSettings')?.click();
    const panel = modal?.querySelector('.modal');
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const spinnerStyle = getComputedStyle(spinner);
    const docStyle = getComputedStyle(document.documentElement);
    const progress = document.querySelector('#profileOverviewBar');
    const progressStyle = progress ? getComputedStyle(progress) : null;

    const state = {
      shown: Boolean(modal?.classList.contains('show')),
      panelAnimation: panelStyle?.animationName || '',
      panelTransform: panelStyle?.transform || '',
      spinnerAnimation: spinnerStyle.animationName || '',
      progressTransition: progressStyle?.transitionDuration || '',
      scrollBehavior: docStyle.scrollBehavior || '',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    spinner.remove();
    closeModal(modal);
    return state;
  })()`);

  await cdp.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);

  assert(result.shown, `reduced-motion modal should still open, got ${JSON.stringify(result)}`);
  assert(result.panelAnimation === 'none' && result.spinnerAnimation === 'none', `reduced-motion should disable modal and spinner animations, got ${JSON.stringify(result)}`);
  assert(result.panelTransform === 'none', `reduced-motion should remove modal transform motion, got ${result.panelTransform}`);
  assert(result.progressTransition === '0s' || result.progressTransition === '0.001s', `reduced-motion should remove progress transitions, got ${result.progressTransition}`);
  assert(result.scrollBehavior === 'auto', `reduced-motion should keep scroll behavior auto, got ${result.scrollBehavior}`);
  assert(!result.horizontalOverflow, 'reduced-motion state introduced horizontal overflow');

  return 'motion:reduced';
}

async function verifyMyProfileVisualContract(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const modal = document.querySelector('#myProfileModal .profile-modal');
    const body = document.querySelector('#myProfileModal .profile-body');
    const actions = document.querySelector('#myProfileModal .profile-actions');
    const actionRow = document.querySelector('#myProfileModal .profile-actions-row');
    const actionButtons = Array.from(document.querySelectorAll('#myProfileModal .profile-actions-row > button'));
    const danger = document.querySelector('#clearMyProfile');
    const save = document.querySelector('#saveMyProfile');
    const primary = document.querySelector('#fillMyProfile');
    const title = document.querySelector('#myProfileTitle');
    const status = document.querySelector('#myProfileStatus');
    const completeness = document.querySelector('#myProfileCompleteness');
    const completenessScore = document.querySelector('#myProfileCompletenessScore');
    const completenessBar = document.querySelector('#myProfileCompletenessBar');
    const completenessHint = document.querySelector('#myProfileCompletenessHint');
    const completenessChips = Array.from(document.querySelectorAll('#myProfileCompletenessChips .profile-completeness-chip'));
    const chipButtons = completenessChips.map(chip => ({
      tagName: chip.tagName,
      type: chip.getAttribute('type') || '',
      label: chip.getAttribute('aria-label') || '',
      title: chip.getAttribute('title') || '',
      width: Math.round(chip.getBoundingClientRect().width || 0),
      height: Math.round(chip.getBoundingClientRect().height || 0)
    }));
    const firstLabel = document.querySelector('#myProfileModal .profile-grid label');
    const firstInput = document.querySelector('#profileFirstName');
    const modalRect = modal?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const actionRowRect = actionRow?.getBoundingClientRect();
    const dangerRect = danger?.getBoundingClientRect();
    const saveRect = save?.getBoundingClientRect();
    const primaryRect = primary?.getBoundingClientRect();
    const statusRect = status?.getBoundingClientRect();
    const completenessRect = completeness?.getBoundingClientRect();
    return {
      titleColor: getComputedStyle(title).color,
      statusText: (status?.textContent || '').trim(),
      statusState: status?.dataset.state || '',
      statusVisible: Boolean(statusRect && statusRect.width >= 50 && statusRect.height >= 18 && statusRect.right <= window.innerWidth),
      completenessText: (completenessScore?.textContent || '').trim(),
      completenessHint: (completenessHint?.textContent || '').trim(),
      completenessVisible: Boolean(completenessRect && completenessRect.width >= 360 && completenessRect.height >= 80),
      completenessBarWidth: completenessBar?.style.width || '',
      completenessChipCount: completenessChips.length,
      completeChipCount: completenessChips.filter(chip => chip.dataset.state === 'complete').length,
      chipButtons,
      labelColor: getComputedStyle(firstLabel).color,
      inputBackground: getComputedStyle(firstInput).backgroundColor,
      inputBorder: getComputedStyle(firstInput).borderColor,
      actionsBackground: getComputedStyle(actions).backgroundColor,
      actionsLabel: actions?.getAttribute('aria-label') || '',
      actionRowLabel: actionRow?.getAttribute('aria-label') || '',
      actionRowDisplay: getComputedStyle(actionRow).display,
      actionRowColumns: getComputedStyle(actionRow).gridTemplateColumns,
      actionButtonOrder: actionButtons.map(button => button.id),
      actionButtonTypes: actionButtons.map(button => button.getAttribute('type') || ''),
      dangerClass: danger?.className || '',
      saveClass: save?.className || '',
      dangerRightAligned: Boolean(dangerRect && actionRowRect && dangerRect.right <= actionRowRect.right + 1 && dangerRect.left > actionRowRect.left),
      saveBeforeDanger: Boolean(saveRect && dangerRect && saveRect.left < dangerRect.left),
      actionRowWidth: Math.round(actionRowRect?.width || 0),
      primaryBackground: getComputedStyle(primary).backgroundImage || getComputedStyle(primary).backgroundColor,
      modalWidth: Math.round(modalRect?.width || 0),
      bodyHeight: Math.round(bodyRect?.height || 0),
      actionsHeight: Math.round(actionsRect?.height || 0),
      primaryWidth: Math.round(primaryRect?.width || 0),
      primaryVisible: Boolean(primaryRect && primaryRect.bottom <= window.innerHeight && primaryRect.width > 300 && primaryRect.height >= 34),
      bodyAboveActions: Boolean(bodyRect && actionsRect && bodyRect.bottom <= actionsRect.top + 1),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(luminanceFromRgb(result.titleColor) >= 180, `My Profile title should be bright, got ${result.titleColor}`);
  assert(result.statusText === '本地已保存' && result.statusState === 'saved' && result.statusVisible, `My Profile save status should be visible and saved, got ${JSON.stringify(result)}`);
  assert(result.completenessText === '100%' && result.completenessBarWidth === '100%', `My Profile completeness should show 100%, got ${JSON.stringify(result)}`);
  assert(result.completenessVisible && result.completenessChipCount === 4 && result.completeChipCount === 4, `My Profile completeness chips should be visible and complete, got ${JSON.stringify(result)}`);
  for (const chip of result.chipButtons) {
    assert(chip.tagName === 'BUTTON' && chip.type === 'button', `My Profile completeness chip should be a non-submit button, got ${JSON.stringify(chip)}`);
    assert(chip.label.includes('完成度') && chip.title === '本组已完整', `My Profile completeness chip should expose accessible complete state, got ${JSON.stringify(chip)}`);
    assert(chip.width >= 150 && chip.height >= 28, `My Profile completeness chip should keep stable dimensions, got ${JSON.stringify(chip)}`);
  }
  assert(result.completenessHint.includes('资料已完整'), `My Profile completeness should show a complete hint, got ${result.completenessHint}`);
  assert(luminanceFromRgb(result.labelColor) >= 110, `My Profile labels should be readable, got ${result.labelColor}`);
  assert(luminanceFromRgb(result.inputBackground) >= 18, `My Profile inputs should not blend into the modal, got ${result.inputBackground}`);
  assert(luminanceFromRgb(result.inputBorder) >= 34, `My Profile input borders should be visible, got ${result.inputBorder}`);
  assert(luminanceFromRgb(result.actionsBackground) >= 8, `My Profile actions background should be solid, got ${result.actionsBackground}`);
  assert(result.actionsLabel === '我的资料操作' && result.actionRowLabel === '资料管理操作', `My Profile actions should expose grouped labels, got ${JSON.stringify(result)}`);
  assert(result.actionRowDisplay === 'grid' && result.actionRowColumns.split(' ').length === 5 && result.actionRowWidth >= 360, `My Profile secondary actions should use a stable five-control grid, got ${JSON.stringify(result)}`);
  assert(result.actionButtonOrder.join(',') === 'importMyProfile,exportMyProfile,copyMyProfile,saveMyProfile,clearMyProfile', `My Profile secondary actions should separate management and destructive order, got ${JSON.stringify(result.actionButtonOrder)}`);
  assert(result.actionButtonTypes.every(type => type === 'button'), `My Profile secondary actions should stay non-submit buttons, got ${JSON.stringify(result.actionButtonTypes)}`);
  assert(result.dangerClass.includes('profile-action-danger') && result.saveClass.includes('profile-action-save'), `My Profile save and clear actions should have distinct visual hierarchy, got ${JSON.stringify(result)}`);
  assert(result.dangerRightAligned && result.saveBeforeDanger, `My Profile destructive clear action should be visually isolated at the row end, got ${JSON.stringify(result)}`);
  assert(String(result.primaryBackground).includes('linear-gradient'), 'My Profile primary action should keep the emphasized gradient background');
  assert(result.modalWidth >= 410, `My Profile modal should use the available popup width, got ${result.modalWidth}`);
  assert(result.bodyHeight >= 600, `My Profile body should keep a useful scroll area, got ${result.bodyHeight}`);
  assert(result.actionsHeight >= 90, `My Profile actions should have stable height, got ${result.actionsHeight}`);
  assert(result.primaryVisible, 'My Profile primary action should be fully visible in the popup viewport');
  assert(result.bodyAboveActions, 'My Profile scroll body should end above the action footer');
  assert(!result.horizontalOverflow, 'My Profile modal introduced horizontal overflow');

  return result;
}

async function verifyMyProfileHeaderStatus(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const button = document.querySelector('#openMyProfile');
    const status = document.querySelector('#myProfileHeaderStatus');
    const saveStatus = document.querySelector('#myProfileStatus');
    const phone = document.querySelector('#profilePhone');
    const beforeRect = status?.getBoundingClientRect();
    const before = {
      text: (status?.textContent || '').trim(),
      state: button?.dataset.state || '',
      label: button?.getAttribute('aria-label') || '',
      title: button?.title || '',
      width: Math.round(beforeRect?.width || 0),
      height: Math.round(beforeRect?.height || 0)
    };

    phone.value = '';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    const partialRect = status?.getBoundingClientRect();
    const partial = {
      text: (status?.textContent || '').trim(),
      state: button?.dataset.state || '',
      label: button?.getAttribute('aria-label') || '',
      title: button?.title || '',
      width: Math.round(partialRect?.width || 0),
      height: Math.round(partialRect?.height || 0)
    };

    phone.value = '+1 415-555-0184';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => {
      const startedAt = Date.now();
      const tick = () => {
        const saved = (saveStatus?.textContent || '').trim() === '本地已保存' && saveStatus?.dataset.state === 'saved';
        if (saved || Date.now() - startedAt > 1600) {
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
    const restored = {
      text: (status?.textContent || '').trim(),
      state: button?.dataset.state || '',
      label: button?.getAttribute('aria-label') || '',
      title: button?.title || '',
      saveText: (saveStatus?.textContent || '').trim(),
      saveState: saveStatus?.dataset.state || ''
    };

    return {
      before,
      partial,
      restored,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.text === '完整' && result.before.state === 'complete' && result.before.label.includes('100%') && result.before.title === '我的资料已完整', `My Profile header status should start complete, got ${JSON.stringify(result.before)}`);
  assert(result.partial.text === '95%' && result.partial.state === 'partial' && result.partial.label.includes('95%') && result.partial.title.includes('95%'), `My Profile header status should track incomplete profile state, got ${JSON.stringify(result.partial)}`);
  assert(result.partial.width >= 28 && result.partial.height >= 18, `My Profile header status should keep stable compact dimensions, got ${JSON.stringify(result.partial)}`);
  assert(result.restored.text === '完整' && result.restored.state === 'complete' && result.restored.label.includes('100%'), `My Profile header status should restore before screenshots, got ${JSON.stringify(result.restored)}`);
  assert(result.restored.saveText === '本地已保存' && result.restored.saveState === 'saved', `My Profile header status check should let autosave settle, got ${JSON.stringify(result.restored)}`);
  assert(!result.horizontalOverflow, 'My Profile header status introduced horizontal overflow');

  return 'profileHeader:100/95/100';
}

async function verifyMyProfileAutoSave(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const input = document.querySelector('#profileFirstName');
    const phone = document.querySelector('#profilePhone');
    const status = document.querySelector('#myProfileStatus');
    const score = document.querySelector('#myProfileCompletenessScore');
    const bar = document.querySelector('#myProfileCompletenessBar');
    input.focus();
    input.value = 'Avery';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const completeAfterName = {
      text: (score?.textContent || '').trim(),
      width: bar?.style.width || ''
    };
    phone.value = '';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    const contactChip = document.querySelector('.profile-completeness-chip[data-profile-group="contact"]');
    const partialAfterPhone = {
      text: (score?.textContent || '').trim(),
      width: bar?.style.width || '',
      contactChip: (contactChip?.textContent || '').replace(/\s+/g, ' ').trim(),
      contactChipTag: contactChip?.tagName || '',
      contactChipState: contactChip?.dataset.state || '',
      contactChipMissingField: contactChip?.dataset.missingField || '',
      contactChipLabel: contactChip?.getAttribute('aria-label') || '',
      contactChipTitle: contactChip?.title || ''
    };
    contactChip?.click();
    const focusAfterChip = document.activeElement?.id || '';
    const saving = {
      text: (status?.textContent || '').trim(),
      state: status?.dataset.state || ''
    };
    await new Promise(resolve => setTimeout(resolve, 700));
    const stored = await chrome.storage.local.get('formPilotMyProfile');
    return {
      saving,
      savedText: (status?.textContent || '').trim(),
      savedState: status?.dataset.state || '',
      storedFirstName: stored.formPilotMyProfile?.profileFirstName || '',
      storedPhone: stored.formPilotMyProfile?.profilePhone || '',
      completeAfterName,
      partialAfterPhone,
      focusAfterChip,
      forbiddenStored: Boolean(stored.formPilotMyProfile?.creditCardNumber || stored.formPilotMyProfile?.creditCardCvv || stored.formPilotMyProfile?.ssn),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.saving.text === '正在保存...' && result.saving.state === 'saving', `My Profile should show saving state after edit, got ${JSON.stringify(result.saving)}`);
  assert(result.savedText === '本地已保存' && result.savedState === 'saved', `My Profile should return to saved state, got ${result.savedText}/${result.savedState}`);
  assert(result.storedFirstName === 'Avery', `My Profile auto-save should persist edited first name, got ${result.storedFirstName}`);
  assert(result.storedPhone === '', `My Profile auto-save should persist cleared phone, got ${result.storedPhone}`);
  assert(result.completeAfterName.text === '100%' && result.completeAfterName.width === '100%', `My Profile completeness should stay complete after non-empty edit, got ${JSON.stringify(result.completeAfterName)}`);
  assert(result.partialAfterPhone.text === '95%' && result.partialAfterPhone.width === '95%' && result.partialAfterPhone.contactChip.includes('3/4'), `My Profile completeness should update after clearing a field, got ${JSON.stringify(result.partialAfterPhone)}`);
  assert(result.partialAfterPhone.contactChipTag === 'BUTTON' && result.partialAfterPhone.contactChipState === 'partial' && result.partialAfterPhone.contactChipMissingField === 'profilePhone', `My Profile partial completeness chip should expose its first missing field, got ${JSON.stringify(result.partialAfterPhone)}`);
  assert(result.partialAfterPhone.contactChipLabel.includes('点击定位缺失项') && result.partialAfterPhone.contactChipTitle === '定位缺失项', `My Profile partial completeness chip should explain the focus action, got ${JSON.stringify(result.partialAfterPhone)}`);
  assert(result.focusAfterChip === 'profilePhone', `My Profile completeness chip should focus the first missing field, got ${result.focusAfterChip}`);
  assert(!result.forbiddenStored, 'My Profile auto-save must not persist forbidden sensitive fields');
  assert(!result.horizontalOverflow, 'My Profile auto-save status introduced horizontal overflow');

  return 'autosave:profileFirstName; completeness:95%';
}

async function verifyMyProfileCopyShippingState(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const button = document.querySelector('#copyShippingToBilling');
    const shippingFields = ['shippingAddress', 'shippingCity', 'shippingState', 'shippingZipCode', 'shippingCountry']
      .map(id => document.querySelector('#' + id));
    const billing = {
      address: document.querySelector('#billingAddress'),
      city: document.querySelector('#billingCity'),
      state: document.querySelector('#billingState'),
      zip: document.querySelector('#billingZipCode'),
      country: document.querySelector('#billingCountry')
    };

    const initial = {
      disabled: Boolean(button?.disabled),
      ariaDisabled: button?.getAttribute('aria-disabled') || '',
      title: button?.title || '',
      text: (button?.textContent || '').trim()
    };

    for (const field of shippingFields) {
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const afterClear = {
      disabled: Boolean(button?.disabled),
      ariaDisabled: button?.getAttribute('aria-disabled') || '',
      title: button?.title || '',
      width: Math.round(button?.getBoundingClientRect().width || 0),
      height: Math.round(button?.getBoundingClientRect().height || 0)
    };

    const values = {
      shippingAddress: '500 Mission St',
      shippingCity: 'San Francisco',
      shippingState: 'CA',
      shippingZipCode: '94105',
      shippingCountry: 'United States'
    };

    for (const [id, value] of Object.entries(values)) {
      const input = document.querySelector('#' + id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const afterFill = {
      disabled: Boolean(button?.disabled),
      ariaDisabled: button?.getAttribute('aria-disabled') || '',
      title: button?.title || ''
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 700));
    const stored = await chrome.storage.local.get('formPilotMyProfile');

    return {
      initial,
      afterClear,
      afterFill,
      billingAddress: billing.address?.value || '',
      billingCity: billing.city?.value || '',
      billingState: billing.state?.value || '',
      billingZipCode: billing.zip?.value || '',
      billingCountry: billing.country?.value || '',
      storedBillingAddress: stored.formPilotMyProfile?.billingAddress || '',
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.initial.disabled === false && result.initial.ariaDisabled === 'false' && result.initial.title === '将收货地址复制到账单地址' && result.initial.text === '同收货地址', `copy-shipping action should start enabled for seeded shipping data, got ${JSON.stringify(result.initial)}`);
  assert(result.afterClear.disabled === true && result.afterClear.ariaDisabled === 'true' && result.afterClear.title === '先填写收货地址', `copy-shipping action should disable when shipping address is empty, got ${JSON.stringify(result.afterClear)}`);
  assert(result.afterClear.width >= 78 && result.afterClear.height >= 26, `copy-shipping action should keep stable disabled dimensions, got ${JSON.stringify(result.afterClear)}`);
  assert(result.afterFill.disabled === false && result.afterFill.ariaDisabled === 'false' && result.afterFill.title === '将收货地址复制到账单地址', `copy-shipping action should re-enable after shipping input, got ${JSON.stringify(result.afterFill)}`);
  assert(result.billingAddress === '500 Mission St' && result.billingCity === 'San Francisco' && result.billingState === 'CA' && result.billingZipCode === '94105' && result.billingCountry === 'United States', `copy-shipping action should copy all address fields, got ${JSON.stringify(result)}`);
  assert(result.storedBillingAddress === '500 Mission St', `copy-shipping action should persist through My Profile whitelist, got ${result.storedBillingAddress}`);
  assert(result.toast === '账单地址已同步', `copy-shipping action should show sync feedback, got ${result.toast}`);
  assert(!result.horizontalOverflow, 'copy-shipping action introduced horizontal overflow');

  return 'copyShipping:disabled/enabled/synced';
}

async function verifyMyProfilePaymentSummaryNormalization(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const previousProfile = { ...myProfile };
    const last4 = document.querySelector('#cardLast4');
    const expiry = document.querySelector('#cardExpiry');
    const note = document.querySelector('#paymentSummaryHint');
    const dispatchPaste = (target, text) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: type => type === 'text' ? text : '' }
      });
      target.dispatchEvent(event);
    };

    dispatchPaste(last4, '4111 1111 1111 4242');
    dispatchPaste(expiry, '12/2028');
    await persistMyProfile(readMyProfileFromInputs(), { updateUI: true });
    const stored = await chrome.storage.local.get('formPilotMyProfile');
    const fillData = buildMyProfileFillData();
    const imported = sanitizeMyProfilePayload({
      profileFirstName: 'Card',
      cardLast4: '4000 0000 0000 9876',
      cardExpiry: '2029/11',
      creditCardNumber: '4111111111111111',
      creditCardCvv: '123',
      ssn: '123-45-6789'
    });
    const importSummary = summarizeMyProfileImportPayload({
      profileFirstName: 'Card',
      shippingCity: 'Seattle',
      creditCardNumber: '4111111111111111',
      creditCardCvv: '123',
      ssn: '123-45-6789',
      favoriteColor: 'blue'
    });
    const importMessage = getMyProfileImportMessage(importSummary);
    const status = document.querySelector('#myProfileStatus');
    setMyProfileStatus(importMessage, 'warning');
    const statusRect = status?.getBoundingClientRect();

    myProfile = normalizeMyProfile(previousProfile);
    updateMyProfileUI();
    await chrome.storage.local.set({ formPilotMyProfile: myProfile });

    return {
      last4Value: last4?.value || '',
      expiryValue: expiry?.value || '',
      storedLast4: stored.formPilotMyProfile?.cardLast4 || '',
      storedExpiry: stored.formPilotMyProfile?.cardExpiry || '',
      fillLast4: fillData.cardLast4 || '',
      fillExpiry: fillData.cardExpiry || '',
      importedLast4: imported.cardLast4 || '',
      importedExpiry: imported.cardExpiry || '',
      importedKeys: Object.keys(imported).sort(),
      importSummary,
      importMessage,
      importStatus: {
        text: status?.textContent || '',
        state: status?.dataset.state || '',
        width: statusRect?.width || 0,
        overflows: Boolean(status && status.scrollWidth > status.clientWidth),
        maxWidth: getComputedStyle(status).maxWidth,
        textOverflow: getComputedStyle(status).textOverflow
      },
      noteText: (note?.textContent || '').trim(),
      pasteDefaultPrevented: last4?.value === '4242' && expiry?.value === '12/28',
      last4MaxLength: last4?.getAttribute('maxlength') || '',
      expiryMaxLength: expiry?.getAttribute('maxlength') || '',
      last4InputMode: last4?.getAttribute('inputmode') || '',
      expiryInputMode: expiry?.getAttribute('inputmode') || '',
      last4Autocomplete: last4?.getAttribute('autocomplete') || '',
      expiryAutocomplete: expiry?.getAttribute('autocomplete') || '',
      describedBy: expiry?.getAttribute('aria-describedby') || '',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.noteText.includes('粘贴卡号时会只保留尾号') && result.noteText.includes('不保存完整卡号'), `payment summary hint should explain the local metadata boundary, got ${result.noteText}`);
  assert(result.last4MaxLength === '4' && result.expiryMaxLength === '5' && result.last4InputMode === 'numeric' && result.expiryInputMode === 'numeric', `payment summary inputs should constrain mobile keyboard and length, got ${JSON.stringify(result)}`);
  assert(result.last4Autocomplete === 'off' && result.expiryAutocomplete === 'off' && result.describedBy === 'paymentSummaryHint', `payment summary inputs should avoid browser payment autofill and reference the boundary hint, got ${JSON.stringify(result)}`);
  assert(result.pasteDefaultPrevented, `payment summary paste handling should normalize before maxlength truncation, got ${JSON.stringify(result)}`);
  assert(result.last4Value === '4242' && result.expiryValue === '12/28', `payment summary input should normalize pasted values, got ${JSON.stringify(result)}`);
  assert(result.storedLast4 === '4242' && result.storedExpiry === '12/28', `payment summary storage should persist normalized metadata only, got ${JSON.stringify(result)}`);
  assert(result.fillLast4 === '4242' && result.fillExpiry === '12/28', `My Profile fill payload should use normalized payment metadata, got ${JSON.stringify(result)}`);
  assert(result.importedLast4 === '9876' && result.importedExpiry === '11/29', `import sanitization should normalize payment metadata, got ${JSON.stringify(result)}`);
  assert(!result.importedKeys.some(key => /creditCard|cardNumber|cardCvv|ssn/i.test(key)), `import sanitization should drop forbidden payment identifiers, got ${JSON.stringify(result.importedKeys)}`);
  assert(result.importSummary.accepted === 2 && result.importSummary.dropped.length === 4 && result.importSummary.dropped.includes('creditCardNumber') && result.importSummary.dropped.includes('ssn'), `import summary should report dropped fields without storing them, got ${JSON.stringify(result.importSummary)}`);
  assert(result.importMessage.includes('已导入，已忽略') && result.importMessage.includes('creditCardNumber'), `import summary message should disclose ignored fields, got ${result.importMessage}`);
  assert(result.importStatus.state === 'warning' && result.importStatus.text === result.importMessage && result.importStatus.width <= 232 && result.importStatus.overflows && result.importStatus.textOverflow === 'ellipsis', `import warning status should stay stable and truncatable, got ${JSON.stringify(result.importStatus)}`);
  assert(!result.horizontalOverflow, 'payment summary normalization introduced horizontal overflow');

  return 'paymentSummary:normalized/import-report';
}

async function verifyMyProfileCopyOutput(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__formPilotClipboardWrites.push(String(text));
        }
      }
    });

    const button = document.querySelector('#copyMyProfile');
    const beforeRect = button?.getBoundingClientRect();
    const previousProfile = { ...myProfile };
    const copyProfile = {
      profileFirstName: 'Avery',
      profileLastName: 'Lee',
      profileEmail: 'avery.lee@example.com',
      profilePhone: '+1 415-555-0142',
      shippingAddress: '88 Market St',
      shippingCity: 'San Francisco',
      shippingState: 'CA',
      shippingZipCode: '94105',
      shippingCountry: 'United States',
      billingAddress: '901 Howard St',
      billingCity: 'San Francisco',
      billingState: 'CA',
      billingZipCode: '94103',
      billingCountry: 'United States',
      cardIssuer: 'Chase',
      cardNetwork: 'Visa',
      cardLast4: '4242',
      cardExpiry: '12/28',
      billingNote: 'Use office billing address'
    };
    const readInputs = () => Object.fromEntries(MY_PROFILE_FIELD_NAMES.map(name => [
      name,
      document.querySelector('#' + name)?.value || ''
    ]));
    const applyProfile = profile => {
      myProfile = normalizeMyProfile(profile);
      updateMyProfileUI();
    };

    applyProfile(copyProfile);
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const fullText = window.__formPilotClipboardWrites.at(-1) || '';
    const fullToast = (document.querySelector('#toast')?.textContent || '').trim();

    ['profilePhone', 'billingNote', 'cardIssuer'].forEach(id => {
      const field = document.querySelector('#' + id);
      if (field) field.value = '';
    });
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const compactText = window.__formPilotClipboardWrites.at(-1) || '';
    const compactToast = (document.querySelector('#toast')?.textContent || '').trim();

    MY_PROFILE_FIELD_NAMES.forEach(id => {
      const field = document.querySelector('#' + id);
      if (field) field.value = '';
    });
    const writesBeforeEmpty = window.__formPilotClipboardWrites.length;
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const emptyRect = button?.getBoundingClientRect();
    const emptyState = {
      writesBefore: writesBeforeEmpty,
      writesAfter: window.__formPilotClipboardWrites.length,
      text: (button?.textContent || '').trim(),
      copied: Boolean(button?.classList.contains('copied')),
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      beforeWidth: Math.round(beforeRect?.width || 0),
      afterWidth: Math.round(emptyRect?.width || 0),
      beforeHeight: Math.round(beforeRect?.height || 0),
      afterHeight: Math.round(emptyRect?.height || 0)
    };

    applyProfile(previousProfile);
    await chrome.storage.local.set({ formPilotMyProfile: previousProfile });
    const restored = readInputs();

    return {
      fullText,
      fullToast,
      compactText,
      compactToast,
      emptyState,
      restored,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  for (const required of [
    '联系人:',
    '姓名: Avery Lee',
    '邮箱: avery.lee@example.com',
    '收货地址:',
    '地址: 88 Market St',
    '账单地址:',
    '支付摘要:',
    '尾号: 4242',
    '账单备注: Use office billing address'
  ]) {
    assert(result.fullText.includes(required), `My Profile copy should include filled section or field ${required}, got ${JSON.stringify(result.fullText)}`);
  }
  assert(result.fullToast === '我的资料已复制', `My Profile copy should show success toast, got ${result.fullToast}`);
  assert(!/411111|123-45-6789|creditCardNumber|creditCardCvv|cardNumber|cardCvv|ssn|CVV|SSN/i.test(result.fullText), `My Profile copy leaked forbidden sensitive data: ${result.fullText}`);
  for (const omitted of ['电话:', '账单备注:', '发卡行:']) {
    assert(!result.compactText.includes(omitted), `My Profile compact copy should omit empty field label ${omitted}, got ${JSON.stringify(result.compactText)}`);
  }
  assert(result.compactText.includes('姓名: Avery Lee') && result.compactText.includes('尾号: 4242'), `My Profile compact copy should keep filled fields, got ${JSON.stringify(result.compactText)}`);
  assert(result.compactToast === '我的资料已复制', `My Profile compact copy should still show success toast, got ${result.compactToast}`);
  assert(result.emptyState.writesAfter === result.emptyState.writesBefore, `My Profile empty copy should not write to clipboard, got ${JSON.stringify(result.emptyState)}`);
  assert(result.emptyState.toast === '没有可复制的资料', `My Profile empty copy should show empty-state toast, got ${result.emptyState.toast}`);
  assert(!result.emptyState.copied, `My Profile empty copy should not show copied feedback, got ${JSON.stringify(result.emptyState)}`);
  assert(result.emptyState.beforeWidth === result.emptyState.afterWidth && result.emptyState.beforeHeight === result.emptyState.afterHeight, `My Profile empty copy should keep stable dimensions, got ${JSON.stringify(result.emptyState)}`);
  assert(result.restored.profileFirstName === 'Avery' && result.restored.profilePhone === '', `My Profile copy test should restore edited profile before screenshots, got ${JSON.stringify(result.restored)}`);
  assert(!result.horizontalOverflow, 'My Profile copy output introduced horizontal overflow');

  return 'profileCopy:compact/empty';
}

async function verifyMyProfileClearConfirmation(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const button = document.querySelector('#clearMyProfile');
    const status = document.querySelector('#myProfileStatus');
    const score = document.querySelector('#myProfileCompletenessScore');
    const bar = document.querySelector('#myProfileCompletenessBar');
    const sampleProfile = {
      profileFirstName: 'Morgan',
      profileLastName: 'Park',
      profileEmail: 'morgan.park@example.com',
      profilePhone: '+1 415-555-0160',
      shippingAddress: '1 Market St',
      shippingCity: 'San Francisco',
      shippingState: 'CA',
      shippingZipCode: '94105',
      shippingCountry: 'United States',
      billingAddress: '1 Market St',
      billingCity: 'San Francisco',
      billingState: 'CA',
      billingZipCode: '94105',
      billingCountry: 'United States',
      cardIssuer: 'Amex',
      cardNetwork: 'Amex',
      cardLast4: '0005',
      cardExpiry: '10/29',
      billingNote: 'QA confirmation profile'
    };

    myProfile = normalizeMyProfile(sampleProfile);
    updateMyProfileUI();
    setMyProfileStatus('本地已保存', 'saved');
    await chrome.storage.local.set({ formPilotMyProfile: myProfile });

    const beforeRect = button?.getBoundingClientRect();
    const before = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      firstName: document.querySelector('#profileFirstName')?.value || '',
      width: Math.round(beforeRect?.width || 0),
      height: Math.round(beforeRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterFirstStorage = await chrome.storage.local.get('formPilotMyProfile');
    const firstRect = button?.getBoundingClientRect();
    const afterFirst = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      classed: Boolean(button?.classList.contains('confirming')),
      storedFirstName: afterFirstStorage.formPilotMyProfile?.profileFirstName || '',
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(firstRect?.width || 0),
      height: Math.round(firstRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterSecondStorage = await chrome.storage.local.get('formPilotMyProfile');
    const secondRect = button?.getBoundingClientRect();
    const afterSecond = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      classed: Boolean(button?.classList.contains('confirming')),
      storedExists: Boolean(afterSecondStorage.formPilotMyProfile),
      firstName: document.querySelector('#profileFirstName')?.value || '',
      score: (score?.textContent || '').trim(),
      barWidth: bar?.style.width || '',
      statusText: (status?.textContent || '').trim(),
      statusState: status?.dataset.state || '',
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(secondRect?.width || 0),
      height: Math.round(secondRect?.height || 0)
    };

    return {
      before,
      afterFirst,
      afterSecond,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.text === '清空' && result.before.title === '清空我的资料' && result.before.pressed === 'false' && result.before.firstName === 'Morgan', `My Profile clear action should start idle with data, got ${JSON.stringify(result.before)}`);
  assert(result.afterFirst.text === '确认清空' && result.afterFirst.title === '再次点击清空我的资料' && result.afterFirst.label === '再次点击清空我的资料' && result.afterFirst.pressed === 'true' && result.afterFirst.confirming === 'true' && result.afterFirst.classed, `My Profile clear first click should enter confirmation state, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterFirst.storedFirstName === 'Morgan' && result.afterFirst.toast === '再次点击确认清空', `My Profile clear first click should not clear stored data, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterSecond.text === '清空' && result.afterSecond.title === '清空我的资料' && result.afterSecond.pressed === 'false' && result.afterSecond.confirming === 'false' && !result.afterSecond.classed, `My Profile clear second click should restore idle button state, got ${JSON.stringify(result.afterSecond)}`);
  assert(!result.afterSecond.storedExists && result.afterSecond.firstName === '' && result.afterSecond.score === '0%' && result.afterSecond.barWidth === '0%', `My Profile clear confirmation should clear local profile and completeness, got ${JSON.stringify(result.afterSecond)}`);
  assert(result.afterSecond.statusText === '本地已清空' && result.afterSecond.statusState === 'saved' && result.afterSecond.toast === '我的资料已清空', `My Profile clear confirmation should show clean feedback, got ${JSON.stringify(result.afterSecond)}`);
  assert(result.before.width === result.afterFirst.width && result.before.width === result.afterSecond.width && result.before.height === result.afterFirst.height && result.before.height === result.afterSecond.height, `My Profile clear confirmation should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'My Profile clear confirmation introduced horizontal overflow');

  return 'profileClear:confirmed';
}

async function restoreMyProfileScreenshotState(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const screenshotProfile = {
      profileFirstName: 'Avery',
      profileLastName: 'Lee',
      profileEmail: 'avery.lee@example.com',
      profilePhone: '+1 415-555-0184',
      shippingAddress: '500 Mission St',
      shippingCity: 'San Francisco',
      shippingState: 'CA',
      shippingZipCode: '94105',
      shippingCountry: 'United States',
      billingAddress: '500 Mission St',
      billingCity: 'San Francisco',
      billingState: 'CA',
      billingZipCode: '94105',
      billingCountry: 'United States',
      cardIssuer: 'Chase',
      cardNetwork: 'Visa',
      cardLast4: '4242',
      cardExpiry: '12/28',
      billingNote: 'Use office billing address'
    };

    myProfile = normalizeMyProfile(screenshotProfile);
    updateMyProfileUI();
    setMyProfileStatus('本地已保存', 'saved');
    await chrome.storage.local.set({ formPilotMyProfile: myProfile });

    const modal = document.querySelector('#myProfileModal .modal');
    const body = document.querySelector('#myProfileModal .profile-body');
    if (body) body.scrollTop = 0;
    modal?.focus({ preventScroll: true });

    const contactChip = document.querySelector('.profile-completeness-chip[data-profile-group="contact"]');
    const score = document.querySelector('#myProfileCompletenessScore');
    const bar = document.querySelector('#myProfileCompletenessBar');
    const status = document.querySelector('#myProfileStatus');
    const phone = document.querySelector('#profilePhone');
    const stored = await chrome.storage.local.get('formPilotMyProfile');

    return {
      score: (score?.textContent || '').trim(),
      barWidth: bar?.style.width || '',
      contactChip: (contactChip?.textContent || '').replace(/\s+/g, ' ').trim(),
      contactState: contactChip?.dataset.state || '',
      phoneValue: phone?.value || '',
      storedPhone: stored.formPilotMyProfile?.profilePhone || '',
      statusText: (status?.textContent || '').trim(),
      statusState: status?.dataset.state || '',
      activeId: document.activeElement?.id || '',
      bodyScrollTop: body?.scrollTop || 0,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.score === '100%' && result.barWidth === '100%', `My Profile screenshot state should be complete, got ${JSON.stringify(result)}`);
  assert(result.contactChip.includes('4/4') && result.contactState === 'complete', `My Profile screenshot contact chip should be complete, got ${JSON.stringify(result)}`);
  assert(result.phoneValue === '+1 415-555-0184' && result.storedPhone === '+1 415-555-0184', `My Profile screenshot phone should be restored, got ${JSON.stringify(result)}`);
  assert(result.statusText === '本地已保存' && result.statusState === 'saved', `My Profile screenshot status should be clean, got ${JSON.stringify(result)}`);
  assert(result.activeId !== 'profilePhone', `My Profile screenshot should not keep focus on the previously missing phone field, got ${result.activeId}`);
  assert(result.bodyScrollTop === 0, `My Profile screenshot should start at the top of the modal body, got ${result.bodyScrollTop}`);
  assert(!result.horizontalOverflow, 'My Profile screenshot restoration introduced horizontal overflow');

  return 'profileSnapshot:100%';
}

async function verifyProfileSectionToggles(cdp, sessionId) {
  const sections = await evaluate(cdp, sessionId, `(() => {
    const result = [];
    for (const section of document.querySelectorAll('.field-section')) {
      const toggle = section.querySelector('[data-section-toggle]');
      const body = document.getElementById(toggle?.getAttribute('aria-controls') || '');
      result.push({
        name: section.dataset.profileSection || '',
        tagName: toggle?.tagName || '',
        toggleId: toggle?.id || '',
        bodyId: body?.id || '',
        expanded: toggle?.getAttribute('aria-expanded') || '',
        hidden: Boolean(body?.hidden),
        collapsed: section.classList.contains('collapsed')
      });
    }
    return result;
  })()`);

  assert(sections.length === 4, `expected 4 generated-profile sections, found ${sections.length}`);
  for (const section of sections) {
    assert(section.toggleId && section.bodyId, `${section.name || 'unknown'} section is missing toggle/body linkage`);
    assert(section.tagName === 'BUTTON', `${section.name} section toggle should be a native button`);
    assert(section.expanded === 'true', `${section.name} section should default expanded`);
    assert(!section.hidden && !section.collapsed, `${section.name} section body should be visible by default`);
  }

  await evaluate(cdp, sessionId, `document.querySelector('#accountSectionToggle').focus(); true`);
  await evaluate(cdp, sessionId, `document.querySelector('#accountSectionToggle').click(); true`);
  const afterCollapse = await evaluate(cdp, sessionId, `(() => {
    const section = document.querySelector('[data-profile-section="account"]');
    const toggle = document.querySelector('#accountSectionToggle');
    const body = document.querySelector('#accountSectionBody');
    return {
      activeId: document.activeElement?.id || '',
      expanded: toggle?.getAttribute('aria-expanded') || '',
      title: toggle?.title || '',
      hidden: Boolean(body?.hidden),
      collapsed: section?.classList.contains('collapsed') || false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
  assert(afterCollapse.activeId === 'accountSectionToggle', `section toggle should keep focus after collapse, got ${afterCollapse.activeId}`);
  assert(afterCollapse.expanded === 'false', 'account section should set aria-expanded=false after collapse');
  assert(afterCollapse.hidden && afterCollapse.collapsed, 'account section body should hide after collapse');
  assert(afterCollapse.title === '展开账号资料', `account section collapsed title mismatch: ${afterCollapse.title}`);
  assert(!afterCollapse.horizontalOverflow, 'collapsing profile sections introduced horizontal overflow');

  const storedCollapsed = await evaluate(cdp, sessionId, `(async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = await chrome.storage.local.get('formPilotProfileSections');
    return result.formPilotProfileSections || null;
  })()`);
  assert(storedCollapsed?.account === true, `account section collapsed state should persist, got ${JSON.stringify(storedCollapsed)}`);

  await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
  await waitFor(cdp, sessionId, `document.readyState === 'complete' || document.readyState === 'interactive'`, 'popup reload after section collapse');
  await waitFor(cdp, sessionId, `document.querySelector('#firstName')?.value === 'Avery'`, 'cached popup data after section reload');
  const afterReload = await evaluate(cdp, sessionId, `(() => {
    const section = document.querySelector('[data-profile-section="account"]');
    const toggle = document.querySelector('#accountSectionToggle');
    const body = document.querySelector('#accountSectionBody');
    return {
      expanded: toggle?.getAttribute('aria-expanded') || '',
      title: toggle?.title || '',
      hidden: Boolean(body?.hidden),
      collapsed: section?.classList.contains('collapsed') || false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
  assert(afterReload.expanded === 'false' && afterReload.hidden && afterReload.collapsed, `account section should restore collapsed state after reload, got ${JSON.stringify(afterReload)}`);
  assert(afterReload.title === '展开账号资料', `account section reload title mismatch: ${afterReload.title}`);
  assert(!afterReload.horizontalOverflow, 'restored profile section state introduced horizontal overflow');

  await evaluate(cdp, sessionId, `document.querySelector('#accountSectionToggle').click(); true`);
  await evaluate(cdp, sessionId, `new Promise(resolve => setTimeout(resolve, 150))`);
  const afterExpand = await evaluate(cdp, sessionId, `(() => {
    const section = document.querySelector('[data-profile-section="account"]');
    const toggle = document.querySelector('#accountSectionToggle');
    const body = document.querySelector('#accountSectionBody');
    return {
      expanded: toggle?.getAttribute('aria-expanded') || '',
      title: toggle?.title || '',
      hidden: Boolean(body?.hidden),
      collapsed: section?.classList.contains('collapsed') || false
    };
  })()`);
  assert(afterExpand.expanded === 'true', 'account section should set aria-expanded=true after re-expand');
  assert(!afterExpand.hidden && !afterExpand.collapsed, 'account section body should show after re-expand');
  assert(afterExpand.title === '折叠账号资料', `account section expanded title mismatch: ${afterExpand.title}`);

  const storedExpanded = await evaluate(cdp, sessionId, `(async () => {
    const result = await chrome.storage.local.get('formPilotProfileSections');
    return result.formPilotProfileSections || null;
  })()`);
  assert(storedExpanded?.account === false, `account section expanded state should persist, got ${JSON.stringify(storedExpanded)}`);

  const sensitive = await evaluate(cdp, sessionId, `(async () => {
    const toggle = document.querySelector('#toggleSensitive');
    const grid = document.querySelector('#sensitiveGrid');
    const section = document.querySelector('#sensitiveSection');
    const cardNumberCopy = document.querySelector('.sensitive-copy[data-sensitive-field="creditCardNumber"]');
    const ssnCopy = document.querySelector('.sensitive-copy[data-sensitive-field="ssn"]');
    const copyButtons = Array.from(document.querySelectorAll('.sensitive-copy'));
    const measureButtons = () => copyButtons.map(button => {
      const rect = button.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    const before = {
      expanded: toggle?.getAttribute('aria-expanded') || '',
      hidden: Boolean(grid?.hidden),
      collapsed: section?.classList.contains('collapsed') || false,
      text: (toggle?.textContent || '').trim()
    };
    toggle?.click();
    const buttonRects = measureButtons();
    const after = {
      expanded: toggle?.getAttribute('aria-expanded') || '',
      hidden: Boolean(grid?.hidden),
      collapsed: section?.classList.contains('collapsed') || false,
      text: (toggle?.textContent || '').trim(),
      cardTitle: cardNumberCopy?.title || '',
      cardLabel: cardNumberCopy?.getAttribute('aria-label') || '',
      ssnTitle: ssnCopy?.title || '',
      ssnLabel: ssnCopy?.getAttribute('aria-label') || '',
      count: copyButtons.length,
      minWidth: Math.min(...buttonRects.map(rect => rect.width)),
      minHeight: Math.min(...buttonRects.map(rect => rect.height)),
      maxWidth: Math.max(...buttonRects.map(rect => rect.width)),
      maxHeight: Math.max(...buttonRects.map(rect => rect.height)),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__formPilotClipboardWrites.push(String(text));
        }
      }
    });
    currentData.sensitive = { ...(currentData.sensitive || {}), creditCardNumber: '4111111111111111' };
    cardNumberCopy?.click();
    await new Promise(resolve => setTimeout(resolve, 1100));
    const afterCopy = {
      text: (cardNumberCopy?.textContent || '').trim(),
      title: cardNumberCopy?.title || '',
      label: cardNumberCopy?.getAttribute('aria-label') || '',
      writes: window.__formPilotClipboardWrites.slice()
    };
    toggle?.click();
    const restored = {
      expanded: toggle?.getAttribute('aria-expanded') || '',
      hidden: Boolean(grid?.hidden),
      collapsed: section?.classList.contains('collapsed') || false,
      text: (toggle?.textContent || '').trim()
    };
    return { before, after, afterCopy, restored };
  })()`);

  assert(sensitive.before.expanded === 'false' && sensitive.before.hidden && sensitive.before.collapsed, 'sensitive section should default collapsed');
  assert(sensitive.after.expanded === 'true' && !sensitive.after.hidden && !sensitive.after.collapsed && sensitive.after.text === '收起', 'sensitive section should expand with synchronized ARIA state');
  assert(sensitive.after.cardTitle === '复制卡号' && sensitive.after.cardLabel === '复制卡号' && sensitive.after.ssnTitle === '复制SSN' && sensitive.after.ssnLabel === '复制SSN', `sensitive copy buttons should expose field-specific labels, got ${JSON.stringify(sensitive.after)}`);
  assert(sensitive.after.count === 8 && sensitive.after.minWidth === sensitive.after.maxWidth && sensitive.after.minHeight === sensitive.after.maxHeight && sensitive.after.minWidth >= 24 && sensitive.after.minHeight >= 24, `sensitive copy buttons should keep stable dimensions, got ${JSON.stringify(sensitive.after)}`);
  assert(sensitive.afterCopy.text === '⧉' && sensitive.afterCopy.title === '复制卡号' && sensitive.afterCopy.label === '复制卡号' && sensitive.afterCopy.writes[0] === '4111111111111111', `sensitive copy button should restore label after manual copy, got ${JSON.stringify(sensitive.afterCopy)}`);
  assert(!sensitive.after.horizontalOverflow, 'expanding sensitive section introduced horizontal overflow');
  assert(sensitive.restored.expanded === 'false' && sensitive.restored.hidden && sensitive.restored.collapsed && sensitive.restored.text === '展开', 'sensitive section should restore collapsed state');

  return sections.map(section => section.name).join('/');
}

async function verifyMailingAddressCopy(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__formPilotClipboardWrites.push(String(text));
        }
      }
    });

    const btn = document.querySelector('#copyMailingAddress');
    btn?.click();
    await new Promise(resolve => setTimeout(resolve, 80));

    const text = window.__formPilotClipboardWrites.at(-1) || '';
    const rect = btn?.getBoundingClientRect();
    return {
      text,
      buttonText: (btn?.textContent || '').trim(),
      copied: Boolean(btn?.classList.contains('copied')),
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      visible: Boolean(rect && rect.width >= 42 && rect.height >= 24),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  const expected = [
    'Avery Stone',
    '+1 212-555-0198',
    '120 Madison Ave',
    'New York, NY, 10016',
    'United States'
  ].join('\n');

  assert(result.text === expected, `mailing address copy should use postal lines, got ${JSON.stringify(result.text)}`);
  assert(!/Pass1234|411111|123-45-6789/i.test(result.text), `mailing address copy leaked private or sensitive fields: ${result.text}`);
  assert(result.buttonText === '✓' && result.copied && result.toast === '已复制到剪贴板', `mailing address copy should show copied feedback, got ${JSON.stringify(result)}`);
  assert(result.visible, `mailing address copy button should stay visible, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'mailing address copy button introduced horizontal overflow');

  return 'mailing:5 lines';
}

async function verifySectionCopyFeedback(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => window.__formPilotClipboardWrites.push(String(text))
      }
    });

    const btn = document.querySelector('.section-copy-btn[data-copy-section="identity"]');
    const beforeRect = btn?.getBoundingClientRect();
    const before = {
      text: (btn?.textContent || '').trim(),
      title: btn?.title || '',
      label: btn?.getAttribute('aria-label') || '',
      width: Math.round(beforeRect?.width || 0),
      height: Math.round(beforeRect?.height || 0),
      copied: Boolean(btn?.classList.contains('copied'))
    };

    btn?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const duringRect = btn?.getBoundingClientRect();
    const during = {
      text: (btn?.textContent || '').trim(),
      title: btn?.title || '',
      label: btn?.getAttribute('aria-label') || '',
      width: Math.round(duringRect?.width || 0),
      height: Math.round(duringRect?.height || 0),
      copied: Boolean(btn?.classList.contains('copied')),
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      writes: window.__formPilotClipboardWrites || []
    };

    btn?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const repeated = {
      text: (btn?.textContent || '').trim(),
      title: btn?.title || '',
      label: btn?.getAttribute('aria-label') || '',
      copied: Boolean(btn?.classList.contains('copied')),
      writes: window.__formPilotClipboardWrites || [],
      storedOriginalText: btn?.dataset.copyOriginalText || '',
      storedOriginalTitle: btn?.dataset.copyOriginalTitle || '',
      hasTimer: Boolean(btn?.dataset.copyFeedbackTimer)
    };

    await new Promise(resolve => setTimeout(resolve, 1700));
    const restoredRect = btn?.getBoundingClientRect();
    return {
      before,
      during,
      repeated,
      restored: {
        text: (btn?.textContent || '').trim(),
        title: btn?.title || '',
        label: btn?.getAttribute('aria-label') || '',
        width: Math.round(restoredRect?.width || 0),
        height: Math.round(restoredRect?.height || 0),
        copied: Boolean(btn?.classList.contains('copied'))
      },
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.text === '复制' && result.before.title === '复制姓名与基础资料' && result.before.label === '复制姓名与基础资料' && result.before.width === 42 && result.before.height >= 24, `section copy button should start with stable accessible state, got ${JSON.stringify(result.before)}`);
  assert(result.during.text === '✓' && result.during.title === '已复制' && result.during.label === '已复制' && result.during.copied && result.during.toast === '已复制到剪贴板', `section copy button should show copied feedback, got ${JSON.stringify(result.during)}`);
  assert(result.during.width === result.before.width && result.during.height === result.before.height, `section copy feedback should not shift button dimensions, got ${JSON.stringify(result)}`);
  assert(result.during.writes.length >= 1 && result.during.writes[0].includes('名: Avery') && result.during.writes[0].includes('姓: Stone') && !result.during.writes[0].includes('4111111111111111') && !result.during.writes[0].includes('123-45-6789'), `section copy should copy public section fields only, got ${JSON.stringify(result.during.writes)}`);
  assert(result.repeated.text === '✓' && result.repeated.title === '已复制' && result.repeated.label === '已复制' && result.repeated.copied && result.repeated.writes.length === 2, `repeated section copy should keep temporary copied feedback while writing twice, got ${JSON.stringify(result.repeated)}`);
  assert(result.repeated.storedOriginalText === '复制' && result.repeated.storedOriginalTitle === '复制姓名与基础资料' && result.repeated.hasTimer, `repeated copy feedback should preserve the original label while restarting its timer, got ${JSON.stringify(result.repeated)}`);
  assert(result.restored.text === '复制' && result.restored.title === '复制姓名与基础资料' && result.restored.label === '复制姓名与基础资料' && !result.restored.copied && result.restored.width === result.before.width, `section copy button should restore cleanly, got ${JSON.stringify(result.restored)}`);
  assert(!result.horizontalOverflow, 'section copy feedback introduced horizontal overflow');

  return 'sectionCopy:stable/repeat feedback';
}

async function verifyCopyAllFeedback(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__formPilotClipboardWrites.push(String(text));
        }
      }
    });

    currentData.sensitive = {
      creditCardNumber: '4111111111111111',
      creditCardCvv: '123',
      ssn: '123-45-6789',
      monthlySalary: '$9000'
    };

    const btn = document.querySelector('#copyAll');
    const beforeRect = btn?.getBoundingClientRect();
    btn?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const duringRect = btn?.getBoundingClientRect();
    const during = {
      text: (btn?.textContent || '').trim(),
      copied: Boolean(btn?.classList.contains('copied')),
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(duringRect?.width || 0),
      height: Math.round(duringRect?.height || 0)
    };
    await new Promise(resolve => setTimeout(resolve, 1050));
    const afterRect = btn?.getBoundingClientRect();
    return {
      text: window.__formPilotClipboardWrites.at(-1) || '',
      during,
      restoredText: (btn?.textContent || '').trim(),
      restoredCopied: Boolean(btn?.classList.contains('copied')),
      beforeWidth: Math.round(beforeRect?.width || 0),
      afterWidth: Math.round(afterRect?.width || 0),
      beforeHeight: Math.round(beforeRect?.height || 0),
      afterHeight: Math.round(afterRect?.height || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  for (const required of ['姓名: Avery Stone', '邮箱: avery@example.com', '地址: 120 Madison Ave', '国家: United States']) {
    assert(result.text.includes(required), `Copy All should include public profile line ${required}, got ${JSON.stringify(result.text)}`);
  }
  assert(!/411111|123-45-6789|\$9000|CVV|SSN/i.test(result.text), `Copy All leaked sensitive display data: ${result.text}`);
  assert(result.during.text === '✓' && result.during.copied && result.during.toast === '已复制全部信息', `Copy All should show copied feedback, got ${JSON.stringify(result.during)}`);
  assert(result.restoredText === '⧉' && !result.restoredCopied, `Copy All should restore icon feedback, got ${JSON.stringify(result)}`);
  assert(result.beforeWidth === result.afterWidth && result.beforeHeight === result.afterHeight && result.beforeWidth >= 34 && result.beforeHeight >= 34, `Copy All feedback should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'Copy All feedback introduced horizontal overflow');

  return 'copyAll:public feedback';
}

async function verifyCopyAllEmptyState(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__formPilotClipboardWrites.push(String(text));
        }
      }
    });

    const btn = document.querySelector('#copyAll');
    const beforeRect = btn?.getBoundingClientRect();
    const originalData = { ...currentData, sensitive: { ...(currentData.sensitive || {}) } };
    currentData = {};
    FIELD_NAMES.forEach(name => {
      const field = elements.fields[name];
      if (!field) return;
      field.value = '';
    });

    btn?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterRect = btn?.getBoundingClientRect();
    const emptyState = {
      writes: window.__formPilotClipboardWrites.length,
      text: (btn?.textContent || '').trim(),
      copied: Boolean(btn?.classList.contains('copied')),
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      beforeWidth: Math.round(beforeRect?.width || 0),
      afterWidth: Math.round(afterRect?.width || 0),
      beforeHeight: Math.round(beforeRect?.height || 0),
      afterHeight: Math.round(afterRect?.height || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    currentData = originalData;
    updateUI();
    return emptyState;
  })()`);

  assert(result.writes === 0, `Copy All empty state should not write to clipboard, got ${JSON.stringify(result)}`);
  assert(result.text === '⧉' && !result.copied, `Copy All empty state should not show copied feedback, got ${JSON.stringify(result)}`);
  assert(result.toast === '没有可复制的内容', `Copy All empty state should show a useful toast, got ${result.toast}`);
  assert(result.beforeWidth === result.afterWidth && result.beforeHeight === result.afterHeight, `Copy All empty state should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'Copy All empty state introduced horizontal overflow');

  return 'copyAllEmpty:guarded';
}

async function verifyInboxVerificationCodeCopy(cdp, sessionId) {
  const prepared = await evaluate(cdp, sessionId, `(() => {
    window.__formPilotClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__formPilotClipboardWrites.push(String(text));
        }
      }
    });

    renderInbox([
      {
        subject: 'Your verification code is 492810',
        intro: 'Use 492810 to finish sign in.',
        from: { address: 'login@example.test' }
      },
      {
        subject: 'Welcome',
        intro: 'No code here.',
        from: { address: 'hello@example.test' }
      }
    ]);

    document.querySelector('#inboxGroup')?.classList.remove('is-hidden');

    const button = document.querySelector('.verification-code');
    button?.focus();
    const rect = button?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    return {
      tag: button?.tagName || '',
      type: button?.getAttribute('type') || '',
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      focused: document.activeElement === button,
      focusShadow: style?.boxShadow || '',
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      codeCount: document.querySelectorAll('.verification-code').length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  await dispatchKey(cdp, sessionId, 'Enter');
  await sleep(120);

  const copied = await evaluate(cdp, sessionId, `(() => ({
    writes: window.__formPilotClipboardWrites || [],
    toast: (document.querySelector('#toast')?.textContent || '').trim(),
    activeTag: document.activeElement?.tagName || '',
    activeClass: document.activeElement?.className || ''
  }))()`);

  assert(prepared.tag === 'BUTTON' && prepared.type === 'button' && prepared.text === '492810', `verification code should render as a compact button, got ${JSON.stringify(prepared)}`);
  assert(prepared.title === '复制验证码' && prepared.label === '复制验证码 492810', `verification code button should expose accessible copy labels, got ${JSON.stringify(prepared)}`);
  assert(prepared.focused, `verification code button should be focusable before keyboard activation, got ${JSON.stringify(prepared)}`);
  assert(prepared.width >= 44 && prepared.height >= 24 && prepared.codeCount === 1, `verification code button should keep stable dimensions and only render detected codes, got ${JSON.stringify(prepared)}`);
  assert(!prepared.horizontalOverflow, 'verification code button introduced horizontal overflow');
  assert(copied.writes.length === 1 && copied.writes[0] === '492810' && copied.toast === '验证码已复制', `verification code button should copy through keyboard activation, got ${JSON.stringify(copied)}`);
  assert(copied.activeTag === 'BUTTON' && String(copied.activeClass).includes('verification-code'), `verification code button should keep focus after copy, got ${JSON.stringify(copied)}`);

  return 'inboxCode:keyboard copy';
}

async function verifyInboxErrorState(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    document.querySelector('#inboxGroup')?.classList.remove('is-hidden');
    renderInboxError(new Error('Simulated Mail.tm outage'));

    const state = document.querySelector('.inbox-state[data-state="error"]');
    const list = document.querySelector('#inboxList');
    const rect = state?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    const style = state ? getComputedStyle(state) : null;
    const result = {
      title: (state?.querySelector('strong')?.textContent || '').trim(),
      detail: (state?.querySelector('span')?.textContent || '').trim(),
      role: state?.getAttribute('role') || '',
      live: state?.getAttribute('aria-live') || '',
      display: style?.display || '',
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      listWidth: Math.round(listRect?.width || 0),
      visible: Boolean(rect && rect.width > 180 && rect.height >= 48),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    renderInbox([
      {
        subject: 'Your verification code is 492810',
        intro: 'Use 492810 to finish sign in.',
        from: { address: 'login@example.test' }
      },
      {
        subject: 'Welcome',
        intro: 'No code here.',
        from: { address: 'hello@example.test' }
      }
    ]);

    return result;
  })()`);

  assert(result.title === '收件箱刷新失败', `Mail.tm failure should render an inline error title, got ${JSON.stringify(result)}`);
  assert(result.detail.includes('Simulated Mail.tm outage'), `Mail.tm failure should keep the useful error detail, got ${JSON.stringify(result)}`);
  assert(result.role === 'alert' && result.live === 'polite', `Mail.tm failure should expose an accessible live error state, got ${JSON.stringify(result)}`);
  assert(result.display === 'flex' && result.visible && result.width === result.listWidth, `Mail.tm failure should render inside the inbox column without layout shift, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, `Mail.tm failure state introduced horizontal overflow, got ${JSON.stringify(result)}`);

  return 'inboxError:visible';
}

async function verifyTempMailRegistrationRecovery(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const originalRegister = window.mailTM?.register;
    const originalGenerateEmail = window.generators?.generateEmail;
    const emailSelect = document.querySelector('#emailDomainType');
    const emailInput = document.querySelector('#email');
    const inboxGroup = document.querySelector('#inboxGroup');
    const inboxList = document.querySelector('#inboxList');

    currentData.username = 'mailfail';
    currentData.password = 'MailfailA1!';
    if (emailSelect) emailSelect.value = 'temp';
    if (window.mailTM) {
      window.mailTM.register = async () => {
        throw new Error('Mail.tm simulated registration outage');
      };
    }
    if (window.generators) {
      window.generators.generateEmail = () => 'mailfail@example.com';
    }

    await regenerateEmail();
    await new Promise(resolve => setTimeout(resolve, 80));

    const state = document.querySelector('.inbox-state[data-state="error"]');
    const rect = state?.getBoundingClientRect();
    const result = {
      email: emailInput?.value || '',
      currentEmail: currentData.email || '',
      inboxHidden: Boolean(inboxGroup?.classList.contains('is-hidden')),
      title: (state?.querySelector('strong')?.textContent || '').trim(),
      detail: (state?.querySelector('span')?.textContent || '').trim(),
      action: (state?.querySelector('[data-role="recovery"]')?.textContent || '').trim(),
      role: state?.getAttribute('role') || '',
      live: state?.getAttribute('aria-live') || '',
      visible: Boolean(rect && rect.width > 180 && rect.height >= 48),
      listWidth: Math.round(inboxList?.getBoundingClientRect().width || 0),
      stateWidth: Math.round(rect?.width || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    if (window.mailTM) window.mailTM.register = originalRegister;
    if (window.generators) window.generators.generateEmail = originalGenerateEmail;
    return result;
  })()`);

  assert(result.email === 'mailfail@example.com' && result.currentEmail === 'mailfail@example.com', `Temp mail registration failure should keep fallback email usable, got ${JSON.stringify(result)}`);
  assert(result.inboxHidden === false, `Temp mail registration failure should keep inbox recovery visible, got ${JSON.stringify(result)}`);
  assert(result.title === '临时邮箱注册失败', `Temp mail registration failure should render a specific inline title, got ${JSON.stringify(result)}`);
  assert(result.detail.includes('Mail.tm simulated registration outage') && result.detail.includes('已改用普通邮箱'), `Temp mail registration failure should explain cause and fallback, got ${JSON.stringify(result)}`);
  assert(result.action.includes('稍后重新生成') || result.action.includes('刷新'), `Temp mail registration failure should provide a recovery path, got ${JSON.stringify(result)}`);
  assert(result.role === 'alert' && result.live === 'polite', `Temp mail registration failure should expose an accessible live state, got ${JSON.stringify(result)}`);
  assert(result.visible && result.stateWidth === result.listWidth && !result.horizontalOverflow, `Temp mail registration recovery should stay visible without overflow, got ${JSON.stringify(result)}`);

  return 'tempMailRecovery:fallback visible';
}

async function verifyAddressServiceRecoveryState(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const addressToggle = document.querySelector('#useAddressApiToggle');
    const service = document.querySelector('#addressServiceState');
    const originalGenerateAddressAsync = window.generators?.generateAddressAsync;
    const originalData = JSON.parse(JSON.stringify(currentData || {}));
    const originalIpData = JSON.parse(JSON.stringify(ipData || {}));
    const originalSource = addressEnhancementState;

    await chrome.storage.local.set({ formPilotAddressApiEnabled: true });
    if (addressToggle) addressToggle.checked = true;
    if (window.generators) {
      window.generators.generateAddressAsync = async () => {
        throw new Error('Simulated map provider outage');
      };
    }

    currentData = {
      firstName: 'Avery',
      lastName: 'Stone',
      gender: 'female',
      birthday: '1992-04-18',
      username: 'avery.stone',
      email: 'avery@example.com',
      password: 'Pass1234!',
      phone: '+1 212-555-0198',
      address: '120 Madison Ave',
      city: 'New York',
      state: 'NY',
      zipCode: '10016',
      country: 'United States'
    };
    ipData = { country: 'United States', city: 'New York', region: 'NY' };
    updateUI();

    await handleRegenerateAll();
    await new Promise(resolve => setTimeout(resolve, 120));

    const rect = service?.getBoundingClientRect();
    const state = {
      exists: Boolean(service),
      dataset: service?.dataset.state || '',
      title: (service?.querySelector('strong')?.textContent || '').trim(),
      detail: (service?.querySelector('span')?.textContent || '').trim(),
      role: service?.getAttribute('role') || '',
      live: service?.getAttribute('aria-live') || '',
      sourceText: (document.querySelector('#profileOverviewSource')?.textContent || '').trim(),
      readinessText: (document.querySelector('#fillReadyAddress')?.textContent || '').trim(),
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      visible: Boolean(rect && rect.width > 260 && rect.height >= 42),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    currentData = originalData;
    ipData = originalIpData;
    addressEnhancementState = originalSource;
    if (window.generators) window.generators.generateAddressAsync = originalGenerateAddressAsync;
    updateUI();
    await saveDataToStorage();
    return state;
  })()`);

  assert(result.exists, `Address service recovery state should exist in the popup, got ${JSON.stringify(result)}`);
  assert(result.dataset === 'fallback', `Address service failure should render fallback state, got ${JSON.stringify(result)}`);
  assert(result.title === '地址服务已降级', `Address service failure should use clear inline fallback title, got ${JSON.stringify(result)}`);
  assert(result.detail.includes('本地地址') && result.detail.includes('稍后'), `Address service failure should explain fallback and recovery, got ${JSON.stringify(result)}`);
  assert(result.role === 'status' && result.live === 'polite', `Address service state should be accessible live status, got ${JSON.stringify(result)}`);
  assert(result.sourceText.includes('本地降级') && result.readinessText.includes('本地降级'), `Address service fallback should stay aligned with source/readiness pills, got ${JSON.stringify(result)}`);
  assert(result.visible && !result.horizontalOverflow, `Address service recovery state should be visible without overflow, got ${JSON.stringify(result)}`);

  return 'addressRecovery:fallback visible';
}

async function verifyFillResultFeedback(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const fillResult = {
      filledCount: 7,
      results: {
        firstName: 'filled',
        lastName: 'filled',
        email: 'skipped filled',
        cardNumber: 'skipped sensitive',
        state: 'not found',
        country: 'no matching option'
      }
    };
    const toast = formatFillResultToast(fillResult, 'AI');
    const summary = buildFillHistorySummary(fillResult, { fillEmptyOnly: true }, 'AI');
    const historyText = formatHistoryFillSummary(summary);
    const lastFill = document.querySelector('#lastFillResult');
    const beforeHidden = Boolean(lastFill?.hidden);
    renderLastFillResult(summary);
    const metricNodes = Array.from(document.querySelectorAll('#lastFillFilled, #lastFillSkipped, #lastFillMissed'));
    const metricRects = metricNodes.map(node => node.getBoundingClientRect());
    const lastFillRect = lastFill?.getBoundingClientRect();
    const lastFillState = {
      hidden: Boolean(lastFill?.hidden),
      state: lastFill?.dataset.state || '',
      title: (document.querySelector('#lastFillResultTitle')?.textContent || '').trim(),
      detail: (document.querySelector('#lastFillResultDetail')?.textContent || '').trim(),
      metrics: metricNodes.map(node => ({
        text: (node.textContent || '').trim(),
        state: node.dataset.state || '',
        label: node.getAttribute('aria-label') || ''
      })),
      visible: Boolean(lastFillRect && lastFillRect.width > 260 && lastFillRect.height >= 40),
      stableMetrics: metricRects.every(rect => Math.round(rect.width) >= 48 && Math.round(rect.height) >= 22)
    };
    const original = elements.historyList.innerHTML;
    openModal(elements.historyModal);
    renderHistoryList([{ id: 101, timestamp: new Date().toISOString(), data: currentData, fillSummary: summary }]);
    const fillNode = document.querySelector('.history-item-fill');
    const rect = fillNode?.getBoundingClientRect();
    const rendered = (fillNode?.textContent || '').trim();
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    elements.historyList.innerHTML = original;
    closeModal(elements.historyModal);
    return {
      toast,
      summary,
      historyText,
      beforeHidden,
      lastFillState,
      rendered,
      visible: Boolean(rect && rect.width > 80 && rect.height >= 10),
      horizontalOverflow: overflow
    };
  })()`);

  assert(result.toast === 'AI 填 7 · 跳过 2 · 未命中 2', `fill result toast should summarize filled/skipped/missed counts, got ${result.toast}`);
  assert(result.summary.filled === 7 && result.summary.skipped === 2 && result.summary.skipFilled === 1 && result.summary.skipSensitive === 1 && result.summary.skipEmpty === 0 && result.summary.skipOther === 0 && result.summary.missed === 2 && result.summary.emptyOnly === true && result.summary.mode === 'AI', `fill result summary mismatch: ${JSON.stringify(result.summary)}`);
  assert(result.historyText === 'AI · 填 7 · 跳过 2（已有 1 · 敏感 1） · 未命中 2', `history summary text mismatch: ${result.historyText}`);
  assert(result.beforeHidden === true, `last-fill result should start hidden before a fill summary, got ${JSON.stringify(result)}`);
  assert(result.lastFillState.visible && result.lastFillState.state === 'warning' && result.lastFillState.title === 'AI 填表完成' && result.lastFillState.detail === result.historyText, `last-fill result should render visible AI summary, got ${JSON.stringify(result.lastFillState)}`);
  assert(JSON.stringify(result.lastFillState.metrics.map(metric => metric.text)) === JSON.stringify(['填 7', '跳过 2', '未命中 2']), `last-fill result metric text mismatch: ${JSON.stringify(result.lastFillState.metrics)}`);
  assert(result.lastFillState.metrics.every(metric => metric.label.includes('字段')) && result.lastFillState.metrics.some(metric => metric.label.includes('已有 1') && metric.label.includes('敏感 1')) && result.lastFillState.stableMetrics, `last-fill result metrics should keep reason labels and stable dimensions, got ${JSON.stringify(result.lastFillState)}`);
  assert(result.rendered === result.historyText && result.visible, `history summary should render visibly, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'fill result history summary introduced horizontal overflow');

  return 'fillResult:7/2/2; lastFill:AI/visible';
}

async function verifyFillButtonLoadingState(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const btn = document.querySelector('#fillForm');
    const guarded = {
      copyAll: document.querySelector('#copyAll'),
      regenerate: document.querySelector('#regenerateAll'),
      useAI: document.querySelector('#useAIToggle'),
      emptyOnly: document.querySelector('#fillEmptyOnlyToggle')
    };
    const guardedBefore = Object.fromEntries(Object.entries(guarded).map(([key, control]) => [key, {
      disabled: Boolean(control?.disabled),
      ariaDisabled: control?.getAttribute('aria-disabled')
    }]));
    const beforeRect = btn?.getBoundingClientRect();
    const loading = showLoading(btn, '填写中...');
    const dock = guardCommandDockDuringFill();
    const busyRect = btn?.getBoundingClientRect();
    const busy = {
      text: (btn?.textContent || '').trim(),
      disabled: Boolean(btn?.disabled),
      classed: Boolean(btn?.classList.contains('loading')),
      ariaBusy: btn?.getAttribute('aria-busy') || '',
      width: Math.round(busyRect?.width || 0),
      height: Math.round(busyRect?.height || 0)
    };
    const guardedBusy = Object.fromEntries(Object.entries(guarded).map(([key, control]) => [key, {
      disabled: Boolean(control?.disabled),
      ariaDisabled: control?.getAttribute('aria-disabled') || ''
    }]));
    dock.restore();
    loading.restore();
    const afterRect = btn?.getBoundingClientRect();
    const guardedRestored = Object.fromEntries(Object.entries(guarded).map(([key, control]) => [key, {
      disabled: Boolean(control?.disabled),
      ariaDisabled: control?.getAttribute('aria-disabled')
    }]));
    return {
      busy,
      guardedBefore,
      guardedBusy,
      guardedRestored,
      restoredText: (btn?.textContent || '').trim(),
      restoredDisabled: Boolean(btn?.disabled),
      restoredClassed: Boolean(btn?.classList.contains('loading')),
      restoredAriaBusy: btn?.getAttribute('aria-busy'),
      beforeWidth: Math.round(beforeRect?.width || 0),
      afterWidth: Math.round(afterRect?.width || 0),
      beforeHeight: Math.round(beforeRect?.height || 0),
      afterHeight: Math.round(afterRect?.height || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.busy.text === '填写中...' && result.busy.disabled && result.busy.classed && result.busy.ariaBusy === 'true', `Fill button should expose a busy loading state, got ${JSON.stringify(result.busy)}`);
  for (const [name, state] of Object.entries(result.guardedBusy)) {
    assert(state.disabled === true && state.ariaDisabled === 'true', `command dock ${name} should be disabled while Fill is busy, got ${JSON.stringify(state)}`);
  }
  for (const [name, state] of Object.entries(result.guardedRestored)) {
    const before = result.guardedBefore[name];
    assert(state.disabled === before.disabled && state.ariaDisabled === before.ariaDisabled, `command dock ${name} should restore its previous disabled state after Fill busy state, got ${JSON.stringify({ before, state })}`);
  }
  assert(result.restoredText === '填写表单' && !result.restoredDisabled && !result.restoredClassed && result.restoredAriaBusy === null, `Fill button loading state should restore cleanly, got ${JSON.stringify(result)}`);
  assert(result.beforeWidth === result.afterWidth && result.beforeHeight === result.afterHeight && result.beforeWidth >= 120 && result.beforeHeight >= 36, `Fill button loading state should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'Fill button loading state introduced horizontal overflow');

  return 'fillBusy:guarded/restored';
}

async function verifyPublicStorageBoundary(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    currentData.sensitive = {
      creditCardNumber: '4111111111111111',
      creditCardCvv: '123',
      ssn: '123-45-6789',
      monthlySalary: '$9000'
    };

    const migrated = await loadDataFromStorage();
    await loadArchiveList();
    await saveDataToStorage();
    await saveToHistory({ filled: 1, skipped: 0, missed: 0, total: 1, mode: 'generated' });
    document.querySelector('#archiveName').value = 'Boundary Test';
    await saveArchive();
    const stored = await chrome.storage.local.get(['formPilotCachedData', 'formPilotHistory', 'formPilotArchives']);
    const history = stored.formPilotHistory || [];
    const archives = stored.formPilotArchives || [];
    return {
      migratedSensitive: Boolean(migrated?.currentData?.sensitive),
      cachedSensitive: Boolean(stored.formPilotCachedData?.currentData?.sensitive),
      historySensitive: history.some(item => item?.data?.sensitive),
      archiveSensitive: archives.some(item => item?.data?.sensitive),
      historyCount: history.length,
      archiveCount: archives.length,
      currentSensitiveVisible: Boolean(currentData.sensitive?.creditCardNumber),
      cachedKeys: Object.keys(stored.formPilotCachedData?.currentData || {}).sort(),
      historyKeys: Object.keys(history[0]?.data || {}).sort(),
      archiveKeys: Object.keys(archives[0]?.data || {}).sort(),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(!result.migratedSensitive, `cached legacy data should be migrated to public-only data, got ${JSON.stringify(result)}`);
  assert(!result.cachedSensitive, `cached generated data must not persist sensitive fields, got ${JSON.stringify(result)}`);
  assert(!result.historySensitive && result.historyCount >= 1, `history must not persist sensitive fields, got ${JSON.stringify(result)}`);
  assert(!result.archiveSensitive && result.archiveCount >= 1, `archives must not persist sensitive fields, got ${JSON.stringify(result)}`);
  assert(result.currentSensitiveVisible, 'current in-memory sensitive display data should remain available for manual-copy UI while popup is open');
  assert(!result.cachedKeys.includes('sensitive') && !result.historyKeys.includes('sensitive') && !result.archiveKeys.includes('sensitive'), `public storage keys should exclude sensitive, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'public storage boundary check introduced horizontal overflow');

  return 'publicStorage:cache/history/archive';
}

async function verifyArchiveDeleteConfirmation(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openSettings')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#settingsModal')?.classList.contains('show')`, 'settings modal for archive delete confirmation check');
  await sleep(250);

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#settingsModal');
    await chrome.storage.local.set({
      formPilotArchives: [{
        name: 'Delete Guard',
        timestamp: Date.now(),
        data: {
          firstName: 'Avery',
          lastName: 'Stone',
          email: 'avery@example.com',
          phone: '+1 212-555-0198',
          address: '120 Madison Ave',
          city: 'New York',
          state: 'NY',
          zipCode: '10016',
          country: 'United States'
        }
      }]
    });
    await loadArchiveList();
    const button = document.querySelector('.archive-item-actions .delete-btn');
    const beforeRect = button?.getBoundingClientRect();
    const before = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      count: document.querySelectorAll('.archive-item').length,
      width: Math.round(beforeRect?.width || 0),
      height: Math.round(beforeRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterFirstStorage = await chrome.storage.local.get('formPilotArchives');
    const firstRect = button?.getBoundingClientRect();
    const afterFirst = {
      text: (button?.textContent || '').trim(),
      title: button?.title || '',
      label: button?.getAttribute('aria-label') || '',
      pressed: button?.getAttribute('aria-pressed') || '',
      confirming: button?.dataset.confirming || '',
      classed: Boolean(button?.classList.contains('confirming')),
      storedCount: (afterFirstStorage.formPilotArchives || []).length,
      count: document.querySelectorAll('.archive-item').length,
      toast: (document.querySelector('#toast')?.textContent || '').trim(),
      width: Math.round(firstRect?.width || 0),
      height: Math.round(firstRect?.height || 0)
    };

    button?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterSecondStorage = await chrome.storage.local.get('formPilotArchives');
    const afterSecond = {
      storedCount: (afterSecondStorage.formPilotArchives || []).length,
      count: document.querySelectorAll('.archive-item').length,
      emptyText: (document.querySelector('.archive-empty')?.textContent || '').trim(),
      toast: (document.querySelector('#toast')?.textContent || '').trim()
    };

    closeModal(modal);
    return {
      before,
      afterFirst,
      afterSecond,
      modalClosed: !modal?.classList.contains('show'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.text === '删除' && result.before.title === '删除存档' && result.before.label === '删除存档' && result.before.pressed === 'false' && result.before.confirming === 'false' && result.before.count === 1, `Archive delete action should start idle, got ${JSON.stringify(result.before)}`);
  assert(result.afterFirst.text === '确认' && result.afterFirst.title === '再次点击删除存档' && result.afterFirst.label === '再次点击删除存档' && result.afterFirst.pressed === 'true' && result.afterFirst.confirming === 'true' && result.afterFirst.classed, `Archive delete first click should enter confirmation state, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterFirst.storedCount === 1 && result.afterFirst.count === 1 && result.afterFirst.toast === '再次点击确认删除存档', `Archive delete first click should not delete storage, got ${JSON.stringify(result.afterFirst)}`);
  assert(result.afterSecond.storedCount === 0 && result.afterSecond.count === 0 && result.afterSecond.emptyText === '暂无存档' && result.afterSecond.toast.includes('已删除'), `Archive delete second click should delete and render empty state, got ${JSON.stringify(result.afterSecond)}`);
  assert(result.before.width === result.afterFirst.width && result.before.height === result.afterFirst.height && result.before.width >= 38, `Archive delete confirmation should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(result.modalClosed, 'Archive delete confirmation check should close the settings modal before later popup QA');
  assert(!result.horizontalOverflow, 'Archive delete confirmation introduced horizontal overflow');

  return 'archiveDelete:confirmed';
}

async function verifyArchiveSearchContract(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('#openSettings')?.click(); true`);
  await waitFor(cdp, sessionId, `document.querySelector('#settingsModal')?.classList.contains('show')`, 'settings modal for archive search check');
  await sleep(250);

  const result = await evaluate(cdp, sessionId, `(async () => {
    const modal = document.querySelector('#settingsModal');
    const search = document.querySelector('#archiveSearch');
    const info = document.querySelector('#archiveInfo');
    const archives = [
      {
        name: 'US Checkout',
        timestamp: Date.now(),
        data: {
          firstName: 'Avery',
          lastName: 'Stone',
          email: 'avery@example.com',
          phone: '+1 212-555-0198',
          address: '120 Madison Ave',
          city: 'New York',
          state: 'NY',
          zipCode: '10016',
          country: 'United States'
        }
      },
      {
        name: 'Tokyo Buyer',
        timestamp: Date.now(),
        data: {
          firstName: 'Yuki',
          lastName: 'Tanaka',
          email: 'yuki@example.jp',
          phone: '080-3928-4719',
          address: 'Ginza 1-1',
          city: 'Tokyo',
          state: 'Tokyo',
          zipCode: '100-0001',
          country: 'Japan'
        }
      },
      {
        name: 'Canada QA',
        timestamp: Date.now(),
        data: {
          firstName: 'Mila',
          lastName: 'Chen',
          email: 'mila@example.ca',
          phone: '+1 604-555-0198',
          address: '22 Robson St',
          city: 'Vancouver',
          state: 'BC',
          zipCode: 'V6B 2A7',
          country: 'Canada'
        }
      }
    ];
    await chrome.storage.local.set({ formPilotArchives: archives });
    await loadArchiveList();

    const initial = {
      count: document.querySelectorAll('.archive-item').length,
      info: (info?.textContent || '').trim(),
      searchLabel: document.querySelector('label[for="archiveSearch"]')?.textContent.trim() || '',
      placeholder: search?.getAttribute('placeholder') || '',
      activeInside: modal?.contains(document.activeElement) || false
    };

    const firstDelete = document.querySelector('.archive-item-actions .delete-btn');
    firstDelete?.click();
    search.value = 'tokyo';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const tokyoButton = document.querySelector('.archive-item-actions .delete-btn');
    const tokyoLoad = document.querySelector('.archive-item-actions .load-btn');
    const tokyo = {
      count: document.querySelectorAll('.archive-item').length,
      info: (info?.textContent || '').trim(),
      itemText: (document.querySelector('.archive-item')?.textContent || '').trim(),
      deleteText: (tokyoButton?.textContent || '').trim(),
      deletePressed: tokyoButton?.getAttribute('aria-pressed') || '',
      deleteConfirming: tokyoButton?.dataset.confirming || '',
      originalIndex: tokyoLoad?.dataset.index || ''
    };

    search.value = 'missing archive';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const none = {
      count: document.querySelectorAll('.archive-item').length,
      info: (info?.textContent || '').trim(),
      empty: (document.querySelector('.archive-empty')?.textContent || '').trim()
    };

    search.value = 'tokyo';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.archive-item-actions .load-btn')?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const loaded = {
      firstName: document.querySelector('#firstName')?.value || '',
      lastName: document.querySelector('#lastName')?.value || '',
      country: document.querySelector('#country')?.value || '',
      modalClosed: !modal?.classList.contains('show'),
      toast: (document.querySelector('#toast')?.textContent || '').trim()
    };

    return {
      initial,
      tokyo,
      none,
      loaded,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.initial.count === 3 && result.initial.info === '已保存 3 个存档', `Archive search should start with full archive list, got ${JSON.stringify(result.initial)}`);
  assert(result.initial.searchLabel === '搜索存档' && result.initial.placeholder.includes('名称') && result.initial.activeInside, `Archive search control should be labelled and stay inside the modal focus scope, got ${JSON.stringify(result.initial)}`);
  assert(result.tokyo.count === 1 && result.tokyo.info === '显示 1 / 3 个' && result.tokyo.itemText.includes('Tokyo Buyer'), `Archive search should filter by name and profile fields, got ${JSON.stringify(result.tokyo)}`);
  assert(result.tokyo.deleteText === '删除' && result.tokyo.deletePressed === 'false' && result.tokyo.deleteConfirming === 'false', `Archive search should reset pending delete confirmation while filtering, got ${JSON.stringify(result.tokyo)}`);
  assert(result.tokyo.originalIndex === '1', `filtered archive load should preserve original index, got ${JSON.stringify(result.tokyo)}`);
  assert(result.none.count === 0 && result.none.info === '显示 0 / 3 个' && result.none.empty === '没有匹配的存档', `Archive search should show a filtered empty state, got ${JSON.stringify(result.none)}`);
  assert(result.loaded.firstName === 'Yuki' && result.loaded.lastName === 'Tanaka' && result.loaded.country === 'Japan' && result.loaded.modalClosed && result.loaded.toast.includes('Tokyo Buyer'), `Archive search load should use original index and close settings, got ${JSON.stringify(result.loaded)}`);
  assert(!result.horizontalOverflow, 'Archive search introduced horizontal overflow');

  return 'archiveSearch:3/1/0';
}

async function verifyHeaderWorkbenchPolish(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const header = document.querySelector('.header');
    const mark = document.querySelector('.brand-mark');
    const title = document.querySelector('.header h1');
    const tagline = document.querySelector('.tagline');
    const actions = document.querySelector('.header-actions');
    const ipWrap = document.querySelector('.ip-info-wrapper');
    const ipInfo = document.querySelector('#ipInfo');
    const refresh = document.querySelector('#ipRefresh');
    const headerRect = header?.getBoundingClientRect();
    const markRect = mark?.getBoundingClientRect();
    const ipRect = ipWrap?.getBoundingClientRect();
    const refreshRect = refresh?.getBoundingClientRect();
    const headerStyle = header ? getComputedStyle(header) : null;
    const markStyle = mark ? getComputedStyle(mark) : null;
    const ipStyle = ipWrap ? getComputedStyle(ipWrap) : null;
    return {
      title: (title?.textContent || '').trim(),
      tagline: (tagline?.textContent || '').trim(),
      actionCount: actions?.children.length || 0,
      headerWidth: Math.round(headerRect?.width || 0),
      headerHeight: Math.round(headerRect?.height || 0),
      borderRadius: parseFloat(headerStyle?.borderRadius || '0'),
      boxShadow: headerStyle?.boxShadow || '',
      backdropFilter: headerStyle?.backdropFilter || headerStyle?.webkitBackdropFilter || '',
      markText: (mark?.textContent || '').trim(),
      markWidth: Math.round(markRect?.width || 0),
      markBorderColor: markStyle?.borderColor || '',
      ipLabel: (document.querySelector('.ip-info-label')?.textContent || '').trim(),
      ipText: (ipInfo?.textContent || '').replace(/\s+/g, ' ').trim(),
      ipWidth: Math.round(ipRect?.width || 0),
      ipBackground: ipStyle?.backgroundColor || '',
      refreshSize: Math.round(refreshRect?.width || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.title === 'FormPilot' && result.tagline === '表单测试工作台', `header product copy should stay compact, got ${JSON.stringify(result)}`);
  assert(result.actionCount === 4, `header should expose four compact actions, got ${result.actionCount}`);
  assert(result.headerWidth >= 390 && result.headerHeight >= 86, `header workbench should use a stable panel surface, got ${JSON.stringify(result)}`);
  assert(result.borderRadius >= 14 && result.boxShadow !== 'none', `header should keep rounded elevated treatment, got ${JSON.stringify(result)}`);
  assert(String(result.backdropFilter).includes('blur'), `header should keep translucent blur, got ${result.backdropFilter}`);
  assert(result.markText === 'FP' && result.markWidth === 34 && result.markBorderColor, `brand mark should render crisply, got ${JSON.stringify(result)}`);
  assert(result.ipLabel === '当前位置' && result.ipText.includes('New York') && result.ipWidth >= 360, `location status row should be readable, got ${JSON.stringify(result)}`);
  assert(result.refreshSize === 28, `IP refresh control should keep a stable tap target, got ${result.refreshSize}`);
  assert(!result.horizontalOverflow, 'header workbench introduced horizontal overflow');

  return `header:${result.headerHeight}px`;
}

async function verifyCommandDockContract(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const actions = document.querySelector('.actions');
    const fill = document.querySelector('#fillForm');
    const regenerate = document.querySelector('#regenerateAll');
    const copyAll = document.querySelector('#copyAll');
    const before = actions?.getBoundingClientRect();
    window.scrollTo(0, document.documentElement.scrollHeight);
    const after = actions?.getBoundingClientRect();
    const fillRect = fill?.getBoundingClientRect();
    const regenerateRect = regenerate?.getBoundingClientRect();
    const copyRect = copyAll?.getBoundingClientRect();
    const style = actions ? getComputedStyle(actions) : null;
    const toggles = Array.from(document.querySelectorAll('.actions .ai-toggle:not(.is-hidden)')).map(wrapper => {
      const input = wrapper.querySelector('input[type="checkbox"]');
      const label = wrapper.querySelector('.ai-toggle-label');
      const state = wrapper.querySelector('.ai-toggle-state');
      const rect = wrapper.getBoundingClientRect();
      return {
        id: wrapper.id || '',
        checked: Boolean(input?.checked),
        label: (label?.textContent || '').trim(),
        stateText: (state?.textContent || '').trim(),
        statePseudo: state ? getComputedStyle(state, '::before').content.replace(/^['"]|['"]$/g, '') : '',
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      };
    });
    return {
      position: style?.position || '',
      top: Math.round(after?.top || -1),
      height: Math.round(after?.height || 0),
      zIndex: Number(style?.zIndex || 0),
      backdropFilter: style?.backdropFilter || style?.webkitBackdropFilter || '',
      fillVisible: Boolean(fillRect && fillRect.top >= 0 && fillRect.bottom <= window.innerHeight && fillRect.width >= 120),
      regenerateVisible: Boolean(regenerateRect && regenerateRect.top >= 0 && regenerateRect.bottom <= window.innerHeight && regenerateRect.width >= 110),
      copyAllVisible: Boolean(copyRect && copyRect.top >= 0 && copyRect.bottom <= window.innerHeight && copyRect.width >= 34),
      toggles,
      topStable: Boolean(before && after && Math.abs(after.top) <= 1),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.position === 'sticky', `command dock should be sticky, got ${result.position}`);
  assert(result.topStable && result.top <= 1, `command dock should stay pinned while scrolling, got top ${result.top}`);
  assert(result.height >= 54 && result.height <= 70, `command dock should keep stable compact height, got ${result.height}`);
  assert(result.zIndex >= 20, `command dock should layer above fields, got z-index ${result.zIndex}`);
  assert(String(result.backdropFilter).includes('blur'), `command dock should keep translucent blur, got ${result.backdropFilter}`);
  assert(result.fillVisible, 'Fill action should remain visible after scrolling to the bottom');
  assert(result.regenerateVisible, 'Regenerate action should remain visible after scrolling to the bottom');
  assert(result.copyAllVisible, 'Copy All action should remain visible after scrolling to the bottom');
  assert(result.toggles.length === 2, `command dock should show two visible toggles, got ${JSON.stringify(result.toggles)}`);
  assert(result.toggles.some(toggle => toggle.id === 'addressApiToggleWrapper' && toggle.checked && toggle.label.includes('地图') && toggle.stateText === '开' && toggle.statePseudo === '开'), `address API toggle should expose visible on text state, got ${JSON.stringify(result.toggles)}`);
  assert(result.toggles.some(toggle => toggle.id === 'fillEmptyOnlyWrapper' && !toggle.checked && toggle.label.includes('空白') && toggle.stateText === '关' && toggle.statePseudo === '关'), `empty-only toggle should expose visible off text state, got ${JSON.stringify(result.toggles)}`);
  assert(result.toggles.every(toggle => toggle.width >= 44 && toggle.height >= 38), `command dock toggles should keep stable compact dimensions, got ${JSON.stringify(result.toggles)}`);
  assert(!result.horizontalOverflow, 'sticky command dock introduced horizontal overflow');

  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0); true');
  return `dock:${result.height}px`;
}

async function verifyWorkflowGuideContract(cdp, sessionId) {
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0); true');
  const result = await evaluate(cdp, sessionId, `(async () => {
    const guide = document.querySelector('#workflowGuide');
    const toggle = document.querySelector('#workflowGuideToggle');
    const details = document.querySelector('#workflowGuideDetails');
    const steps = Array.from(document.querySelectorAll('.workflow-guide-steps span')).map(step => {
      const rect = step.getBoundingClientRect();
      return {
        text: (step.textContent || '').trim(),
        step: step.dataset.step || '',
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      };
    });
    const guideRect = guide?.getBoundingClientRect();
    const compact = {
      state: guide?.dataset.state || '',
      label: guide?.getAttribute('aria-label') || '',
      title: (guide?.querySelector('.workflow-guide-copy strong')?.textContent || '').trim(),
      detail: (guide?.querySelector('.workflow-guide-copy span:last-child')?.textContent || '').trim(),
      toggleText: (toggle?.textContent || '').trim(),
      expanded: toggle?.getAttribute('aria-expanded') || '',
      controls: toggle?.getAttribute('aria-controls') || '',
      hidden: Boolean(details?.hidden),
      width: Math.round(guideRect?.width || 0),
      height: Math.round(guideRect?.height || 0),
      top: Math.round(guideRect?.top || 0),
      steps,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };

    toggle?.focus();
    return compact;
  })()`);

  await dispatchKey(cdp, sessionId, 'Enter');

  const expanded = await evaluate(cdp, sessionId, `(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    const guide = document.querySelector('#workflowGuide');
    const toggle = document.querySelector('#workflowGuideToggle');
    const details = document.querySelector('#workflowGuideDetails');
    const expandedRect = guide?.getBoundingClientRect();
    return {
      state: guide?.dataset.state || '',
      toggleText: (toggle?.textContent || '').trim(),
      expanded: toggle?.getAttribute('aria-expanded') || '',
      hidden: Boolean(details?.hidden),
      detailText: (details?.textContent || '').trim(),
      activeId: document.activeElement?.id || '',
      width: Math.round(expandedRect?.width || 0),
      height: Math.round(expandedRect?.height || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  const restored = await evaluate(cdp, sessionId, `(async () => {
    const guide = document.querySelector('#workflowGuide');
    const toggle = document.querySelector('#workflowGuideToggle');
    const details = document.querySelector('#workflowGuideDetails');
    toggle?.click();
    await new Promise(resolve => setTimeout(resolve, 40));
    return {
      state: guide?.dataset.state || '',
      expanded: toggle?.getAttribute('aria-expanded') || '',
      hidden: Boolean(details?.hidden),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.label === '安全填表工作流', `workflow guide should expose a clear accessible label, got ${JSON.stringify(result)}`);
  assert(result.state === 'compact' && result.expanded === 'false' && result.hidden === true, `workflow guide should start compact, got ${JSON.stringify(result)}`);
  assert(result.title === '先看计划，再填表' && result.detail.includes('扫描只读可见字段') && result.detail.includes('敏感字段'), `workflow guide should explain safe workflow in compact copy, got ${JSON.stringify(result)}`);
  assert(result.controls === 'workflowGuideDetails', `workflow guide toggle should control detail region, got ${JSON.stringify(result)}`);
  assert(result.steps.length === 3 && result.steps.map(step => step.step).join('/') === 'prepare/scan/fill', `workflow guide should show three ordered step chips, got ${JSON.stringify(result.steps)}`);
  assert(result.steps.every(step => step.width >= 110 && step.height >= 24), `workflow guide step chips should keep stable compact dimensions, got ${JSON.stringify(result.steps)}`);
  assert(result.width >= 390 && result.height >= 82 && result.top >= 0, `workflow guide should be visible near top without crowding, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'compact workflow guide introduced horizontal overflow');

  assert(expanded.state === 'expanded' && expanded.expanded === 'true' && expanded.hidden === false, `workflow guide should expand with Enter on its toggle, got ${JSON.stringify(expanded)}`);
  assert(expanded.detailText.includes('检查当前资料') && expanded.detailText.includes('读取当前标签页可见表单') && expanded.detailText.includes('确认计划后再触发 Fill'), `expanded workflow guide should reveal actionable details, got ${JSON.stringify(expanded)}`);
  assert(expanded.activeId === 'workflowGuideToggle', `workflow guide toggle should keep keyboard focus after expansion, got ${JSON.stringify(expanded)}`);
  assert(expanded.width === result.width && expanded.height > result.height, `workflow guide expansion should preserve width and grow vertically, got compact ${JSON.stringify(result)} expanded ${JSON.stringify(expanded)}`);
  assert(!expanded.horizontalOverflow, 'expanded workflow guide introduced horizontal overflow');

  assert(restored.state === 'compact' && restored.expanded === 'false' && restored.hidden === true && !restored.horizontalOverflow, `workflow guide should collapse cleanly after check, got ${JSON.stringify(restored)}`);

  return `workflowGuide:${result.height}/${expanded.height}`;
}

async function verifyShortcutHintContract(cdp, sessionId) {
  await waitFor(cdp, sessionId, `document.querySelector('#shortcutHintKey')?.textContent?.trim().length > 0`, 'shortcut hint key label');
  const result = await evaluate(cdp, sessionId, `(() => {
    const hint = document.querySelector('#shortcutHint');
    const key = document.querySelector('#shortcutHintKey');
    const detail = document.querySelector('#shortcutHintDetail');
    const hintRect = hint?.getBoundingClientRect();
    const keyRect = key?.getBoundingClientRect();
    const style = hint ? getComputedStyle(hint) : null;
    return {
      label: hint?.getAttribute('aria-label') || '',
      title: hint?.title || '',
      keyText: (key?.textContent || '').trim(),
      detailText: (detail?.textContent || '').trim(),
      width: Math.round(hintRect?.width || 0),
      height: Math.round(hintRect?.height || 0),
      keyWidth: Math.round(keyRect?.width || 0),
      keyHeight: Math.round(keyRect?.height || 0),
      display: style?.display || '',
      columns: style?.gridTemplateColumns || '',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.label === '快捷键填表提示', `shortcut hint should expose a clear accessible label, got ${JSON.stringify(result)}`);
  assert(result.keyText === 'Ctrl+Shift+F' || result.keyText === 'Command+Shift+F' || result.keyText === '快捷键未绑定', `shortcut hint should show the active or fallback fill-form shortcut, got ${JSON.stringify(result)}`);
  assert(result.detailText.includes('与 Fill 使用同一安全边界') && result.detailText.includes('公开资料') && result.detailText.includes('空白优先'), `shortcut hint should explain the same safety boundary as Fill, got ${JSON.stringify(result)}`);
  assert(result.title.includes(result.keyText) && result.title.includes('公开资料'), `shortcut hint title should include key and safety detail, got ${JSON.stringify(result)}`);
  assert(result.width >= 390 && result.height >= 44 && result.height <= 72, `shortcut hint should keep a compact stable surface, got ${JSON.stringify(result)}`);
  assert(result.keyWidth >= 86 && result.keyHeight >= 24, `shortcut key pill should keep stable dimensions, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'shortcut hint introduced horizontal overflow');

  return `shortcutHint:${result.keyText}/${result.height}`;
}

async function verifyPageScanPreviewContract(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const summary = summarizePageScan({
      fields: [
        { required: true },
        { required: false },
        { required: true }
      ],
      pageContext: { pageType: 'checkout', hasCaptcha: true },
      matchPreview: {
        matchCount: 2,
        requiredCount: 2,
        requiredMatchCount: 1,
        missingRequiredCount: 1,
        matchedFields: ['email', 'phone'],
        unmatchedRequiredLabels: ['公司税号'],
        sensitiveRequiredCount: 1,
        sensitiveRequiredLabels: ['CVV']
      }
    });
    renderPageScanState(
      'ready',
      summary.pageTypeLabel + ' · ' + summary.total + ' 个字段',
      formatPageScanDetail(summary),
      Object.assign({}, summary.matchPreview, { fieldCount: summary.total })
    );

    const panel = document.querySelector('#pageScanPanel');
    const title = document.querySelector('#pageScanTitle');
    const detail = document.querySelector('#pageScanDetail');
    const meta = document.querySelector('#pageScanMeta');
    const plan = document.querySelector('#pageScanPlan');
    const planTitle = document.querySelector('#pageScanPlanTitle');
    const pageScanPlanMatched = document.querySelector('#pageScanPlanMatched');
    const pageScanPlanUnmatched = document.querySelector('#pageScanPlanUnmatched');
    const pageScanPlanSensitive = document.querySelector('#pageScanPlanSensitive');
    const button = document.querySelector('#scanCurrentPage');
    const panelRect = panel?.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    const planRect = plan?.getBoundingClientRect();
    const style = panel ? getComputedStyle(panel) : null;
    const chips = Array.from(meta?.querySelectorAll('span') || []).map(chip => {
      const chipRect = chip.getBoundingClientRect();
      return {
        id: chip.id || '',
        text: (chip.textContent || '').trim(),
        state: chip.dataset.state || '',
        label: chip.getAttribute('aria-label') || '',
        title: chip.title || '',
        width: Math.round(chipRect.width || 0),
        height: Math.round(chipRect.height || 0)
      };
    });
    return {
      label: panel?.getAttribute('aria-label') || '',
      live: panel?.getAttribute('aria-live') || '',
      state: panel?.dataset.state || '',
      matchCount: panel?.dataset.matchCount || '',
      fieldCount: panel?.dataset.fieldCount || '',
      requiredMatchCount: panel?.dataset.requiredMatchCount || '',
      requiredCount: panel?.dataset.requiredCount || '',
      title: (title?.textContent || '').trim(),
      detail: (detail?.textContent || '').trim(),
      metaHidden: meta?.hidden === true,
      metaLabel: meta?.getAttribute('aria-label') || '',
      chips,
      planHidden: plan?.hidden === true,
      planLabel: plan?.getAttribute('aria-label') || '',
      planTitle: (planTitle?.textContent || '').trim(),
      matchedPlan: Array.from(pageScanPlanMatched?.querySelectorAll('span') || []).map(item => ({ text: (item.textContent || '').trim(), state: item.dataset.state || '' })),
      unmatchedPlan: Array.from(pageScanPlanUnmatched?.querySelectorAll('span') || []).map(item => ({ text: (item.textContent || '').trim(), state: item.dataset.state || '' })),
      sensitivePlan: Array.from(pageScanPlanSensitive?.querySelectorAll('span') || []).map(item => ({ text: (item.textContent || '').trim(), state: item.dataset.state || '' })),
      sensitivePlanLabel: pageScanPlanSensitive?.getAttribute('aria-label') || '',
      planWidth: Math.round(planRect?.width || 0),
      planHeight: Math.round(planRect?.height || 0),
      buttonText: (button?.textContent || '').trim(),
      buttonTitle: button?.title || '',
      buttonLabel: button?.getAttribute('aria-label') || '',
      buttonType: button?.type || '',
      width: Math.round(panelRect?.width || 0),
      height: Math.round(panelRect?.height || 0),
      buttonWidth: Math.round(buttonRect?.width || 0),
      buttonHeight: Math.round(buttonRect?.height || 0),
      display: style?.display || '',
      columns: style?.gridTemplateColumns || '',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.label === '当前页面扫描预览' && result.live === 'polite', `page scan preview should expose a live labelled region, got ${JSON.stringify(result)}`);
  assert(result.state === 'ready' && result.title === '结账页 · 3 个字段', `page scan preview should render summarized scan state, got ${JSON.stringify(result)}`);
  assert(result.detail.includes('预计命中 2/3') && result.detail.includes('必填已识别 1/2') && result.detail.includes('公司税号') && result.detail.includes('敏感必填 1 个将跳过') && result.detail.includes('CVV') && result.detail.includes('验证码'), `page scan preview should explain match preview, required fields, sensitive skips, and captcha, got ${result.detail}`);
  assert(result.matchCount === '2' && result.fieldCount === '3' && result.requiredMatchCount === '1' && result.requiredCount === '2', `page scan preview should expose temporary UI-only match data for readiness, got ${JSON.stringify(result)}`);
  assert(result.metaLabel === '页面扫描摘要' && result.metaHidden === false && result.chips.length === 3, `page scan preview should expose a compact scan summary chip row, got ${JSON.stringify(result)}`);
  assert(result.chips.some(chip => chip.id === 'pageScanMatchChip' && chip.text === '命中 2/3' && chip.state === 'ready' && chip.label.includes('预计可匹配')), `match chip should show compact hit ratio and label, got ${JSON.stringify(result.chips)}`);
  assert(result.chips.some(chip => chip.id === 'pageScanRequiredChip' && chip.text === '必填 1/2' && chip.state === 'warning' && chip.label.includes('必填字段已识别')), `required chip should show required-field coverage, got ${JSON.stringify(result.chips)}`);
  assert(result.chips.some(chip => chip.id === 'pageScanSensitiveChip' && chip.text === '敏感跳过 1' && chip.state === 'blocked' && chip.label.includes('CVV')), `sensitive chip should show skipped sensitive required fields, got ${JSON.stringify(result.chips)}`);
  assert(result.chips.every(chip => chip.width >= 42 && chip.height >= 20 && chip.label), `scan summary chips should keep stable compact dimensions and labels, got ${JSON.stringify(result.chips)}`);
  assert(result.planHidden === false && result.planLabel === '扫描计划' && result.planTitle.includes('扫描计划'), `page scan plan should be visible after ready scan, got ${JSON.stringify(result)}`);
  assert(result.matchedPlan.some(item => item.text === '邮箱' && item.state === 'matched') && result.matchedPlan.some(item => item.text === '电话' && item.state === 'matched'), `page scan plan should show matched public fields through shared labels, got ${JSON.stringify(result.matchedPlan)}`);
  assert(result.unmatchedPlan.some(item => item.text === '公司税号' && item.state === 'unmatched'), `page scan plan should show unmatched required labels, got ${JSON.stringify(result.unmatchedPlan)}`);
  assert(result.sensitivePlan.some(item => item.text === 'CVV' && item.state === 'blocked'), `page scan plan should show sensitive required labels as safely skipped, got ${JSON.stringify(result.sensitivePlan)}`);
  assert(result.sensitivePlanLabel.includes('安全跳过'), `page scan plan should expose safe-skip semantics, got ${JSON.stringify(result)}`);
  assert(result.planWidth >= 300 && result.planHeight >= 54, `page scan plan should keep a compact readable footprint, got ${JSON.stringify(result)}`);
  assert(result.buttonText === '扫描' && result.buttonTitle === '扫描当前页表单' && result.buttonLabel === '扫描当前页表单' && result.buttonType === 'button', `page scan button should stay explicit and accessible, got ${JSON.stringify(result)}`);
  assert(result.display === 'grid' && result.width >= 390 && result.height >= 72 && result.buttonWidth === 58 && result.buttonHeight === 34, `page scan preview should keep stable compact dimensions, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'page scan preview introduced horizontal overflow');

  const reset = await evaluate(cdp, sessionId, `(() => {
    renderPageScanState('loading', '正在扫描当前页', '只读取可见表单字段，不会填写页面内容。');
    return {
      hidden: document.querySelector('#pageScanPlan')?.hidden === true,
      text: (document.querySelector('#pageScanPlan')?.textContent || '').trim(),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
  assert(reset.hidden === true, `page scan plan should hide outside ready state, got ${JSON.stringify(reset)}`);
  assert(!reset.horizontalOverflow, 'page scan plan introduced horizontal overflow');

  return 'pageScan:ready/compact-plan';
}

async function verifyFillReadinessContract(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    renderPageScanState('ready', '结账页 · 3 个字段', '预计命中 2/3 个字段，必填已识别 1/2，检测到验证码。', {
      matchCount: 2,
      fieldCount: 3,
      requiredMatchCount: 1,
      requiredCount: 2
    });
    updateFillReadiness();
    const panel = document.querySelector('#fillReadiness');
    const title = document.querySelector('#fillReadinessTitle');
    const score = document.querySelector('#fillReadinessScore');
    const bar = document.querySelector('#fillReadinessBar');
    const hint = document.querySelector('#fillReadinessHint');
    const grid = document.querySelector('.fill-readiness-grid');
    const rect = panel?.getBoundingClientRect();
    const style = panel ? getComputedStyle(panel) : null;
    const gridStyle = grid ? getComputedStyle(grid) : null;
    const pills = Array.from(grid?.querySelectorAll('span') || []).map(pill => {
      const pillRect = pill.getBoundingClientRect();
      return {
        id: pill.id || '',
        text: (pill.textContent || '').trim(),
        state: pill.dataset.state || '',
        label: pill.getAttribute('aria-label') || '',
        title: pill.title || '',
        width: Math.round(pillRect.width || 0),
        height: Math.round(pillRect.height || 0)
      };
    });
    const beforeEmpty = {
      state: panel?.dataset.state || '',
      title: (title?.textContent || '').trim(),
      score: (score?.textContent || '').trim(),
      scoreLabel: score?.getAttribute('aria-label') || '',
      barWidth: bar?.style.width || '',
      barState: bar?.dataset.state || '',
      hint: (hint?.textContent || '').trim(),
      pills
    };

    const emptyToggle = document.querySelector('#fillEmptyOnlyToggle');
    if (emptyToggle && !emptyToggle.checked) emptyToggle.click();
    const afterEmptyPill = (document.querySelector('#fillReadyMode')?.textContent || '').trim();
    const afterEmptyState = document.querySelector('#fillReadyMode')?.dataset.state || '';

    const originalFirstName = currentData.firstName;
    currentData.firstName = '';
    updateUI();
    const afterMissing = {
      state: panel?.dataset.state || '',
      title: (title?.textContent || '').trim(),
      profilePill: (document.querySelector('#fillReadyProfile')?.textContent || '').trim(),
      profileState: document.querySelector('#fillReadyProfile')?.dataset.state || '',
      hint: (hint?.textContent || '').trim()
    };
    currentData.firstName = originalFirstName;
    updateUI();
    if (emptyToggle?.checked) emptyToggle.click();

    return {
      label: panel?.getAttribute('aria-label') || '',
      live: panel?.getAttribute('aria-live') || '',
      display: style?.display || '',
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
      gridDisplay: gridStyle?.display || '',
      gridColumns: gridStyle?.gridTemplateColumns || '',
      beforeEmpty,
      afterEmptyPill,
      afterEmptyState,
      afterMissing,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.label === '填表准备度' && result.live === 'polite', `fill readiness should expose a labelled live region, got ${JSON.stringify(result)}`);
  assert(result.display === 'grid' && result.width >= 390 && result.height >= 110, `fill readiness should keep a stable compact surface, got ${JSON.stringify(result)}`);
  assert(result.gridDisplay === 'grid' && result.gridColumns.split(' ').length === 3, `fill readiness should use a stable three-column pill grid, got ${JSON.stringify(result)}`);
  assert(result.beforeEmpty.state === 'ready' && result.beforeEmpty.title === '可以填写' && result.beforeEmpty.scoreLabel.includes('填表准备度'), `fill readiness should become ready after a complete profile and page scan, got ${JSON.stringify(result.beforeEmpty)}`);
  assert(result.beforeEmpty.pills.length === 6 && result.beforeEmpty.pills.some(pill => pill.id === 'fillReadyPage' && pill.text.includes('2/3') && pill.title.includes('必填 1/2')) && result.beforeEmpty.pills.some(pill => pill.id === 'fillReadySavedProfile' && pill.text.includes('100%')), `fill readiness pills should summarize page match preview and saved profile status, got ${JSON.stringify(result.beforeEmpty.pills)}`);
  assert(result.beforeEmpty.pills.every(pill => pill.width >= 110 && pill.height >= 24 && pill.label), `fill readiness pills should keep stable dimensions and accessible labels, got ${JSON.stringify(result.beforeEmpty.pills)}`);
  assert(result.afterEmptyPill === '模式 空白优先' && result.afterEmptyState === 'empty-only', `fill readiness should update when empty-only mode changes, got ${JSON.stringify(result)}`);
  assert(result.afterMissing.state === 'partial' && result.afterMissing.profileState === 'partial' && result.afterMissing.profilePill === '资料 12/13' && result.afterMissing.hint.includes('名'), `fill readiness should update when profile completeness changes, got ${JSON.stringify(result.afterMissing)}`);
  assert(!result.horizontalOverflow, 'fill readiness introduced horizontal overflow');

  return 'readiness:ready/emptyOnly/partial';
}

async function verifyProfileOverviewContract(cdp, sessionId) {
  const initial = await evaluate(cdp, sessionId, `(() => {
    const overview = document.querySelector('#profileOverview');
    const score = document.querySelector('#profileOverviewScore');
    const name = document.querySelector('#profileOverviewName');
    const detail = document.querySelector('#profileOverviewDetail');
    const bar = document.querySelector('#profileOverviewBar');
    const missing = document.querySelector('#profileOverviewMissing');
    const locked = document.querySelector('#profileOverviewLocked');
    const source = document.querySelector('#profileOverviewSource');
    const gap = document.querySelector('#profileOverviewGap');
    const meta = document.querySelector('.profile-overview-meta');
    const badges = Object.fromEntries(Array.from(document.querySelectorAll('[data-section-completion]')).map(badge => [
      badge.dataset.sectionCompletion,
      {
        text: (badge.textContent || '').trim(),
        state: badge.dataset.state || '',
        label: badge.getAttribute('aria-label') || '',
        title: badge.title || '',
        width: Math.round(badge.getBoundingClientRect().width || 0),
        height: Math.round(badge.getBoundingClientRect().height || 0)
      }
    ]));
    const rect = overview?.getBoundingClientRect();
    const scoreBlockRect = document.querySelector('.profile-overview-main')?.getBoundingClientRect();
    const trackRect = document.querySelector('.profile-overview-track')?.getBoundingClientRect();
    const nameRect = name?.getBoundingClientRect();
    const detailRect = detail?.getBoundingClientRect();
    const metaRect = meta?.getBoundingClientRect();
    const metaStyle = meta ? getComputedStyle(meta) : null;
    const metaPills = Array.from(meta?.querySelectorAll('span') || []).map(pill => {
      const pillRect = pill.getBoundingClientRect();
      return {
        id: pill.id || '',
        text: (pill.textContent || '').trim(),
        state: pill.dataset.state || '',
        title: pill.title || '',
        label: pill.getAttribute('aria-label') || '',
        width: Math.round(pillRect.width || 0),
        height: Math.round(pillRect.height || 0),
        left: Math.round(pillRect.left || 0),
        top: Math.round(pillRect.top || 0)
      };
    });
    return {
      label: overview?.getAttribute('aria-label') || '',
      state: overview?.dataset.state || '',
      score: (score?.textContent || '').trim(),
      scoreLabel: score?.getAttribute('aria-label') || '',
      name: (name?.textContent || '').trim(),
      detail: (detail?.textContent || '').trim(),
      barWidth: bar?.style.width || '',
      barState: bar?.dataset.state || '',
      missing: (missing?.textContent || '').trim(),
      missingState: missing?.dataset.state || '',
      missingTitle: missing?.title || '',
      locked: (locked?.textContent || '').trim(),
      lockedState: locked?.dataset.state || '',
      lockedTitle: locked?.title || '',
      source: (source?.textContent || '').trim(),
      sourceState: source?.dataset.state || '',
      sourceTitle: source?.title || '',
      gapText: (gap?.textContent || '').trim(),
      gapState: gap?.dataset.state || '',
      gapHidden: Boolean(gap?.classList.contains('is-hidden')),
      gapDisplay: gap ? getComputedStyle(gap).display : '',
      gapWidth: Math.round(gap?.getBoundingClientRect().width || 0),
      gapHeight: Math.round(gap?.getBoundingClientRect().height || 0),
      metaDisplay: metaStyle?.display || '',
      metaColumns: metaStyle?.gridTemplateColumns || '',
      metaWidth: Math.round(metaRect?.width || 0),
      metaPills,
      badges,
      visible: Boolean(rect && rect.width >= 390 && rect.height >= 40),
      scoreBlockWidth: Math.round(scoreBlockRect?.width || 0),
      trackWidth: Math.round(trackRect?.width || 0),
      trackLeft: Math.round(trackRect?.left || 0),
      scoreBlockLeft: Math.round(scoreBlockRect?.left || 0),
      identityLeft: Math.round(nameRect?.left || 0),
      summaryVisible: Boolean(nameRect && detailRect && nameRect.width >= 120 && detailRect.width >= 120),
      sourceVisible: Boolean(source?.getBoundingClientRect().width),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(initial.label === '当前生成资料概览', `Generated profile overview should expose an accessible label, got ${initial.label}`);
  assert(initial.score === '13/13' && initial.barWidth === '100%', `Generated profile overview should show a complete seeded profile, got ${JSON.stringify(initial)}`);
  assert(initial.state === 'complete' && initial.barState === 'complete' && initial.scoreLabel.includes('13/13'), `Generated profile overview should expose complete visual state, got ${JSON.stringify(initial)}`);
  assert(initial.scoreBlockWidth === 62 && initial.trackWidth === 62 && initial.trackLeft === initial.scoreBlockLeft && initial.trackLeft < initial.identityLeft, `Generated profile overview progress track should stay scoped to the score block, got ${JSON.stringify(initial)}`);
  assert(initial.name === 'Avery Stone' && initial.detail.includes('avery@example.com') && initial.detail.includes('New York') && initial.detail.includes('United States') && initial.summaryVisible, `Generated profile overview should show a compact public identity summary, got ${JSON.stringify(initial)}`);
  assert(initial.missing === '资料完整' && initial.missingState === 'complete' && initial.missingTitle === '资料完整', `Generated profile overview should show complete missing state, got ${JSON.stringify(initial)}`);
  assert(initial.gapHidden && initial.gapState === 'complete' && initial.gapText === '' && initial.gapDisplay === 'none', `Generated profile overview should keep the gap hint quiet when complete, got ${JSON.stringify(initial)}`);
  assert(initial.locked === '锁定 0' && initial.lockedState === 'empty' && initial.lockedTitle === '没有锁定字段', `Generated profile overview should start with no locks, got ${JSON.stringify(initial)}`);
  assert(initial.source.startsWith('来源 ') && initial.source.length > 3 && initial.sourceVisible && initial.sourceState && initial.sourceTitle.includes('资料来源'), `Generated profile overview source should be visible and stateful, got ${JSON.stringify(initial)}`);
  const sourceStates = await evaluate(cdp, sessionId, `(() => {
    const source = document.querySelector('#profileOverviewSource');
    const states = [];
    const read = label => states.push({
      label,
      text: (source?.textContent || '').trim(),
      state: source?.dataset.state || '',
      title: source?.title || ''
    });

    addressEnhancementState = 'geoapify';
    updateProfileOverview();
    read('geoapify');
    addressEnhancementState = 'openstreetmap';
    updateProfileOverview();
    read('openstreetmap');
    addressEnhancementState = 'fallback';
    updateProfileOverview();
    read('fallback');
    addressEnhancementState = 'local';
    updateProfileOverview();
    read('local');

    return states;
  })()`);

  assert(sourceStates.some(item => item.label === 'geoapify' && item.text === '来源 Geoapify' && item.state === 'maps'), `Generated profile overview should expose Geoapify map source, got ${JSON.stringify(sourceStates)}`);
  assert(sourceStates.some(item => item.label === 'openstreetmap' && item.text === '来源 OSM' && item.state === 'maps'), `Generated profile overview should expose OSM map source, got ${JSON.stringify(sourceStates)}`);
  assert(sourceStates.some(item => item.label === 'fallback' && item.text === '来源 本地降级' && item.state === 'fallback' && item.title.includes('本地降级')), `Generated profile overview should expose address fallback source, got ${JSON.stringify(sourceStates)}`);
  const metaColumnWidths = String(initial.metaColumns).split(/\s+/).map(parseFloat).filter(Number.isFinite);
  assert(initial.metaDisplay === 'grid' && metaColumnWidths.length === 2 && Math.abs(metaColumnWidths[0] - metaColumnWidths[1]) <= 1 && initial.metaWidth === 142, `Generated profile overview meta should use a stable two-column grid, got ${JSON.stringify(initial)}`);
  assert(initial.metaPills.length === 3 && initial.metaPills.every(pill => pill.title && pill.label === pill.title && pill.width >= 64 && pill.height >= 22), `Generated profile overview meta pills should expose labels and stable dimensions, got ${JSON.stringify(initial.metaPills)}`);
  assert(initial.metaPills.some(pill => pill.id === 'profileOverviewMissing' && pill.width === initial.metaWidth) && initial.metaPills.some(pill => pill.id === 'profileOverviewSource' && pill.width === initial.metaWidth), `Generated profile overview wide meta pills should span the grid, got ${JSON.stringify(initial.metaPills)}`);
  assert(initial.badges.identity?.text === '4/4' && initial.badges.account?.text === '3/3' && initial.badges.contact?.text === '6/6', `Generated section completion badges should summarize seeded sections, got ${JSON.stringify(initial.badges)}`);
  for (const [name, badge] of Object.entries(initial.badges)) {
    assert(badge.state === 'complete' && badge.label.includes('完成度') && badge.title === '本节资料完整', `${name} section badge should expose complete accessible state, got ${JSON.stringify(badge)}`);
    assert(badge.width >= 34 && badge.height >= 24, `${name} section badge should keep stable compact dimensions, got ${JSON.stringify(badge)}`);
  }
  assert(initial.visible, `Generated profile overview should be visible and stable, got ${JSON.stringify(initial)}`);
  assert(!initial.horizontalOverflow, 'Generated profile overview introduced horizontal overflow');

  const live = await evaluate(cdp, sessionId, `(() => {
    const firstNameLock = document.querySelector('.lock-btn[data-field="firstName"]');
    const phone = document.querySelector('#phone');
    const locked = document.querySelector('#profileOverviewLocked');
    const score = document.querySelector('#profileOverviewScore');
    const bar = document.querySelector('#profileOverviewBar');
    const missing = document.querySelector('#profileOverviewMissing');
    const gap = document.querySelector('#profileOverviewGap');
    const detail = document.querySelector('#profileOverviewDetail');
    const email = document.querySelector('#email');
    const contactBadge = document.querySelector('[data-section-completion="contact"]');

    firstNameLock?.click();
    const lockedAfterClick = (locked?.textContent || '').trim();
    const lockedStateAfterClick = locked?.dataset.state || '';
    phone.value = '';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    const scoreAfterClear = (score?.textContent || '').trim();
    const barAfterClear = bar?.style.width || '';
    const barStateAfterClear = bar?.dataset.state || '';
    const missingAfterClear = (missing?.textContent || '').trim();
    const missingStateAfterClear = missing?.dataset.state || '';
    const gapAfterClear = {
      text: (gap?.textContent || '').trim(),
      state: gap?.dataset.state || '',
      hidden: Boolean(gap?.classList.contains('is-hidden')),
      width: Math.round(gap?.getBoundingClientRect().width || 0),
      height: Math.round(gap?.getBoundingClientRect().height || 0)
    };
    const contactAfterClear = {
      text: (contactBadge?.textContent || '').trim(),
      state: contactBadge?.dataset.state || '',
      label: contactBadge?.getAttribute('aria-label') || '',
      title: contactBadge?.title || ''
    };
    email.value = '';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    const detailAfterEmailClear = (detail?.textContent || '').trim();
    email.value = 'avery@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));

    phone.value = '+1 212-555-0198';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    firstNameLock?.click();
    const gapAfterRestore = {
      text: (gap?.textContent || '').trim(),
      state: gap?.dataset.state || '',
      hidden: Boolean(gap?.classList.contains('is-hidden'))
    };
    const contactRestored = {
      text: (contactBadge?.textContent || '').trim(),
      state: contactBadge?.dataset.state || ''
    };

    return {
      lockedAfterClick,
      lockedStateAfterClick,
      scoreAfterClear,
      barAfterClear,
      barStateAfterClear,
      missingAfterClear,
      missingStateAfterClear,
      gapAfterClear,
      detailAfterEmailClear,
      contactAfterClear,
      restoredScore: (score?.textContent || '').trim(),
      restoredLocked: (locked?.textContent || '').trim(),
      gapAfterRestore,
      contactRestored,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(live.lockedAfterClick === '锁定 1' && live.lockedStateAfterClick === 'locked', `Generated profile overview should update lock count live, got ${JSON.stringify(live)}`);
  assert(live.scoreAfterClear === '12/13' && live.barAfterClear === '92%' && live.barStateAfterClear === 'partial', `Generated profile overview should update score and bar after clearing phone, got ${JSON.stringify(live)}`);
  assert(live.missingAfterClear.includes('电话') && live.missingStateAfterClear === 'partial', `Generated profile overview missing label should mention phone, got ${JSON.stringify(live)}`);
  assert(live.gapAfterClear.text.includes('补齐 电话') && live.gapAfterClear.text.includes('填表更稳') && live.gapAfterClear.state === 'partial' && !live.gapAfterClear.hidden && live.gapAfterClear.width >= 390 && live.gapAfterClear.height >= 24, `Generated profile overview gap hint should explain missing fields without layout collapse, got ${JSON.stringify(live.gapAfterClear)}`);
  assert(live.detailAfterEmailClear.includes('New York') && !live.detailAfterEmailClear.includes('avery@example.com'), `Generated profile overview detail should fall back to location when email is empty, got ${live.detailAfterEmailClear}`);
  assert(live.contactAfterClear.text === '5/6' && live.contactAfterClear.state === 'partial' && live.contactAfterClear.title === '本节还差 1 项' && live.contactAfterClear.label.includes('5/6'), `Generated contact section badge should update after clearing phone, got ${JSON.stringify(live.contactAfterClear)}`);
  assert(live.restoredScore === '13/13' && live.restoredLocked === '锁定 0', `Generated profile overview should restore before screenshots, got ${JSON.stringify(live)}`);
  assert(live.gapAfterRestore.hidden && live.gapAfterRestore.state === 'complete' && live.gapAfterRestore.text === '', `Generated profile overview gap hint should hide again after restore, got ${JSON.stringify(live.gapAfterRestore)}`);
  assert(live.contactRestored.text === '6/6' && live.contactRestored.state === 'complete', `Generated contact section badge should restore before screenshots, got ${JSON.stringify(live.contactRestored)}`);
  assert(!live.horizontalOverflow, 'Generated profile overview live updates introduced horizontal overflow');

  return `overview:${live.scoreAfterClear}->${live.restoredScore}; sections:5/6`;
}

async function verifyCountryScopeHelpContract(cdp, sessionId) {
  const coverageFocus = await focusSelectorByTab(cdp, sessionId, '#countryCoverage summary', { startSelector: '#country', maxTabs: 10 });

  const result = await evaluate(cdp, sessionId, `(() => {
    const country = document.querySelector('#country');
    const countryNote = document.querySelector('#countryScopeNote');
    const countryCoverage = document.querySelector('#countryCoverage');
    const countryCoverageSummary = countryCoverage?.querySelector('summary');
    const countryCoverageList = document.querySelector('#countryCoverageList');
    const coverageFocusShadow = countryCoverageSummary ? getComputedStyle(countryCoverageSummary).boxShadow : '';
    countryCoverage?.setAttribute('open', '');
    const sourceHint = document.querySelector('#sourceSectionBody')?.previousElementSibling?.querySelector('small');
    const locationLabel = document.querySelector('label[for="targetLocation"]');
    const location = document.querySelector('#targetLocation');
    const button = document.querySelector('#generateByLocation');
    const locationHint = document.querySelector('#usLocationHint');
    const suggestions = Array.from(document.querySelectorAll('#usLocationSuggestions option')).map(option => option.value);
    const coverageItems = Array.from(document.querySelectorAll('#countryCoverageList [data-country]')).map(item => ({
      country: item.dataset.country || '',
      selected: item.classList.contains('is-selected'),
      ariaCurrent: item.getAttribute('aria-current') || ''
    }));
    const countryNoteRect = countryNote?.getBoundingClientRect();
    const coverageRect = countryCoverageList?.getBoundingClientRect();
    const locationHintRect = locationHint?.getBoundingClientRect();
    const locationRect = location?.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    return {
      countryDescribedBy: country?.getAttribute('aria-describedby') || '',
      countryScope: (countryNote?.textContent || '').replace(/\s+/g, ' ').trim(),
      countryNoteVisible: Boolean(countryNoteRect && countryNoteRect.width >= 320 && countryNoteRect.height >= 28),
      countryCoverageOpen: Boolean(countryCoverage?.open),
      countryCoverageSummary: (countryCoverageSummary?.textContent || '').replace(/\s+/g, ' ').trim(),
      countryCoverageCount: coverageItems.length,
      countryCoverageFirst: coverageItems[0]?.country || '',
      countryCoverageLast: coverageItems.at(-1)?.country || '',
      countryCoverageVisible: Boolean(coverageRect && coverageRect.width >= 320 && coverageRect.height >= 230),
      selectedCoverage: coverageItems.filter(item => item.selected).map(item => item.country),
      selectedCoverageAria: coverageItems.filter(item => item.ariaCurrent === 'true').map(item => item.country),
      countryCoverageFocused: document.activeElement === countryCoverageSummary,
      coverageFocusShadow,
      sourceHint: (sourceHint?.textContent || '').trim(),
      locationLabel: (locationLabel?.textContent || '').trim(),
      locationPlaceholder: location?.getAttribute('placeholder') || '',
      locationDescribedBy: location?.getAttribute('aria-describedby') || '',
      locationWidth: Math.round(locationRect?.width || 0),
      buttonText: (button?.textContent || '').trim(),
      buttonTitle: button?.title || '',
      buttonLabel: button?.getAttribute('aria-label') || '',
      buttonWidth: Math.round(buttonRect?.width || 0),
      buttonHeight: Math.round(buttonRect?.height || 0),
      locationScope: (locationHint?.textContent || '').replace(/\s+/g, ' ').trim(),
      locationHintVisible: Boolean(locationHintRect && locationHintRect.width >= 300 && locationHintRect.height >= 28),
      newYorkCount: suggestions.filter(value => value === 'New York').length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.countryDescribedBy === 'countryScopeNote', `country picker should reference its scope note, got ${JSON.stringify(result)}`);
  assert(result.countryScope.includes('支持 19 个国家/地区生成资料') && result.countryScope.includes('城市级定点生成目前仅限美国'), `country scope note should clarify generated-data coverage, got ${result.countryScope}`);
  assert(result.countryNoteVisible, `country scope note should be visible and stable, got ${JSON.stringify(result)}`);
  assert(result.countryCoverageOpen && result.countryCoverageSummary === '查看支持的国家/地区', `country coverage panel should open with concise summary copy, got ${JSON.stringify(result)}`);
  assert(result.countryCoverageCount === 19 && result.countryCoverageFirst === 'United States' && result.countryCoverageLast === 'Netherlands', `country coverage panel should mirror the picker countries, got ${JSON.stringify(result)}`);
  assert(result.countryCoverageVisible, `country coverage panel should render a stable two-column grid, got ${JSON.stringify(result)}`);
  assert(result.selectedCoverage.length === 1 && result.selectedCoverage[0] === 'United States' && result.selectedCoverageAria[0] === 'United States', `country coverage should highlight the selected country accessibly, got ${JSON.stringify(result)}`);
  assert(result.countryCoverageFocused && coverageFocus.focused && result.coverageFocusShadow && result.coverageFocusShadow !== 'none', `country coverage summary should expose visible keyboard focus, got ${JSON.stringify({ ...result, coverageFocus })}`);
  assert(result.sourceHint === '美国定点地址', `source helper should name the US-specific location flow, got ${result.sourceHint}`);
  assert(result.locationLabel === '美国位置', `location input label should name US scope, got ${result.locationLabel}`);
  assert(result.locationPlaceholder === '州/城市，如 California 或 Seattle' && result.locationDescribedBy === 'usLocationHint', `US location input should expose concise examples and helper reference, got ${JSON.stringify(result)}`);
  assert(result.locationWidth >= 250, `US location input should keep enough width for examples, got ${JSON.stringify(result)}`);
  assert(result.buttonText === '生成' && result.buttonTitle === '按美国州或城市生成地址' && result.buttonLabel === '按美国州或城市生成地址', `US location action should have descriptive copy and labels, got ${JSON.stringify(result)}`);
  assert(result.buttonWidth === 48 && result.buttonHeight >= 31, `US location button should keep stable compact dimensions, got ${JSON.stringify(result)}`);
  assert(result.locationScope.includes('meiguodizhi.com') && result.locationScope.includes('其它国家请用上方国家选择'), `US location hint should explain the API boundary, got ${result.locationScope}`);
  assert(result.locationHintVisible, `US location hint should remain visible, got ${JSON.stringify(result)}`);
  assert(result.newYorkCount === 1, `US location suggestions should not repeat New York, got ${result.newYorkCount}`);
  assert(!result.horizontalOverflow, 'country scope helper polish introduced horizontal overflow');

  return 'countryScope:19/US+coverage';
}

async function verifyFieldActionButtonContract(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const lock = document.querySelector('.lock-btn[data-field="firstName"]');
    const copy = document.querySelector('.copy-btn[data-field="firstName"]');
    const refresh = document.querySelector('.refresh-btn[data-field="firstName"]');
    const allActions = Array.from(document.querySelectorAll('.lock-btn, .copy-btn, .refresh-btn'));
    const buttonRects = allActions.map(button => {
      const rect = button.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    const before = {
      lockText: (lock?.textContent || '').trim(),
      lockTitle: lock?.title || '',
      lockLabel: lock?.getAttribute('aria-label') || '',
      lockPressed: lock?.getAttribute('aria-pressed') || '',
      copyTitle: copy?.title || '',
      copyLabel: copy?.getAttribute('aria-label') || '',
      refreshTitle: refresh?.title || '',
      refreshLabel: refresh?.getAttribute('aria-label') || '',
      minWidth: Math.min(...buttonRects.map(rect => rect.width)),
      minHeight: Math.min(...buttonRects.map(rect => rect.height)),
      maxWidth: Math.max(...buttonRects.map(rect => rect.width)),
      maxHeight: Math.max(...buttonRects.map(rect => rect.height))
    };
    lock?.click();
    const locked = {
      lockText: (lock?.textContent || '').trim(),
      lockTitle: lock?.title || '',
      lockLabel: lock?.getAttribute('aria-label') || '',
      lockPressed: lock?.getAttribute('aria-pressed') || '',
      lockedClass: Boolean(lock?.classList.contains('locked'))
    };
    lock?.click();
    return {
      before,
      locked,
      restoredPressed: lock?.getAttribute('aria-pressed') || '',
      restoredClass: Boolean(lock?.classList.contains('locked')),
      count: allActions.length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.count >= 34, `field action buttons should cover generated profile fields, got ${result.count}`);
  assert(result.before.lockText === '未锁' && result.before.lockTitle === '锁定名' && result.before.lockLabel === '锁定名' && result.before.lockPressed === 'false', `unlocked field action state mismatch: ${JSON.stringify(result.before)}`);
  assert(result.before.copyTitle === '复制名' && result.before.copyLabel === '复制名', `copy field action label mismatch: ${JSON.stringify(result.before)}`);
  assert(result.before.refreshTitle === '重新生成名' && result.before.refreshLabel === '重新生成名', `refresh field action label mismatch: ${JSON.stringify(result.before)}`);
  assert(result.before.minWidth === result.before.maxWidth && result.before.minHeight === result.before.maxHeight && result.before.minWidth >= 31 && result.before.minHeight >= 31, `field action buttons should keep stable dimensions, got ${JSON.stringify(result.before)}`);
  assert(result.locked.lockText === '锁' && result.locked.lockTitle === '解锁名' && result.locked.lockLabel === '解锁名' && result.locked.lockPressed === 'true' && result.locked.lockedClass, `locked field action state mismatch: ${JSON.stringify(result.locked)}`);
  assert(result.restoredPressed === 'false' && !result.restoredClass, `field action lock should restore before screenshots, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'field action button polish introduced horizontal overflow');

  return `fieldActions:${result.count}`;
}

async function verifyFillEmptyOnlyToggleContract(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const wrapper = document.querySelector('#fillEmptyOnlyWrapper');
    const toggle = document.querySelector('#fillEmptyOnlyToggle');
    const label = wrapper?.querySelector('.ai-toggle-label');
    const state = wrapper?.querySelector('.ai-toggle-state');
    const rect = wrapper?.getBoundingClientRect();
    toggle?.focus();
    const focusStyle = wrapper ? getComputedStyle(wrapper) : null;
    const before = {
      checked: Boolean(toggle?.checked),
      label: (label?.textContent || '').trim(),
      state: (state?.textContent || '').trim(),
      statePseudo: state ? getComputedStyle(state, '::before').content.replace(/^['"]|['"]$/g, '') : '',
      title: wrapper?.title || '',
      visible: Boolean(rect && rect.width >= 44 && rect.height >= 30),
      focusInside: document.activeElement === toggle,
      focusShadow: focusStyle?.boxShadow || '',
      inputDisplay: toggle ? getComputedStyle(toggle).display : ''
    };
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const storedOn = await chrome.storage.local.get('formPilotFillEmptyOnly');
    const afterOnState = state ? getComputedStyle(state, '::before').content.replace(/^['"]|['"]$/g, '') : '';
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const storedOff = await chrome.storage.local.get('formPilotFillEmptyOnly');
    return {
      before,
      afterOnState,
      storedOn: storedOn.formPilotFillEmptyOnly,
      storedOff: storedOff.formPilotFillEmptyOnly,
      checkedAfterRestore: Boolean(toggle?.checked),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.before.visible, `fill-empty-only toggle should be visible, got ${JSON.stringify(result)}`);
  assert(result.before.label.includes('空白') && result.before.state === '关' && result.before.statePseudo === '关' && result.before.title.includes('保留页面已有内容'), `fill-empty-only toggle copy should be compact and expose text state, got ${JSON.stringify(result.before)}`);
  assert(result.before.focusInside && result.before.focusShadow !== 'none' && result.before.inputDisplay !== 'none', `fill-empty-only checkbox should remain keyboard focusable while visually hidden, got ${JSON.stringify(result.before)}`);
  assert(result.before.checked === false, 'fill-empty-only toggle should default off for seeded popup QA');
  assert(result.afterOnState === '开', `fill-empty-only toggle state text should switch on after click, got ${JSON.stringify(result)}`);
  assert(result.storedOn === true && result.storedOff === false && result.checkedAfterRestore === false, `fill-empty-only toggle should persist and restore off, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'fill-empty-only toggle introduced horizontal overflow');

  return 'emptyOnly:off/on/off';
}

async function verifyCommandTogglePersistence(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(async () => {
    const addressToggle = document.querySelector('#useAddressApiToggle');
    const addressWrapper = document.querySelector('#addressApiToggleWrapper');
    const emptyToggle = document.querySelector('#fillEmptyOnlyToggle');
    const aiToggle = document.querySelector('#useAIToggle');
    const aiWrapper = document.querySelector('#aiToggleWrapper');
    const source = document.querySelector('#profileOverviewSource');
    const readAddressOverview = () => {
      updateSettingsOverview();
      const card = document.querySelector('[data-settings-overview="address"]');
      return {
        state: card?.dataset.state || '',
        title: (card?.querySelector('strong')?.textContent || '').trim(),
        detail: (card?.querySelector('small')?.textContent || '').trim()
      };
    };

    const readAIMode = async () => {
      const stored = await chrome.storage.local.get('formPilotUseAI');
      return {
        checked: Boolean(aiToggle?.checked),
        disabled: Boolean(aiToggle?.disabled),
        hidden: Boolean(aiWrapper?.classList.contains('is-hidden')),
        wrapperDisabled: aiWrapper?.getAttribute('aria-disabled') || '',
        stored: stored.formPilotUseAI,
        enabled: isAIModeEnabled()
      };
    };

    await chrome.storage.local.set({ formPilotAddressApiEnabled: true, formPilotFillEmptyOnly: false, formPilotUseAI: false });
    if (addressToggle) addressToggle.checked = true;
    if (emptyToggle) emptyToggle.checked = false;
    if (aiToggle) aiToggle.checked = false;
    updateProfileOverview();
    const addressBefore = {
      checked: Boolean(addressToggle?.checked),
      label: (addressWrapper?.querySelector('.ai-toggle-label')?.textContent || '').trim(),
      stateText: (addressWrapper?.querySelector('.ai-toggle-state')?.textContent || '').trim(),
      source: (source?.textContent || '').trim(),
      overview: readAddressOverview()
    };

    const openSettings = document.querySelector('#openSettings');
    const settingsModal = document.querySelector('#settingsModal');
    openSettings?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const enableAI = document.querySelector('#enableAI');
    const openaiKey = document.querySelector('#openaiKey');
    const openaiModel = document.querySelector('#openaiModel');
    enableAI.checked = true;
    openaiKey.value = 'sk-command-mode-test';
    openaiModel.value = 'gpt-4.1-mini';
    await saveSettings();
    updateSettingsOverview();
    closeModal(settingsModal);
    await new Promise(resolve => setTimeout(resolve, 80));
    const aiReady = await readAIMode();
    aiToggle?.click();
    await new Promise(resolve => setTimeout(resolve, 140));
    const aiOn = await readAIMode();
    openSettings?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    enableAI.checked = false;
    await saveSettings();
    updateSettingsOverview();
    closeModal(settingsModal);
    await new Promise(resolve => setTimeout(resolve, 140));
    const aiAfterSettingsOff = await readAIMode();
    const originalData = JSON.parse(JSON.stringify(currentData || {}));
    const originalIpData = JSON.parse(JSON.stringify(ipData || {}));
    const originalAddressEnhancementState = addressEnhancementState;
    const originalGenerateAddressAsync = window.generators?.generateAddressAsync;
    window.__formPilotAIPathUsed = false;
    if (window.generators) window.generators.generateAddressAsync = async () => null;
    window.generateWithAI = async () => {
      window.__formPilotAIPathUsed = true;
      throw new Error('AI path should stay disabled');
    };
    await handleRegenerateAll();
    await new Promise(resolve => setTimeout(resolve, 160));
    const aiAfterGenerate = {
      aiPathUsed: Boolean(window.__formPilotAIPathUsed),
      currentSource: currentData.source || '',
      country: currentData.country || '',
      enabled: isAIModeEnabled()
    };
    currentData = originalData;
    ipData = originalIpData;
    addressEnhancementState = originalAddressEnhancementState;
    if (window.generators) window.generators.generateAddressAsync = originalGenerateAddressAsync;
    updateUI();
    await saveDataToStorage();

    addressToggle?.click();
    await new Promise(resolve => setTimeout(resolve, 140));
    const storedOff = await chrome.storage.local.get('formPilotAddressApiEnabled');
    updateProfileOverview();
    const addressOff = {
      checked: Boolean(addressToggle?.checked),
      stored: storedOff.formPilotAddressApiEnabled,
      source: (source?.textContent || '').trim(),
      overview: readAddressOverview()
    };

    emptyToggle?.click();
    await new Promise(resolve => setTimeout(resolve, 140));
    const storedEmptyOn = await chrome.storage.local.get('formPilotFillEmptyOnly');
    addressToggle?.click();
    await new Promise(resolve => setTimeout(resolve, 140));
    const storedOn = await chrome.storage.local.get('formPilotAddressApiEnabled');
    updateProfileOverview();
    const addressOn = {
      checked: Boolean(addressToggle?.checked),
      stored: storedOn.formPilotAddressApiEnabled,
      source: (source?.textContent || '').trim(),
      overview: readAddressOverview()
    };
    return {
      addressBefore,
      aiReady,
      aiOn,
      aiAfterSettingsOff,
      aiAfterGenerate,
      addressOff,
      addressOn,
      storedEmptyOn: storedEmptyOn.formPilotFillEmptyOnly,
      emptyChecked: Boolean(emptyToggle?.checked),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(result.addressBefore.checked && result.addressBefore.label.includes('地图') && result.addressBefore.stateText === '开' && result.addressBefore.source.includes('地图/本地'), `address API toggle should start on with visible state and map source, got ${JSON.stringify(result.addressBefore)}`);
  assert(result.addressBefore.overview.state === 'partial' && result.addressBefore.overview.title === 'OSM' && result.addressBefore.overview.detail === '无需 API Key', `address overview should describe keyless map fallback, got ${JSON.stringify(result.addressBefore.overview)}`);
  assert(result.aiReady.hidden === false && result.aiReady.disabled === false && result.aiReady.wrapperDisabled === 'false' && result.aiReady.enabled === false, `AI mode toggle should become available only after enabled settings and key are saved, got ${JSON.stringify(result.aiReady)}`);
  assert(result.aiOn.checked === true && result.aiOn.stored === true && result.aiOn.enabled === true, `AI mode toggle should persist on only while settings are ready, got ${JSON.stringify(result.aiOn)}`);
  assert(result.aiAfterSettingsOff.checked === false && result.aiAfterSettingsOff.disabled === true && result.aiAfterSettingsOff.hidden === true && result.aiAfterSettingsOff.stored === false && result.aiAfterSettingsOff.enabled === false, `disabling AI settings should clear and hide the command AI mode, got ${JSON.stringify(result.aiAfterSettingsOff)}`);
  assert(result.aiAfterGenerate.aiPathUsed === false && result.aiAfterGenerate.enabled === false, `regenerate should not call AI after settings disable the hidden command toggle, got ${JSON.stringify(result.aiAfterGenerate)}`);
  assert(result.addressOff.checked === false && result.addressOff.stored === false && result.addressOff.source.includes('本地'), `address API toggle should persist off and switch source to local, got ${JSON.stringify(result.addressOff)}`);
  assert(result.addressOff.overview.state === 'off' && result.addressOff.overview.title === '关闭' && result.addressOff.overview.detail === '仅用本地地址', `address overview should describe disabled map lookup, got ${JSON.stringify(result.addressOff.overview)}`);
  assert(result.addressOn.checked === true && result.addressOn.stored === true && result.addressOn.source.includes('地图/本地'), `address API toggle should persist on and restore map source, got ${JSON.stringify(result.addressOn)}`);
  assert(result.storedEmptyOn === true && result.emptyChecked, `empty-only toggle should stay independent from address toggle, got ${JSON.stringify(result)}`);
  assert(!result.horizontalOverflow, 'command toggle persistence introduced horizontal overflow');

  await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
  await waitFor(cdp, sessionId, `document.readyState === 'complete' || document.readyState === 'interactive'`, 'popup reload after command toggle persistence');
  await waitFor(cdp, sessionId, `document.querySelector('#firstName')?.value === 'Avery'`, 'cached popup profile after command toggle reload');
  const afterReload = await evaluate(cdp, sessionId, `(() => {
    updateSettingsOverview();
    const addressToggle = document.querySelector('#useAddressApiToggle');
    const emptyToggle = document.querySelector('#fillEmptyOnlyToggle');
    const source = document.querySelector('#profileOverviewSource');
    const card = document.querySelector('[data-settings-overview="address"]');
    return {
      addressChecked: Boolean(addressToggle?.checked),
      emptyChecked: Boolean(emptyToggle?.checked),
      addressSourceAfterReload: (source?.textContent || '').trim(),
      addressOverviewAfterReload: {
        state: card?.dataset.state || '',
        title: (card?.querySelector('strong')?.textContent || '').trim(),
        detail: (card?.querySelector('small')?.textContent || '').trim()
      },
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  assert(afterReload.addressChecked && afterReload.emptyChecked, `command toggles should restore saved states after reload, got ${JSON.stringify(afterReload)}`);
  assert(afterReload.addressSourceAfterReload.includes('地图/本地'), `address source should restore map/local after reload, got ${JSON.stringify(afterReload)}`);
  assert(afterReload.addressOverviewAfterReload.title === 'OSM' && afterReload.addressOverviewAfterReload.detail === '无需 API Key', `address overview should restore keyless map state after reload, got ${JSON.stringify(afterReload)}`);
  assert(!afterReload.horizontalOverflow, 'command toggle reload restoration introduced horizontal overflow');

  await evaluate(cdp, sessionId, `(async () => {
    const emptyToggle = document.querySelector('#fillEmptyOnlyToggle');
    if (emptyToggle?.checked) emptyToggle.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    return true;
  })()`);

  return 'commandToggles:address/empty/AI/reload';
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
    '--window-size=460,860',
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

    const { serviceWorker, targets } = await waitForFormPilotServiceWorker(cdp);
    if (!serviceWorker) {
      const summary = serviceWorkerSummary(targets);
      if (extensionFlagUnsupported(stderr)) {
        throw new Error(`The selected browser rejected unpacked-extension flags. Set CHROME_PATH to Microsoft Edge, Chromium, Chrome for Testing, or another browser that allows --load-extension. Inspected extension service workers:\n${summary}`);
      }
      throw new Error(`FormPilot service worker target was not found. Inspected extension service workers:\n${summary}`);
    }

    const workerSession = await attachToTarget(cdp, serviceWorker.targetId);
    await cdp.send('Runtime.enable', {}, workerSession);
    await evaluate(cdp, workerSession, seedStorageExpression());

    const extensionId = getExtensionId(serviceWorker.url);
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const popupTarget = await cdp.send('Target.createTarget', { url: popupUrl });
    const popupSession = await attachToTarget(cdp, popupTarget.targetId);
    await cdp.send('Runtime.enable', {}, popupSession);
    await cdp.send('Page.enable', {}, popupSession);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 460,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false
    }, popupSession);

    await waitFor(cdp, popupSession, `document.readyState === 'complete' || document.readyState === 'interactive'`, 'popup document readiness');
    await waitFor(cdp, popupSession, `document.querySelector('#firstName')?.value === 'Avery'`, 'cached popup profile data');
    const headerSummary = await verifyHeaderWorkbenchPolish(cdp, popupSession);
    const dockSummary = await verifyCommandDockContract(cdp, popupSession);
    const workflowGuideSummary = await verifyWorkflowGuideContract(cdp, popupSession);
    const shortcutHintSummary = await verifyShortcutHintContract(cdp, popupSession);
    const emptyOnlySummary = await verifyFillEmptyOnlyToggleContract(cdp, popupSession);
    const commandToggleSummary = await verifyCommandTogglePersistence(cdp, popupSession);
    const compactActionSummary = await verifyCompactActionAccessibility(cdp, popupSession);
    const pageScanSummary = await verifyPageScanPreviewContract(cdp, popupSession);
    const readinessSummary = await verifyFillReadinessContract(cdp, popupSession);
    const overviewSummary = await verifyProfileOverviewContract(cdp, popupSession);
    const countryScopeSummary = await verifyCountryScopeHelpContract(cdp, popupSession);
    const fieldActionSummary = await verifyFieldActionButtonContract(cdp, popupSession);
    const sectionSummary = await verifyProfileSectionToggles(cdp, popupSession);
    const mailingSummary = await verifyMailingAddressCopy(cdp, popupSession);
    const sectionCopySummary = await verifySectionCopyFeedback(cdp, popupSession);
    const copyAllSummary = await verifyCopyAllFeedback(cdp, popupSession);
    const copyAllEmptySummary = await verifyCopyAllEmptyState(cdp, popupSession);
    const inboxCodeSummary = await verifyInboxVerificationCodeCopy(cdp, popupSession);
    const inboxErrorSummary = await verifyInboxErrorState(cdp, popupSession);
    const tempMailRecoverySummary = await verifyTempMailRegistrationRecovery(cdp, popupSession);
    const addressRecoverySummary = await verifyAddressServiceRecoveryState(cdp, popupSession);
    const fillResultSummary = await verifyFillResultFeedback(cdp, popupSession);
    const fillBusySummary = await verifyFillButtonLoadingState(cdp, popupSession);
    const publicStorageSummary = await verifyPublicStorageBoundary(cdp, popupSession);
    const reducedMotionSummary = await verifyReducedMotionContract(cdp, popupSession);
    const mainScreenshotSummary = await settlePopupScreenshotState(cdp, popupSession, 'mainScreenshot');
    const mainScreenshotTopSummary = await prepareMainScreenshotState(cdp, popupSession);
    await captureScreenshot(cdp, popupSession, 'output/playwright/popup-main.png');

    const checks = [];
    for (const config of [
      { modal: 'settingsModal', trigger: 'openSettings' },
      { modal: 'historyModal', trigger: 'openHistory' },
      { modal: 'myProfileModal', trigger: 'openMyProfile' }
    ]) {
      checks.push(await verifyModalKeyboard(cdp, popupSession, config));
    }
    const keyVisibilitySummary = await verifySettingsKeyVisibilityControl(cdp, popupSession);
    const settingsOverviewSummary = await verifySettingsOverviewPolish(cdp, popupSession);
    await evaluate(cdp, popupSession, `document.querySelector('#openSettings')?.click(); true`);
    await waitFor(cdp, popupSession, `document.querySelector('#settingsModal')?.classList.contains('show')`, 'settings modal screenshot state');
    await sleep(250);
    const settingsScreenshotSummary = await settlePopupScreenshotState(cdp, popupSession, 'settingsScreenshot');
    const settingsScreenshotTopSummary = await prepareSettingsScreenshotState(cdp, popupSession);
    await captureScreenshot(cdp, popupSession, 'output/playwright/popup-settings.png');
    await evaluate(cdp, popupSession, `closeModal(document.querySelector('#settingsModal')); true`);
    const archiveSearchSummary = await verifyArchiveSearchContract(cdp, popupSession);
    const historySearchSummary = await verifyHistorySearchContract(cdp, popupSession);
    const historyItemDeleteSummary = await verifyHistoryItemDeleteConfirmation(cdp, popupSession);
    const historyClearSummary = await verifyHistoryClearConfirmation(cdp, popupSession);
    const archiveDeleteSummary = await verifyArchiveDeleteConfirmation(cdp, popupSession);

    await evaluate(cdp, popupSession, `document.querySelector('#openMyProfile').click(); true`);
    await waitFor(cdp, popupSession, `document.querySelector('#myProfileModal')?.classList.contains('show')`, 'My Profile modal screenshot state');
    await sleep(250);
    const profileHeaderSummary = await verifyMyProfileHeaderStatus(cdp, popupSession);
    await sleep(700);
    await verifyMyProfileVisualContract(cdp, popupSession);
    const autoSaveSummary = await verifyMyProfileAutoSave(cdp, popupSession);
    const copyShippingSummary = await verifyMyProfileCopyShippingState(cdp, popupSession);
    const paymentSummary = await verifyMyProfilePaymentSummaryNormalization(cdp, popupSession);
    const profileCopySummary = await verifyMyProfileCopyOutput(cdp, popupSession);
    const profileClearSummary = await verifyMyProfileClearConfirmation(cdp, popupSession);
    const profileSnapshotSummary = await restoreMyProfileScreenshotState(cdp, popupSession);
    const profileScreenshotSummary = await settlePopupScreenshotState(cdp, popupSession, 'profileScreenshot');
    await captureScreenshot(cdp, popupSession, 'output/playwright/popup-profile.png');

    const summary = checks.map(check => `${check.modal}: ${check.first}/${check.last}/${check.trigger}`).join('; ');
    console.log(`FormPilot popup keyboard verification passed in ${version.Browser}: ${headerSummary}; ${dockSummary}; ${workflowGuideSummary}; ${shortcutHintSummary}; ${emptyOnlySummary}; ${commandToggleSummary}; ${compactActionSummary}; ${pageScanSummary}; ${readinessSummary}; ${overviewSummary}; ${countryScopeSummary}; ${fieldActionSummary}; ${mailingSummary}; ${sectionCopySummary}; ${copyAllSummary}; ${copyAllEmptySummary}; ${inboxCodeSummary}; ${inboxErrorSummary}; ${tempMailRecoverySummary}; ${addressRecoverySummary}; ${fillResultSummary}; ${fillBusySummary}; ${publicStorageSummary}; ${reducedMotionSummary}; ${mainScreenshotSummary}; ${mainScreenshotTopSummary}; ${keyVisibilitySummary}; ${settingsOverviewSummary}; ${settingsScreenshotSummary}; ${settingsScreenshotTopSummary}; ${archiveSearchSummary}; ${historySearchSummary}; ${historyItemDeleteSummary}; ${historyClearSummary}; ${archiveDeleteSummary}; ${profileHeaderSummary}; ${autoSaveSummary}; ${copyShippingSummary}; ${paymentSummary}; ${profileCopySummary}; ${profileClearSummary}; ${profileSnapshotSummary}; ${profileScreenshotSummary}; sections ${sectionSummary}; ${summary}`);
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
  console.error(`FormPilot popup keyboard verification failed: ${error.message}`);
  process.exit(1);
});
