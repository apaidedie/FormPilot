/**
 * UI 管理模块
 */

/**
 * 更新界面显示
 */
function updateUI() {
    FIELD_NAMES.forEach(name => {
        if (elements.fields[name] && currentData[name] !== undefined) {
            if (name === 'country' || name === 'gender') {
                const selectEl = elements.fields[name];
                const options = Array.from(selectEl.options).map(opt => opt.value);
                if (options.includes(currentData[name])) {
                    selectEl.value = currentData[name];
                } else if (name === 'country') {
                    selectEl.selectedIndex = 0;
                    currentData[name] = selectEl.value;
                    ipData.country = selectEl.value;
                }
            } else {
                elements.fields[name].value = currentData[name];
            }
        }
    });

    const sensitive = currentData.sensitive || {};
    SENSITIVE_FIELD_NAMES.forEach(name => {
        if (elements.sensitiveFields[name]) {
            elements.sensitiveFields[name].value = sensitive[name] || '';
        }
    });

    syncFieldActionButtons();
    syncSensitiveCopyButtons();
    updateProfileOverview();
}

function getProfileOverviewSource() {
    if (currentData.source === 'meiguodizhi') return currentData.requestedLocation ? `美国 ${currentData.requestedLocation}` : '美国位置';
    if (currentData.source === 'ai') return 'AI';
    if (addressEnhancementState === 'geoapify') return 'Geoapify';
    if (addressEnhancementState === 'openstreetmap') return 'OSM';
    if (addressEnhancementState === 'fallback') return '本地降级';
    if (elements.targetLocation?.value?.trim()) return '美国位置';
    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;
    return addressApiEnabled ? '地图/本地' : '本地';
}

function getProfileOverviewSourceState(source) {
    if (currentData.source === 'meiguodizhi') return 'meiguodizhi';
    if (currentData.source === 'ai') return 'ai';
    if (addressEnhancementState === 'geoapify' || addressEnhancementState === 'openstreetmap') return 'maps';
    if (addressEnhancementState === 'fallback') return 'fallback';
    if (source.includes('地图')) return 'maps';
    return 'local';
}

function getCompactProfileLocation() {
    const locality = [currentData.city, currentData.state]
        .filter(value => String(value || '').trim())
        .join(', ')
        .trim();
    const country = String(currentData.country || '').trim();
    if (locality && country) return `${locality} · ${country}`;
    return locality || country || '位置待生成';
}

function setOverviewPillState(element, state, title) {
    if (!element) return;
    element.dataset.state = state;
    if (title) {
        element.title = title;
        element.setAttribute('aria-label', title);
    }
}

function updateProfileOverviewIdentity() {
    if (!elements.profileOverviewName || !elements.profileOverviewDetail) return;

    const fullName = [currentData.firstName, currentData.lastName]
        .filter(value => String(value || '').trim())
        .join(' ')
        .trim();
    const email = String(currentData.email || '').trim();
    const location = getCompactProfileLocation();

    elements.profileOverviewName.textContent = fullName || '姓名待生成';
    elements.profileOverviewDetail.textContent = email ? `${email} · ${location}` : location;
}

function getMissingProfileFields() {
    return FIELD_NAMES.filter(name => !String(currentData?.[name] || '').trim());
}

function getProfileFieldLabel(name) {
    return FIELD_LABELS[name] || name;
}

function setReadinessPill(element, text, state, title) {
    if (!element) return;
    element.textContent = text;
    element.dataset.state = state;
    if (title) {
        element.title = title;
        element.setAttribute('aria-label', title);
    }
}

function getReadinessPageState() {
    const state = elements.pageScanPanel?.dataset.state || 'idle';
    const title = String(elements.pageScanTitle?.textContent || '').trim();
    const matchCount = Number(elements.pageScanPanel?.dataset.matchCount || 0);
    const fieldCount = Number(elements.pageScanPanel?.dataset.fieldCount || 0);
    const requiredMatchCount = Number(elements.pageScanPanel?.dataset.requiredMatchCount || 0);
    const requiredCount = Number(elements.pageScanPanel?.dataset.requiredCount || 0);
    const matchLabel = state === 'ready' && fieldCount ? `${matchCount}/${fieldCount}` : '';
    const labels = {
        ready: matchLabel || title || '已扫描',
        loading: '扫描中',
        empty: '无字段',
        error: '扫描失败',
        idle: '未扫描'
    };

    return {
        state,
        label: labels[state] || labels.idle,
        title,
        matchLabel,
        matchCount,
        fieldCount,
        requiredMatchCount,
        requiredCount,
        ready: state === 'ready',
        warning: state === 'empty' || state === 'error'
    };
}

function getReadinessModeState() {
    if (elements.fillEmptyOnlyToggle?.checked) {
        return { state: 'empty-only', label: '空白优先', title: '只填写页面空白字段' };
    }
    return { state: 'standard', label: '标准', title: '允许覆盖可匹配字段' };
}

function getReadinessAIState() {
    if (isAIModeEnabled()) return { state: 'on', label: '已启用', title: 'AI 智能匹配已启用' };
    if (isAISettingsReady()) return { state: 'ready', label: '可启用', title: 'AI 已配置，可在命令栏启用' };
    return { state: 'off', label: '关闭', title: 'AI 未启用或缺少 API Key' };
}

function getReadinessAddressState() {
    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;
    const source = getProfileOverviewSource();
    if (!addressApiEnabled) return { state: 'local', label: '本地', title: '地址增强已关闭' };
    if (addressEnhancementState === 'geoapify') return { state: 'maps', label: 'Geoapify', title: '使用 Geoapify 地址增强' };
    if (addressEnhancementState === 'openstreetmap') return { state: 'maps', label: 'OSM', title: '使用 OpenStreetMap 地址增强' };
    if (addressEnhancementState === 'fallback') return { state: 'fallback', label: '本地降级', title: '地图服务不可用，已用本地地址' };
    if (source.includes('美国')) return { state: 'meiguodizhi', label: '美国位置', title: `资料来源：${source}` };
    return { state: 'maps', label: '地图/本地', title: '地址增强开启，必要时回退本地地址' };
}

const ADDRESS_SERVICE_COPY = {
    idle: {
        title: '地址增强待命',
        detail: '地图开启时优先尝试 Geoapify 或 OSM；不可用时继续使用本地地址。'
    },
    off: {
        title: '地址增强已关闭',
        detail: '当前只使用本地地址生成，不访问地图服务。'
    },
    loading: {
        title: '正在检查地址服务',
        detail: '正在尝试地图地址；失败时会自动保留本地地址。'
    },
    ready: {
        title: '地址服务可用',
        detail: '已使用地图地址增强当前资料。'
    },
    fallback: {
        title: '地址服务已降级',
        detail: '地图服务暂时不可用，已保留本地地址；稍后可重新生成再试。'
    }
};

function setAddressServiceState(state = 'idle', detail = '') {
    const panel = elements.addressServiceState;
    if (!panel) return;

    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;
    const nextState = addressApiEnabled ? state : 'off';
    const copy = ADDRESS_SERVICE_COPY[nextState] || ADDRESS_SERVICE_COPY.idle;
    const title = panel.querySelector('strong');
    const body = panel.querySelector('span');

    panel.dataset.state = nextState;
    if (title) title.textContent = copy.title;
    if (body) body.textContent = detail || copy.detail;
    panel.title = detail || copy.detail;
}

function syncAddressServiceState() {
    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;
    if (!addressApiEnabled) {
        setAddressServiceState('off');
        return;
    }

    if (addressEnhancementState === 'geoapify') {
        setAddressServiceState('ready', 'Geoapify 返回了地图地址，当前资料已更新。');
        return;
    }
    if (addressEnhancementState === 'openstreetmap') {
        setAddressServiceState('ready', 'OSM 返回了地图地址，当前资料已更新。');
        return;
    }
    if (addressEnhancementState === 'fallback') {
        setAddressServiceState('fallback');
        return;
    }

    setAddressServiceState('idle');
}

function getFillReadinessModel() {
    const missing = getMissingProfileFields();
    const profileFilled = FIELD_NAMES.length - missing.length;
    const page = getReadinessPageState();
    const myProfileSummary = getMyProfileCompletenessSummary();

    let score = Math.round((profileFilled / FIELD_NAMES.length) * 45);
    if (page.ready) score += 25;
    if (elements.fillEmptyOnlyToggle?.checked) score += 8;
    if (isAIModeEnabled()) score += 8;
    if (myProfileSummary.percent >= 80) score += 8;
    if (document.getElementById('useAddressApiToggle')?.checked !== false) score += 6;
    if (page.ready && !missing.length) score = Math.max(score, 88);
    score = Math.min(100, score);

    const state = page.ready && !missing.length
        ? 'ready'
        : page.warning
            ? 'warning'
            : score >= 60
                ? 'partial'
                : 'checking';

    const title = state === 'ready'
        ? '可以填写'
        : state === 'warning'
            ? '先看页面状态'
            : missing.length
                ? '资料还差一点'
                : '建议先扫描页面';

    const hint = state === 'ready'
        ? '资料完整且页面已扫描，可以执行 Fill。'
        : page.warning
            ? '当前页面扫描结果不理想，确认页面后再填写。'
            : missing.length
                ? `还差 ${missing.slice(0, 2).map(getProfileFieldLabel).join('、')}${missing.length > 2 ? ` 等 ${missing.length} 项` : ''}，补齐后命中更稳。`
                : '资料已就绪，扫描当前页可提前发现必填项和验证码。';

    return {
        score,
        state,
        title,
        hint,
        profileFilled,
        missingCount: missing.length,
        page,
        mode: getReadinessModeState(),
        ai: getReadinessAIState(),
        address: getReadinessAddressState(),
        myProfileSummary
    };
}

function updateFillReadiness() {
    if (!elements.fillReadiness || !elements.fillReadinessScore || !elements.fillReadinessBar) return;

    const model = getFillReadinessModel();
    elements.fillReadiness.dataset.state = model.state;
    elements.fillReadiness.title = model.hint;

    if (elements.fillReadinessTitle) elements.fillReadinessTitle.textContent = model.title;
    elements.fillReadinessScore.textContent = `${model.score}%`;
    elements.fillReadinessScore.setAttribute('aria-label', `填表准备度 ${model.score}%`);
    elements.fillReadinessBar.style.width = `${model.score}%`;
    elements.fillReadinessBar.dataset.state = model.state;
    if (elements.fillReadinessHint) elements.fillReadinessHint.textContent = model.hint;

    setReadinessPill(
        elements.fillReadyProfile,
        `资料 ${model.profileFilled}/${FIELD_NAMES.length}`,
        model.missingCount ? 'partial' : 'ready',
        model.missingCount ? `生成资料缺少 ${model.missingCount} 项` : '生成资料完整'
    );
    setReadinessPill(
        elements.fillReadyPage,
        `页面 ${model.page.label}`,
        model.page.state,
        model.page.ready
            ? `当前页面已扫描${model.page.title ? `：${model.page.title}` : ''}${model.page.requiredCount ? `，必填 ${model.page.requiredMatchCount}/${model.page.requiredCount}` : ''}`
            : `页面扫描状态：${model.page.label}`
    );
    setReadinessPill(elements.fillReadyMode, `模式 ${model.mode.label}`, model.mode.state, model.mode.title);
    setReadinessPill(elements.fillReadyAI, `AI ${model.ai.label}`, model.ai.state, model.ai.title);
    setReadinessPill(elements.fillReadyAddress, `地址 ${model.address.label}`, model.address.state, model.address.title);
    setReadinessPill(
        elements.fillReadySavedProfile,
        `本地资料 ${model.myProfileSummary.percent}%`,
        model.myProfileSummary.percent === 100 ? 'ready' : 'partial',
        `我的资料完成度 ${model.myProfileSummary.percent}%`
    );
}

function getFillResultModeLabel(summary = {}) {
    if (summary.mode === 'AI') return 'AI';
    if (summary.mode === 'myProfile') return '我的资料';
    return '';
}

function formatSkipReasonSummary(summary = {}) {
    const parts = [];
    if (Number(summary.skipFilled) > 0) parts.push(`已有 ${summary.skipFilled}`);
    if (Number(summary.skipSensitive) > 0) parts.push(`敏感 ${summary.skipSensitive}`);
    if (Number(summary.skipEmpty) > 0) parts.push(`空值 ${summary.skipEmpty}`);
    if (Number(summary.skipOther) > 0) parts.push(`其它 ${summary.skipOther}`);
    return parts.join(' · ');
}

function setLastFillMetric(element, label, value, state, title) {
    if (!element) return;
    const count = Number(value || 0);
    const titleText = title || `${label} ${count} 个字段`;
    element.textContent = `${label} ${count}`;
    element.dataset.state = state;
    element.title = titleText;
    element.setAttribute('aria-label', titleText);
}

function renderLastFillResult(summary = null) {
    if (!elements.lastFillResult) return;

    if (!summary || typeof summary !== 'object') {
        elements.lastFillResult.hidden = true;
        elements.lastFillResult.dataset.state = 'empty';
        return;
    }

    const filled = Number(summary.filled || 0);
    const skipped = Number(summary.skipped || 0);
    const missed = Number(summary.missed || 0);
    const state = missed > 0 || filled === 0 ? 'warning' : 'ready';
    const modeLabel = getFillResultModeLabel(summary);
    const title = `${modeLabel ? `${modeLabel} ` : ''}填表完成`;
    const detail = formatHistoryFillSummary(summary) || '没有可汇总的字段变化';
    const skipReason = formatSkipReasonSummary(summary);

    elements.lastFillResult.hidden = false;
    elements.lastFillResult.dataset.state = state;
    elements.lastFillResult.title = detail;
    if (elements.lastFillResultTitle) elements.lastFillResultTitle.textContent = title;
    if (elements.lastFillResultDetail) elements.lastFillResultDetail.textContent = detail;

    setLastFillMetric(elements.lastFillFilled, '填', filled, filled > 0 ? 'ready' : 'neutral');
    setLastFillMetric(elements.lastFillSkipped, '跳过', skipped, skipped > 0 ? 'warning' : 'neutral', skipReason ? `跳过 ${skipped} 个字段：${skipReason}` : '跳过 0 个字段');
    setLastFillMetric(elements.lastFillMissed, '未命中', missed, missed > 0 ? 'warning' : 'neutral');
}

function updateSectionCompletionBadges() {
    Object.entries(COPY_SECTION_FIELDS).forEach(([sectionName, fields]) => {
        const badge = elements.sectionCompletions?.[sectionName];
        if (!badge) return;

        const filled = fields.filter(name => String(currentData?.[name] || '').trim()).length;
        const total = fields.length;
        const complete = filled === total;
        badge.textContent = `${filled}/${total}`;
        badge.dataset.state = complete ? 'complete' : 'partial';
        const label = badge.dataset.sectionLabel || sectionName;
        badge.setAttribute('aria-label', `${label}完成度 ${filled}/${total}`);
        badge.title = complete ? '本节资料完整' : `本节还差 ${total - filled} 项`;
    });
}

function updateCountryCoverageSelection() {
    if (!elements.countryCoverageList) return;

    const selectedCountry = String(currentData.country || elements.fields.country?.value || '').trim();
    elements.countryCoverageList.querySelectorAll('[data-country]').forEach(item => {
        const isSelected = item.dataset.country === selectedCountry;
        item.classList.toggle('is-selected', isSelected);
        if (isSelected) {
            item.setAttribute('aria-current', 'true');
        } else {
            item.removeAttribute('aria-current');
        }
    });
}

function updateProfileOverview() {
    if (!elements.profileOverviewScore || !elements.profileOverviewBar) return;

    const missing = getMissingProfileFields();
    const missingLabels = missing.map(getProfileFieldLabel);
    const filled = FIELD_NAMES.length - missing.length;
    const percent = Math.round((filled / FIELD_NAMES.length) * 100);
    const overviewState = missing.length === 0 ? 'complete' : (filled === 0 ? 'empty' : 'partial');
    elements.profileOverviewScore.textContent = `${filled}/${FIELD_NAMES.length}`;
    elements.profileOverviewScore.setAttribute('aria-label', `当前资料完成度 ${filled}/${FIELD_NAMES.length}`);
    elements.profileOverviewBar.style.width = `${percent}%`;
    elements.profileOverviewBar.dataset.state = overviewState;
    if (elements.profileOverview) {
        elements.profileOverview.dataset.state = overviewState;
        elements.profileOverview.title = missing.length ? `当前资料缺 ${missing.length} 项` : '当前资料已完整';
    }

    if (elements.profileOverviewMissing) {
        const missingLabel = missing.length
            ? `缺 ${missingLabels.slice(0, 2).join('、')}${missing.length > 2 ? ` +${missing.length - 2}` : ''}`
            : '资料完整';
        elements.profileOverviewMissing.textContent = missingLabel;
        setOverviewPillState(
            elements.profileOverviewMissing,
            missing.length ? 'partial' : 'complete',
            missing.length ? `缺少 ${missing.length} 项资料` : '资料完整'
        );
    }

    if (elements.profileOverviewGap) {
        if (missing.length) {
            const visibleLabels = missingLabels.slice(0, 4);
            const extraCount = missing.length - visibleLabels.length;
            elements.profileOverviewGap.textContent = `补齐 ${visibleLabels.join('、')}${extraCount > 0 ? ` 等 ${missing.length} 项` : ''} 后再填表更稳`;
            elements.profileOverviewGap.classList.remove('is-hidden');
            elements.profileOverviewGap.dataset.state = 'partial';
        } else {
            elements.profileOverviewGap.textContent = '';
            elements.profileOverviewGap.classList.add('is-hidden');
            elements.profileOverviewGap.dataset.state = 'complete';
        }
    }

    if (elements.profileOverviewLocked) {
        const lockedCount = lockedFields.size;
        elements.profileOverviewLocked.textContent = `锁定 ${lockedCount}`;
        setOverviewPillState(
            elements.profileOverviewLocked,
            lockedCount ? 'locked' : 'empty',
            lockedCount ? `已锁定 ${lockedCount} 个字段` : '没有锁定字段'
        );
    }

    if (elements.profileOverviewSource) {
        const source = getProfileOverviewSource();
        const sourceState = getProfileOverviewSourceState(source);
        elements.profileOverviewSource.textContent = `来源 ${source}`;
        setOverviewPillState(elements.profileOverviewSource, sourceState, `资料来源：${source}`);
    }

    updateProfileOverviewIdentity();
    updateSectionCompletionBadges();
    updateCountryCoverageSelection();
    syncAddressServiceState();
    updateFillReadiness();
}

/**
 * 更新设置 UI
 */
function updateSettingsUI() {
    if (elements.enableAI) elements.enableAI.checked = userSettings.enableAI;
    if (elements.openaiBaseUrl) elements.openaiBaseUrl.value = userSettings.openaiBaseUrl;
    if (elements.openaiKey) elements.openaiKey.value = userSettings.openaiKey;
    if (elements.openaiModel) elements.openaiModel.value = userSettings.openaiModel;
    if (elements.aiPersona) elements.aiPersona.value = userSettings.aiPersona;
    if (elements.passwordLength) elements.passwordLength.value = userSettings.passwordLength;
    if (elements.pwdUppercase) elements.pwdUppercase.checked = userSettings.pwdUppercase;
    if (elements.pwdLowercase) elements.pwdLowercase.checked = userSettings.pwdLowercase;
    if (elements.pwdNumbers) elements.pwdNumbers.checked = userSettings.pwdNumbers;
    if (elements.pwdSymbols) elements.pwdSymbols.checked = userSettings.pwdSymbols;
    if (elements.minAge) elements.minAge.value = userSettings.minAge;
    if (elements.maxAge) elements.maxAge.value = userSettings.maxAge;
    if (elements.autoClearData) elements.autoClearData.checked = userSettings.autoClearData;
    if (elements.geoapifyKey) elements.geoapifyKey.value = userSettings.geoapifyKey || '';

    syncAIModeToggleAvailability();

    updateSettingsOverview();
    updateFillReadiness();
}

function setSettingsOverviewCard(name, state, title, detail) {
    const card = elements.settingsOverviewItems?.[name];
    if (!card) return;

    card.dataset.state = state;
    const titleEl = card.querySelector('strong');
    const detailEl = card.querySelector('small');
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
    card.title = `${card.querySelector('span')?.textContent || name}: ${title}，${detail}`;
}

function updateSettingsOverview() {
    if (!elements.settingsOverview) return;

    const enabledComplexity = [
        userSettings.pwdUppercase,
        userSettings.pwdLowercase,
        userSettings.pwdNumbers,
        userSettings.pwdSymbols
    ].filter(Boolean).length;
    setSettingsOverviewCard(
        'password',
        enabledComplexity >= 3 ? 'on' : 'partial',
        `${userSettings.passwordLength || 12} 位`,
        `${enabledComplexity}/4 复杂度`
    );

    const aiEnabled = isAISettingsReady();
    setSettingsOverviewCard(
        'ai',
        aiEnabled ? 'on' : 'off',
        aiEnabled ? '可用' : '未启用',
        aiEnabled ? (userSettings.openaiModel || '默认模型') : '需要启用并填写 Key'
    );

    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;
    const hasGeoapifyKey = Boolean(String(elements.geoapifyKey?.value || userSettings.geoapifyKey || '').trim());
    setSettingsOverviewCard(
        'address',
        addressApiEnabled ? (hasGeoapifyKey ? 'on' : 'partial') : 'off',
        addressApiEnabled ? (hasGeoapifyKey ? 'Geoapify' : 'OSM') : '关闭',
        addressApiEnabled ? (hasGeoapifyKey ? '优先地图地址' : '无需 API Key') : '仅用本地地址'
    );

    const archiveCount = Array.isArray(archiveItems) ? archiveItems.length : 0;
    setSettingsOverviewCard(
        'archive',
        archiveCount ? 'on' : 'empty',
        `${archiveCount} 个`,
        archiveCount ? '可搜索和加载' : '暂无存档'
    );
}

function readMyProfileValueForCompleteness(fieldName) {
    const inputValue = elements.myProfileFields[fieldName]?.value;
    if (inputValue !== undefined) return String(inputValue).trim();
    return String(myProfile[fieldName] || '').trim();
}

function getFirstMissingMyProfileField(group) {
    return group.fields.find(field => !readMyProfileValueForCompleteness(field)) || '';
}

function getMyProfileCompletenessSummary() {
    let filled = 0;
    let total = 0;
    const summaries = MY_PROFILE_COMPLETENESS_GROUPS.map(group => {
        const groupFilled = group.fields.filter(field => readMyProfileValueForCompleteness(field)).length;
        const missingField = getFirstMissingMyProfileField(group);
        filled += groupFilled;
        total += group.fields.length;
        return {
            ...group,
            filled: groupFilled,
            total: group.fields.length,
            missingField
        };
    });
    const percent = total ? Math.round((filled / total) * 100) : 0;
    return { filled, total, percent, summaries };
}

function updateMyProfileHeaderStatus(summary = getMyProfileCompletenessSummary()) {
    if (!elements.myProfileHeaderStatus || !elements.openMyProfile) return;

    const complete = summary.percent === 100;
    elements.myProfileHeaderStatus.textContent = complete ? '完整' : `${summary.percent}%`;
    elements.openMyProfile.dataset.state = complete ? 'complete' : 'partial';
    elements.openMyProfile.setAttribute('aria-label', `打开我的资料，完成度 ${summary.percent}%`);
    elements.openMyProfile.title = complete ? '我的资料已完整' : `我的资料完成度 ${summary.percent}%`;
}

function updateMyProfileCompleteness() {
    const summary = getMyProfileCompletenessSummary();
    updateMyProfileHeaderStatus(summary);

    if (!elements.myProfileCompletenessScore || !elements.myProfileCompletenessBar || !elements.myProfileCompletenessChips) return;

    elements.myProfileCompletenessScore.textContent = `${summary.percent}%`;
    elements.myProfileCompletenessBar.style.width = `${summary.percent}%`;
    elements.myProfileCompletenessChips.innerHTML = summary.summaries.map(group => `
        <button class="profile-completeness-chip" type="button" data-profile-group="${group.id}" data-missing-field="${group.missingField}" data-state="${group.filled === group.total ? 'complete' : 'partial'}" title="${group.missingField ? '定位缺失项' : '本组已完整'}" aria-label="${group.label}完成度 ${group.filled}/${group.total}${group.missingField ? '，点击定位缺失项' : ''}">
            <span>${group.label}</span>
            <b>${group.filled}/${group.total}</b>
        </button>
    `).join('');

    if (elements.myProfileCompletenessHint) {
        const missingGroup = summary.summaries.find(group => group.filled < group.total);
        elements.myProfileCompletenessHint.textContent = missingGroup
            ? `还差 ${missingGroup.label}，填表命中率会更高。`
            : '资料已完整，可以更放心地一键填表。';
    }

    updateFillReadiness();
}

/**
 * 渲染历史记录列表
 */
function renderHistoryList(history) {
    if (!elements.historyList) return;
    historyItems = Array.isArray(history) ? history : [];
    renderFilteredHistoryList();
}

function getHistorySearchText(item) {
    const data = item?.data || {};
    return [
        data.firstName,
        data.lastName,
        data.email,
        data.phone,
        data.city,
        data.state,
        data.country,
        item?.country,
        formatHistoryFillSummary(item?.fillSummary)
    ].filter(Boolean).join(' ').toLowerCase();
}

function getFilteredHistoryItems() {
    const query = String(elements.historySearch?.value || '').trim().toLowerCase();
    if (!query) return historyItems;
    return historyItems.filter(item => getHistorySearchText(item).includes(query));
}

function updateHistoryInfo(total, visible, hasQuery) {
    if (!elements.historyInfo) return;
    if (total === 0) {
        elements.historyInfo.textContent = '暂无历史记录';
    } else if (hasQuery) {
        elements.historyInfo.textContent = `显示 ${visible} / ${total} 条`;
    } else {
        elements.historyInfo.textContent = `最近使用的 ${total} 组数据`;
    }
}

function renderFilteredHistoryList() {
    if (!elements.historyList) return;

    const query = String(elements.historySearch?.value || '').trim();
    const visibleHistory = getFilteredHistoryItems();
    updateHistoryInfo(historyItems.length, visibleHistory.length, Boolean(query));

    if (historyItems.length === 0) {
        elements.historyList.innerHTML = '<div class="history-empty">暂无历史记录</div>';
        return;
    }

    if (visibleHistory.length === 0) {
        elements.historyList.innerHTML = '<div class="history-empty">没有匹配的历史记录</div>';
        return;
    }

    elements.historyList.innerHTML = visibleHistory.map(item => {
        const data = item.data;
        const name = escapeHtml(`${data.firstName || ''} ${data.lastName || ''}`.trim() || '未知');
        const email = escapeHtml(data.email || '无邮箱');
        const time = formatHistoryTime(item.timestamp);
        const fillSummary = escapeHtml(formatHistoryFillSummary(item.fillSummary));
        const loadLabel = escapeHtml(`加载历史记录 ${name}`);

        return `
            <div class="history-item" data-id="${item.id}">
                <button class="history-item-info" type="button" data-id="${item.id}" title="加载此记录" aria-label="${loadLabel}">
                    <div class="history-item-name">${name}</div>
                    <div class="history-item-email">${email}</div>
                    ${fillSummary ? `<div class="history-item-fill">${fillSummary}</div>` : ''}
                </button>
                <div class="history-item-time">${time}</div>
                <button class="history-item-delete" data-id="${item.id}" title="删除历史记录" aria-label="删除历史记录" aria-pressed="false" data-confirming="false">删除</button>
            </div>
        `;
    }).join('');

    const loadHistoryFromButton = (btn) => {
        resetHistoryItemDeleteConfirmState();
        const id = parseInt(btn.dataset.id);
        loadHistoryItem(id);
    };

    // 绑定加载事件
    elements.historyList.querySelectorAll('.history-item-info').forEach(el => {
        el.addEventListener('click', (e) => {
            loadHistoryFromButton(e.currentTarget);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            loadHistoryFromButton(e.currentTarget);
        });
    });

    // 绑定删除事件
    elements.historyList.querySelectorAll('.history-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.currentTarget;
            const id = parseInt(btn.dataset.id);
            if (btn.dataset.confirming === 'true') {
                deleteHistoryItem(id);
            } else {
                markHistoryItemDeleteConfirm(btn);
                showToast('再次点击确认删除历史');
            }
        });
    });
}

function formatHistoryFillSummary(summary) {
    if (!summary || typeof summary !== 'object') return '';

    const parts = [];
    if (Number(summary.filled) > 0) parts.push(`填 ${summary.filled}`);
    if (Number(summary.skipped) > 0) {
        const skipReason = formatSkipReasonSummary(summary);
        parts.push(`跳过 ${summary.skipped}${skipReason ? `（${skipReason}）` : ''}`);
    }
    if (Number(summary.missed) > 0) parts.push(`未命中 ${summary.missed}`);
    if (!parts.length) return '';

    const mode = getFillResultModeLabel(summary) || (summary.emptyOnly ? '空白模式' : '');
    return [mode, parts.join(' · ')].filter(Boolean).join(' · ');
}

function renderInboxError(error, options = {}) {
    if (!elements.inboxList) return;

    const rawMessage = error?.message || '';
    const title = options.title || '收件箱刷新失败';
    const detail = options.detail || (rawMessage && rawMessage.length <= 120
        ? rawMessage
        : '请稍后重试，或重新生成临时邮箱。');
    const recovery = options.recovery || '';

    elements.inboxList.innerHTML = `
        <div class="inbox-state" data-state="error" role="alert" aria-live="polite">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(detail)}</span>
            ${recovery ? `<span class="inbox-recovery" data-role="recovery">${escapeHtml(recovery)}</span>` : ''}
        </div>
    `;
}

/**
 * 渲染收件箱
 */
function renderInbox(messages) {
    if (!elements.inboxList) return;

    if (!messages || messages.length === 0) {
        elements.inboxList.innerHTML = '<div class="inbox-empty">暂无邮件</div>';
        return;
    }

    elements.inboxList.innerHTML = messages.map(msg => {
        const subject = escapeHtml(msg.subject) || '(无主题)';
        const from = escapeHtml(msg.from?.address || '');
        const intro = escapeHtml(msg.intro) || '';
        // 尝试提取验证码（只匹配纯数字，确保安全）
        const codeMatch = (msg.subject || '').match(/\b\d{4,6}\b/) || (msg.intro || '').match(/\b\d{4,6}\b/);
        const code = codeMatch ? escapeHtml(codeMatch[0]) : '';
        const codeHtml = code ? `<button class="verification-code" type="button" title="复制验证码" aria-label="复制验证码 ${code}" data-code="${code}">${code}</button>` : '';

        return `
            <div class="email-item">
                <div class="email-header">
                    <span class="email-from">${from}</span>
                    ${codeHtml}
                </div>
                <div class="email-subject">${subject}</div>
                <div class="email-intro">${intro}</div>
            </div>
        `;
    }).join('');

    const copyVerificationCode = async (btn) => {
        const code = btn.dataset.code;
        if (code) {
            try {
                await navigator.clipboard.writeText(code);
                showToast('验证码已复制');
            } catch (err) {
                log.error('复制失败:', err);
            }
        }
    };

    // 使用按钮事件，保留鼠标与键盘的同一条复制路径
    elements.inboxList.querySelectorAll('.verification-code').forEach(el => {
        el.addEventListener('click', async (e) => {
            await copyVerificationCode(e.currentTarget);
        });
        el.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            await copyVerificationCode(e.currentTarget);
        });
    });
}

/**
 * 渲染存档列表
 */
async function renderArchiveList(archives) {
    if (!elements.archiveList) return;
    archiveItems = Array.isArray(archives) ? archives : [];
    updateSettingsOverview();
    renderFilteredArchiveList();
}

function getArchiveSearchText(archive) {
    const data = archive?.data || {};
    return [
        archive?.name,
        data.firstName,
        data.lastName,
        data.email,
        data.phone,
        data.city,
        data.state,
        data.country
    ].filter(Boolean).join(' ').toLowerCase();
}

function getFilteredArchiveItems() {
    const query = String(elements.archiveSearch?.value || '').trim().toLowerCase();
    const indexed = archiveItems.map((archive, index) => ({ archive, index }));
    if (!query) return indexed;
    return indexed.filter(({ archive }) => getArchiveSearchText(archive).includes(query));
}

function updateArchiveInfo(total, visible, hasQuery) {
    if (!elements.archiveInfo) return;
    if (total === 0) {
        elements.archiveInfo.textContent = '暂无存档';
    } else if (hasQuery) {
        elements.archiveInfo.textContent = `显示 ${visible} / ${total} 个`;
    } else {
        elements.archiveInfo.textContent = `已保存 ${total} 个存档`;
    }
}

function renderFilteredArchiveList() {
    if (!elements.archiveList) return;

    const query = String(elements.archiveSearch?.value || '').trim();
    const visibleArchives = getFilteredArchiveItems();
    updateArchiveInfo(archiveItems.length, visibleArchives.length, Boolean(query));

    if (archiveItems.length === 0) {
        elements.archiveList.innerHTML = '<div class="archive-empty">暂无存档</div>';
        return;
    }

    if (visibleArchives.length === 0) {
        elements.archiveList.innerHTML = '<div class="archive-empty">没有匹配的存档</div>';
        return;
    }

    elements.archiveList.innerHTML = visibleArchives.map(({ archive, index }) => `
        <div class="archive-item" data-index="${index}">
            <span class="archive-item-name">${escapeHtml(archive.name || '未命名存档')}</span>
            <div class="archive-item-actions">
                <button class="load-btn" title="加载存档" aria-label="加载存档" data-action="load" data-index="${index}">加载</button>
                <button class="delete-btn" title="删除存档" aria-label="删除存档" aria-pressed="false" data-confirming="false" data-action="delete" data-index="${index}">删除</button>
            </div>
        </div>
    `).join('');
}

// ============ Modal helpers ============

const MODAL_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

let modalReturnFocus = null;

function getModalPanel(modal) {
    return modal?.querySelector('.modal');
}

function isFocusableElement(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
}

function getModalFocusableElements(modal) {
    const panel = getModalPanel(modal);
    if (!panel) return [];
    return Array.from(panel.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter(isFocusableElement);
}

function openModal(modal) {
    if (!modal) return;
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    const panel = getModalPanel(modal);
    if (panel) {
        setTimeout(() => panel.focus(), 0);
    }
}

function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (modalReturnFocus && document.contains(modalReturnFocus)) {
        modalReturnFocus.focus();
    }
    modalReturnFocus = null;
}

function closeActiveModal() {
    const activeModal = document.querySelector('.modal-overlay.show');
    if (activeModal) closeModal(activeModal);
}

function trapModalFocus(e) {
    if (e.key !== 'Tab') return;

    const activeModal = document.querySelector('.modal-overlay.show');
    if (!activeModal) return;

    const focusable = getModalFocusableElements(activeModal);
    const panel = getModalPanel(activeModal);
    if (!focusable.length) {
        e.preventDefault();
        panel?.focus();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === first || active === panel || !activeModal.contains(active))) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && (active === last || active === panel || !activeModal.contains(active))) {
        e.preventDefault();
        first.focus();
    }
}

// ============ 主题功能 ============

/**
 * 应用主题
 */
function applyTheme(theme) {
    if (theme === 'light') {
        document.body.classList.add('light-theme');
        if (elements.themeToggle) {
            elements.themeToggle.textContent = '深色';
            elements.themeToggle.setAttribute('aria-label', '切换到深色主题');
            elements.themeToggle.setAttribute('title', '切换到深色主题');
        }
    } else {
        document.body.classList.remove('light-theme');
        if (elements.themeToggle) {
            elements.themeToggle.textContent = '浅色';
            elements.themeToggle.setAttribute('aria-label', '切换到浅色主题');
            elements.themeToggle.setAttribute('title', '切换到浅色主题');
        }
    }
}

/**
 * 切换主题
 */
async function toggleTheme() {
    const isLight = document.body.classList.contains('light-theme');
    const newTheme = isLight ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
}

/**
 * 初始化主题
 */
async function initTheme() {
    try {
        const theme = await loadTheme();
        applyTheme(theme);
    } catch (e) {
        log.info('初始化主题失败:', e);
    }
}
