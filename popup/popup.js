/**
 * Popup 主逻辑 - 初始化与协调
 * 全局变量 (currentData, ipData, lockedFields, userSettings, elements)
 * 已在 constants.js 中声明
 */

/**
 * 初始化
 */
document.addEventListener('DOMContentLoaded', async () => {
    log.info(' 开始初始化...');

    try { await window.FormPilotStorageMigration.migrateLegacyStorageKeys(); } catch (e) { log.info('storage migration error:', e); }

    // 缓存 DOM 元素
    elements.ipInfo = document.getElementById('ipInfo');
    elements.ipRefresh = document.getElementById('ipRefresh');
    elements.openMyProfile = document.getElementById('openMyProfile');
    elements.myProfileHeaderStatus = document.getElementById('myProfileHeaderStatus');
    elements.closeMyProfile = document.getElementById('closeMyProfile');
    elements.myProfileModal = document.getElementById('myProfileModal');
    elements.copyShippingToBilling = document.getElementById('copyShippingToBilling');
    elements.saveMyProfile = document.getElementById('saveMyProfile');
    elements.fillMyProfile = document.getElementById('fillMyProfile');
    elements.copyMyProfile = document.getElementById('copyMyProfile');
    elements.importMyProfile = document.getElementById('importMyProfile');
    elements.exportMyProfile = document.getElementById('exportMyProfile');
    elements.myProfileImportFile = document.getElementById('myProfileImportFile');
    elements.clearMyProfile = document.getElementById('clearMyProfile');
    elements.myProfileStatus = document.getElementById('myProfileStatus');
    elements.myProfileCompleteness = document.getElementById('myProfileCompleteness');
    elements.myProfileCompletenessScore = document.getElementById('myProfileCompletenessScore');
    elements.myProfileCompletenessBar = document.getElementById('myProfileCompletenessBar');
    elements.myProfileCompletenessHint = document.getElementById('myProfileCompletenessHint');
    elements.myProfileCompletenessChips = document.getElementById('myProfileCompletenessChips');
    elements.targetLocation = document.getElementById('targetLocation');
    elements.generateByLocation = document.getElementById('generateByLocation');
    elements.addressServiceState = document.getElementById('addressServiceState');
    elements.toggleSensitive = document.getElementById('toggleSensitive');
    elements.sensitiveSection = document.getElementById('sensitiveSection');
    elements.sensitiveGrid = document.getElementById('sensitiveGrid');
    elements.regenerateAll = document.getElementById('regenerateAll');
    elements.fillForm = document.getElementById('fillForm');
    elements.workflowGuide = document.getElementById('workflowGuide');
    elements.workflowGuideToggle = document.getElementById('workflowGuideToggle');
    elements.workflowGuideDetails = document.getElementById('workflowGuideDetails');
    elements.shortcutHint = document.getElementById('shortcutHint');
    elements.shortcutHintKey = document.getElementById('shortcutHintKey');
    elements.shortcutHintDetail = document.getElementById('shortcutHintDetail');
    elements.scanCurrentPage = document.getElementById('scanCurrentPage');
    elements.pageScanPanel = document.getElementById('pageScanPanel');
    elements.pageScanTitle = document.getElementById('pageScanTitle');
    elements.pageScanDetail = document.getElementById('pageScanDetail');
    elements.pageScanMeta = document.getElementById('pageScanMeta');
    elements.pageScanMatchChip = document.getElementById('pageScanMatchChip');
    elements.pageScanRequiredChip = document.getElementById('pageScanRequiredChip');
    elements.pageScanSensitiveChip = document.getElementById('pageScanSensitiveChip');
    elements.pageScanPlan = document.getElementById('pageScanPlan');
    elements.pageScanPlanTitle = document.getElementById('pageScanPlanTitle');
    elements.pageScanPlanMatched = document.getElementById('pageScanPlanMatched');
    elements.pageScanPlanUnmatched = document.getElementById('pageScanPlanUnmatched');
    elements.pageScanPlanSensitive = document.getElementById('pageScanPlanSensitive');
    elements.lastFillResult = document.getElementById('lastFillResult');
    elements.lastFillResultTitle = document.getElementById('lastFillResultTitle');
    elements.lastFillResultDetail = document.getElementById('lastFillResultDetail');
    elements.lastFillFilled = document.getElementById('lastFillFilled');
    elements.lastFillSkipped = document.getElementById('lastFillSkipped');
    elements.lastFillMissed = document.getElementById('lastFillMissed');
    elements.profileOverview = document.getElementById('profileOverview');
    elements.profileOverviewScore = document.getElementById('profileOverviewScore');
    elements.profileOverviewName = document.getElementById('profileOverviewName');
    elements.profileOverviewDetail = document.getElementById('profileOverviewDetail');
    elements.profileOverviewBar = document.getElementById('profileOverviewBar');
    elements.profileOverviewMissing = document.getElementById('profileOverviewMissing');
    elements.profileOverviewLocked = document.getElementById('profileOverviewLocked');
    elements.profileOverviewSource = document.getElementById('profileOverviewSource');
    elements.profileOverviewGap = document.getElementById('profileOverviewGap');
    elements.countryCoverageList = document.getElementById('countryCoverageList');
    document.querySelectorAll('[data-section-completion]').forEach(el => {
        elements.sectionCompletions[el.dataset.sectionCompletion] = el;
    });
    elements.fillEmptyOnlyToggle = document.getElementById('fillEmptyOnlyToggle');
    elements.fillEmptyOnlyWrapper = document.getElementById('fillEmptyOnlyWrapper');
    elements.useAIToggle = document.getElementById('useAIToggle');
    elements.aiToggleWrapper = document.getElementById('aiToggleWrapper');
    elements.fillReadiness = document.getElementById('fillReadiness');
    elements.fillReadinessTitle = document.getElementById('fillReadinessTitle');
    elements.fillReadinessScore = document.getElementById('fillReadinessScore');
    elements.fillReadinessBar = document.getElementById('fillReadinessBar');
    elements.fillReadinessHint = document.getElementById('fillReadinessHint');
    elements.fillReadyProfile = document.getElementById('fillReadyProfile');
    elements.fillReadyPage = document.getElementById('fillReadyPage');
    elements.fillReadyMode = document.getElementById('fillReadyMode');
    elements.fillReadyAI = document.getElementById('fillReadyAI');
    elements.fillReadyAddress = document.getElementById('fillReadyAddress');
    elements.fillReadySavedProfile = document.getElementById('fillReadySavedProfile');
    elements.themeToggle = document.getElementById('themeToggle');
    elements.toast = document.getElementById('toast');

    FIELD_NAMES.forEach(name => {
        elements.fields[name] = document.getElementById(name);
    });

    SENSITIVE_FIELD_NAMES.forEach(name => {
        elements.sensitiveFields[name] = document.getElementById(name);
    });

    MY_PROFILE_FIELD_NAMES.forEach(name => {
        elements.myProfileFields[name] = document.getElementById(name);
    });

    syncFieldActionButtons();
    syncSensitiveCopyButtons();

    elements.emailDomainType = document.getElementById('emailDomainType');
    elements.customDomain = document.getElementById('customDomain');

    elements.copyAll = document.getElementById('copyAll');
    elements.openSettings = document.getElementById('openSettings');
    elements.closeSettings = document.getElementById('closeSettings');
    elements.settingsModal = document.getElementById('settingsModal');
    elements.settingsOverview = document.getElementById('settingsOverview');
    document.querySelectorAll('[data-settings-overview]').forEach(el => {
        elements.settingsOverviewItems[el.dataset.settingsOverview] = el;
    });
    elements.enableAI = document.getElementById('enableAI');
    elements.openaiBaseUrl = document.getElementById('openaiBaseUrl');
    elements.openaiKey = document.getElementById('openaiKey');
    elements.toggleOpenAIKeyVisibility = document.getElementById('toggleOpenAIKeyVisibility');
    elements.openaiModel = document.getElementById('openaiModel');
    elements.aiPersona = document.getElementById('aiPersona');
    elements.passwordLength = document.getElementById('passwordLength');
    elements.testAI = document.getElementById('testAI');
    elements.pwdUppercase = document.getElementById('pwdUppercase');
    elements.pwdLowercase = document.getElementById('pwdLowercase');
    elements.pwdNumbers = document.getElementById('pwdNumbers');
    elements.pwdSymbols = document.getElementById('pwdSymbols');
    elements.minAge = document.getElementById('minAge');
    elements.maxAge = document.getElementById('maxAge');
    elements.autoClearData = document.getElementById('autoClearData');
    elements.archiveName = document.getElementById('archiveName');
    elements.archiveSearch = document.getElementById('archiveSearch');
    elements.archiveInfo = document.getElementById('archiveInfo');
    elements.saveArchive = document.getElementById('saveArchive');
    elements.archiveList = document.getElementById('archiveList');
    elements.inboxGroup = document.getElementById('inboxGroup');
    elements.refreshInbox = document.getElementById('refreshInbox');
    elements.inboxList = document.getElementById('inboxList');
    elements.openHistory = document.getElementById('openHistory');
    elements.closeHistory = document.getElementById('closeHistory');
    elements.historyModal = document.getElementById('historyModal');
    elements.historySearch = document.getElementById('historySearch');
    elements.historyInfo = document.getElementById('historyInfo');
    elements.historyList = document.getElementById('historyList');
    elements.clearHistory = document.getElementById('clearHistory');
    elements.geoapifyKey = document.getElementById('geoapifyKey');

    // 加载配置
    try { await loadTheme(); } catch (e) { log.info('loadTheme error:', e); }
    try { await loadSettings(); } catch (e) { log.info('loadSettings error:', e); }
    try { await loadMyProfileData(); } catch (e) { log.info('loadMyProfileData error:', e); }
    try { await loadLockedFields(); } catch (e) { log.info('loadLockedFields error:', e); }

    // 加载命令栏开关状态
    try {
        const result = await chrome.storage.local.get([AI_MODE_KEY, FILL_EMPTY_ONLY_KEY, ADDRESS_API_ENABLED_KEY]);
        if (elements.useAIToggle) {
            elements.useAIToggle.checked = result[AI_MODE_KEY] === true && isAISettingsReady();
            if (result[AI_MODE_KEY] === true && !isAISettingsReady()) {
                await chrome.storage.local.set({ [AI_MODE_KEY]: false });
            }
        }
        if (elements.fillEmptyOnlyToggle) {
            elements.fillEmptyOnlyToggle.checked = result[FILL_EMPTY_ONLY_KEY] === true;
        }
        const addressApiToggle = document.getElementById('useAddressApiToggle');
        if (addressApiToggle) {
            addressApiToggle.checked = result[ADDRESS_API_ENABLED_KEY] !== false;
        }
        syncAIModeToggleAvailability();
    } catch (e) { log.info('loadCommandToggles error:', e); }

    // 绑定事件
    await bindEvents();

    // 加载数据
    let cachedData = null;
    try {
        cachedData = await loadDataFromStorage();
    } catch (e) {
        log.info('loadDataFromStorage error:', e);
    }

    if (cachedData && cachedData.currentData && Object.keys(cachedData.currentData).length > 0) {
        log.info(' 使用缓存数据');
        currentData = cachedData.currentData;
        ipData = cachedData.ipData || {};

        if (cachedData.emailDomain && elements.emailDomainType) {
            elements.emailDomainType.value = cachedData.emailDomain;
            if (cachedData.emailDomain === 'custom' && cachedData.customDomain && elements.customDomain) {
                elements.customDomain.value = cachedData.customDomain;
                elements.customDomain.classList.remove('is-hidden');
            }

            // 如果是临时邮箱，尝试恢复会话
            if (cachedData.emailDomain === 'temp' && window.mailTM && currentData.email && currentData.password) {
                if (elements.inboxGroup) elements.inboxGroup.classList.remove('is-hidden');
                window.mailTM.login(currentData.email, currentData.password).then(() => {
                    refreshInbox();
                }).catch(e => log.info('Silent login failed:', e));
            }
        }

        if (cachedData.targetLocation && elements.targetLocation) {
            elements.targetLocation.value = cachedData.targetLocation;
        }

        if (window.generators) {
            window.generators.setCustomEmailDomain(elements.emailDomainType?.value || 'gmail.com');
        }

        if (elements.ipInfo) {
            if (ipData.city && ipData.country) {
                if (ipData.city === ipData.country || ipData.city === 'Singapore' || ipData.city === 'Hong Kong') {
                    elements.ipInfo.innerHTML = `<span class="location">${ipData.country}</span>`;
                } else {
                    elements.ipInfo.innerHTML = `<span class="location">${ipData.city}, ${ipData.country}</span>`;
                }
            } else if (ipData.country) {
                elements.ipInfo.innerHTML = `<span class="location">${ipData.country}</span>`;
            } else {
                elements.ipInfo.innerHTML = `<span class="location">已缓存数据</span>`;
            }
        }

        updateUI();
    } else {
        log.info(' 无缓存，获取 IP 信息...');
        if (window.generators) {
            window.generators.setCustomEmailDomain(elements.emailDomainType?.value || 'gmail.com');
        }
        try {
            await fetchIPInfo();
        } catch (e) {
            log.error(' fetchIPInfo 失败:', e);
            // 使用默认值
            if (elements.ipInfo) {
                elements.ipInfo.innerHTML = `<span class="location">United States (默认)</span>`;
            }
            if (window.generators) {
                ipData = { country: 'United States', city: 'New York', region: '' };
                currentData = window.generators.generateAllInfoWithSettings(ipData, userSettings);
                currentData.sensitive = {};
                updateUI();
                saveDataToStorage();
            }
        }
    }

    log.info(' 初始化完成');
});

/**
 * 从输入框更新 currentData
 */
function updateCurrentDataFromInputs() {
    FIELD_NAMES.forEach(name => {
        if (elements.fields[name]) {
            currentData[name] = elements.fields[name].value;
        }
    });
    updateProfileOverview();
}

// 暴露函数给全局 (如果需要)
window.loadArchive = loadArchive;
window.deleteArchive = deleteArchive;
