/**
 * 表单填写功能
 */

/**
 * 在页面中填写表单
 */
async function fillFormInPage() {
    updateCurrentDataFromInputs();
    const btn = elements.fillForm;
    const loading = showLoading(btn, '填写中...');
    const commandDockGuard = guardCommandDockDuringFill();
    const fillOptions = getFillOptions();

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // 检查 AI 开关是否开启（主界面开关）
        if (isAIModeEnabled()) {
            btn.textContent = 'AI 分析中...';

            // 1. 扫描页面表单
            const scanResult = await sendMessageToTab(tab.id, { action: 'scanForm' });

            if (!scanResult || !scanResult.fields || scanResult.fields.length === 0) {
                throw new Error('未找到可见的表单字段');
            }

            btn.textContent = 'AI 匹配中...';

            // 2. 构建 AI Prompt
            const prompt = buildAIFormPrompt(scanResult);

            // 3. 调用 AI
            const apiUrl = normalizeApiUrl(userSettings.openaiBaseUrl);
            log.info(' AI Request URL:', apiUrl);
            await ensureHostPermission(apiUrl);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${userSettings.openaiKey}`
                },
                body: JSON.stringify({
                    model: userSettings.openaiModel,
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant that fills forms based on user profiles.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.3
                })
            });

            const contentType = response.headers.get('content-type');
            if (!response.ok) {
                const text = await response.text();
                log.error('API Error Response:', text);
                throw new Error(`API Error (${response.status}): ${text.slice(0, 100)}...`);
            }
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                log.error('API Invalid Content-Type:', contentType, text);
                throw new Error(`API 返回了非 JSON 数据(可能是 HTML)。请检查 API 地址是否正确。预览: ${text.slice(0, 50)}...`);
            }

            const data = await response.json();
            const content = data.choices[0].message.content;

            let jsonStr = content.replace(/```json\n ?|\n ? ```/g, '').trim();
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonStr = jsonMatch[0];

            const mapping = JSON.parse(jsonStr);

            // 清洗数据
            sanitizeFormMapping(mapping, scanResult);

            log.info(' Sanitized & Overridden Mapping:', mapping);

            btn.textContent = '填写中...';

            // 4. 发送填表指令
            const fillResult = await sendMessageToTab(tab.id, { action: 'fillFormSmart', data: mapping, options: fillOptions });
            const summary = buildFillHistorySummary(fillResult, fillOptions, 'AI');
            renderLastFillResult(summary);
            showToast(formatFillResultToast(fillResult, 'AI'));
            saveToHistory(summary);

        } else {
            // 传统逻辑
            const fillResult = await sendMessageToTab(tab.id, { action: 'fillForm', data: getPublicProfileData(), options: fillOptions });
            const summary = buildFillHistorySummary(fillResult, fillOptions, 'generated');
            renderLastFillResult(summary);
            showToast(formatFillResultToast(fillResult));
            saveToHistory(summary);
        }

    } catch (error) {
        log.error('填写表单失败:', error);
        showToast('填写失败: ' + error.message);
    } finally {
        commandDockGuard.restore();
        loading.restore();
    }
}

async function fillMyProfileInPage() {
    const btn = elements.fillMyProfile;
    const loading = showLoading(btn, '填写中...');

    try {
        await saveMyProfileData();
        const data = buildMyProfileFillData();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const fillOptions = getFillOptions();
        const fillResult = await sendMessageToTab(tab.id, { action: 'fillForm', data, options: fillOptions });
        renderLastFillResult(buildFillHistorySummary(fillResult, fillOptions, 'myProfile'));
        showToast(formatFillResultToast(fillResult, '我的资料'));
        closeModal(elements.myProfileModal);
    } catch (error) {
        log.error('我的资料填表失败:', error);
        showToast('填写失败: ' + error.message);
    } finally {
        loading.restore();
    }
}

function summarizePageScan(scanResult) {
    const fields = Array.isArray(scanResult?.fields) ? scanResult.fields : [];
    const requiredCount = fields.filter(field => field.required).length;
    const pageType = scanResult?.pageContext?.pageType || 'unknown';
    const hasCaptcha = scanResult?.pageContext?.hasCaptcha === true;
    const matchPreview = scanResult?.matchPreview && typeof scanResult.matchPreview === 'object'
        ? scanResult.matchPreview
        : null;
    const typeLabels = {
        login: '登录页',
        register: '注册页',
        checkout: '结账页',
        contact: '联系表单',
        survey: '问卷',
        profile: '资料页',
        application: '申请表',
        subscription: '订阅表单',
        unknown: '普通页面'
    };

    return {
        total: fields.length,
        requiredCount,
        pageTypeLabel: typeLabels[pageType] || '普通页面',
        hasCaptcha,
        matchPreview: matchPreview ? {
            matchCount: Number(matchPreview.matchCount || 0),
            requiredCount: Number(matchPreview.requiredCount ?? requiredCount),
            requiredMatchCount: Number(matchPreview.requiredMatchCount || 0),
            missingRequiredCount: Number(matchPreview.missingRequiredCount || 0),
            matchedFields: Array.isArray(matchPreview.matchedFields) ? matchPreview.matchedFields : [],
            unmatchedRequiredLabels: Array.isArray(matchPreview.unmatchedRequiredLabels) ? matchPreview.unmatchedRequiredLabels : [],
            sensitiveRequiredCount: Number(matchPreview.sensitiveRequiredCount || 0),
            sensitiveRequiredLabels: Array.isArray(matchPreview.sensitiveRequiredLabels) ? matchPreview.sensitiveRequiredLabels : []
        } : null
    };
}

function formatPageScanDetail(summary) {
    const preview = summary.matchPreview;
    const captchaText = summary.hasCaptcha ? '，检测到验证码' : '';

    if (!preview) {
        return `其中 ${summary.requiredCount} 个必填${captchaText}，可点击填写表单继续。`;
    }

    const requiredText = preview.requiredCount
        ? `必填已识别 ${preview.requiredMatchCount}/${preview.requiredCount}`
        : '没有必填标记';
    const missingText = preview.missingRequiredCount && preview.unmatchedRequiredLabels.length
        ? `，未识别：${preview.unmatchedRequiredLabels.join('、')}`
        : '';
    const sensitiveText = preview.sensitiveRequiredCount
        ? `，敏感必填 ${preview.sensitiveRequiredCount} 个将跳过${preview.sensitiveRequiredLabels.length ? `：${preview.sensitiveRequiredLabels.join('、')}` : ''}`
        : '';

    return `预计命中 ${preview.matchCount}/${summary.total} 个字段，${requiredText}${missingText}${sensitiveText}${captchaText}。`;
}

function setPageScanChip(element, text, state, title) {
    if (!element) return;
    element.textContent = text;
    element.dataset.state = state;
    element.title = title || text;
    element.setAttribute('aria-label', title || text);
}

function renderPageScanMeta(preview = null) {
    if (!elements.pageScanMeta) return;

    if (!preview) {
        elements.pageScanMeta.hidden = true;
        setPageScanChip(elements.pageScanMatchChip, '命中 -', 'neutral', '尚未生成页面命中预览');
        setPageScanChip(elements.pageScanRequiredChip, '必填 -', 'neutral', '尚未生成必填字段预览');
        setPageScanChip(elements.pageScanSensitiveChip, '敏感 0', 'neutral', '尚未检测敏感必填字段');
        return;
    }

    elements.pageScanMeta.hidden = false;
    const fieldCount = Number(preview.fieldCount || preview.total || 0);
    const matchCount = Number(preview.matchCount || 0);
    const requiredCount = Number(preview.requiredCount || 0);
    const requiredMatchCount = Number(preview.requiredMatchCount || 0);
    const sensitiveRequiredCount = Number(preview.sensitiveRequiredCount || 0);
    const sensitiveLabels = Array.isArray(preview.sensitiveRequiredLabels) ? preview.sensitiveRequiredLabels : [];

    setPageScanChip(
        elements.pageScanMatchChip,
        `命中 ${matchCount}/${fieldCount}`,
        matchCount ? 'ready' : 'warning',
        `预计可匹配 ${matchCount}/${fieldCount} 个可见字段`
    );
    setPageScanChip(
        elements.pageScanRequiredChip,
        requiredCount ? `必填 ${requiredMatchCount}/${requiredCount}` : '必填 0',
        requiredCount && requiredMatchCount < requiredCount ? 'warning' : 'ready',
        requiredCount ? `必填字段已识别 ${requiredMatchCount}/${requiredCount}` : '当前页没有必填标记'
    );
    setPageScanChip(
        elements.pageScanSensitiveChip,
        sensitiveRequiredCount ? `敏感跳过 ${sensitiveRequiredCount}` : '敏感 0',
        sensitiveRequiredCount ? 'blocked' : 'ready',
        sensitiveRequiredCount
            ? `敏感必填将跳过${sensitiveLabels.length ? `：${sensitiveLabels.join('、')}` : ''}`
            : '未发现需要跳过的敏感必填字段'
    );
}

function getScanPlanFieldLabel(fieldName) {
    return FIELD_LABELS[fieldName] || fieldName;
}

function getBoundedScanPlanItems(items, maxItems = 4) {
    return Array.from(new Set((Array.isArray(items) ? items : [])
        .map(item => String(item || '').trim())
        .filter(Boolean)))
        .slice(0, maxItems);
}

function renderScanPlanList(element, items, state, emptyText) {
    if (!element) return;

    const bounded = getBoundedScanPlanItems(items);
    const displayItems = bounded.length ? bounded : [emptyText];
    element.innerHTML = displayItems.map(item => (
        `<span data-state="${state}">${escapeHtml(item)}</span>`
    )).join('');
}

function renderPageScanPlan(preview = null) {
    if (!elements.pageScanPlan) return;

    if (!preview) {
        elements.pageScanPlan.hidden = true;
        if (elements.pageScanPlanTitle) elements.pageScanPlanTitle.textContent = '扫描计划';
        renderScanPlanList(elements.pageScanPlanMatched, [], 'matched', '等待扫描');
        renderScanPlanList(elements.pageScanPlanUnmatched, [], 'unmatched', '等待扫描');
        renderScanPlanList(elements.pageScanPlanSensitive, [], 'blocked', '等待扫描');
        return;
    }

    const matchedLabels = getBoundedScanPlanItems(preview.matchedFields, 6).map(getScanPlanFieldLabel);
    const unmatchedLabels = getBoundedScanPlanItems(preview.unmatchedRequiredLabels, 3);
    const sensitiveLabels = getBoundedScanPlanItems(preview.sensitiveRequiredLabels, 3);

    elements.pageScanPlan.hidden = false;
    if (elements.pageScanPlanTitle) {
        elements.pageScanPlanTitle.textContent = '扫描计划 · 将填写 / 仍需手动确认 / 安全跳过';
    }
    renderScanPlanList(elements.pageScanPlanMatched, matchedLabels, 'matched', '将填写 0');
    renderScanPlanList(elements.pageScanPlanUnmatched, unmatchedLabels, 'unmatched', '仍需手动确认 0');
    renderScanPlanList(elements.pageScanPlanSensitive, sensitiveLabels, 'blocked', '安全跳过 0');
}

function renderPageScanState(state, title, detail, preview = null) {
    if (elements.pageScanPanel) {
        elements.pageScanPanel.dataset.state = state;
        delete elements.pageScanPanel.dataset.matchCount;
        delete elements.pageScanPanel.dataset.fieldCount;
        delete elements.pageScanPanel.dataset.requiredMatchCount;
        delete elements.pageScanPanel.dataset.requiredCount;
        delete elements.pageScanPanel.dataset.sensitiveRequiredCount;

        if (preview) {
            elements.pageScanPanel.dataset.matchCount = String(preview.matchCount || 0);
            elements.pageScanPanel.dataset.fieldCount = String(preview.fieldCount || preview.total || 0);
            elements.pageScanPanel.dataset.requiredMatchCount = String(preview.requiredMatchCount || 0);
            elements.pageScanPanel.dataset.requiredCount = String(preview.requiredCount || 0);
            elements.pageScanPanel.dataset.sensitiveRequiredCount = String(preview.sensitiveRequiredCount || 0);
        }
    }
    if (elements.pageScanTitle) elements.pageScanTitle.textContent = title;
    if (elements.pageScanDetail) elements.pageScanDetail.textContent = detail;
    renderPageScanMeta(state === 'ready' ? preview : null);
    renderPageScanPlan(state === 'ready' ? preview : null);
    updateFillReadiness();
}

async function scanCurrentPageForms() {
    const btn = elements.scanCurrentPage;
    const loading = showLoading(btn, '扫描中');
    renderPageScanState('loading', '正在扫描当前页', '只读取可见表单字段，不会填写页面内容。');

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('未找到当前标签页');

        const scanResult = await sendMessageToTab(tab.id, { action: 'scanForm' });
        const summary = summarizePageScan(scanResult);

        if (!summary.total) {
            renderPageScanState('empty', '未发现可填写字段', '当前页没有可见的输入框、下拉框或文本域。');
            showToast('未发现可填写字段');
            return;
        }

        renderPageScanState(
            'ready',
            `${summary.pageTypeLabel} · ${summary.total} 个字段`,
            formatPageScanDetail(summary),
            summary.matchPreview ? { ...summary.matchPreview, fieldCount: summary.total } : null
        );
        showToast(`扫描到 ${summary.total} 个字段`);
    } catch (error) {
        renderPageScanState('error', '扫描失败', (error.message || '请刷新页面后重试').slice(0, 64));
        handleError(error, '扫描页面');
    } finally {
        loading.restore();
    }
}

function getFillOptions() {
    return {
        fillEmptyOnly: elements.fillEmptyOnlyToggle?.checked === true
    };
}

function summarizeFillResults(fillResult) {
    const results = fillResult?.results || {};
    const values = Object.values(results).map(value => String(value || ''));
    const skippedValues = values.filter(value => value.startsWith('skipped'));
    const skipFilled = skippedValues.filter(value => value === 'skipped filled').length;
    const skipSensitive = skippedValues.filter(value => value === 'skipped sensitive').length;
    const skipEmpty = skippedValues.filter(value => value === 'skipped empty').length;
    const skipOther = Math.max(0, skippedValues.length - skipFilled - skipSensitive - skipEmpty);

    return {
        filled: Number(fillResult?.filledCount || 0),
        skipped: skippedValues.length,
        skipFilled,
        skipSensitive,
        skipEmpty,
        skipOther,
        missed: values.filter(value => value === 'not found' || value === 'no matching option').length,
        total: values.length
    };
}

function formatFillResultToast(fillResult, label = '') {
    const summary = summarizeFillResults(fillResult);
    const prefix = label ? `${label} ` : '';

    if (!summary.total) return `${prefix}填表完成`;

    const parts = [`填 ${summary.filled}`];
    if (summary.skipped) parts.push(`跳过 ${summary.skipped}`);
    if (summary.missed) parts.push(`未命中 ${summary.missed}`);
    return `${prefix}${parts.join(' · ')}`;
}

function buildFillHistorySummary(fillResult, options = {}, mode = 'generated') {
    return {
        ...summarizeFillResults(fillResult),
        emptyOnly: options.fillEmptyOnly === true,
        mode
    };
}

/**
 * 构建 AI 表单填写 Prompt
 */
function buildAIFormPrompt(scanResult) {
    return `
You are an advanced AI Form Assistant. Your goal is to fill a web form intelligently, acting as the Persona defined below.

Current User Profile: ${JSON.stringify(getPublicProfileData())}
Persona Description: ${userSettings.aiPersona || 'None'}

Page Context:
Title: ${scanResult.pageContext.title}
Description: ${scanResult.pageContext.description}
URL: ${scanResult.pageContext.url}

Form Fields Found:
${JSON.stringify(scanResult.fields)}

Instructions:
1. **Analyze Context**: Determine the purpose of this form (e.g., "Job Application", "E-commerce Checkout", "Casual Survey", "Government Registration").
2. **Analyze Fields**: For each field, evaluate:
   - **Necessity**: Is it required? (Check 'required' attribute and context).
   - **Privacy/Risk**: Is this sensitive identity, financial, employment, or credential information?
3. **Decide Strategy**:
   - **Real Format**: For standard required fields, use the Persona's data.
   - **Sensitive Boundary**: NEVER fill full card numbers, CVV/CVC, SSN, tax IDs, national IDs, passport numbers, driver's license numbers, bank account numbers, routing numbers, income, salary, employer, company name, or employment status. Omit those keys or return an empty string.
   - **Leave Empty**: If a field is optional, intrusive, or not relevant to the form's core purpose, omit the key or return an empty string.
   - **Refuse/N/A**: If a field is intrusive and allows text input, you may fill "N/A" or "Prefer not to say".
4. **Cultural & Language Adaptation** (CRITICAL):
   - **GLOBAL RULE**: ALWAYS use **Half-width (ASCII)** characters for: **Password**, **Email**, **Phone**, **Postal Code**, **Numbers**. NEVER use Full-width (e.g., １２３, ａｂｃ) for these fields.
   - **Address Logic**: If the form expects a **Local Address** (e.g., has "Prefecture" dropdown, or specific local Zip format) and the Current User Profile has a foreign address, **IGNORE the Profile address and INVENT a valid local address** for the page's target country.
   - **Detect Language**: The page language is '${scanResult.pageContext.language}'. Adapt formats accordingly.
   - **Japan (JP)**:
     - **Name**: Use Surname First order. Use Kanji for Name fields, Katakana for "Furigana/Reading" fields.
     - **Postal Code**: Check placeholder. If unknown, try "NNN-NNNN" (ASCII).
     - **Phone**: Check placeholder. If unknown, generate a **RANDOM** valid mobile number (starts with 090, 080, or 070). **DO NOT** use "1234" or "0000" sequences. Example: "080-3928-4719".
   - **Germany (DE)**: Ensure addresses are precise (Street + Number, Zip City). Use formal tone.
   - **China (CN)**: Use +86 phone format. Do not generate resident ID numbers or other government identifiers.
   - **Tone**: Match the questionnaire tone (Conservative/Formal for Gov/Bank; Open/Casual for Social/Gaming).
5. **Invent Missing Data**: If the Persona lacks normal non-sensitive profile data, invent it consistently. Do not invent identity, financial, employment, or payment credentials.

Output Format:
Return ONLY a valid JSON object where keys are the field 'id' and values are the string to fill.
Example:
{
  "field_1": "John",
  "income_field": "50,000 - 60,000 USD",
  "optional_intrusive_field": ""
}
`;
}

const AI_FORBIDDEN_FIELD_TERMS = [
    'ssn', 'socialsecurity', 'socialsecuritynumber', 'taxid', 'tin', 'itin', 'ein',
    'nationalid', 'residentid', 'identitynumber', 'idcard', 'passport',
    'driverlicense', 'driverslicense', 'drivinglicense', 'creditcard', 'creditcardnumber',
    'cardnumber', 'ccnumber', 'cvv', 'cvc', 'securitycode', 'bankaccount',
    'accountnumber', 'routingnumber', 'iban', 'swift', 'income', 'salary',
    'annualincome', 'monthlysalary', 'employmentstatus', 'employer', 'company', 'companyname'
];

const AI_FORBIDDEN_LOCALIZED_TERMS = [
    '社会安全', '社会保障', '身份证', '身份證', '居民身份证', '居民身份',
    '纳税', '納税', '税号', '稅號', '個人番号', 'マイナンバー',
    '驾驶证', '駕駛證', '運転免許', '护照', '護照', 'パスポート',
    '信用卡', '卡号', '卡號', '安全码', '安全碼', '银行卡', '銀行卡',
    '银行账号', '銀行帳號', '銀行口座', '收入', '薪资', '薪資', '年収',
    '年收入', '月收入', '职业状态', '職業狀態', '雇主', '公司', '勤務先', '会社名'
];

function normalizeFieldText(value) {
    return String(value || '').toLowerCase().replace(/[\s_\-./:：()[\]（）]+/g, '');
}

function isForbiddenAIFormField(fieldMeta, key) {
    const rawText = [
        key,
        fieldMeta?.id,
        fieldMeta?.name,
        fieldMeta?.type,
        fieldMeta?.label,
        fieldMeta?.placeholder,
        fieldMeta?.context,
        fieldMeta?.group,
        fieldMeta?.autocomplete
    ].filter(Boolean).join(' ');
    const compactText = normalizeFieldText(rawText);

    return AI_FORBIDDEN_FIELD_TERMS.some(term => compactText.includes(term)) ||
        AI_FORBIDDEN_LOCALIZED_TERMS.some(term => rawText.includes(term));
}

/**
 * 清洗 AI 返回的表单映射数据
 */
function sanitizeFormMapping(mapping, scanResult) {
    Object.keys(mapping).forEach(key => {
        const fieldMeta = scanResult.fields.find(f => f.id === key || f.name === key);
        if (isForbiddenAIFormField(fieldMeta, key)) {
            delete mapping[key];
            return;
        }

        let val = mapping[key];
        if (val === null || val === undefined) {
            delete mapping[key];
            return;
        }

        if (typeof val === 'string') {
            // 1. 全角转半角 (通用处理)
            val = val.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
                .replace(/\u3000/g, ' ');

            if (!val.trim()) {
                delete mapping[key];
                return;
            }

            // 2. 查找字段元数据
            const label = fieldMeta ? (fieldMeta.label || '').toLowerCase() : '';
            const type = fieldMeta ? (fieldMeta.type || '').toLowerCase() : '';
            const name = fieldMeta ? (fieldMeta.name || '').toLowerCase() : '';
            const lowerKey = key.toLowerCase();

            // 3. 智能判断字段类型并清洗
            const isPassword = type === 'password' || lowerKey.includes('password') || name.includes('password') || label.includes('密码') || label.includes('パスワード');
            const isEmail = type === 'email' || lowerKey.includes('email') || name.includes('email') || label.includes('邮箱') || label.includes('メール');
            const isPhone = type === 'tel' || lowerKey.includes('phone') || lowerKey.includes('mobile') || label.includes('电话') || label.includes('電話') || label.includes('携帯');
            const isZip = lowerKey.includes('zip') || lowerKey.includes('postal') || label.includes('邮编') || label.includes('郵便');

            if (isPassword) {
                // 密码：强制使用当前 Profile 的密码
                if (currentData.password) {
                    val = currentData.password;
                } else if (window.generators && window.generators.generatePasswordWithSettings) {
                    val = window.generators.generatePasswordWithSettings(userSettings);
                } else {
                    val = val.replace(/[^\x00-\x7F]/g, '');
                }
            } else if (isEmail) {
                // 邮箱：只保留 ASCII
                val = val.replace(/[^\x00-\x7F]/g, '');
            } else if (isPhone) {
                // 电话：强制使用当前 Profile 的电话
                if (currentData.phone) {
                    val = currentData.phone;
                } else if (window.generators && window.generators.generatePhone) {
                    const country = ipData.country || 'United States';
                    val = window.generators.generatePhone(country);
                } else {
                    val = val.replace(/[^\d-]/g, '');
                }
            } else if (isZip) {
                // 邮编：只保留数字和横杠
                val = val.replace(/[^\d-]/g, '');
            }

            mapping[key] = val;
        }
    });
}

// copyAllToClipboard 已在 utils.js 中定义
