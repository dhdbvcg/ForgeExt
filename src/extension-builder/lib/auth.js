/**
 * Extension Builder — 登录账号系统
 *
 * 基于 localStorage 的轻量账号管理（注册 / 登录 / 登出 / 会话）。
 * 密码使用 SHA-256 加盐哈希存储，不保存明文。
 * 在非 HTTPS 环境（crypto.subtle 不可用）自动回退到确定性哈希，
 * 保证任何部署环境（http / https / localhost）都能正常工作。
 */

const USERS_KEY = 'extbuilder_users';
const SESSION_KEY = 'extbuilder_session';
const PREV_SESSION_KEY = 'extbuilder_prev_session'; // 切换账号时记住上一个会话
const SESSION_DAYS = 30;

import {cloudAvailable, cloudUpsertUser, cloudFetchUsers} from './cloud.js';

// ---- 哈希 ----

function sha256Hex(text) {
    // 优先使用 Web Crypto（仅安全上下文可用，https / localhost）
    if (typeof window !== 'undefined' && window.crypto &&
            window.crypto.subtle && window.crypto.subtle.digest) {
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
            .then((buf) => {
                const bytes = new Uint8Array(buf);
                let hex = '';
                for (let i = 0; i < bytes.length; i++) {
                    hex += bytes[i].toString(16).padStart(2, '0');
                }
                return hex;
            })
            .catch(() => fallbackHash(text));
    }
    return Promise.resolve(fallbackHash(text));
}

// 回退哈希：FNV-1a 变体双通道，确定性输出 64 位 hex
function fallbackHash(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x1000193;
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 ^= ch;
            h1 = Math.imul(h1, 0x01000193);
            h2 = Math.imul(h2 ^ ch, 0x85ebca6b);
        }
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') +
           (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---- 存储 ----

function getUsers() {
    try {
        const users = JSON.parse(localStorage.getItem(USERS_KEY) || '{}');
        // 历史账号补 uid（本功能上线前创建的账号，首次读取时按 createdAt 升序补为 0,1,2...）
        if (migrateUids(users)) {
            setUsers(users);
        }
        return users;
    } catch (e) {
        return {};
    }
}

function setUsers(users) {
    try {
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
    } catch (e) {
        // 存储空间不足等，忽略
    }
}

// ---- UID ----
// 每个账号分配一个唯一且递增的数字 ID，从 0 开始。
// 1) 新注册/导入/第三方登录的账号：uid = max(已有 uid) + 1（没有则 0）。
// 2) 历史账号（本功能上线前创建，缺 uid）：首次读取时按 createdAt 升序补为 0,1,2...，保证唯一。

function nextUid(users) {
    let maxUid = -1;
    Object.keys(users).forEach((k) => {
        const u = users[k];
        if (u && typeof u.uid === 'number' && u.uid > maxUid) maxUid = u.uid;
    });
    return maxUid + 1; // 没有任何 uid 时为 0
}

function migrateUids(users) {
    const missing = Object.keys(users)
        .filter((k) => users[k] && typeof users[k].uid !== 'number');
    if (missing.length === 0) return false;
    const start = nextUid(users); // 基于已存在 uid 计算起点，保证不与已有冲突
    missing
        .sort((a, b) => (users[a].createdAt || 0) - (users[b].createdAt || 0))
        .forEach((k, i) => {
            users[k].uid = start + i;
        });
    return true;
}

function makeToken() {
    return Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2) +
        Date.now().toString(36);
}

// ---- 会话 ----

/**
 * 为用户建立会话并写入存储，返回会话对象。
 * @param {string} username 用户名
 * @param {boolean} [remember] 是否"自动登录/记住我"：
 *   - true（默认）：写入 localStorage，30 天有效，刷新/重开浏览器都保持登录
 *   - false：写入 sessionStorage，仅当前浏览器会话有效，关闭标签页后失效
 * 同步链接导入新账号时也会用到。
 */
export function createSession(username, remember) {
    const session = {
        username,
        token: makeToken(),
        remember: !!remember,
        expires: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
    };
    try {
        const storage = remember ? localStorage : sessionStorage;
        storage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
        // 忽略（存储不可用时会话不持久）
    }
    return session;
}

export function getSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.username) return null;
        if (s.expires && s.expires < Date.now()) {
            localStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        if (!getUsers()[s.username]) {
            // 账号已被删除则强制退出
            localStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        return s;
    } catch (e) {
        return null;
    }
}

export function logout() {
    try {
        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
        // 忽略
    }
}

/**
 * 确保本地存在该账号的最小记录（用于跨域网站登录同步后，getSession 的账号存在性校验能通过）。
 * 仅创建占位记录，不写入密码哈希——编辑器本地不校验网站账号密码，会话已由网站鉴权。
 * @param {string} username
 */
export function ensureSiteAccount(username) {
    if (!username) return;
    try {
        const users = getUsers();
        if (!users[username]) {
            users[username] = { provider: 'site', createdAt: Date.now() };
            setUsers(users);
        }
    } catch (e) {
        // 忽略
    }
}

// ---- 线上服务端地址（主域 + Pages 备用域，自动回退）----
// 两个域名指向同一套 Pages Functions；主域不通（DNS/证书/网络波动）时自动换备用域。
const SITE_ORIGINS = [
    'https://scratchextensioneditor.cc.cd',
    'https://scratchextensioneditor.pages.dev'
];

/**
 * 依次尝试多个地址 POST JSON，返回第一个**有响应**的结果。
 * 只有网络层失败（fetch 抛错）才换下一个地址；
 * 服务端返回的业务错误（4xx/5xx）原样返回，不再重试其它地址。
 * @param {string} path 形如 '/api/code'
 * @param {object} payload 请求体
 * @returns {Promise<{ok:boolean,status:number,data:object}>}
 */
async function postJsonWithFallback(path, payload) {
    let lastErr = null;
    for (let i = 0; i < SITE_ORIGINS.length; i++) {
        const url = SITE_ORIGINS[i] + path;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => ({}));
            return {ok: res.ok, status: res.status, data};
        } catch (e) {
            lastErr = e;
            console.warn('[Auth] 请求失败，尝试下一个地址 ' + url + ':', e.message);
        }
    }
    throw lastErr || new Error('验证服务不可用');
}

// ---- Cloudflare Turnstile 服务端验证 ----
/**
 * 向服务端验证 Turnstile token。
 * @returns {Promise<boolean>} 验证通过返回 true
 */
export async function verifyTurnstile(token) {
    if (!token || typeof token !== 'string' || token.length < 10) return false;
    try {
        const {ok, data} = await postJsonWithFallback('/api/turnstile-verify', {token});
        if (!ok) return false;
        return !!data.success;
    } catch (e) {
        // 网络不可达时降级：仅信任 token 存在（弱校验）
        console.warn('[Turnstile] 服务端验证失败，降级为客户端存在性校验:', e.message);
        return token.length >= 10;
    }
}

// ---- 邮箱验证码（注册时发送 / 校验） ----
//
// 三种发信模式，按优先级依次尝试：
//   1) 服务端通道（默认，生产推荐）：functions/api/code.js 部署在 Cloudflare Pages，
//      验证码在服务端生成 + 校验，经 Resend 以 noreply@scratchextensioneditor.cc.cd
//      真实发出。密钥只在服务端，前端无法伪造验证结果。
//   2) EmailJS 前端直发（备用）：配置下方 EMAILJS_* 后由浏览器直发。
//      ⚠️ 验证码在浏览器侧生成与校验，可被绕过，仅适合无后端场景。
//   3) 本地伪后端（开发回退）：请求 localhost:3458/api/auth，验证码只打印到控制台
//      并直接显示在页面（不真发信），便于断网联调。
//
// 要用服务端通道，把 SERVER_CODE_ENABLED 设为 true（函数已部署在 Cloudflare Pages）。

// === 服务端验证码通道（推荐）===
// 对应 website/functions/api/code.js，地址走 SITE_ORIGINS 自动回退
const CODE_API_PATH = '/api/code';
const SERVER_CODE_ENABLED = true;

// === EmailJS 配置（备用通道，在 emailjs.com 免费注册后填写）===
//   1. 注册 https://www.emailjs.com/ 免费账号
//   2. Email Service 添加一个发信服务（Gmail / Outlook / 其它）
//   3. Email Templates 建模板，变量用 {{code}} {{email}} {{time}}
//   4. 把下面三个值填上即可真正发信
const EMAILJS_PUBLIC_KEY = '';   // 例如 'XZsB9x7Qxk2Z3aBcD'
const EMAILJS_SERVICE_ID  = '';  // 例如 'service_xxxxxx'
const EMAILJS_TEMPLATE_ID = '';  // 例如 'template_xxxxxx'
const EMAILJS_ENABLED = !!(EMAILJS_PUBLIC_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID);

// 开发回退端点（上述通道都不可用时使用）
const AUTH_API_URL = 'http://localhost:3458/api/auth';

// 验证码本地存储（sessionStorage，关页即失效，降低泄露风险）
const CODE_STORE_KEY = 'extbuilder_email_code';
const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟有效

function genCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function saveLocalCode(email, code) {
    try {
        sessionStorage.setItem(CODE_STORE_KEY, JSON.stringify({
            email: String(email).trim().toLowerCase(),
            code,
            expires: Date.now() + CODE_TTL_MS
        }));
    } catch (e) { /* ignore */ }
}

function checkLocalCode(email, code) {
    try {
        const raw = sessionStorage.getItem(CODE_STORE_KEY);
        if (!raw) return false;
        const rec = JSON.parse(raw);
        if (rec.expires < Date.now()) return false;
        if (rec.email !== String(email).trim().toLowerCase()) return false;
        return rec.code === String(code).trim();
    } catch (e) { return false; }
}

/**
 * 向指定邮箱发送验证码（注册 / 重置密码）。
 *
 * 通道优先级：
 *   1) 服务端（SERVER_CODE_ENABLED）—— 验证码在服务端生成、经 Resend 真实发出，
 *      本地不保存明文，返回 {result:{devCode:''}}
 *   2) EmailJS —— 浏览器直发，本地保存明文用于校验
 *   3) 本地伪后端 —— 不发信，返回 {result:{devCode}} 供页面显示（仅联调用）
 *
 * @returns {Promise<object>} {success:boolean, error?:string, result:{devCode:string}}
 */
export async function sendEmailCode(email, purpose = 'register', captchaToken = '') {
    const lowerEmail = String(email).trim().toLowerCase();

    // ---- 1) 服务端通道 ----
    if (SERVER_CODE_ENABLED) {
        try {
            const {ok, status, data} = await postJsonWithFallback(CODE_API_PATH, {
                action: 'send', email: lowerEmail, purpose, token: captchaToken
            });
            if (!ok || !data.ok) {
                // 服务端出错时不再回落到"页面显示验证码"的不安全分支
                return {
                    success: false,
                    error: data.error || ('验证服务返回异常（' + status + '）'),
                    result: {devCode: ''}
                };
            }
            return {success: true, result: {devCode: ''}, expiresIn: data.expiresIn};
        } catch (e) {
            return {
                success: false,
                error: '无法连接验证服务：' + e.message,
                result: {devCode: ''}
            };
        }
    }

    // ---- 2) / 3) 本地生成验证码的通道 ----
    const code = genCode();
    saveLocalCode(lowerEmail, code);

    if (EMAILJS_ENABLED) {
        // 真实发信：浏览器直接调 EmailJS REST API
        const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                service_id: EMAILJS_SERVICE_ID,
                template_id: EMAILJS_TEMPLATE_ID,
                user_id: EMAILJS_PUBLIC_KEY,
                template_params: {
                    email: lowerEmail,
                    code: code,
                    time: '10 分钟'
                }
            })
        });
        if (!res.ok) {
            let msg = '邮件发送失败（' + res.status + '）';
            try {
                const t = await res.text();
                if (t) msg += '：' + t.slice(0, 120);
            } catch (e) { /* ignore */ }
            // 发送失败也保留本地码，方便开发调试
            return {success: false, error: msg, result: {devCode: code}};
        }
        return {success: true, result: {devCode: ''}};
    }

    // 回退：本地伪后端
    const res = await fetch(AUTH_API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'send', email: lowerEmail, purpose})
    });
    const data = await res.json().catch(() => ({}));
    const errMsg = data.error || (data.errors && data.errors[0] && data.errors[0].message) || '';
    if (!res.ok || !data.success) {
        throw new Error(errMsg || ('发送失败（' + res.status + '）'));
    }
    return data;
}

/**
 * 校验邮箱验证码。
 * - 服务端通道：提交给服务端比对，通过返回服务端签发的一次性 verifiedToken
 * - EmailJS 通道：本地比对 sessionStorage 中保存的码，返回本地签发的 token
 * - 本地伪后端：请求 localhost 校验
 * @returns {Promise<string>} verifiedToken
 */
export async function verifyEmailCode(email, code, purpose = 'register') {
    // ---- 1) 服务端通道 ----
    if (SERVER_CODE_ENABLED) {
        const {ok, status, data} = await postJsonWithFallback(CODE_API_PATH, {
            action: 'verify',
            email: String(email).trim().toLowerCase(),
            code: String(code).trim(),
            purpose
        });
        if (!ok || !data.ok || !data.verifiedToken) {
            throw new Error(data.error || ('验证失败（' + status + '）'));
        }
        return data.verifiedToken;
    }

    if (EMAILJS_ENABLED) {
        if (!checkLocalCode(email, code)) {
            throw new Error('验证码错误或已过期');
        }
        // 本地签发 short-lived token（仅用于通过 register() 的前置校验）
        return 'local-verified-' + Date.now();
    }

    const res = await fetch(AUTH_API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'verify', email, code, purpose})
    });
    const data = await res.json().catch(() => ({}));
    const errMsg = data.error || (data.errors && data.errors[0] && data.errors[0].message) || '';
    if (!res.ok || !data.success) {
        throw new Error(errMsg || ('验证失败（' + res.status + '）'));
    }
    return (data.result && data.result.verifiedToken) || data.verifiedToken;
}

// ---- 注册 / 登录 ----

export function register(username, password, remember, captchaToken, email, emailVerifiedToken) {
    const name = String(username || '').trim();
    if (name.length < 2) return Promise.reject(new Error('用户名至少需要 2 个字符'));
    if (!password || String(password).length < 4) {
        return Promise.reject(new Error('密码至少需要 4 个字符'));
    }
    // 邮箱验证码：注册必须提供已通过服务端校验的 verifiedToken
    const emailOk = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return Promise.reject(new Error('请输入正确的邮箱地址'));
    if (!emailVerifiedToken || typeof emailVerifiedToken !== 'string') {
        return Promise.reject(new Error('请先完成邮箱验证'));
    }
    // Cloudflare Turnstile：注册模式必须提供 token，且需服务端验证通过
    if (!captchaToken || typeof captchaToken !== 'string' || captchaToken.length < 10) {
        return Promise.reject(new Error('请完成人机验证'));
    }
    // 先过服务端验证（失败则拒绝注册）
    return verifyTurnstile(captchaToken).then((ok) => {
        if (!ok) return Promise.reject(new Error('人机验证未通过，请重试'));
        const users = getUsers();
        if (users[name]) return Promise.reject(new Error('该用户名已被注册，请直接登录'));
        const salt = makeToken();
        return sha256Hex(salt + '::' + password).then((hash) => {
            users[name] = {salt, hash, email, emailVerified: true, createdAt: Date.now(), uid: nextUid(users)};
            setUsers(users);
            // 云端备份账号（失败不阻断本地注册，静默降级）
            if (cloudAvailable()) {
                cloudUpsertUser({username: name, ...users[name]}).catch(e => console.warn('[Cloud] 账号上传失败:', e.message));
            }
            return createSession(name, remember);
        });
    });
}

export function login(username, password, remember) {
    const name = String(username || '').trim();
    const users = getUsers();
    let u = users[name];
    if (!u && cloudAvailable()) {
        // 本地无此账号 → 尝试从云端拉取（支持多设备首次登录）
        return cloudFetchUsers().then((cloudUsers) => {
            const cu = cloudUsers.find(c => c.username === name);
            if (!cu) return Promise.reject(new Error('用户不存在，请先注册'));
            // 拉取成功后写入本地缓存
            const cached = getUsers();
            cached[name] = {
                salt: cu.salt,
                hash: cu.hash,
                createdAt: cu.createdAt || Date.now(),
                provider: cu.provider || 'local',
                email: cu.email,
                uid: (typeof cu.uid === 'number') ? cu.uid : nextUid(cached)
            };
            setUsers(cached);
            u = cached[name];
            return sha256Hex(u.salt + '::' + password).then((hash) => {
                if (hash !== u.hash) return Promise.reject(new Error('密码错误'));
                return createSession(name, remember);
            });
        });
    }
    if (!u) return Promise.reject(new Error('用户不存在，请先注册'));
    return sha256Hex(u.salt + '::' + password).then((hash) => {
        if (hash !== u.hash) return Promise.reject(new Error('密码错误'));
        return createSession(name, remember);
    });
}

// ---- 供同步链接使用 ----

export function getUserMeta(username) {
    return getUsers()[username] || null;
}

/**
 * 从同步链接导入账号（仅当本地不存在该用户名时创建）。
 * 已存在的账号不会被覆盖，密码保持本地版本。
 * 返回 true 表示新建了账号。
 */
export function importUser(meta) {
    if (!meta || !meta.username || !meta.salt || !meta.hash) return false;
    const users = getUsers();
    if (users[meta.username]) return false;
    users[meta.username] = {
        salt: meta.salt,
        hash: meta.hash,
        createdAt: meta.createdAt || Date.now(),
        uid: nextUid(users)
    };
    setUsers(users);
    return true;
}

// ---- 切换账号（记住上一个会话，支持一键切回） ----

/**
 * 保存当前会话为"上一个会话"（切换/退出前调用）。
 */
export function savePrevSession(s) {
    try {
        if (s && s.username) {
            localStorage.setItem(PREV_SESSION_KEY, JSON.stringify(s));
        }
    } catch (e) { /* silent */ }
}

/**
 * 读取上一个会话（用于"一键切回"）。
 */
export function getPrevSession() {
    try {
        const raw = localStorage.getItem(PREV_SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.username) return null;
        // 检查是否过期
        if (s.expires && s.expires < Date.now()) {
            clearPrevSession();
            return null;
        }
        return s;
    } catch (e) { return null; }
}

/**
 * 清除上一个会话。
 */
export function clearPrevSession() {
    try {
        localStorage.removeItem(PREV_SESSION_KEY);
    } catch (e) { /* silent */ }
}

/**
 * 一键清除本浏览器的全部本地账号数据：
 *   - 本地账号注册表（extbuilder_users）
 *   - 当前登录会话（extbuilder_session，localStorage + sessionStorage）
 *   - 切换账号时记住的上一个会话（extbuilder_prev_session）
 * 不触碰服务器端账号（KV / 云端），仅清理本机缓存。
 * 与"线上已注册用户清零"配套的本地收口，便于彻底清掉测试残留。
 */
export function clearLocalAuthData() {
    try {
        localStorage.removeItem(USERS_KEY);
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(PREV_SESSION_KEY);
    } catch (e) { /* silent */ }
    try {
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(PREV_SESSION_KEY);
    } catch (e) { /* silent */ }
}

/**
 * 一键切回到上一个会话：恢复 session 到当前登录状态。
 * 返回恢复的会话对象；失败返回 null。
 */
export function switchToPrevSession() {
    const prev = getPrevSession();
    if (!prev) return null;
    // 先退出当前
    logout();
    // 恢复上一个
    createSession(prev.username, prev.remember);
    return getSession();
}

// ---- 多账号切换 ----

/**
 * 获取所有已注册的账号列表（用于多账号切换菜单）。
 * 返回数组：[{ username, provider, email, createdAt }, ...]，按 username 排序。
 */
export function getRegisteredAccounts() {
    try {
        const users = getUsers();
        return Object.keys(users)
            .map(k => ({
                username: k,
                uid: (users[k] && typeof users[k].uid === 'number') ? users[k].uid : -1,
                provider: (users[k] && users[k].provider) || 'local',
                email: (users[k] && users[k].email) || '',
                createdAt: (users[k] && users[k].createdAt) || 0
            }))
            .sort((a, b) => a.username.localeCompare(b.username));
    } catch (e) {
        return [];
    }
}

/**
 * 切换到指定账号（用其已存储的凭据重新建立会话）。
 * 注意：此函数不验证密码，仅基于"该用户名已在本地注册"这一事实创建会话。
 * 适用于多账号快速切换（用户已信任本机环境）。
 * @param {string} username 要切换到的用户名
 * @param {boolean} [remember=true] 是否记住登录
 * @returns {object|null} 新会话对象，失败返回 null
 */
export function switchToAccount(username, remember) {
    if (!username) return null;
    const users = getUsers();
    if (!users[username]) return null;
    logout();
    return createSession(username, remember !== false);
}

// ---- GitHub OAuth 登录 ----
// 流程：前端打开 GitHub 授权页（弹窗）→ GitHub 重定向到我们部署在 Cloudflare Pages 的
// /api/github-callback（服务端用 client_secret 换 token，前端拿不到 secret）→ 回调页把
// 用户资料 postMessage 回编辑器 → 这里建立/复用本地账号并登录。
// 与 DNSHE 的「GitHub 快捷登录」能力一致，但密钥留在服务端，前端只持有 client_id（非机密）。

// ⚠️ 替换为你在 GitHub 创建的 OAuth App 的 client_id（公开，可放前端）
const GITHUB_CLIENT_ID = 'Ov23liyPHcuvhocCJCws';
const GITHUB_AUTH_BASE = 'https://github.com/login/oauth/authorize';
const GITHUB_SCOPE = 'user:email';
// 必须与该 GitHub OAuth App 中登记的「Authorization callback URL」完全一致
const GITHUB_CALLBACK = 'https://scratchextensioneditor.cc.cd/api/github-callback';

// ── GitHub Device Flow（默认登录方式） ──
// 为什么不用上面的 authorize 重定向流程：那条路必须有服务端用 client_secret
// 换 token，而现成的服务端只部署在 scratchextensioneditor.cc.cd 上，本地
// 127.0.0.1 点登录会被弹到线上编辑器去。Device Flow 没有 redirect_uri，
// token 由浏览器直接轮询换取，因此在任何源（含 localhost）都能完成登录。
//
// GitHub 的这两个端点不带 CORS 头，浏览器直连会 Failed to fetch，故走
// webpack devServer 的同源反代 /github-oauth/*（见 webpack.config.js）。
// 注意：GitHub Device Flow 需要在 OAuth App 设置里勾选 Enable Device Flow。
const GITHUB_DEVICE_START = '/github-oauth/device/code';
const GITHUB_DEVICE_TOKEN = '/github-oauth/oauth/access_token';
const GITHUB_DEVICE_VERIFY = 'https://github.com/login/device';

/**
 * 第一步：向 GitHub 申请设备码与用户码。
 * @param {string} [scope] 自定义授权范围；不传则用登录所需的最小集 user:email
 * @returns {Promise<{deviceCode, userCode, verificationUri, expiresIn, interval}>}
 */
export function startGitHubDeviceFlow(scope) {
    return fetch(GITHUB_DEVICE_START, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: JSON.stringify({client_id: GITHUB_CLIENT_ID, scope: scope || GITHUB_SCOPE})
    }).then((r) => r.json().catch(() => ({}))).then((d) => {
        if (!d || !d.device_code) {
            const msg = (d && (d.error_description || d.error)) || 'GitHub 未返回设备码';
            throw new Error(msg + '（若提示 device_flow_disabled，请在 GitHub OAuth App 设置里勾选 Enable Device Flow）');
        }
        const verify = d.verification_uri || GITHUB_DEVICE_VERIFY;
        return {
            deviceCode: d.device_code,
            userCode: d.user_code,
            verificationUri: verify,
            // 带 user_code 预填的授权页：GitHub 会直接填好输入框，用户只需点确认。
            // 若该参数不被识别也只是被忽略，页面照常可用，故无需探测支持性。
            verificationUriComplete: verify + '?user_code=' + encodeURIComponent(d.user_code),
            expiresIn: Number(d.expires_in) || 900,
            interval: Number(d.interval) || 5
        };
    });
}

/**
 * 第二步：轮询换取 access_token。
 * 返回值里 access_token 存在即成功；否则看 error 字段：
 *   authorization_pending → 用户还没授权，继续等
 *   slow_down             → 轮询过快，应拉长间隔
 *   expired_token         → 设备码过期，需重新开始
 *   access_denied         → 用户拒绝
 */
export function pollGitHubDeviceToken(deviceCode) {
    return fetch(GITHUB_DEVICE_TOKEN, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
    }).then((r) => r.json().catch(() => ({})));
}

/**
 * 第三步：用 access_token 拉 GitHub 用户资料（api.github.com 自带 CORS，可直连）。
 * @returns {Promise<{id, login, name, email, avatar}>}
 */
export function fetchGitHubProfile(accessToken) {
    const headers = {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/vnd.github+json'
    };
    return fetch('https://api.github.com/user', {headers: headers})
        .then((r) => r.json())
        .then((user) => {
            if (!user || !user.login) throw new Error('无法获取 GitHub 用户资料');
            const base = {
                id: user.id,
                login: user.login,
                name: user.name || user.login,
                email: user.email || '',
                avatar: user.avatar_url || ''
            };
            if (base.email) return base;
            // 主邮箱为私密时 /user 不带 email，需要单独查 /user/emails
            return fetch('https://api.github.com/user/emails', {headers: headers})
                .then((r) => r.json())
                .then((list) => {
                    if (Array.isArray(list)) {
                        const p = list.find((e) => e.primary && e.verified) ||
                            list.find((e) => e.verified);
                        if (p) base.email = p.email;
                    }
                    return base;
                })
                .catch(() => base);
        });
}

/**
 * 生成随机 state（CSRF 防护），返回十六进制串。
 */
export function makeGitHubState() {
    try {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const a = crypto.getRandomValues(new Uint8Array(16));
            return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) { /* fall through */ }
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
}

/**
 * 构造 GitHub 授权页 URL（前端弹窗打开它）。
 * @param {string} state 由 makeGitHubState() 生成，回调时需校验一致
 */
export function buildGitHubAuthUrl(state) {
    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: GITHUB_CALLBACK,
        scope: GITHUB_SCOPE,
        state: String(state || '')
    });
    return GITHUB_AUTH_BASE + '?' + params.toString();
}

/**
 * 用 GitHub 用户资料在本地建立/复用账号并登录（无需密码）。
 * @param {object} profile {id, login, name, email, avatar}
 * @param {boolean} [remember] 是否记住登录（默认 true）
 * @returns {Promise<object>} 会话对象
 */
export function loginWithGitHub(profile, remember) {
    if (!profile || !profile.login) {
        return Promise.reject(new Error('GitHub 资料无效'));
    }
    const name = String(profile.login);
    const users = getUsers();
    const existing = users[name];
    // 已存在同名「本地账号」（provider=local）：以联邦方式直接登入，不覆盖其密码哈希
    if (!existing || existing.provider !== 'local') {
        users[name] = {
            provider: 'github',
            githubId: profile.id,
            email: profile.email || (existing && existing.email) || '',
            name: profile.name || name,
            avatar: profile.avatar || '',
            createdAt: (existing && existing.createdAt) || Date.now(),
            uid: (existing && typeof existing.uid === 'number') ? existing.uid : nextUid(users)
        };
        setUsers(users);
    }
    return Promise.resolve(createSession(name, remember !== false));
}
