/**
 * Content Script - 表单自动填写（增强版）
 */

(() => {
if (window.__formPilotContentLoaded) {
    return;
}
window.__formPilotContentLoaded = true;

const FORMPILOT_DEBUG = false;
const formPilotLog = (...args) => FORMPILOT_DEBUG && console.log('[FormPilot]', ...args);

// 常见表单字段选择器映射（扩展版）
// 常见表单字段选择器映射（扩展版）
const FIELD_SELECTORS = {
    ...window.FormPilotSelectors.common,
    ...window.FormPilotSelectors.japan
};

// 标签关键字映射
const LABEL_KEYWORDS = {
    ...window.FormPilotSelectors.commonLabels,
    ...window.FormPilotSelectors.japanLabels
};

// 用于检测全名字段（需要拆分）
const FULLNAME_SELECTORS = window.FormPilotSelectors.fullNames || [];

const PUBLIC_SCAN_PREVIEW_FIELDS = [
    'fullName', 'firstName', 'lastName', 'gender', 'birthday',
    'username', 'email', 'password', 'phone', 'address',
    'city', 'state', 'zipCode', 'country'
];

/**
 * 获取元素的标签文本
 */
function getLabelText(element) {
    let labelText = '';
    const id = element.id;

    // 1. 查找 <label for="id">
    if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) labelText += label.innerText;
    }

    // 2. 查找父级 <label>
    const parentLabel = element.closest('label');
    if (parentLabel) labelText += parentLabel.innerText;

    // 3. 查找 aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) labelText += ariaLabel;

    // 4. 查找 placeholder
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) labelText += placeholder;

    // 5. 查找前置文本节点 (简单的启发式)
    // 很多表格布局中，label 在 input 的前一个 td 或兄弟节点
    let previous = element.previousElementSibling;
    while (previous) {
        if (previous.tagName === 'LABEL' || previous.tagName === 'SPAN' || previous.tagName === 'TD' || previous.tagName === 'TH') {
            labelText += previous.innerText;
            break;
        }
        previous = previous.previousElementSibling;
    }

    return labelText.toLowerCase().replace(/\s+/g, '');
}

/**
 * 通过标签文本查找字段
 */
function findFieldByLabel(fieldName) {
    const keywords = LABEL_KEYWORDS[fieldName];
    if (!keywords || keywords.length === 0) return null;

    // 获取所有可见的输入框
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'));

    for (const input of inputs) {
        if (input.disabled || input.readOnly || !isVisible(input)) continue;

        // 如果该输入框已经被其他规则匹配过，可能需要跳过（这里简化处理，优先匹配）

        const text = getLabelText(input);
        if (!text) continue;

        for (const keyword of keywords) {
            // 简单的包含匹配
            if (text.includes(keyword.toLowerCase().replace(/\s+/g, ''))) {
                return input;
            }
        }
    }
    return null;
}

/**
 * 查找表单字段（单个）
 */
function findField(fieldName) {
    // 1. 优先尝试 CSS 选择器
    const selectors = FIELD_SELECTORS[fieldName] || [];
    for (const selector of selectors) {
        try {
            const element = document.querySelector(selector);
            if (element && isVisible(element) && !element.disabled && !element.readOnly) {
                return element;
            }
        } catch (e) {
            // 忽略无效选择器
        }
    }

    // 2. 尝试智能标签匹配
    return findFieldByLabel(fieldName);
}


/**
 * 查找全名字段
 */
function findFullNameField() {
    for (const selector of FULLNAME_SELECTORS) {
        try {
            const element = document.querySelector(selector);
            if (element && isVisible(element) && !element.disabled && !element.readOnly) {
                return element;
            }
        } catch (e) {
            formPilotLog('Selector error:', selector, e);
        }
    }
    return null;
}

/**
 * 查找所有匹配的字段（用于密码等需要填写多次的字段）
 */
function findAllFields(fieldName) {
    const selectors = FIELD_SELECTORS[fieldName] || [];
    const elements = [];

    for (const selector of selectors) {
        try {
            const allElements = document.querySelectorAll(selector);
            allElements.forEach(element => {
                if (isVisible(element) && !element.disabled && !element.readOnly) {
                    // 避免重复添加
                    if (!elements.includes(element)) {
                        elements.push(element);
                    }
                }
            });
        } catch (e) {
            formPilotLog('Selector error:', selector, e);
        }
    }

    return elements;
}

/**
 * 检查元素是否可见
 */
function isVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;
}

/**
 * 模拟用户输入（增强版，支持 React/Vue 等框架）
 */
function simulateInput(element, value) {
    // 聚焦元素
    element.focus();

    // 对于 React 等框架，需要使用原生 setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
    )?.set;

    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    // 清空并设置值
    if (element.tagName.toLowerCase() === 'textarea' && nativeTextAreaValueSetter) {
        nativeTextAreaValueSetter.call(element, value);
    } else if (nativeInputValueSetter) {
        nativeInputValueSetter.call(element, value);
    } else {
        element.value = value;
    }

    // 触发各种事件以确保表单验证和框架状态更新
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    element.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'a' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));

    // 失焦触发验证
    element.blur();
}

/**
 * 处理 select 元素（增强版）
 */
function fillSelect(element, value) {
    const options = element.options;
    const searchValue = value.toLowerCase();

    // 首先尝试精确匹配
    for (let i = 0; i < options.length; i++) {
        const optionText = options[i].text.toLowerCase();
        const optionValue = options[i].value.toLowerCase();

        if (optionText === searchValue || optionValue === searchValue) {
            element.selectedIndex = i;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
    }

    // 然后尝试包含匹配
    for (let i = 0; i < options.length; i++) {
        const optionText = options[i].text.toLowerCase();
        const optionValue = options[i].value.toLowerCase();

        if (optionText.includes(searchValue) || optionValue.includes(searchValue) ||
            searchValue.includes(optionText) || searchValue.includes(optionValue)) {
            element.selectedIndex = i;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
    }

    return false;
}

/**
 * 处理 radio 按钮
 */
function hasCheckedRadio(name) {
    return Boolean(document.querySelector(`input[type="radio"][name*="${name}" i]:checked`));
}

function fillRadio(name, value, options = {}) {
    if (options.fillEmptyOnly === true && hasCheckedRadio(name)) return 'skipped filled';

    const radios = document.querySelectorAll(`input[type="radio"][name*="${name}" i]`);
    const searchValue = value.toLowerCase();

    for (const radio of radios) {
        const radioValue = radio.value.toLowerCase();
        const labelText = radio.labels?.[0]?.textContent?.toLowerCase() || '';

        if (radioValue.includes(searchValue) || labelText.includes(searchValue)) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
    }
    return false;
}

function hasExistingValue(element) {
    if (!element) return false;
    if (element.type === 'radio' || element.type === 'checkbox') return element.checked;
    return String(element.value || '').trim().length > 0;
}

function shouldSkipFilledField(element, options = {}) {
    return options.fillEmptyOnly === true && hasExistingValue(element);
}

function getPreviewElementsForField(fieldName) {
    if (fieldName === 'fullName') {
        const fullNameField = findFullNameField();
        return fullNameField ? [fullNameField] : [];
    }

    if (fieldName === 'password') {
        return findAllFields('password');
    }

    const field = findField(fieldName);
    return field ? [field] : [];
}

function getSafeScanPreviewLabel(meta) {
    const label = String(meta?.label || meta?.placeholder || meta?.name || meta?.id || '').trim();
    return label.replace(/\s+/g, ' ').slice(0, 48);
}

function isSensitiveScanPreviewItem(item) {
    const meta = item?.meta || {};
    const rawText = [
        meta.id,
        meta.name,
        meta.type,
        meta.label,
        meta.placeholder,
        meta.context,
        meta.group,
        meta.autocomplete,
        item?.input?.getAttribute?.('aria-label'),
        getLabelText(item?.input || {})
    ].filter(Boolean).join(' ');
    const compactText = normalizeSmartFillText(rawText);

    return SMART_FILL_FORBIDDEN_FIELD_TERMS.some(term => compactText.includes(term)) ||
        SMART_FILL_FORBIDDEN_LOCALIZED_TERMS.some(term => rawText.includes(term));
}

function buildScanMatchPreview(scanItems) {
    const elementMatches = new Map();

    PUBLIC_SCAN_PREVIEW_FIELDS.forEach(fieldName => {
        getPreviewElementsForField(fieldName).forEach(element => {
            if (!elementMatches.has(element)) elementMatches.set(element, []);
            elementMatches.get(element).push(fieldName);
        });
    });

    const matchedFields = [];
    const matchedSet = new Set();
    const requiredItems = scanItems.filter(item => item.meta.required);
    let matchCount = 0;
    let requiredMatchCount = 0;
    let sensitiveRequiredCount = 0;
    const unmatchedRequiredLabels = [];
    const sensitiveRequiredLabels = [];

    scanItems.forEach(item => {
        const match = elementMatches.get(item.input)?.[0] || '';
        if (!match) {
            if (item.meta.required) {
                const label = getSafeScanPreviewLabel(item.meta);
                if (isSensitiveScanPreviewItem(item)) {
                    sensitiveRequiredCount++;
                    if (label) sensitiveRequiredLabels.push(label);
                } else if (label) {
                    unmatchedRequiredLabels.push(label);
                }
            }
            return;
        }

        if (!matchedSet.has(match)) {
            matchedSet.add(match);
            matchedFields.push(match);
        }

        matchCount++;
        if (item.meta.required) requiredMatchCount++;
    });

    return {
        fieldCount: scanItems.length,
        matchCount,
        requiredCount: requiredItems.length,
        requiredMatchCount,
        missingRequiredCount: Math.max(0, requiredItems.length - requiredMatchCount),
        matchedFields: matchedFields.slice(0, 12),
        unmatchedRequiredLabels: unmatchedRequiredLabels.slice(0, 3),
        sensitiveRequiredCount,
        sensitiveRequiredLabels: sensitiveRequiredLabels.slice(0, 3)
    };
}

function fillSingleField(fieldName, value, options = {}) {
    const element = findField(fieldName);
    if (!element) return false;
    if (shouldSkipFilledField(element, options)) return 'skipped filled';

    if (element.tagName.toLowerCase() === 'select') {
        return fillSelect(element, value);
    }

    simulateInput(element, value);
    return true;
}

function fillGenericAddressFallback(data, options = {}) {
    const fallbackFields = {
        address: data.shippingAddress || data.address,
        city: data.shippingCity || data.city,
        state: data.shippingState || data.state,
        zipCode: data.shippingZipCode || data.zipCode,
        country: data.shippingCountry || data.country
    };
    const fallbackResults = {};
    let count = 0;

    for (const [fieldName, value] of Object.entries(fallbackFields)) {
        if (!value) continue;
        const result = fillSingleField(fieldName, value, options);
        if (result === 'skipped filled') {
            fallbackResults[fieldName] = 'skipped filled';
        } else if (result) {
            count++;
            fallbackResults[fieldName] = 'filled';
        } else {
            fallbackResults[fieldName] = 'not found';
        }
    }

    return { count, fallbackResults };
}

/**
 * 填写表单（增强版）
 */
function fillForm(data, options = {}) {
    let filledCount = 0;
    const results = {};
    const hasSpecificAddressData = !!(
        data.shippingAddress || data.billingAddress || data.shippingCity || data.billingCity ||
        data.shippingState || data.billingState || data.shippingZipCode || data.billingZipCode ||
        data.shippingCountry || data.billingCountry
    );

    // 先检查是否有全名字段
    const fullNameField = findFullNameField();
    if (fullNameField && data.firstName && data.lastName) {
        if (shouldSkipFilledField(fullNameField, options)) {
            results['fullName'] = 'skipped filled';
        } else {
            const fullName = `${data.firstName} ${data.lastName}`;
            simulateInput(fullNameField, fullName);
            filledCount++;
            results['fullName'] = 'filled';
        }
    }

    for (const [fieldName, value] of Object.entries(data)) {
        if (!value) continue;

        // address 字段延迟到最后填写，避免被邮编自动填充覆盖
        if (fieldName === 'address') {
            continue;
        }

        // 有收货/账单专用字段时，通用字段只作为兜底，避免覆盖专用地址。
        if (hasSpecificAddressData && ['city', 'state', 'zipCode', 'country'].includes(fieldName)) {
            continue;
        }

        // 密码字段需要填写所有匹配项（密码 + 确认密码）
        if (fieldName === 'password') {
            const elements = findAllFields('password');
            if (elements.length > 0) {
                const targets = elements.filter(element => !shouldSkipFilledField(element, options));
                targets.forEach(element => {
                    simulateInput(element, value);
                    filledCount++;
                });
                results[fieldName] = targets.length
                    ? `filled ${targets.length} field(s)`
                    : 'skipped filled';
            } else {
                results[fieldName] = 'not found';
            }
            continue;
        }

        // 电话字段去掉区号，只填写号码部分
        if (fieldName === 'phone') {
            const element = findField(fieldName);
            if (element) {
                // 根据字段类型决定是否保留格式
                if (shouldSkipFilledField(element, options)) {
                    results[fieldName] = 'skipped filled';
                } else {
                    const phoneNumber = value.replace(/^\+\d+\s*/, '');
                    simulateInput(element, phoneNumber);
                    filledCount++;
                    results[fieldName] = 'filled';
                }
            } else {
                results[fieldName] = 'not found';
            }
            continue;
        }

        // 性别字段特殊处理（可能是 radio）
        if (fieldName === 'gender') {
            const element = findField(fieldName);
            if (element) {
                if (shouldSkipFilledField(element, options)) {
                    results[fieldName] = 'skipped filled';
                } else if (element.tagName.toLowerCase() === 'select') {
                    if (fillSelect(element, value)) {
                        filledCount++;
                        results[fieldName] = 'filled (select)';
                    }
                } else {
                    simulateInput(element, value);
                    filledCount++;
                    results[fieldName] = 'filled';
                }
            } else {
                // 尝试 radio 按钮
                const genderRadioResult = fillRadio('gender', value, options);
                const sexRadioResult = genderRadioResult || fillRadio('sex', value, options);
                if (sexRadioResult === 'skipped filled') {
                    results[fieldName] = 'skipped filled';
                } else if (sexRadioResult) {
                    filledCount++;
                    results[fieldName] = 'filled (radio)';
                } else {
                    results[fieldName] = 'not found';
                }
            }
            continue;
        }

        const element = findField(fieldName);

        if (element) {
            if (shouldSkipFilledField(element, options)) {
                results[fieldName] = 'skipped filled';
            } else if (element.tagName.toLowerCase() === 'select') {
                if (fillSelect(element, value)) {
                    filledCount++;
                    results[fieldName] = 'filled';
                } else {
                    results[fieldName] = 'no matching option';
                }
            } else {
                simulateInput(element, value);
                filledCount++;
                results[fieldName] = 'filled';
            }
        } else {
            results[fieldName] = 'not found';
        }
    }

    formPilotLog('填写完成:', filledCount, '个字段', results);

    if (hasSpecificAddressData) {
        const filledSpecificAddress = Object.entries(results).some(([key, result]) => {
            return (key.startsWith('shipping') || key.startsWith('billing')) && String(result).startsWith('filled');
        });

        if (!filledSpecificAddress) {
            const fallback = fillGenericAddressFallback(data, options);
            filledCount += fallback.count;
            Object.assign(results, fallback.fallbackResults);
            formPilotLog('使用通用地址兜底:', fallback.fallbackResults);
        }
    }

    // 最后填写 address 字段，避免被邮编自动填充覆盖
    if (data.address && !hasSpecificAddressData) {
        setTimeout(() => {
            const addressEl = findField('address');
            if (addressEl) {
                // 确保不是邮箱字段
                const elName = (addressEl.name || '').toLowerCase();
                const elType = (addressEl.type || '').toLowerCase();
                if (elType === 'email' || elName.includes('mail')) {
                    formPilotLog('跳过 address 填写，目标是邮箱字段');
                } else if (shouldSkipFilledField(addressEl, options)) {
                    formPilotLog('跳过 address 填写，目标已有内容');
                } else {
                    simulateInput(addressEl, data.address);
                    formPilotLog('延迟填写 address:', data.address);
                }
            }
        }, 1500);
    }

    return { filledCount, results };
}

/**
 * 扫描页面表单结构（增强版）
 */
function scanForm() {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'));
    const formStructure = [];
    const scanItems = [];

    inputs.forEach((input, index) => {
        if (!isVisible(input) || input.disabled || input.readOnly) return;

        // 获取标签文本（增强版）
        const labelInfo = getEnhancedLabel(input);

        // 获取扩展上下文（向上遍历3层）
        const context = getExpandedContext(input);

        // 检测所属分组
        const group = detectFieldGroup(input);

        // 检测相邻字段关系
        const siblingInfo = detectSiblingRelation(input, inputs);

        // 获取 ID 或 Name 作为唯一标识
        const id = input.id || input.name || `field_${index}`;

        const meta = {
            id: id,
            type: input.type || input.tagName.toLowerCase(),
            label: labelInfo.text,
            labelSource: labelInfo.source,
            placeholder: input.placeholder || '',
            context: context,
            group: group,
            siblings: siblingInfo,
            name: input.name || '',
            className: input.className || '',
            required: input.required || input.getAttribute('aria-required') === 'true',
            min: input.min || '',
            max: input.max || '',
            maxLength: input.maxLength > 0 ? input.maxLength : '',
            pattern: input.pattern || '',
            autocomplete: input.autocomplete || ''
        };

        formStructure.push(meta);
        scanItems.push({ input, meta });
    });

    // 获取页面语义信息（增强版）
    const pageContext = analyzePageContext();

    return {
        fields: formStructure,
        pageContext: pageContext,
        matchPreview: buildScanMatchPreview(scanItems)
    };
}

/**
 * 获取增强的标签信息
 */
function getEnhancedLabel(element) {
    let labelText = '';
    let labelSource = '';
    const id = element.id;

    // 1. 查找 <label for="id">
    if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) {
            labelText = label.innerText.trim();
            labelSource = 'label-for';
        }
    }

    // 2. 查找父级 <label>
    if (!labelText) {
        const parentLabel = element.closest('label');
        if (parentLabel) {
            labelText = parentLabel.innerText.trim();
            labelSource = 'parent-label';
        }
    }

    // 3. aria-label
    if (!labelText) {
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel) {
            labelText = ariaLabel;
            labelSource = 'aria-label';
        }
    }

    // 4. aria-labelledby
    if (!labelText) {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) {
                labelText = labelEl.innerText.trim();
                labelSource = 'aria-labelledby';
            }
        }
    }

    // 5. aria-describedby (作为补充上下文)
    if (!labelText) {
        const describedBy = element.getAttribute('aria-describedby');
        if (describedBy) {
            const descEl = document.getElementById(describedBy);
            if (descEl) {
                labelText = descEl.innerText.trim();
                labelSource = 'aria-describedby';
            }
        }
    }

    // 6. title 属性
    if (!labelText) {
        const title = element.getAttribute('title');
        if (title) {
            labelText = title;
            labelSource = 'title';
        }
    }

    // 7. placeholder
    if (!labelText) {
        const placeholder = element.getAttribute('placeholder');
        if (placeholder) {
            labelText = placeholder;
            labelSource = 'placeholder';
        }
    }

    // 8. 前置兄弟元素（表格布局常见）
    if (!labelText) {
        let previous = element.previousElementSibling;
        let attempts = 0;
        while (previous && attempts < 3) {
            if (['LABEL', 'SPAN', 'TD', 'TH', 'DIV', 'P'].includes(previous.tagName)) {
                const text = previous.innerText?.trim();
                if (text && text.length < 100) {
                    labelText = text;
                    labelSource = 'sibling-element';
                    break;
                }
            }
            previous = previous.previousElementSibling;
            attempts++;
        }
    }

    // 9. 父级元素中的文本节点（去除子元素文本后）
    if (!labelText) {
        const parent = element.parentElement;
        if (parent) {
            const cloned = parent.cloneNode(true);
            // 移除 input 元素
            cloned.querySelectorAll('input, select, textarea, button').forEach(el => el.remove());
            const text = cloned.innerText?.trim();
            if (text && text.length < 200) {
                labelText = text;
                labelSource = 'parent-text';
            }
        }
    }

    return {
        text: labelText.replace(/\s+/g, ' ').substring(0, 200),
        source: labelSource
    };
}

/**
 * 获取扩展上下文（向上遍历多层）
 */
function getExpandedContext(element) {
    const contextParts = [];
    let current = element.parentElement;
    let depth = 0;
    const maxDepth = 4;

    while (current && depth < maxDepth) {
        // 检查是否有有意义的语义信息
        const tagName = current.tagName.toLowerCase();

        // 跳过无意义的容器
        if (['body', 'html', 'main', 'article', 'section'].includes(tagName)) {
            break;
        }

        // 检查类名和 ID 中的语义
        const semantic = extractSemanticFromElement(current);
        if (semantic) {
            contextParts.push(semantic);
        }

        // 检查 heading 元素
        const heading = current.querySelector('h1, h2, h3, h4, h5, h6, legend');
        if (heading && !contextParts.includes(heading.innerText.trim())) {
            const headingText = heading.innerText.trim();
            if (headingText.length < 100) {
                contextParts.push(`[section: ${headingText}]`);
            }
        }

        current = current.parentElement;
        depth++;
    }

    return contextParts.join(' | ').substring(0, 300);
}

/**
 * 从元素中提取语义信息（class, id, data-* 属性）
 */
function extractSemanticFromElement(element) {
    const hints = [];

    // 检查 class
    const className = element.className;
    if (className && typeof className === 'string') {
        // 常见语义关键词
        const semanticKeywords = ['personal', 'contact', 'address', 'payment', 'billing', 'shipping',
            'account', 'profile', 'login', 'register', 'signup', 'form', 'info', 'details',
            '个人', '联系', '地址', '支付', '账户', '注册', '登录'];

        for (const keyword of semanticKeywords) {
            if (className.toLowerCase().includes(keyword)) {
                hints.push(`class:${keyword}`);
            }
        }
    }

    // 检查 data-* 属性
    for (const attr of element.attributes) {
        if (attr.name.startsWith('data-') && attr.value) {
            const value = attr.value.toLowerCase();
            if (value.length < 50 && !/^\d+$/.test(value)) {
                hints.push(`${attr.name}:${value}`);
            }
        }
    }

    return hints.length > 0 ? hints.join(', ') : '';
}

/**
 * 检测字段所属分组
 */
function detectFieldGroup(element) {
    // 1. 检查 fieldset
    const fieldset = element.closest('fieldset');
    if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) {
            return legend.innerText.trim();
        }
    }

    // 2. 检查带有标题的父容器
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 5) {
        // 检查是否有分组标题
        const heading = current.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
        if (heading) {
            return heading.innerText.trim();
        }

        // 检查常见分组类名
        const className = (current.className || '').toLowerCase();
        if (className.includes('group') || className.includes('section') || className.includes('block') || className.includes('panel')) {
            // 尝试从第一个标题或 label 获取分组名
            const firstHeading = current.querySelector('h1, h2, h3, h4, h5, h6, .title, .heading');
            if (firstHeading) {
                return firstHeading.innerText.trim();
            }
        }

        current = current.parentElement;
        depth++;
    }

    return '';
}

/**
 * 检测相邻字段关系
 */
function detectSiblingRelation(element, allInputs) {
    const info = {
        prevField: null,
        nextField: null,
        sameNamePrefix: []
    };

    const currentIndex = allInputs.indexOf(element);

    // 前一个字段
    if (currentIndex > 0) {
        const prev = allInputs[currentIndex - 1];
        if (prev.name || prev.id) {
            info.prevField = prev.name || prev.id;
        }
    }

    // 后一个字段
    if (currentIndex < allInputs.length - 1) {
        const next = allInputs[currentIndex + 1];
        if (next.name || next.id) {
            info.nextField = next.name || next.id;
        }
    }

    // 相同 name 前缀的字段（如 address_1, address_2）
    const currentName = element.name || '';
    if (currentName) {
        const prefix = currentName.replace(/[\[\]_-]?\d+[\[\]_-]?$/, '').replace(/[\[\]_-]$/, '');
        if (prefix && prefix !== currentName) {
            allInputs.forEach(input => {
                if (input !== element && input.name && input.name.startsWith(prefix)) {
                    info.sameNamePrefix.push(input.name);
                }
            });
        }
    }

    return info;
}

/**
 * 分析页面上下文（增强版）
 */
function analyzePageContext() {
    const pageTitle = document.title;
    const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
    const url = window.location.href;
    const language = document.documentElement.lang || navigator.language || 'en';

    // 检测页面类型
    const pageType = detectPageType(url, pageTitle, metaDesc);

    // 获取表单 action
    const forms = document.querySelectorAll('form');
    const formActions = [];
    forms.forEach(form => {
        if (form.action) {
            formActions.push(form.action);
        }
    });

    // 获取页面主标题
    const h1 = document.querySelector('h1');
    const mainHeading = h1 ? h1.innerText.trim() : '';

    // 检测是否有 CAPTCHA
    const hasCaptcha = !!(
        document.querySelector('[class*="captcha"]') ||
        document.querySelector('[id*="captcha"]') ||
        document.querySelector('[class*="recaptcha"]') ||
        document.querySelector('iframe[src*="recaptcha"]')
    );

    // 检测提交按钮文本
    const submitBtn = document.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    const submitText = submitBtn ? (submitBtn.innerText || submitBtn.value || '').trim() : '';

    return {
        title: pageTitle,
        description: metaDesc,
        url: url,
        language: language,
        pageType: pageType,
        mainHeading: mainHeading,
        formActions: formActions,
        hasCaptcha: hasCaptcha,
        submitButtonText: submitText
    };
}

/**
 * 检测页面类型
 */
function detectPageType(url, title, description) {
    const combined = `${url} ${title} ${description}`.toLowerCase();

    // 按优先级检测
    const patterns = [
        { type: 'login', keywords: ['login', 'signin', 'sign in', 'log in', '登录', 'ログイン', '로그인'] },
        { type: 'register', keywords: ['register', 'signup', 'sign up', 'create account', '注册', '新規登録', '会員登録', '가입'] },
        { type: 'checkout', keywords: ['checkout', 'payment', 'order', 'cart', '结账', '支付', '购物车', '決済', 'お支払い'] },
        { type: 'contact', keywords: ['contact', 'inquiry', 'message', '联系', '留言', 'お問い合わせ', '問い合わせ'] },
        { type: 'survey', keywords: ['survey', 'questionnaire', 'feedback', '问卷', '调查', 'アンケート'] },
        { type: 'profile', keywords: ['profile', 'account', 'settings', 'edit', '个人资料', '账户', 'プロフィール', '設定'] },
        { type: 'application', keywords: ['apply', 'application', 'job', 'career', '申请', '应聘', '応募', '申込'] },
        { type: 'subscription', keywords: ['subscribe', 'newsletter', 'mailing', '订阅', '购读'] }
    ];

    for (const { type, keywords } of patterns) {
        for (const keyword of keywords) {
            if (combined.includes(keyword)) {
                return type;
            }
        }
    }

    return 'unknown';
}

/**
 * 智能填写表单 (AI)
 */
const SMART_FILL_FORBIDDEN_FIELD_TERMS = [
    'ssn', 'socialsecurity', 'socialsecuritynumber', 'taxid', 'tin', 'itin', 'ein',
    'nationalid', 'residentid', 'identitynumber', 'idcard', 'passport',
    'driverlicense', 'driverslicense', 'drivinglicense', 'creditcardnumber',
    'cardnumber', 'ccnumber', 'cvv', 'cvc', 'securitycode', 'bankaccount',
    'accountnumber', 'routingnumber', 'iban', 'swift', 'income', 'salary',
    'annualincome', 'monthlysalary', 'employmentstatus', 'employer', 'company', 'companyname'
];

const SMART_FILL_FORBIDDEN_LOCALIZED_TERMS = [
    '社会安全', '社会保障', '身份证', '身份證', '居民身份证', '居民身份',
    '纳税', '納税', '税号', '稅號', '個人番号', 'マイナンバー',
    '驾驶证', '駕駛證', '運転免許', '护照', '護照', 'パスポート',
    '信用卡', '卡号', '卡號', '安全码', '安全碼', '银行卡', '銀行卡',
    '银行账号', '銀行帳號', '銀行口座', '收入', '薪资', '薪資', '年収',
    '年收入', '月收入', '职业状态', '職業狀態', '雇主', '公司', '勤務先', '会社名'
];

function normalizeSmartFillText(value) {
    return String(value || '').toLowerCase().replace(/[\s_\-./:：()[\]（）]+/g, '');
}

function isForbiddenSmartFillTarget(key, element) {
    const rawText = [
        key,
        element?.id,
        element?.name,
        element?.type,
        element?.autocomplete,
        element?.placeholder,
        element?.getAttribute?.('aria-label'),
        getLabelText(element || {})
    ].filter(Boolean).join(' ');
    const compactText = normalizeSmartFillText(rawText);

    return SMART_FILL_FORBIDDEN_FIELD_TERMS.some(term => compactText.includes(term)) ||
        SMART_FILL_FORBIDDEN_LOCALIZED_TERMS.some(term => rawText.includes(term));
}

function fillFormSmart(mapping, options = {}) {
    let filledCount = 0;
    const results = {};

    for (const [key, value] of Object.entries(mapping)) {
        if (value === null || value === undefined || value === '') {
            results[key] = 'skipped empty';
            continue;
        }

        // key 可能是 id 或 name
        let element = document.getElementById(key);
        if (!element) {
            element = document.querySelector(`[name="${key}"]`);
        }

        // 如果是生成的临时 ID (field_x)，尝试通过索引找回（不太可靠，但作为兜底）
        if (!element && key.startsWith('field_')) {
            const index = parseInt(key.split('_')[1]);
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'));
            if (inputs[index]) element = inputs[index];
        }

        if (element && isVisible(element)) {
            if (isForbiddenSmartFillTarget(key, element)) {
                results[key] = 'skipped sensitive';
                continue;
            }

            if (shouldSkipFilledField(element, options)) {
                results[key] = 'skipped filled';
                continue;
            }

            if (element.tagName.toLowerCase() === 'select') {
                fillSelect(element, value);
            } else if (element.type === 'radio' || element.type === 'checkbox') {
                // 对于 radio/checkbox，AI 可能会返回 true/false 或 value
                if (value === true || value === 'true' || value === element.value) {
                    element.checked = true;
                }
            } else {
                simulateInput(element, String(value));
            }
            filledCount++;
            results[key] = 'filled';
        } else {
            results[key] = 'not found';
        }
    }

    return { filledCount, results };
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fillForm') {
        const result = fillForm(request.data, request.options || {});
        sendResponse(result);
    } else if (request.action === 'scanForm') {
        const result = scanForm();
        sendResponse(result);
    } else if (request.action === 'fillFormSmart') {
        const result = fillFormSmart(request.data, request.options || {});
        sendResponse(result);
    }
    return true;
});

// 标记 content script 已加载
formPilotLog('Content script loaded (Enhanced)');
})();
