/**
 * 常量和配置
 */

// ============ 调试开关 ============
// 生产环境设为 false 关闭所有日志输出
const DEBUG = false;

// 统一日志函数
const log = {
    info: (...args) => DEBUG && console.log('[FormPilot]', ...args),
    error: (...args) => DEBUG && console.error('[FormPilot]', ...args),
    warn: (...args) => DEBUG && console.warn('[FormPilot]', ...args)
};

// 存储键名
const STORAGE_KEY = 'formPilotCachedData';
const THEME_KEY = 'formPilotTheme';
const LOCKED_KEY = 'formPilotLockedFields';
const SETTINGS_KEY = 'formPilotSettings';
const ARCHIVES_KEY = 'formPilotArchives';
const AUTO_CLEAR_KEY = 'formPilotAutoClear';
const HISTORY_KEY = 'formPilotHistory';
const GEOAPIFY_KEY = 'formPilotGeoapifyKey';
const MY_PROFILE_KEY = 'formPilotMyProfile';
const AI_MODE_KEY = 'formPilotUseAI';
const FILL_EMPTY_ONLY_KEY = 'formPilotFillEmptyOnly';
const ADDRESS_API_ENABLED_KEY = 'formPilotAddressApiEnabled';
const PROFILE_SECTIONS_KEY = 'formPilotProfileSections';
const MY_PROFILE_EXPORT_VERSION = 1;

// 缓存版本
const CACHE_VERSION = 'v3';

// 历史记录最大条数
const MAX_HISTORY_ITEMS = 10;

// 字段列表
const FIELD_NAMES = [
    'firstName', 'lastName', 'gender', 'birthday',
    'username', 'email', 'password', 'phone',
    'address', 'city', 'state', 'zipCode', 'country'
];

const SENSITIVE_FIELD_NAMES = [
    'creditCardType', 'creditCardNumber', 'creditCardExpires', 'creditCardCvv',
    'ssn', 'monthlySalary', 'employmentStatus', 'companyName'
];

const SENSITIVE_FIELD_LABELS = {
    creditCardType: '卡类型',
    creditCardNumber: '卡号',
    creditCardExpires: '有效期',
    creditCardCvv: 'CVV',
    ssn: 'SSN',
    monthlySalary: '收入',
    employmentStatus: '职业状态',
    companyName: '公司'
};

const MY_PROFILE_FIELD_NAMES = [
    'profileFirstName', 'profileLastName', 'profileEmail', 'profilePhone',
    'shippingAddress', 'shippingCity', 'shippingState', 'shippingZipCode', 'shippingCountry',
    'billingAddress', 'billingCity', 'billingState', 'billingZipCode', 'billingCountry',
    'cardIssuer', 'cardNetwork', 'cardLast4', 'cardExpiry', 'billingNote'
];

const MY_PROFILE_COMPLETENESS_GROUPS = [
    {
        id: 'contact',
        label: '联系人',
        fields: ['profileFirstName', 'profileLastName', 'profileEmail', 'profilePhone']
    },
    {
        id: 'shipping',
        label: '收货地址',
        fields: ['shippingAddress', 'shippingCity', 'shippingState', 'shippingZipCode', 'shippingCountry']
    },
    {
        id: 'billing',
        label: '账单地址',
        fields: ['billingAddress', 'billingCity', 'billingState', 'billingZipCode', 'billingCountry']
    },
    {
        id: 'payment',
        label: '支付摘要',
        fields: ['cardIssuer', 'cardNetwork', 'cardLast4', 'cardExpiry', 'billingNote']
    }
];

const COPY_SECTION_FIELDS = {
    identity: ['firstName', 'lastName', 'gender', 'birthday'],
    account: ['username', 'email', 'password'],
    contact: ['phone', 'address', 'city', 'state', 'zipCode', 'country']
};

const FIELD_LABELS = {
    firstName: '名',
    lastName: '姓',
    gender: '性别',
    birthday: '生日',
    username: '用户名',
    email: '邮箱',
    password: '密码',
    phone: '电话',
    address: '地址',
    city: '城市',
    state: '州/省',
    zipCode: '邮编',
    country: '国家'
};

const DEFAULT_MY_PROFILE = {
    profileFirstName: '',
    profileLastName: '',
    profileEmail: '',
    profilePhone: '',
    shippingAddress: '',
    shippingCity: '',
    shippingState: '',
    shippingZipCode: '',
    shippingCountry: '',
    billingAddress: '',
    billingCity: '',
    billingState: '',
    billingZipCode: '',
    billingCountry: '',
    cardIssuer: '',
    cardNetwork: '',
    cardLast4: '',
    cardExpiry: '',
    billingNote: ''
};

// 默认设置
const DEFAULT_SETTINGS = {
    enableAI: false,
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiKey: '',
    openaiModel: 'gpt-3.5-turbo',
    aiPersona: '',
    passwordLength: 12,
    pwdUppercase: true,
    pwdLowercase: true,
    pwdNumbers: true,
    pwdSymbols: true,
    minAge: 18,
    maxAge: 55,
    autoClearData: false
};

// ============ 全局状态变量 ============
// 这些变量需要在模块加载前声明，供所有模块共享

let currentData = {};
let ipData = {};
let lockedFields = new Set();
let userSettings = { ...DEFAULT_SETTINGS };
let myProfile = { ...DEFAULT_MY_PROFILE };
let clearMyProfileConfirmTimer = null;
let clearHistoryConfirmTimer = null;
let historyItems = [];
let archiveItems = [];
let addressEnhancementState = 'local';

// DOM 元素引用（在 DOMContentLoaded 后由 popup.js 填充）
const elements = {
    ipInfo: null,
    ipRefresh: null,
    openMyProfile: null,
    myProfileHeaderStatus: null,
    closeMyProfile: null,
    myProfileModal: null,
    copyShippingToBilling: null,
    saveMyProfile: null,
    fillMyProfile: null,
    copyMyProfile: null,
    importMyProfile: null,
    exportMyProfile: null,
    myProfileImportFile: null,
    clearMyProfile: null,
    myProfileStatus: null,
    myProfileCompleteness: null,
    myProfileCompletenessScore: null,
    myProfileCompletenessBar: null,
    myProfileCompletenessHint: null,
    myProfileCompletenessChips: null,
    myProfileFields: {},
    targetLocation: null,
    generateByLocation: null,
    addressServiceState: null,
    toggleSensitive: null,
    sensitiveSection: null,
    sensitiveGrid: null,
    sensitiveFields: {},
    fields: {},
    regenerateAll: null,
    fillForm: null,
    workflowGuide: null,
    workflowGuideToggle: null,
    workflowGuideDetails: null,
    shortcutHint: null,
    shortcutHintKey: null,
    shortcutHintDetail: null,
    scanCurrentPage: null,
    pageScanPanel: null,
    pageScanTitle: null,
    pageScanDetail: null,
    pageScanMeta: null,
    pageScanMatchChip: null,
    pageScanRequiredChip: null,
    pageScanSensitiveChip: null,
    pageScanPlan: null,
    pageScanPlanTitle: null,
    pageScanPlanMatched: null,
    pageScanPlanUnmatched: null,
    pageScanPlanSensitive: null,
    lastFillResult: null,
    lastFillResultTitle: null,
    lastFillResultDetail: null,
    lastFillFilled: null,
    lastFillSkipped: null,
    lastFillMissed: null,
    profileOverview: null,
    profileOverviewScore: null,
    profileOverviewName: null,
    profileOverviewDetail: null,
    profileOverviewBar: null,
    profileOverviewMissing: null,
    profileOverviewLocked: null,
    profileOverviewSource: null,
    profileOverviewGap: null,
    countryCoverageList: null,
    sectionCompletions: {},
    emailDomainType: null,
    customDomain: null,
    themeToggle: null,
    toast: null,
    copyAll: null,
    openSettings: null,
    closeSettings: null,
    settingsModal: null,
    settingsOverview: null,
    settingsOverviewItems: {},
    useAIToggle: null,
    aiToggleWrapper: null,
    fillEmptyOnlyToggle: null,
    fillEmptyOnlyWrapper: null,
    fillReadiness: null,
    fillReadinessTitle: null,
    fillReadinessScore: null,
    fillReadinessBar: null,
    fillReadinessHint: null,
    fillReadyProfile: null,
    fillReadyPage: null,
    fillReadyMode: null,
    fillReadyAI: null,
    fillReadyAddress: null,
    fillReadySavedProfile: null,
    enableAI: null,
    openaiBaseUrl: null,
    openaiKey: null,
    toggleOpenAIKeyVisibility: null,
    openaiModel: null,
    aiPersona: null,
    passwordLength: null,
    pwdUppercase: null,
    pwdLowercase: null,
    pwdNumbers: null,
    pwdSymbols: null,
    minAge: null,
    maxAge: null,
    autoClearData: null,
    archiveName: null,
    archiveSearch: null,
    archiveInfo: null,
    saveArchive: null,
    archiveList: null,
    inboxGroup: null,
    refreshInbox: null,
    inboxList: null,
    openHistory: null,
    closeHistory: null,
    historyModal: null,
    historySearch: null,
    historyInfo: null,
    historyList: null,
    clearHistory: null,
    geoapifyKey: null,
    testAI: null
};
