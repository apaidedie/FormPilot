/**
 * 工具函数
 */

/**
 * HTML 转义函数，防止 XSS 攻击
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 显示 toast 提示
 */
function showToast(message) {
    const toast = elements.toast;
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 1500);
}

/**
 * 复制到剪贴板
 */
async function copyToClipboard(text, btn, successMessage = '已复制到剪贴板') {
    try {
        await navigator.clipboard.writeText(text);
        if (btn) {
            const originalText = btn.dataset.copyOriginalText ?? btn.textContent;
            const originalAriaLabel = btn.dataset.copyOriginalAriaLabel ?? btn.getAttribute('aria-label');
            const originalTitle = btn.dataset.copyOriginalTitle ?? btn.getAttribute('title');
            if (!btn.dataset.copyOriginalText) {
                btn.dataset.copyOriginalText = originalText || '';
                btn.dataset.copyOriginalAriaLabel = originalAriaLabel || '';
                btn.dataset.copyOriginalTitle = originalTitle || '';
            }
            if (btn.dataset.copyFeedbackTimer) {
                clearTimeout(Number(btn.dataset.copyFeedbackTimer));
            }
            btn.classList.add('copied');
            btn.textContent = '✓';
            btn.setAttribute('aria-label', '已复制');
            btn.setAttribute('title', '已复制');
            btn.dataset.copyFeedbackTimer = String(setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = originalText;
                if (btn.classList.contains('lock-btn') || btn.classList.contains('copy-btn') || btn.classList.contains('refresh-btn')) {
                    syncFieldActionButton(btn);
                } else if (btn.classList.contains('sensitive-copy')) {
                    syncSensitiveCopyButton(btn);
                } else {
                    if (originalAriaLabel) btn.setAttribute('aria-label', originalAriaLabel);
                    if (originalTitle) btn.setAttribute('title', originalTitle);
                }
                delete btn.dataset.copyOriginalText;
                delete btn.dataset.copyOriginalAriaLabel;
                delete btn.dataset.copyOriginalTitle;
                delete btn.dataset.copyFeedbackTimer;
            }, 1000));
        }
        showToast(successMessage);
    } catch (err) {
        log.error('复制失败:', err);
        showToast('复制失败');
    }
}

function getFieldActionLabel(fieldName) {
    return FIELD_LABELS[fieldName] || fieldName || '字段';
}

function getSensitiveFieldLabel(fieldName) {
    return SENSITIVE_FIELD_LABELS[fieldName] || fieldName || '外部资料';
}

function syncSensitiveCopyButton(btn) {
    if (!btn) return;

    const fieldName = btn.dataset.sensitiveField;
    const label = getSensitiveFieldLabel(fieldName);
    btn.textContent = btn.classList.contains('copied') ? '✓' : '⧉';
    btn.title = `复制${label}`;
    btn.setAttribute('aria-label', btn.title);
}

function syncSensitiveCopyButtons() {
    document.querySelectorAll('.sensitive-copy').forEach(syncSensitiveCopyButton);
}

function syncFieldActionButton(btn) {
    if (!btn) return;

    const fieldName = btn.dataset.field;
    const label = getFieldActionLabel(fieldName);

    if (btn.classList.contains('lock-btn')) {
        const isLocked = lockedFields.has(fieldName);
        btn.classList.toggle('locked', isLocked);
        btn.textContent = isLocked ? '锁' : '未锁';
        btn.title = isLocked ? `解锁${label}` : `锁定${label}`;
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', String(isLocked));
        return;
    }

    if (btn.classList.contains('copy-btn')) {
        btn.textContent = btn.classList.contains('copied') ? '✓' : '⧉';
        btn.title = `复制${label}`;
        btn.setAttribute('aria-label', btn.title);
        return;
    }

    if (btn.classList.contains('refresh-btn')) {
        btn.textContent = '↻';
        btn.title = `重新生成${label}`;
        btn.setAttribute('aria-label', btn.title);
    }
}

function syncFieldActionButtons() {
    document.querySelectorAll('.lock-btn, .copy-btn, .refresh-btn').forEach(syncFieldActionButton);
}

function setControlsDisabled(controls, disabled) {
    const states = controls
        .filter(Boolean)
        .map(control => ({
            control,
            disabled: Boolean(control.disabled),
            ariaDisabled: control.getAttribute('aria-disabled')
        }));

    states.forEach(({ control }) => {
        control.disabled = disabled;
        control.setAttribute('aria-disabled', String(disabled));
    });

    return {
        restore() {
            states.forEach(({ control, disabled: wasDisabled, ariaDisabled }) => {
                control.disabled = wasDisabled;
                if (ariaDisabled === null) {
                    control.removeAttribute('aria-disabled');
                } else {
                    control.setAttribute('aria-disabled', ariaDisabled);
                }
            });
        }
    };
}

function guardCommandDockDuringFill() {
    const controls = [
        elements.copyAll,
        elements.scanCurrentPage,
        elements.regenerateAll,
        elements.useAIToggle,
        elements.fillEmptyOnlyToggle
    ];

    return setControlsDisabled(controls, true);
}

function isAISettingsReady() {
    return Boolean(userSettings.enableAI && String(userSettings.openaiKey || '').trim());
}

function syncAIModeToggleAvailability() {
    const ready = isAISettingsReady();

    if (elements.aiToggleWrapper) {
        elements.aiToggleWrapper.classList.toggle('is-hidden', !ready);
        elements.aiToggleWrapper.title = ready
            ? '切换 AI 模式'
            : '先在设置里启用 AI 并填写 API Key';
        elements.aiToggleWrapper.setAttribute('aria-label', ready ? '切换 AI 模式' : 'AI 模式不可用');
        elements.aiToggleWrapper.setAttribute('aria-disabled', String(!ready));
    }

    if (elements.useAIToggle) {
        elements.useAIToggle.disabled = !ready;
        elements.useAIToggle.setAttribute('aria-disabled', String(!ready));
        if (!ready) elements.useAIToggle.checked = false;
    }

    return ready;
}

function isAIModeEnabled() {
    return Boolean(elements.useAIToggle?.checked && isAISettingsReady());
}

function getPublicProfileData(profile = currentData) {
    const { sensitive, ...publicData } = profile || {};
    return publicData;
}

function getOriginPattern(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return `${parsed.protocol}//${parsed.host}/*`;
    } catch (e) {
        return null;
    }
}

async function ensureHostPermission(url) {
    const origin = getOriginPattern(url);
    if (!origin || !chrome.permissions) return true;

    const permissions = { origins: [origin] };
    const hasPermission = await chrome.permissions.contains(permissions);
    if (hasPermission) return true;

    const granted = await chrome.permissions.request(permissions);
    if (!granted) {
        throw new Error('未授权访问该 API 域名');
    }
    return true;
}

function buildMyProfileFillData() {
    const profile = { ...myProfile, ...readMyProfileFromInputs() };
    myProfile = profile;

    return {
        firstName: profile.profileFirstName,
        lastName: profile.profileLastName,
        email: profile.profileEmail,
        phone: profile.profilePhone,
        address: profile.shippingAddress,
        city: profile.shippingCity,
        state: profile.shippingState,
        zipCode: profile.shippingZipCode,
        country: profile.shippingCountry,
        shippingAddress: profile.shippingAddress,
        shippingCity: profile.shippingCity,
        shippingState: profile.shippingState,
        shippingZipCode: profile.shippingZipCode,
        shippingCountry: profile.shippingCountry,
        billingAddress: profile.billingAddress,
        billingCity: profile.billingCity,
        billingState: profile.billingState,
        billingZipCode: profile.billingZipCode,
        billingCountry: profile.billingCountry,
        cardIssuer: profile.cardIssuer,
        cardNetwork: profile.cardNetwork,
        cardLast4: profile.cardLast4,
        cardExpiry: profile.cardExpiry,
        billingNote: profile.billingNote
    };
}

function compactLabeledLines(pairs) {
    return pairs
        .map(([label, value]) => {
            const text = String(value || '').trim();
            return text ? `${label}: ${text}` : '';
        })
        .filter(Boolean);
}

function appendProfileSection(lines, title, pairs) {
    const sectionLines = compactLabeledLines(pairs);
    if (!sectionLines.length) return;

    if (lines.length) lines.push('');
    lines.push(`${title}:`, ...sectionLines);
}

async function copyMyProfileToClipboard() {
    myProfile = readMyProfileFromInputs();
    const fullName = [myProfile.profileFirstName, myProfile.profileLastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    const lines = [];

    appendProfileSection(lines, '联系人', [
        ['姓名', fullName],
        ['邮箱', myProfile.profileEmail],
        ['电话', myProfile.profilePhone]
    ]);
    appendProfileSection(lines, '收货地址', [
        ['地址', myProfile.shippingAddress],
        ['城市', myProfile.shippingCity],
        ['州/省', myProfile.shippingState],
        ['邮编', myProfile.shippingZipCode],
        ['国家', myProfile.shippingCountry]
    ]);
    appendProfileSection(lines, '账单地址', [
        ['地址', myProfile.billingAddress],
        ['城市', myProfile.billingCity],
        ['州/省', myProfile.billingState],
        ['邮编', myProfile.billingZipCode],
        ['国家', myProfile.billingCountry]
    ]);
    appendProfileSection(lines, '支付摘要', [
        ['发卡行', myProfile.cardIssuer],
        ['卡组织', myProfile.cardNetwork],
        ['尾号', myProfile.cardLast4],
        ['有效期', myProfile.cardExpiry],
        ['账单备注', myProfile.billingNote]
    ]);

    if (!lines.length) {
        showToast('没有可复制的资料');
        return;
    }

    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        showToast('我的资料已复制');
    } catch (err) {
        log.error('复制我的资料失败:', err);
        showToast('复制失败');
    }
}

async function copySectionToClipboard(sectionName, btn) {
    const fields = COPY_SECTION_FIELDS[sectionName];
    if (!fields) return;

    updateCurrentDataFromInputs();

    const lines = fields
        .map(fieldName => {
            const value = currentData[fieldName] || '';
            if (!value) return '';
            const displayValue = fieldName === 'gender'
                ? (value === 'male' ? '男' : value === 'female' ? '女' : value)
                : value;
            return `${FIELD_LABELS[fieldName] || fieldName}: ${displayValue}`;
        })
        .filter(Boolean);

    if (!lines.length) {
        showToast('没有可复制的内容');
        return;
    }

    await copyToClipboard(lines.join('\n'), btn);
}

function buildMailingAddressText(profile) {
    const fullName = [profile.firstName, profile.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    const locality = [profile.city, profile.state, profile.zipCode]
        .filter(Boolean)
        .join(', ')
        .trim();

    return [
        fullName,
        profile.phone,
        profile.address,
        locality,
        profile.country
    ]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join('\n');
}

async function copyMailingAddressToClipboard(btn) {
    updateCurrentDataFromInputs();

    const text = buildMailingAddressText(getPublicProfileData());
    if (!text) {
        showToast('没有可复制的地址');
        return;
    }

    await copyToClipboard(text, btn);
}

/**
 * 一键复制全部信息
 */
async function copyAllToClipboard(btn) {
    updateCurrentDataFromInputs();

    const fullName = [currentData.firstName, currentData.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    const publicFields = [
        ['姓名', fullName],
        ['性别', currentData.gender === 'male' ? '男' : currentData.gender === 'female' ? '女' : currentData.gender],
        ['生日', currentData.birthday],
        ['用户名', currentData.username],
        ['邮箱', currentData.email],
        ['密码', currentData.password],
        ['电话', currentData.phone],
        ['地址', currentData.address],
        ['城市', currentData.city],
        ['州/省', currentData.state],
        ['邮编', currentData.zipCode],
        ['国家', currentData.country]
    ];

    const text = publicFields
        .map(([label, value]) => value ? `${label}: ${value}` : '')
        .filter(Boolean)
        .join('\n');

    if (!text) {
        showToast('没有可复制的内容');
        return;
    }

    await copyToClipboard(text, btn, '已复制全部信息');
}

/**
 * 确保 content script 已注入到指定 tab
 * @param {number} tabId - 标签页 ID
 * @returns {Promise<void>}
 */
async function ensureContentScriptInjected(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                'scripts/selectors/common.js',
                'scripts/selectors/japan.js',
                'scripts/content.js'
            ]
        });
        // 等待脚本初始化
        await new Promise(r => setTimeout(r, 200));
    } catch (e) {
        log.error('[FormPilot] 脚本注入失败:', e);
        throw new Error('无法注入脚本，请刷新页面后重试');
    }
}

/**
 * 安全发送消息到 content script，自动处理脚本未加载的情况
 * @param {number} tabId - 标签页 ID
 * @param {object} message - 要发送的消息
 * @returns {Promise<any>} - content script 的响应
 */
async function sendMessageToTab(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        // content script 未加载，尝试注入
        await ensureContentScriptInjected(tabId);
        return await chrome.tabs.sendMessage(tabId, message);
    }
}

/**
 * 切换字段锁定状态
 */
function toggleLock(fieldName, btn) {
    const label = getFieldActionLabel(fieldName);
    if (lockedFields.has(fieldName)) {
        lockedFields.delete(fieldName);
        syncFieldActionButton(btn);
        showToast(`${label} 已解锁`);
    } else {
        lockedFields.add(fieldName);
        syncFieldActionButton(btn);
        showToast(`${label} 已锁定`);
    }
    saveLockedFields();
    updateProfileOverview();
}

/**
 * 格式化历史记录时间
 */
function formatHistoryTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    // 小于1分钟
    if (diff < 60000) return '刚刚';
    // 小于1小时
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    // 小于24小时
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    // 小于7天
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    // 其他
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ============ 统一错误处理 ============

/**
 * 统一错误处理函数
 * @param {Error} error - 错误对象
 * @param {string} context - 错误上下文描述
 * @param {boolean} showToastMsg - 是否显示 toast 提示
 */
function handleError(error, context = '操作', showToastMsg = true) {
    log.error(`${context}失败:`, error);
    if (showToastMsg) {
        const message = error.message || '未知错误';
        showToast(`${context}失败: ${message.slice(0, 50)}`);
    }
}

/**
 * 包装异步函数，自动处理错误
 * @param {Function} fn - 异步函数
 * @param {string} context - 错误上下文
 */
function withErrorHandler(fn, context) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            handleError(error, context);
        }
    };
}

// ============ 加载状态管理 ============

/**
 * 显示按钮加载状态
 * @param {HTMLElement} btn - 按钮元素
 * @param {string} loadingText - 加载中显示的文字
 * @returns {object} - 包含原始文字和恢复函数的对象
 */
function showLoading(btn, loadingText = '加载中...') {
    if (!btn) return { restore: () => {} };

    const originalText = btn.textContent;
    const originalDisabled = btn.disabled;
    const originalAriaBusy = btn.getAttribute('aria-busy');

    btn.textContent = loadingText;
    btn.disabled = true;
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');

    return {
        originalText,
        restore: () => {
            btn.textContent = originalText;
            btn.disabled = originalDisabled;
            btn.classList.remove('loading');
            if (originalAriaBusy === null) {
                btn.removeAttribute('aria-busy');
            } else {
                btn.setAttribute('aria-busy', originalAriaBusy);
            }
        }
    };
}

/**
 * 显示元素的加载遮罩
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 加载提示文字
 * @returns {Function} - 移除遮罩的函数
 */
function showLoadingOverlay(container, message = '加载中...') {
    if (!container) return () => {};

    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `<div class="loading-spinner"></div><div class="loading-text">${message}</div>`;

    container.classList.add('loading-host');
    container.appendChild(overlay);

    return () => {
        overlay.remove();
        if (!container.querySelector('.loading-overlay')) {
            container.classList.remove('loading-host');
        }
    };
}

/**
 * 执行带加载状态的异步操作
 * @param {HTMLElement} btn - 按钮元素
 * @param {string} loadingText - 加载中文字
 * @param {Function} asyncFn - 异步函数
 * @param {string} errorContext - 错误上下文
 */
async function withLoading(btn, loadingText, asyncFn, errorContext = '操作') {
    const loading = showLoading(btn, loadingText);
    try {
        return await asyncFn();
    } catch (error) {
        handleError(error, errorContext);
    } finally {
        loading.restore();
    }
}
