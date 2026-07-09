/**
 * Background Service Worker - 快捷键和数据清除支持
 */

importScripts('popup/js/storage-migration.js');

const STORAGE_KEY = 'formPilotCachedData';
const AUTO_CLEAR_KEY = 'formPilotAutoClear';
const FILL_EMPTY_ONLY_KEY = 'formPilotFillEmptyOnly';
const LOCKED_KEY = 'formPilotLockedFields';
const CONTENT_SCRIPT_FILES = [
  'scripts/selectors/common.js',
  'scripts/selectors/japan.js',
  'scripts/content.js'
];

function getPublicProfileData(data) {
  const { sensitive, ...publicData } = data || {};
  return publicData;
}

async function ensureContentScriptInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES
  });
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await ensureContentScriptInjected(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'formpilot-open',
    title: 'FormPilot - 打开面板',
    contexts: ['page', 'editable']
  });
});

// 右键菜单点击处理 - 尝试打开 popup
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'formpilot-open') {
    chrome.action.openPopup();
  }
});

// 快捷键命令处理
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'fill-form') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try {
        await FormPilotStorageMigration.migrateLegacyStorageKeys();
        const result = await chrome.storage.local.get([STORAGE_KEY, FILL_EMPTY_ONLY_KEY]);
        const cached = result[STORAGE_KEY];
        if (cached && cached.currentData) {
          await sendMessageToTab(tab.id, {
            action: 'fillForm',
            data: getPublicProfileData(cached.currentData),
            options: { fillEmptyOnly: result[FILL_EMPTY_ONLY_KEY] === true }
          });
        }
      } catch (error) {
        console.error('[FormPilot] 填写表单失败:', error);
      }
    }
  }
});

// 浏览器启动时检查是否需要清除数据
chrome.runtime.onStartup.addListener(async () => {
  try {
    await FormPilotStorageMigration.migrateLegacyStorageKeys();
    const result = await chrome.storage.local.get(AUTO_CLEAR_KEY);
    if (result[AUTO_CLEAR_KEY]) {
      await chrome.storage.local.remove([STORAGE_KEY, LOCKED_KEY]);
    }
  } catch (error) {
    console.error('[FormPilot] 清除数据失败:', error);
  }
});
