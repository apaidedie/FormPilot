/**
 * 存档管理模块
 */

function sanitizeArchiveItem(item) {
    return {
        ...item,
        data: getPublicProfileData(item?.data || {})
    };
}

function resetArchiveDeleteConfirmState(exceptButton = null) {
    if (!elements.archiveList) return;
    elements.archiveList.querySelectorAll('.delete-btn[data-confirming="true"]').forEach(btn => {
        if (btn === exceptButton) return;
        btn.dataset.confirming = 'false';
        btn.classList.remove('confirming');
        btn.textContent = '删除';
        btn.title = '删除存档';
        btn.setAttribute('aria-label', '删除存档');
        btn.setAttribute('aria-pressed', 'false');
    });
}

function markArchiveDeleteConfirm(btn) {
    resetArchiveDeleteConfirmState(btn);
    btn.dataset.confirming = 'true';
    btn.classList.add('confirming');
    btn.textContent = '确认';
    btn.title = '再次点击删除存档';
    btn.setAttribute('aria-label', '再次点击删除存档');
    btn.setAttribute('aria-pressed', 'true');
}

async function normalizeArchiveStorage(archives) {
    let changed = !Array.isArray(archives);
    const source = Array.isArray(archives) ? archives : [];
    const normalized = source.map(item => {
        const cleaned = sanitizeArchiveItem(item);
        if (item?.data?.sensitive) changed = true;
        return cleaned;
    });

    if (changed) {
        await chrome.storage.local.set({ [ARCHIVES_KEY]: normalized });
    }

    return normalized;
}

/**
 * 保存存档
 */
async function saveArchive() {
    const name = elements.archiveName?.value?.trim();
    if (!name) {
        showToast('请输入存档名称');
        return;
    }

    updateCurrentDataFromInputs();

    try {
        const result = await chrome.storage.local.get(ARCHIVES_KEY);
        const archives = await normalizeArchiveStorage(result[ARCHIVES_KEY] || []);

        const existingIndex = archives.findIndex(a => a.name === name);
        const publicData = getPublicProfileData();
        const archiveData = {
            name,
            data: publicData,
            timestamp: Date.now()
        };

        if (existingIndex >= 0) {
            archives[existingIndex] = archiveData;
            showToast(`存档 "${name}" 已更新`);
        } else {
            archives.push(archiveData);
            showToast(`存档 "${name}" 已保存`);
        }

        await chrome.storage.local.set({ [ARCHIVES_KEY]: archives });
        if (elements.archiveName) elements.archiveName.value = '';
        if (elements.archiveSearch) elements.archiveSearch.value = '';
        await loadArchiveList();
    } catch (e) {
        log.info('保存存档失败:', e);
        showToast('保存失败');
    }
}

/**
 * 加载存档列表
 */
async function loadArchiveList() {
    try {
        const result = await chrome.storage.local.get(ARCHIVES_KEY);
        const archives = await normalizeArchiveStorage(result[ARCHIVES_KEY] || []);
        renderArchiveList(archives);
    } catch (e) {
        log.info('加载存档列表失败:', e);
    }
}

/**
 * 加载存档
 */
async function loadArchive(index) {
    try {
        const result = await chrome.storage.local.get(ARCHIVES_KEY);
        const archives = await normalizeArchiveStorage(result[ARCHIVES_KEY] || []);

        if (archives[index]) {
            resetArchiveDeleteConfirmState();
            // 保存锁定字段的当前值
            const lockedValues = {};
            lockedFields.forEach(field => {
                lockedValues[field] = currentData[field];
            });

            // 加载存档数据
            currentData = getPublicProfileData(archives[index].data);

            // 恢复锁定字段的值
            lockedFields.forEach(field => {
                if (lockedValues[field] !== undefined) {
                    currentData[field] = lockedValues[field];
                }
            });

            updateUI();
            saveDataToStorage();
            closeSettingsModal();

            const lockedCount = lockedFields.size;
            if (lockedCount > 0) {
                showToast(`已加载存档（${lockedCount}个锁定字段已保留）`);
            } else {
                showToast(`已加载存档 "${archives[index].name}"`);
            }
        } else {
            showToast('存档不存在');
        }
    } catch (e) {
        log.info('加载存档失败:', e);
        showToast('加载存档失败');
    }
}

/**
 * 删除存档
 */
async function deleteArchive(index) {
    try {
        resetArchiveDeleteConfirmState();
        const result = await chrome.storage.local.get(ARCHIVES_KEY);
        const archives = await normalizeArchiveStorage(result[ARCHIVES_KEY] || []);

        if (archives[index]) {
            const name = archives[index].name;
            archives.splice(index, 1);
            await chrome.storage.local.set({ [ARCHIVES_KEY]: archives });
            await loadArchiveList();
            showToast(`存档 "${name}" 已删除`);
        }
    } catch (e) {
        log.info('删除存档失败:', e);
        showToast('删除存档失败');
    }
}

/**
 * 打开设置模态框
 */
async function openSettingsModal() {
    if (elements.settingsModal) {
        openModal(elements.settingsModal);
        updateSettingsUI();
        if (elements.archiveSearch) elements.archiveSearch.value = '';
        await loadArchiveList();
        updateSettingsOverview();
    }
}

/**
 * 关闭设置模态框
 */
function closeSettingsModal() {
    closeModal(elements.settingsModal);
}
