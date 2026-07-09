/**
 * 存储相关功能
 */

/**
 * 保存锁定状态到 storage
 */
async function saveLockedFields() {
    try {
        await chrome.storage.local.set({
            [LOCKED_KEY]: Array.from(lockedFields)
        });
    } catch (e) {
        log.info('保存锁定状态失败:', e);
    }
}

/**
 * 从 storage 加载锁定状态
 */
async function loadLockedFields() {
    try {
        const result = await chrome.storage.local.get(LOCKED_KEY);
        if (result[LOCKED_KEY]) {
            lockedFields = new Set(result[LOCKED_KEY]);
            syncFieldActionButtons();
            updateProfileOverview();
        }
    } catch (e) {
        log.info('加载锁定状态失败:', e);
    }
}

/**
 * 保存数据到 chrome.storage
 */
async function saveDataToStorage() {
    try {
        await chrome.storage.local.set({
            [STORAGE_KEY]: {
                version: CACHE_VERSION,
                currentData: getPublicProfileData(),
                ipData,
                emailDomain: elements.emailDomainType?.value,
                customDomain: elements.customDomain?.value,
                targetLocation: elements.targetLocation?.value?.trim() || ''
            }
        });
    } catch (e) {
        log.info('保存数据失败:', e);
    }
}

/**
 * 从 chrome.storage 加载数据
 */
async function loadDataFromStorage() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const cached = result[STORAGE_KEY];
        if (cached && cached.version !== CACHE_VERSION) {
            log.info('缓存版本不匹配，清除旧缓存');
            await chrome.storage.local.remove(STORAGE_KEY);
            return null;
        }
        if (cached?.currentData) {
            cached.currentData = getPublicProfileData(cached.currentData);
            await chrome.storage.local.set({ [STORAGE_KEY]: cached });
        }
        return cached || null;
    } catch (e) {
        log.info('加载数据失败:', e);
        return null;
    }
}

function readMyProfileFromInputs() {
    const profile = { ...DEFAULT_MY_PROFILE };
    MY_PROFILE_FIELD_NAMES.forEach(name => {
        const el = elements.myProfileFields[name];
        profile[name] = el ? el.value.trim() : '';
    });
    updateMyProfileCompleteness();
    return normalizeMyProfile(profile);
}

function normalizeCardLast4(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.slice(-4);
}

function normalizeCardExpiry(value) {
    const raw = String(value || '').trim();
    const parts = raw.split(/\D+/).filter(Boolean);
    if (parts.length >= 2) {
        const first = parts[0];
        const second = parts[1];
        const yearFirst = first.length === 4;
        const month = yearFirst ? second.slice(0, 2) : first.slice(0, 2);
        const yearDigits = yearFirst ? first : second;
        const year = yearDigits.length > 2 ? yearDigits.slice(-2) : yearDigits.slice(0, 2);
        return year ? `${month}/${year}` : month;
    }

    const allDigits = raw.replace(/\D/g, '');
    if (!allDigits) return '';
    const digits = allDigits.length >= 6 && allDigits.startsWith('20')
        ? `${allDigits.slice(4, 6)}${allDigits.slice(2, 4)}`
        : allDigits.slice(0, 4);
    return digits.length > 2
        ? `${digits.slice(0, 2)}/${digits.slice(2)}`
        : digits;
}

function normalizeMyProfile(profile) {
    const normalized = { ...DEFAULT_MY_PROFILE, ...profile };
    normalized.cardLast4 = normalizeCardLast4(normalized.cardLast4);
    normalized.cardExpiry = normalizeCardExpiry(normalized.cardExpiry);
    return normalized;
}

function sanitizeMyProfilePayload(payload) {
    const cleaned = { ...DEFAULT_MY_PROFILE };
    MY_PROFILE_FIELD_NAMES.forEach(name => {
        const value = payload && Object.prototype.hasOwnProperty.call(payload, name)
            ? payload[name]
            : '';
        cleaned[name] = typeof value === 'string' || typeof value === 'number'
            ? String(value).trim()
            : '';
    });
    return normalizeMyProfile(cleaned);
}

function summarizeMyProfileImportPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { accepted: 0, dropped: [] };
    }

    const dropped = [];
    let accepted = 0;

    Object.keys(payload).forEach(key => {
        if (MY_PROFILE_FIELD_NAMES.includes(key)) {
            accepted++;
        } else {
            dropped.push(key);
        }
    });

    return { accepted, dropped };
}

function getMyProfileImportMessage(summary) {
    if (!summary?.dropped?.length) return '我的资料已导入';

    const shown = summary.dropped.slice(0, 3).join(', ');
    const more = summary.dropped.length > 3 ? ` 等 ${summary.dropped.length} 项` : '';
    return `已导入，已忽略 ${shown}${more}`;
}

function updateMyProfileUI() {
    MY_PROFILE_FIELD_NAMES.forEach(name => {
        const el = elements.myProfileFields[name];
        if (el) el.value = myProfile[name] || '';
    });
    updateMyProfileCompleteness();
    updateCopyShippingToBillingState();
}

function hasShippingAddressInput() {
    return ['shippingAddress', 'shippingCity', 'shippingState', 'shippingZipCode', 'shippingCountry']
        .some(name => String(elements.myProfileFields[name]?.value || '').trim());
}

function updateCopyShippingToBillingState() {
    if (!elements.copyShippingToBilling) return;

    const enabled = hasShippingAddressInput();
    elements.copyShippingToBilling.disabled = !enabled;
    elements.copyShippingToBilling.setAttribute('aria-disabled', String(!enabled));
    elements.copyShippingToBilling.title = enabled
        ? '将收货地址复制到账单地址'
        : '先填写收货地址';
}

function setMyProfileStatus(message, state = 'saved') {
    if (!elements.myProfileStatus) return;
    elements.myProfileStatus.textContent = message;
    elements.myProfileStatus.dataset.state = state;
}

async function persistMyProfile(profile, options = {}) {
    const nextProfile = sanitizeMyProfilePayload(profile);
    myProfile = nextProfile;
    if (options.updateUI) {
        updateMyProfileUI();
    }

    try {
        await chrome.storage.local.set({ [MY_PROFILE_KEY]: myProfile });
        setMyProfileStatus(options.statusMessage || '本地已保存', 'saved');
        updateMyProfileCompleteness();
        if (options.toastMessage) showToast(options.toastMessage);
        return true;
    } catch (e) {
        log.info(options.errorLog || '保存我的资料失败:', e);
        setMyProfileStatus('保存失败', 'error');
        if (options.errorToast) showToast(options.errorToast);
        return false;
    }
}

async function saveMyProfileData() {
    await persistMyProfile(readMyProfileFromInputs(), {
        updateUI: true,
        toastMessage: '我的资料已保存',
        errorToast: '保存失败'
    });
}

async function loadMyProfileData() {
    try {
        const result = await chrome.storage.local.get(MY_PROFILE_KEY);
        myProfile = normalizeMyProfile(result[MY_PROFILE_KEY] || {});
        updateMyProfileUI();
        setMyProfileStatus('本地已保存', 'saved');
    } catch (e) {
        log.info('加载我的资料失败:', e);
    }
}

let myProfileAutoSaveTimer = null;

function cancelMyProfileAutoSave() {
    if (!myProfileAutoSaveTimer) return;
    clearTimeout(myProfileAutoSaveTimer);
    myProfileAutoSaveTimer = null;
}

function scheduleMyProfileAutoSave() {
    cancelMyProfileAutoSave();
    setMyProfileStatus('正在保存...', 'saving');
    myProfileAutoSaveTimer = setTimeout(async () => {
        myProfileAutoSaveTimer = null;
        await persistMyProfile(readMyProfileFromInputs(), {
            statusMessage: '本地已保存',
            errorLog: '自动保存我的资料失败:'
        });
    }, 450);
}

async function copyShippingAddressToBilling() {
    updateCopyShippingToBillingState();
    if (elements.copyShippingToBilling?.disabled) {
        showToast('先填写收货地址');
        return;
    }

    const pairs = {
        billingAddress: 'shippingAddress',
        billingCity: 'shippingCity',
        billingState: 'shippingState',
        billingZipCode: 'shippingZipCode',
        billingCountry: 'shippingCountry'
    };

    Object.entries(pairs).forEach(([target, source]) => {
        const sourceEl = elements.myProfileFields[source];
        const targetEl = elements.myProfileFields[target];
        if (sourceEl && targetEl) targetEl.value = sourceEl.value.trim();
    });

    await persistMyProfile(readMyProfileFromInputs(), {
        toastMessage: '账单地址已同步',
        errorToast: '同步失败',
        errorLog: '同步账单地址失败:'
    });
    updateCopyShippingToBillingState();
}

async function clearMyProfileData() {
    cancelMyProfileAutoSave();
    myProfile = { ...DEFAULT_MY_PROFILE };
    updateMyProfileUI();
    try {
        await chrome.storage.local.remove(MY_PROFILE_KEY);
        setMyProfileStatus('本地已清空', 'saved');
        showToast('我的资料已清空');
    } catch (e) {
        log.info('清空我的资料失败:', e);
        setMyProfileStatus('清空失败', 'error');
    }
}

async function exportMyProfileData() {
    let url = '';

    try {
        await persistMyProfile(sanitizeMyProfilePayload(readMyProfileFromInputs()), { updateUI: true });

        const data = {
            schema: 'formpilot-my-profile',
            version: MY_PROFILE_EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            profile: myProfile
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `formpilot-my-profile-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        showToast('我的资料已导出');
    } catch (e) {
        log.info('导出我的资料失败:', e);
        showToast('导出失败');
    } finally {
        if (url) URL.revokeObjectURL(url);
    }
}

async function importMyProfileFromFile(file) {
    if (!file) return;

    try {
        if (file.size > 128 * 1024) {
            throw new Error('文件过大');
        }

        const text = await file.text();
        const parsed = JSON.parse(text);
        const payload = parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object'
            ? parsed.profile
            : parsed;
        const summary = summarizeMyProfileImportPayload(payload);

        await persistMyProfile(sanitizeMyProfilePayload(payload), { updateUI: true });
        setMyProfileStatus(getMyProfileImportMessage(summary), summary.dropped.length ? 'warning' : 'saved');
        showToast(summary.dropped.length ? `已忽略 ${summary.dropped.length} 个未支持字段` : '我的资料已导入');
    } catch (e) {
        log.info('导入我的资料失败:', e);
        setMyProfileStatus('导入失败', 'error');
        showToast(`导入失败: ${(e.message || '文件无效').slice(0, 32)}`);
    }
}

/**
 * 保存主题
 */
async function saveTheme(theme) {
    try {
        await chrome.storage.local.set({ [THEME_KEY]: theme });
    } catch (e) {
        log.info('保存主题失败:', e);
    }
}

/**
 * 加载主题
 */
async function loadTheme() {
    try {
        const result = await chrome.storage.local.get(THEME_KEY);
        const theme = result[THEME_KEY] || 'dark';
        applyTheme(theme);
    } catch (e) {
        log.info('加载主题失败:', e);
        applyTheme('dark');
    }
}

/**
 * 保存设置
 */
async function saveSettings() {
    userSettings = {
        enableAI: elements.enableAI?.checked ?? false,
        openaiBaseUrl: elements.openaiBaseUrl?.value?.trim() || 'https://api.openai.com/v1',
        openaiKey: elements.openaiKey?.value?.trim() || '',
        openaiModel: elements.openaiModel?.value?.trim() || 'gpt-3.5-turbo',
        aiPersona: elements.aiPersona?.value?.trim() || '',
        passwordLength: parseInt(elements.passwordLength?.value) || 12,
        pwdUppercase: elements.pwdUppercase?.checked ?? true,
        pwdLowercase: elements.pwdLowercase?.checked ?? true,
        pwdNumbers: elements.pwdNumbers?.checked ?? true,
        pwdSymbols: elements.pwdSymbols?.checked ?? true,
        minAge: parseInt(elements.minAge?.value) || 18,
        maxAge: parseInt(elements.maxAge?.value) || 55,
        autoClearData: elements.autoClearData?.checked ?? false,
        geoapifyKey: elements.geoapifyKey?.value?.trim() || ''
    };

    try {
        await chrome.storage.local.set({ [SETTINGS_KEY]: userSettings });
        await chrome.storage.local.set({ [AUTO_CLEAR_KEY]: userSettings.autoClearData });
        if (!syncAIModeToggleAvailability()) {
            await chrome.storage.local.set({ [AI_MODE_KEY]: false });
        }
        if (window.generators && window.generators.updateSettings) {
            window.generators.updateSettings(userSettings);
        }
        // 设置 Geoapify API Key 到 generators
        if (window.generators && window.generators.setGeoapifyApiKey) {
            window.generators.setGeoapifyApiKey(userSettings.geoapifyKey);
        }
    } catch (e) {
        log.info('保存设置失败:', e);
    }
}

/**
 * 加载设置
 */
async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(SETTINGS_KEY);
        if (result[SETTINGS_KEY]) {
            userSettings = { ...userSettings, ...result[SETTINGS_KEY] };
        }
        updateSettingsUI();
        if (window.generators && window.generators.updateSettings) {
            window.generators.updateSettings(userSettings);
        }
        // 加载 Geoapify API Key (独立存储)
        await loadGeoapifyKey();
    } catch (e) {
        log.info('加载设置失败:', e);
    }
}

/**
 * 加载 Geoapify API Key (独立存储)
 */
async function loadGeoapifyKey() {
    try {
        const result = await chrome.storage.local.get(GEOAPIFY_KEY);
        const geoapifyKey = result[GEOAPIFY_KEY] || '';
        if (elements.geoapifyKey) {
            elements.geoapifyKey.value = geoapifyKey;
        }
        // 同步到 generators
        if (window.generators && window.generators.setGeoapifyApiKey) {
            window.generators.setGeoapifyApiKey(geoapifyKey);
        }
        log.info(' Geoapify API Key 已加载');
    } catch (e) {
        log.info('加载 Geoapify API Key 失败:', e);
    }
}

/**
 * 保存 Geoapify API Key (独立存储，实时保存)
 */
async function saveGeoapifyKey() {
    const key = elements.geoapifyKey?.value?.trim() || '';
    try {
        await chrome.storage.local.set({ [GEOAPIFY_KEY]: key });
        // 同步到 generators
        if (window.generators && window.generators.setGeoapifyApiKey) {
            window.generators.setGeoapifyApiKey(key);
        }
        showToast(key ? 'Geoapify API Key 已保存' : 'Geoapify API Key 已清除');
        log.info(' Geoapify API Key 已保存');
    } catch (e) {
        log.info('保存 Geoapify API Key 失败:', e);
    }
}
