/**
 * 临时邮箱模块
 */

const MAIL_TM_API = 'https://api.mail.tm';

window.mailTM = window.mailTM || {
    token: '',
    address: '',

    async request(path, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        const response = await fetch(`${MAIL_TM_API}${path}`, {
            ...options,
            headers
        });

        if (!response.ok) {
            const message = await response.text().catch(() => '');
            throw new Error(message || `Mail.tm request failed: ${response.status}`);
        }

        if (response.status === 204) {
            return null;
        }

        return response.json();
    },

    async getDomain() {
        const data = await this.request('/domains?page=1');
        const domains = data['hydra:member'] || [];
        const activeDomain = domains.find(domain => domain.isActive !== false);
        if (!activeDomain?.domain) {
            throw new Error('Mail.tm 没有可用域名');
        }
        return activeDomain.domain;
    },

    async register(username, password) {
        const safeUsername = String(username || 'formpilot')
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, '')
            .slice(0, 24) || 'formpilot';
        const domain = await this.getDomain();
        const address = `${safeUsername}${Date.now().toString().slice(-6)}@${domain}`;
        const mailPassword = String(password || '').length >= 8 ? password : `${safeUsername}A1!mail`;

        await this.request('/accounts', {
            method: 'POST',
            body: JSON.stringify({ address, password: mailPassword })
        });

        await this.login(address, mailPassword);
        return { address, password: mailPassword };
    },

    async login(address, password) {
        const data = await this.request('/token', {
            method: 'POST',
            body: JSON.stringify({ address, password })
        });

        this.token = data.token || '';
        this.address = address;
        return data;
    },

    async getMessages() {
        const data = await this.request('/messages?page=1');
        return data['hydra:member'] || [];
    }
};

/**
 * 重新生成邮箱
 */
async function regenerateEmail() {
    if (!window.generators) return;

    // 如果邮箱被锁定，不进行任何操作
    if (lockedFields.has('email')) {
        showToast('邮箱已锁定，跳过生成');
        return;
    }

    updateCurrentDataFromInputs();

    const domainType = elements.emailDomainType?.value;

    if (domainType === 'temp' && window.mailTM) {
        try {
            showToast('正在注册临时邮箱...');
            // 使用当前密码作为邮箱密码
            const account = await window.mailTM.register(currentData.username, currentData.password);
            currentData.email = account.address;
            currentData.password = account.password;
            if (elements.fields.password) elements.fields.password.value = currentData.password;
            if (elements.inboxGroup) elements.inboxGroup.classList.remove('is-hidden');
            refreshInbox();
        } catch (e) {
            log.error('Temp mail registration failed:', e);
            showToast('临时邮箱注册失败，使用默认邮箱');
            currentData.email = window.generators.generateEmail(currentData.username);
            if (elements.inboxGroup) elements.inboxGroup.classList.remove('is-hidden');
            renderInboxError(e, {
                title: '临时邮箱注册失败',
                detail: `${e?.message || 'Mail.tm 暂时不可用'}，已改用普通邮箱。`,
                recovery: '稍后重新生成临时邮箱，或先用当前邮箱继续测试。'
            });
        }
    } else {
        currentData.email = window.generators.generateEmail(currentData.username);
        if (elements.inboxGroup) elements.inboxGroup.classList.add('is-hidden');
    }

    if (elements.fields.email) {
        elements.fields.email.value = currentData.email;
    }
}

/**
 * 刷新收件箱
 */
async function refreshInbox() {
    if (!window.mailTM || !window.mailTM.token) return;

    if (elements.refreshInbox) {
        elements.refreshInbox.classList.add('rotating');
    }

    try {
        const messages = await window.mailTM.getMessages();
        renderInbox(messages);
        showToast('收件箱已更新');
    } catch (e) {
        log.error('Fetch messages failed:', e);
        renderInboxError(e);
        showToast('收件箱刷新失败');
    } finally {
        if (elements.refreshInbox) {
            elements.refreshInbox.classList.remove('rotating');
        }
    }
}
