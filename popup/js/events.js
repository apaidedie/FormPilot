/**
 * 事件绑定模块
 */

// ============ 核心处理函数 ============

/**
 * 处理重新生成全部数据
 */
async function handleRegenerateAll() {
    if (!window.generators) return;

    const btn = elements.regenerateAll;
    const loading = showLoading(btn, '↻ 生成中...');

    try {
        const targetLocation = elements.targetLocation?.value?.trim();
        if (targetLocation) {
            await applyLocationProfile(targetLocation);
            return;
        }

        // 检查 AI 开关是否开启
        if (isAIModeEnabled()) {
            loading.restore();
            await generateWithAI();
            return;
        }

        // 保存锁定字段的值
        const lockedValues = {};
        lockedFields.forEach(field => {
            lockedValues[field] = currentData[field];
        });

        // 生成新数据
        currentData = window.generators.generateAllInfoWithSettings(ipData, userSettings);
        currentData.sensitive = {};
        addressEnhancementState = 'local';

        // 尝试获取真实地址
        await tryFetchRealAddress(lockedValues);

        // 处理临时邮箱
        const domainType = elements.emailDomainType?.value;
        if (domainType === 'temp' && !lockedFields.has('email')) {
            await regenerateEmail();
        }

        // 恢复锁定字段的值
        lockedFields.forEach(field => {
            if (lockedValues[field] !== undefined) {
                currentData[field] = lockedValues[field];
            }
        });

        updateUI();
        saveDataToStorage();
        showToast('数据已生成');

    } catch (error) {
        handleError(error, '生成数据');
    } finally {
        loading.restore();
    }
}

/**
 * 尝试获取真实地址
 */
async function tryFetchRealAddress(lockedValues) {
    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;

    if (!addressApiEnabled || !window.generators.generateAddressAsync || lockedFields.has('address')) {
        if (!addressApiEnabled) setAddressServiceState('off');
        return;
    }

    try {
        showToast('正在获取真实地址...');
        setAddressServiceState('loading');
        const realAddress = await window.generators.generateAddressAsync(
            currentData.country,
            currentData.city
        );

        if (realAddress && realAddress.address) {
            currentData.address = realAddress.address;

            if (realAddress.state && !lockedFields.has('state')) {
                currentData.state = realAddress.state;
            }
            if (realAddress.zipCode && !lockedFields.has('zipCode')) {
                currentData.zipCode = realAddress.zipCode;
            }

            const sourceText = realAddress.source === 'geoapify' ? 'Geoapify' :
                realAddress.source === 'openstreetmap' ? 'OSM' : '本地';
            addressEnhancementState = realAddress.source || 'local';
            if (realAddress.source === 'local') {
                setAddressServiceState('fallback');
            } else {
                setAddressServiceState('ready', `${sourceText} 返回了地图地址，当前资料已更新。`);
            }
            showToast(realAddress.source === 'local'
                ? '地图服务不可用，已用本地地址'
                : `已获取地图地址 (${sourceText})`);
        } else {
            addressEnhancementState = 'fallback';
            setAddressServiceState('fallback');
            showToast('地图服务不可用，已用本地地址');
        }
    } catch (e) {
        log.info('地址 API 调用失败:', e);
        addressEnhancementState = 'fallback';
        setAddressServiceState('fallback');
        showToast('地图服务不可用，已用本地地址');
    }
}

function getLockedValues() {
    const lockedValues = {};
    lockedFields.forEach(field => {
        lockedValues[field] = currentData[field];
    });
    return lockedValues;
}

function restoreLockedValues(lockedValues) {
    lockedFields.forEach(field => {
        if (lockedValues[field] !== undefined) {
            currentData[field] = lockedValues[field];
        }
    });
}

async function applyLocationProfile(location) {
    if (!window.generators?.fetchMeiguodizhiProfile) {
        throw new Error('美国地址服务未加载');
    }

    const lockedValues = getLockedValues();
    const profile = await window.generators.fetchMeiguodizhiProfile(location, userSettings);
    currentData = { ...currentData, ...profile };
    addressEnhancementState = 'local';
    ipData = {
        country: 'United States',
        city: profile.city || '',
        region: profile.state || ''
    };
    restoreLockedValues(lockedValues);
    updateUI();
    saveDataToStorage();
    showToast(`已生成 ${profile.requestedLocation || '美国'} 地址`);
}

async function handleGenerateByLocation() {
    const location = elements.targetLocation?.value?.trim();
    if (!location) {
        showToast('请输入美国州或城市');
        return;
    }

    const btn = elements.generateByLocation;
    const loading = showLoading(btn, '...');

    try {
        await applyLocationProfile(location);
    } catch (error) {
        handleError(error, '按位置生成');
    } finally {
        loading.restore();
    }
}

/**
 * 处理国家切换
 */
async function handleCountryChange() {
    if (!window.generators) return;

    const newCountry = elements.fields.country.value;
    ipData.country = newCountry;
    ipData.city = '';
    ipData.region = '';

    // 保存锁定字段的值
    const lockedValues = {};
    lockedFields.forEach(field => {
        lockedValues[field] = currentData[field];
    });

    currentData = window.generators.generateAllInfoWithSettings(ipData, userSettings);
    currentData.sensitive = {};
    addressEnhancementState = 'local';

    // 恢复锁定字段的值
    lockedFields.forEach(field => {
        if (lockedValues[field] !== undefined) {
            currentData[field] = lockedValues[field];
        }
    });

    updateUI();
    saveDataToStorage();
    showToast(`已切换到 ${newCountry}`);
}

/**
 * 处理单字段刷新
 */
function handleFieldRefresh(fieldName) {
    if (!window.generators) return;

    // 如果字段被锁定，不进行刷新
    if (lockedFields.has(fieldName)) {
        showToast(`${fieldName} 已锁定，无法刷新`);
        return;
    }

    updateCurrentDataFromInputs();
    const result = window.generators.regenerateField(fieldName, currentData, ipData);

    if (result && result._isLocationUpdate) {
        addressEnhancementState = 'local';
        // 位置更新时也要检查锁定状态
        if (!lockedFields.has('city')) {
            currentData.city = result.city;
            if (elements.fields.city) elements.fields.city.value = result.city;
        }
        if (!lockedFields.has('state')) {
            currentData.state = result.state;
            if (elements.fields.state) elements.fields.state.value = result.state;
        }
        if (!lockedFields.has('zipCode')) {
            currentData.zipCode = result.zipCode;
            if (elements.fields.zipCode) elements.fields.zipCode.value = result.zipCode;
        }
    } else {
        if (fieldName === 'address') {
            addressEnhancementState = 'local';
        }
        currentData[fieldName] = result;
        if (elements.fields[fieldName]) {
            elements.fields[fieldName].value = currentData[fieldName];
        }
    }
    updateProfileOverview();
    saveDataToStorage();
}

/**
 * 处理邮箱域名类型切换
 */
function handleEmailDomainChange() {
    const domain = elements.emailDomainType.value;

    if (domain === 'custom') {
        if (elements.customDomain) elements.customDomain.classList.remove('is-hidden');
        if (elements.customDomain?.value?.trim() && window.generators) {
            window.generators.setCustomEmailDomain(elements.customDomain.value.trim());
            regenerateEmail();
        }
    } else {
        if (elements.customDomain) elements.customDomain.classList.add('is-hidden');
        if (window.generators) {
            window.generators.setCustomEmailDomain(domain);
            regenerateEmail();
        }
    }
    saveDataToStorage();
}

/**
 * 处理 IP 刷新
 */
async function handleIPRefresh() {
    const btn = elements.ipRefresh;
    const loading = showLoading(btn, '↻');

    try {
        await fetchIPInfo();
        showToast('已更新位置信息');
    } catch (error) {
        handleError(error, 'IP 检测');
    } finally {
        loading.restore();
    }
}

function updateSectionToggleState(section, collapsed) {
    const toggle = section.querySelector('[data-section-toggle]');
    const bodyId = toggle?.getAttribute('aria-controls');
    const body = bodyId ? document.getElementById(bodyId) : null;

    section.classList.toggle('collapsed', collapsed);
    toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (toggle) {
        toggle.title = collapsed ? toggle.dataset.collapsedTitle : toggle.dataset.expandedTitle;
    }
    if (body) {
        body.hidden = collapsed;
    }
}

function getProfileSectionStates() {
    const states = {};
    document.querySelectorAll('.field-section[data-profile-section]').forEach(section => {
        const name = section.dataset.profileSection;
        if (name) states[name] = section.classList.contains('collapsed');
    });
    return states;
}

async function saveProfileSectionStates() {
    try {
        await chrome.storage.local.set({ [PROFILE_SECTIONS_KEY]: getProfileSectionStates() });
    } catch (error) {
        log.warn('saveProfileSectionStates failed:', error);
    }
}

async function loadProfileSectionStates() {
    try {
        const result = await chrome.storage.local.get(PROFILE_SECTIONS_KEY);
        return result[PROFILE_SECTIONS_KEY] || {};
    } catch (error) {
        log.warn('loadProfileSectionStates failed:', error);
        return {};
    }
}

async function bindProfileSectionToggles() {
    const savedStates = await loadProfileSectionStates();
    document.querySelectorAll('.field-section [data-section-toggle]').forEach(toggle => {
        const section = toggle.closest('.field-section');
        if (!section) return;

        const name = section.dataset.profileSection;
        const collapsed = Object.prototype.hasOwnProperty.call(savedStates, name) ? savedStates[name] === true : false;
        updateSectionToggleState(section, collapsed);
        toggle.addEventListener('click', () => {
            const nextCollapsed = !section.classList.contains('collapsed');
            updateSectionToggleState(section, nextCollapsed);
            saveProfileSectionStates();
        });
    });
}

function syncWorkflowGuideState(expanded = false) {
    if (!elements.workflowGuide || !elements.workflowGuideToggle || !elements.workflowGuideDetails) return;

    elements.workflowGuide.dataset.state = expanded ? 'expanded' : 'compact';
    elements.workflowGuideToggle.textContent = expanded ? '收起' : '展开';
    elements.workflowGuideToggle.title = expanded ? '收起安全填表流程' : '展开安全填表流程';
    elements.workflowGuideToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    elements.workflowGuideDetails.hidden = !expanded;
}

function toggleWorkflowGuide() {
    if (!elements.workflowGuideToggle) return;
    syncWorkflowGuideState(elements.workflowGuideToggle.getAttribute('aria-expanded') !== 'true');
}

function getDefaultShortcutLabel() {
    return navigator.platform?.toLowerCase().includes('mac') ? 'Command+Shift+F' : 'Ctrl+Shift+F';
}

async function syncShortcutHint() {
    if (!elements.shortcutHint || !elements.shortcutHintKey || !elements.shortcutHintDetail) return;

    let shortcut = getDefaultShortcutLabel();

    try {
        const commands = await chrome.commands.getAll();
        const fillCommand = commands.find(command => command.name === 'fill-form');
        if (fillCommand && typeof fillCommand.shortcut === 'string') {
            shortcut = fillCommand.shortcut.trim() || '快捷键未绑定';
        }
    } catch (error) {
        log.warn('syncShortcutHint failed:', error);
    }

    const detail = shortcut === '快捷键未绑定'
        ? '快捷键未绑定，仍可使用填写表单按钮；公开资料与空白优先边界不变。'
        : '与 Fill 使用同一安全边界：公开资料，空白优先。';
    elements.shortcutHintKey.textContent = shortcut;
    elements.shortcutHintKey.title = shortcut === '快捷键未绑定' ? '当前没有绑定快捷键' : `当前快捷键：${shortcut}`;
    elements.shortcutHintDetail.textContent = detail;
    elements.shortcutHint.title = `${shortcut} · ${detail}`;
}

function updateSensitiveToggleState(collapsed) {
    if (!elements.toggleSensitive || !elements.sensitiveSection) return;

    elements.sensitiveSection.classList.toggle('collapsed', collapsed);
    elements.toggleSensitive.textContent = collapsed ? '展开' : '收起';
    elements.toggleSensitive.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (elements.sensitiveGrid) {
        elements.sensitiveGrid.hidden = collapsed;
    }
}

// ============ 事件绑定 ============

/**
 * 绑定所有事件处理器
 */
async function bindEvents() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeActiveModal();
            return;
        }
        trapModalFocus(e);
    });

    // 主题切换
    if (elements.themeToggle) {
        elements.themeToggle.addEventListener('click', toggleTheme);
    }

    // IP 刷新
    if (elements.ipRefresh) {
        elements.ipRefresh.addEventListener('click', handleIPRefresh);
    }

    // 按美国位置生成
    if (elements.generateByLocation) {
        elements.generateByLocation.addEventListener('click', handleGenerateByLocation);
    }

    await bindProfileSectionToggles();

    if (elements.targetLocation) {
        elements.targetLocation.addEventListener('input', updateProfileOverview);
        elements.targetLocation.addEventListener('change', () => {
            updateProfileOverview();
            saveDataToStorage();
        });
        elements.targetLocation.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleGenerateByLocation();
            }
        });
    }

    if (elements.toggleSensitive && elements.sensitiveSection) {
        updateSensitiveToggleState(elements.sensitiveSection.classList.contains('collapsed'));
        elements.toggleSensitive.addEventListener('click', () => {
            updateSensitiveToggleState(!elements.sensitiveSection.classList.contains('collapsed'));
        });
    }

    // 收件箱刷新
    if (elements.refreshInbox) {
        elements.refreshInbox.addEventListener('click', refreshInbox);
    }

    // 重新生成全部
    if (elements.regenerateAll) {
        elements.regenerateAll.addEventListener('click', handleRegenerateAll);
    }

    // 填表
    if (elements.fillForm) {
        elements.fillForm.addEventListener('click', fillFormInPage);
    }

    if (elements.workflowGuideToggle) {
        syncWorkflowGuideState(elements.workflowGuideToggle.getAttribute('aria-expanded') === 'true');
        elements.workflowGuideToggle.addEventListener('click', toggleWorkflowGuide);
        elements.workflowGuideToggle.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleWorkflowGuide();
            }
        });
    }

    syncShortcutHint();

    // 扫描当前页表单
    if (elements.scanCurrentPage) {
        elements.scanCurrentPage.addEventListener('click', scanCurrentPageForms);
    }

    // AI 开关
    if (elements.useAIToggle) {
        elements.useAIToggle.addEventListener('change', () => {
            syncAIModeToggleAvailability();
            updateProfileOverview();
            updateFillReadiness();
            chrome.storage.local.set({ [AI_MODE_KEY]: elements.useAIToggle.checked && isAISettingsReady() });
        });
    }

    if (elements.fillEmptyOnlyToggle) {
        elements.fillEmptyOnlyToggle.addEventListener('change', () => {
            updateFillReadiness();
            chrome.storage.local.set({ [FILL_EMPTY_ONLY_KEY]: elements.fillEmptyOnlyToggle.checked });
        });
    }

    const addressApiToggle = document.getElementById('useAddressApiToggle');
    if (addressApiToggle) {
        addressApiToggle.addEventListener('change', () => {
            chrome.storage.local.set({ [ADDRESS_API_ENABLED_KEY]: addressApiToggle.checked });
            syncAddressServiceState();
            updateProfileOverview();
            updateSettingsOverview();
            updateFillReadiness();
        });
    }

    // 锁定按钮
    document.querySelectorAll('.lock-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const fieldName = e.currentTarget.dataset.field;
            toggleLock(fieldName, e.currentTarget);
        });
    });

    // 复制按钮
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const fieldName = e.currentTarget.dataset.field;
            const value = currentData[fieldName] || elements.fields[fieldName]?.value;
            if (value) {
                copyToClipboard(value, e.currentTarget);
            }
        });
    });

    // 敏感资料只允许手动复制，不参与一键填表
    document.querySelectorAll('.sensitive-copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const fieldName = e.currentTarget.dataset.sensitiveField;
            const value = currentData.sensitive?.[fieldName] || elements.sensitiveFields[fieldName]?.value;
            if (value) {
                copyToClipboard(value, e.currentTarget);
            }
        });
    });

    document.addEventListener('click', (e) => {
        const mailingBtn = e.target.closest('#copyMailingAddress');
        if (mailingBtn) {
            copyMailingAddressToClipboard(mailingBtn);
            return;
        }

        const btn = e.target.closest('.section-copy-btn');
        if (!btn) return;
        if (!btn.dataset.copySection) return;
        copySectionToClipboard(btn.dataset.copySection, btn);
    });

    // 单字段刷新按钮
    document.querySelectorAll('.refresh-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            handleFieldRefresh(e.currentTarget.dataset.field);
        });
    });

    // 字段输入事件
    FIELD_NAMES.forEach(name => {
        if (elements.fields[name]) {
            const handler = () => {
                currentData[name] = elements.fields[name].value;
                updateProfileOverview();
                saveDataToStorage();
            };
            elements.fields[name].addEventListener('input', handler);
            elements.fields[name].addEventListener('change', handler);
        }
    });

    // 国家切换
    if (elements.fields.country) {
        elements.fields.country.addEventListener('change', handleCountryChange);
    }

    // 邮箱域名类型切换
    if (elements.emailDomainType) {
        elements.emailDomainType.addEventListener('change', handleEmailDomainChange);
    }

    // 自定义域名输入
    if (elements.customDomain) {
        elements.customDomain.addEventListener('input', () => {
            const domain = elements.customDomain.value.trim();
            if (domain && window.generators) {
                window.generators.setCustomEmailDomain(domain);
                regenerateEmail();
            }
            saveDataToStorage();
        });
    }

    // 绑定设置相关事件
    bindSettingsEvents();
}

/**
 * 绑定设置相关事件
 */
function bindSettingsEvents() {
    // 设置模态框
    if (elements.openSettings) {
        elements.openSettings.addEventListener('click', openSettingsModal);
    }
    if (elements.closeSettings) {
        elements.closeSettings.addEventListener('click', closeSettingsModal);
    }
    if (elements.settingsModal) {
        elements.settingsModal.addEventListener('click', (e) => {
            if (e.target === elements.settingsModal) {
                closeSettingsModal();
            }
        });
    }

    // 复制全部
    if (elements.copyAll) {
        elements.copyAll.addEventListener('click', (e) => copyAllToClipboard(e.currentTarget));
    }

    // 存档
    if (elements.saveArchive) {
        elements.saveArchive.addEventListener('click', saveArchive);
    }

    if (elements.archiveSearch) {
        elements.archiveSearch.addEventListener('input', () => {
            resetArchiveDeleteConfirmState();
            renderFilteredArchiveList();
        });
    }

    // AI 测试
    if (elements.testAI) {
        elements.testAI.addEventListener('click', testAIConnection);
    }

    if (elements.toggleOpenAIKeyVisibility) {
        elements.toggleOpenAIKeyVisibility.addEventListener('click', toggleOpenAIKeyVisibility);
    }

    // 存档列表
    if (elements.archiveList) {
        elements.archiveList.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;

            const action = btn.dataset.action;
            const index = parseInt(btn.dataset.index);

            if (action === 'load') {
                resetArchiveDeleteConfirmState();
                loadArchive(index);
            } else if (action === 'delete') {
                if (btn.dataset.confirming === 'true') {
                    deleteArchive(index);
                } else {
                    markArchiveDeleteConfirm(btn);
                    showToast('再次点击确认删除存档');
                }
            }
        });
    }

    // 设置输入项自动保存
    const settingInputs = [
        'enableAI', 'openaiBaseUrl', 'openaiKey', 'openaiModel', 'aiPersona',
        'passwordLength', 'pwdUppercase', 'pwdLowercase', 'pwdNumbers', 'pwdSymbols',
        'minAge', 'maxAge', 'autoClearData'
    ];
    settingInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', async () => {
                await saveSettings();
                updateSettingsOverview();
            });
        }
    });

    // Geoapify API Key
    if (elements.geoapifyKey) {
        const syncGeoapifyKey = async () => {
            await saveGeoapifyKey();
            updateSettingsOverview();
        };
        elements.geoapifyKey.addEventListener('change', syncGeoapifyKey);
        elements.geoapifyKey.addEventListener('blur', syncGeoapifyKey);
        elements.geoapifyKey.addEventListener('input', updateSettingsOverview);
    }

    bindMyProfileEvents();

    // 历史记录
    bindHistoryEvents();
}

function toggleOpenAIKeyVisibility() {
    if (!elements.openaiKey || !elements.toggleOpenAIKeyVisibility) return;

    const isVisible = elements.openaiKey.type === 'text';
    const shouldShow = !isVisible;
    elements.openaiKey.type = shouldShow ? 'text' : 'password';
    elements.toggleOpenAIKeyVisibility.textContent = shouldShow ? '隐藏' : '显示';
    elements.toggleOpenAIKeyVisibility.setAttribute('aria-pressed', String(shouldShow));
    elements.toggleOpenAIKeyVisibility.setAttribute('aria-label', shouldShow ? '隐藏 API Key' : '显示 API Key');
    elements.toggleOpenAIKeyVisibility.title = shouldShow ? '隐藏 API Key' : '显示 API Key';
}

function bindMyProfileEvents() {
    if (elements.openMyProfile) {
        elements.openMyProfile.addEventListener('click', () => {
            updateMyProfileUI();
            updateMyProfileCompleteness();
            openModal(elements.myProfileModal);
        });
    }

    if (elements.closeMyProfile) {
        elements.closeMyProfile.addEventListener('click', () => {
            closeModal(elements.myProfileModal);
        });
    }

    if (elements.myProfileModal) {
        elements.myProfileModal.addEventListener('click', (e) => {
            if (e.target === elements.myProfileModal) {
                closeModal(elements.myProfileModal);
            }
        });
    }

    if (elements.saveMyProfile) {
        elements.saveMyProfile.addEventListener('click', saveMyProfileData);
    }

    if (elements.copyShippingToBilling) {
        elements.copyShippingToBilling.addEventListener('click', copyShippingAddressToBilling);
    }

    if (elements.myProfileCompletenessChips) {
        elements.myProfileCompletenessChips.addEventListener('click', (e) => {
            const chip = e.target.closest('.profile-completeness-chip');
            if (!chip) return;

            const target = elements.myProfileFields[chip.dataset.missingField];
            if (target) {
                target.focus();
                const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
            }
        });
    }

    if (elements.myProfileFields.cardLast4) {
        elements.myProfileFields.cardLast4.addEventListener('paste', (e) => {
            const text = e.clipboardData?.getData('text') || '';
            if (!text) return;
            e.preventDefault();
            e.currentTarget.value = normalizeCardLast4(text);
            e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
        });
        elements.myProfileFields.cardLast4.addEventListener('input', (e) => {
            e.currentTarget.value = normalizeCardLast4(e.currentTarget.value);
            updateMyProfileCompleteness();
        });
    }

    if (elements.myProfileFields.cardExpiry) {
        elements.myProfileFields.cardExpiry.addEventListener('paste', (e) => {
            const text = e.clipboardData?.getData('text') || '';
            if (!text) return;
            e.preventDefault();
            e.currentTarget.value = normalizeCardExpiry(text);
            e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
        });
        elements.myProfileFields.cardExpiry.addEventListener('input', (e) => {
            e.currentTarget.value = normalizeCardExpiry(e.currentTarget.value);
            updateMyProfileCompleteness();
        });
    }

    MY_PROFILE_FIELD_NAMES.forEach(name => {
        const el = elements.myProfileFields[name];
        if (!el) return;
        const syncProfileInput = () => {
            updateMyProfileCompleteness();
            if (name.startsWith('shipping')) updateCopyShippingToBillingState();
            scheduleMyProfileAutoSave();
        };
        el.addEventListener('input', syncProfileInput);
        el.addEventListener('change', syncProfileInput);
    });

    if (elements.fillMyProfile) {
        elements.fillMyProfile.addEventListener('click', fillMyProfileInPage);
    }

    if (elements.copyMyProfile) {
        elements.copyMyProfile.addEventListener('click', copyMyProfileToClipboard);
    }

    if (elements.exportMyProfile) {
        elements.exportMyProfile.addEventListener('click', exportMyProfileData);
    }

    if (elements.importMyProfile && elements.myProfileImportFile) {
        elements.importMyProfile.addEventListener('click', () => {
            elements.myProfileImportFile.click();
        });
        elements.myProfileImportFile.addEventListener('change', async (e) => {
            await importMyProfileFromFile(e.currentTarget.files?.[0]);
            e.currentTarget.value = '';
        });
    }

    if (elements.clearMyProfile) {
        elements.clearMyProfile.addEventListener('click', handleClearMyProfileClick);
    }
}

function resetClearMyProfileConfirmState() {
    if (clearMyProfileConfirmTimer) {
        clearTimeout(clearMyProfileConfirmTimer);
        clearMyProfileConfirmTimer = null;
    }
    if (!elements.clearMyProfile) return;
    elements.clearMyProfile.dataset.confirming = 'false';
    elements.clearMyProfile.classList.remove('confirming');
    elements.clearMyProfile.textContent = '清空';
    elements.clearMyProfile.title = '清空我的资料';
    elements.clearMyProfile.setAttribute('aria-label', '清空我的资料');
    elements.clearMyProfile.setAttribute('aria-pressed', 'false');
}

async function handleClearMyProfileClick() {
    if (!elements.clearMyProfile) return;

    if (elements.clearMyProfile.dataset.confirming === 'true') {
        resetClearMyProfileConfirmState();
        await clearMyProfileData();
        return;
    }

    elements.clearMyProfile.dataset.confirming = 'true';
    elements.clearMyProfile.classList.add('confirming');
    elements.clearMyProfile.textContent = '确认清空';
    elements.clearMyProfile.title = '再次点击清空我的资料';
    elements.clearMyProfile.setAttribute('aria-label', '再次点击清空我的资料');
    elements.clearMyProfile.setAttribute('aria-pressed', 'true');
    showToast('再次点击确认清空');
    clearMyProfileConfirmTimer = setTimeout(resetClearMyProfileConfirmState, 3200);
}

/**
 * 绑定历史记录相关事件
 */
function bindHistoryEvents() {
    if (elements.openHistory) {
        elements.openHistory.addEventListener('click', () => {
            if (elements.historyModal) {
                openModal(elements.historyModal);
                if (elements.historySearch) elements.historySearch.value = '';
                loadHistoryList();
            }
        });
    }

    if (elements.closeHistory) {
        elements.closeHistory.addEventListener('click', () => {
            closeModal(elements.historyModal);
        });
    }

    if (elements.historyModal) {
        elements.historyModal.addEventListener('click', (e) => {
            if (e.target === elements.historyModal) {
                closeModal(elements.historyModal);
            }
        });
    }

    if (elements.clearHistory) {
        elements.clearHistory.addEventListener('click', handleClearHistoryClick);
    }

    if (elements.historySearch) {
        elements.historySearch.addEventListener('input', () => {
            resetHistoryItemDeleteConfirmState();
            renderFilteredHistoryList();
        });
    }
}

function resetClearHistoryConfirmState() {
    if (clearHistoryConfirmTimer) {
        clearTimeout(clearHistoryConfirmTimer);
        clearHistoryConfirmTimer = null;
    }
    if (!elements.clearHistory) return;
    elements.clearHistory.dataset.confirming = 'false';
    elements.clearHistory.classList.remove('confirming');
    elements.clearHistory.textContent = '清空历史';
    elements.clearHistory.title = '清空历史记录';
    elements.clearHistory.setAttribute('aria-label', '清空历史记录');
    elements.clearHistory.setAttribute('aria-pressed', 'false');
}

async function handleClearHistoryClick() {
    if (!elements.clearHistory) return;

    if (elements.clearHistory.dataset.confirming === 'true') {
        resetClearHistoryConfirmState();
        await clearAllHistory();
        return;
    }

    elements.clearHistory.dataset.confirming = 'true';
    elements.clearHistory.classList.add('confirming');
    elements.clearHistory.textContent = '确认清空';
    elements.clearHistory.title = '再次点击清空历史记录';
    elements.clearHistory.setAttribute('aria-label', '再次点击清空历史记录');
    elements.clearHistory.setAttribute('aria-pressed', 'true');
    showToast('再次点击确认清空历史');
    clearHistoryConfirmTimer = setTimeout(resetClearHistoryConfirmState, 3200);
}
