/**
 * API 与通信模块
 */

/**
 * 获取 IP 信息
 */
async function fetchIPInfo() {
    log.info('开始获取 IP 信息...');

    if (elements.ipInfo) {
        elements.ipInfo.innerHTML = '<span class="loading">获取位置中...</span>';
    }

    // 保存锁定字段的当前值
    const lockedValues = {};
    lockedFields.forEach(field => {
        lockedValues[field] = currentData[field];
    });

    let country = 'United States';
    let city = 'New York';
    let region = '';
    let success = false;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch('https://ipapi.co/json/', { signal: controller.signal });
        clearTimeout(timeoutId);
        const result = await response.json();
        log.info('ipapi.co 响应:', result);
        if (result.country_name) {
            country = result.country_name;
            city = result.city || 'Unknown';
            region = result.region || '';
            success = true;
        }
    } catch (e) {
        log.info('ipapi.co failed:', e.message);
    }

    if (!success) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const response = await fetch('http://ip-api.com/json/', { signal: controller.signal });
            clearTimeout(timeoutId);
            const result = await response.json();
            log.info('ip-api.com 响应:', result);
            if (result.status === 'success') {
                country = result.country;
                city = result.city || 'Unknown';
                region = result.regionName || '';
                success = true;
            }
        } catch (e) {
            log.info('ip-api.com failed:', e.message);
        }
    }

    if (!window.generators) {
        log.error('generators 未加载');
        if (elements.ipInfo) {
            elements.ipInfo.innerHTML = `<span class="location">${country} (默认)</span>`;
        }
        return;
    }

    const normalizedCountry = window.generators.normalizeCountry(country);
    log.info('标准化国家:', normalizedCountry);

    ipData = {
        country: normalizedCountry,
        city: city,
        region: region
    };

    if (elements.ipInfo) {
        if (success) {
            if (city === normalizedCountry || city === 'Singapore' || city === 'Hong Kong') {
                elements.ipInfo.innerHTML = `<span class="location">${normalizedCountry}</span>`;
            } else {
                elements.ipInfo.innerHTML = `<span class="location">${city}, ${normalizedCountry}</span>`;
            }
        } else {
            elements.ipInfo.innerHTML = `<span class="location">${normalizedCountry} (默认)</span>`;
        }
    }

    currentData = window.generators.generateAllInfoWithSettings(ipData, userSettings);
    currentData.sensitive = {};
    addressEnhancementState = 'local';
    log.info('生成数据:', currentData);

    // 尝试获取真实地址（智能切换：Geoapify → OSM → 本地）
    const addressApiEnabled = document.getElementById('useAddressApiToggle')?.checked !== false;
    if (addressApiEnabled && window.generators.generateAddressAsync) {
        try {
            showToast('正在获取真实地址...');
            setAddressServiceState('loading');
            const realAddress = await window.generators.generateAddressAsync(
                currentData.country,
                currentData.city
            );
            if (realAddress && realAddress.address) {
                // 检查锁定状态后再更新
                if (!lockedFields.has('address')) {
                    currentData.address = realAddress.address;
                }
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
    } else {
        setAddressServiceState('off');
    }

    // 恢复锁定字段的值
    lockedFields.forEach(field => {
        if (lockedValues[field] !== undefined) {
            currentData[field] = lockedValues[field];
        }
    });

    updateUI();
    saveDataToStorage();
}
