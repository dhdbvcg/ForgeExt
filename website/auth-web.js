/**
 * auth-web.js —— 网站端（scratchextensioneditor.cc.cd）轻量认证模块（纯静态版）
 *
 * ★ 本版本为「纯静态」实现，不依赖任何后端 / Cloudflare Pages Functions / wrangler。
 *   可直接把 website/ 目录拖到 Cloudflare Pages（Direct Upload）或任意静态空间部署。
 *
 * 设计要点：
 *   1. GitHub OAuth 采用服务端回调流程（Cloudflare Pages Function 代为换 token + 拉资料）
 *      —— 回调地址 /api/github-callback，在 Cloudflare 边缘完成 token 交换（不受浏览器网络限制）
 *   2. 用户名/密码注册只存浏览器 localStorage（无邮箱验证码，因为纯静态无法发信）
 *   3. 会话管理（localStorage: extbuilder_session / extbuilder_users）
 *   4. 登录后把 session postMessage 给已打开的编辑器窗口（跨域）
 *   5. 提供 session-bridge：让编辑器通过隐藏 iframe 拉取本站 session
 *
 * 用法：<script src="auth-web.js"></script> 后调用 AuthWeb.init(options)
 */

var AuthWeb = (function () {
    'use strict';

    var USERS_KEY = 'extbuilder_users';
    var SESSION_KEY = 'extbuilder_session';
    var SITE_ORIGINS = [
        'https://scratchextensioneditor.cc.cd',
        'https://scratchextensioneditor.pages.dev'
    ];
    var GITHUB_CLIENT_ID = 'Ov23liyPHcuvhocCJCws';
    // 发给 GitHub 的 redirect_uri（必须与 GitHub OAuth App 注册的完全一致）
    var GITHUB_CALLBACK = 'https://scratchextensioneditor.cc.cd/api/github-callback';

    // ---- 工具 ----

    function getOrigin() {
        return (typeof location !== 'undefined' && location.origin) || '';
    }

    function apiBase() {
        // 同源直接用相对路径；否则尝试主域
        if (getOrigin().indexOf('scratchextensioneditor.cc.cd') !== -1) return '';
        if (getOrigin().indexOf('scratchextensioneditor.pages.dev') !== -1) return '';
        return 'https://scratchextensioneditor.cc.cd';
    }

    // ---- localStorage 操作 ----

    function getUsers() {
        try {
            var u = JSON.parse(localStorage.getItem(USERS_KEY) || '{}');
            if (migrateUids(u)) setUsers(u);
            return u;
        } catch (e) { return {}; }
    }
    function setUsers(u) {
        try { localStorage.setItem(USERS_KEY, JSON.stringify(u)); } catch (e) {}
    }

    // ---- UID：每个账号唯一递增数字 ID，从 0 开始；历史账号首次读取补 0,1,2... ----
    function nextUid(users) {
        var maxUid = -1;
        Object.keys(users).forEach(function (k) {
            var x = users[k];
            if (x && typeof x.uid === 'number' && x.uid > maxUid) maxUid = x.uid;
        });
        return maxUid + 1;
    }
    function migrateUids(users) {
        var missing = Object.keys(users).filter(function (k) { return users[k] && typeof users[k].uid !== 'number'; });
        if (missing.length === 0) return false;
        var start = nextUid(users);
        missing
            .sort(function (a, b) { return (users[a].createdAt || 0) - (users[b].createdAt || 0); })
            .forEach(function (k, i) { users[k].uid = start + i; });
        return true;
    }
    function getSession() {
        try {
            var raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            var s = JSON.parse(raw);
            if (!s || !s.username) return null;
            if (s.expires && s.expires < Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
            return s;
        } catch (e) { return null; }
    }
    function createSession(username, remember) {
        var s = {
            username: username,
            token: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36),
            remember: !!remember,
            expires: Date.now() + 30 * 24 * 60 * 60 * 1000
        };
        // 始终写入 localStorage：跨域编辑器（127.0.0.1:8601 等）通过 session-bridge.html
        // 读取此会话来同步登录状态；sessionStorage 跨标签页/跨源不可见，会导致编辑器拿不到登录状态
        try {
            localStorage.setItem(SESSION_KEY, JSON.stringify(s));
        } catch (e) {}
        return s;
    }
    function removeSession() {
        try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    // ---- 哈希（与 auth.js 一致的 fallback） ----

    function sha256(text) {
        if (crypto && crypto.subtle) {
            return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
                .then(function (buf) {
                    var bytes = new Uint8Array(buf), hex = '';
                    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
                    return hex;
                })
                .catch(function () { return fallbackHash(text); });
        }
        return Promise.resolve(fallbackHash(text));
    }
    function fallbackHash(text) {
        var h1 = 0x811c9dc5, h2 = 0x1000193;
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i < text.length; i++) {
                var ch = text.charCodeAt(i);
                h1 ^= ch; h1 = Math.imul(h1, 0x01000193);
                h2 = Math.imul(h2 ^ ch, 0x85ebca6b);
            }
        }
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    }

    // ---- 业务逻辑 ----

    function login(username, password, remember) {
        var name = String(username || '').trim();
        var users = getUsers();
        var u = users[name];
        if (!u) return Promise.reject(new Error('用户不存在，请先注册'));
        var salt = u.salt;
        return sha256(salt + '::' + password).then(function (hash) {
            if (hash !== u.hash) return Promise.reject(new Error('密码错误'));
            return createSession(name, remember);
        });
    }

    function register(username, password, email, verifiedToken, remember) {
        var name = String(username || '').trim();
        if (name.length < 2) return Promise.reject(new Error('用户名至少需要 2 个字符'));
        if (!password || password.length < 4) return Promise.reject(new Error('密码至少需要 4 个字符'));
        var users = getUsers();
        if (users[name]) return Promise.reject(new Error('该用户名已被注册'));

        var salt = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
        return sha256(salt + '::' + password).then(function (hash) {
            users[name] = { salt: salt, hash: hash, email: email || '', emailVerified: !!verifiedToken, provider: 'local', createdAt: Date.now(), uid: nextUid(users) };
            setUsers(users);
            return createSession(name, remember);
        });
    }

    // ---- 邮箱验证码（走网站后端 /api/code） ----
    function postJson(path, payload) {
        return fetch(apiBase() + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); }).then(function (data) {
            if (!data || data.success === false) return Promise.reject(new Error((data && data.error) || '请求失败'));
            return data;
        }).catch(function (e) {
            if (e && e.message) return Promise.reject(e);
            return Promise.reject(new Error('网络错误，请检查连接'));
        });
    }

    // 判断错误是否代表「服务端验证码不可用」（纯静态部署 / 未绑 KV / 未配 RESEND_API_KEY）
    // 这类情况下自动降级到本地模式，保证流程仍可走通
    function isServerUnavailable(err) {
        var msg = (err && err.message) || '';
        return /AUTH_KV|RESEND_API_KEY|未知 action|请求失败|网络错误|Failed to fetch|Unexpected token|<!DOCTYPE/i.test(msg);
    }

    // ---- 本地降级模式（纯静态部署时无后端，验证码直接显示在页面上） ----
    var LOCAL_TTL = 10 * 60 * 1000; // 10 分钟

    function localStore(email, code) {
        try {
            sessionStorage.setItem('localcode:' + email, JSON.stringify({
                code: code, expires: Date.now() + LOCAL_TTL, attempts: 0
            }));
        } catch (e) {}
    }
    function localRead(email) {
        try {
            var raw = sessionStorage.getItem('localcode:' + email);
            if (!raw) return null;
            var r = JSON.parse(raw);
            if (!r || r.expires < Date.now()) { sessionStorage.removeItem('localcode:' + email); return null; }
            return r;
        } catch (e) { return null; }
    }

    function sendCode(email, turnstileToken) {
        return postJson('/api/code', { action: 'send', email: email, token: turnstileToken, purpose: 'register' })
            .catch(function (err) {
                if (!isServerUnavailable(err)) return Promise.reject(err);
                // 降级：本地生成验证码并提示（不发真邮件）
                var code = String(Math.floor(100000 + Math.random() * 900000));
                localStore(email, code);
                return {
                    success: true,
                    localMode: true,
                    devCode: code,
                    message: '【本地模式】未连接邮件服务，验证码为：' + code
                };
            });
    }

    function verifyCode(email, code) {
        return postJson('/api/code', { action: 'verify', email: email, code: code, purpose: 'register' })
            .catch(function (err) {
                if (!isServerUnavailable(err)) return Promise.reject(err);
                // 降级：本地校验
                var rec = localRead(email);
                if (!rec) return Promise.reject(new Error('验证码已过期或不存在，请重新获取'));
                if ((rec.attempts || 0) >= 5) {
                    try { sessionStorage.removeItem('localcode:' + email); } catch (e) {}
                    return Promise.reject(new Error('错误次数过多，请重新获取验证码'));
                }
                if (rec.code !== String(code).trim()) {
                    rec.attempts = (rec.attempts || 0) + 1;
                    localStore(email, rec.code);
                    try {
                        var s = JSON.parse(sessionStorage.getItem('localcode:' + email));
                        s.attempts = rec.attempts;
                        sessionStorage.setItem('localcode:' + email, JSON.stringify(s));
                    } catch (e) {}
                    return Promise.reject(new Error('验证码错误，还可尝试 ' + (5 - rec.attempts) + ' 次'));
                }
                try { sessionStorage.removeItem('localcode:' + email); } catch (e) {}
                return { success: true, verifiedToken: 'local:' + Date.now(), localMode: true };
            });
    }

    // ---- GitHub OAuth（PKCE，纯前端，无需 client_secret / 后端） ----

    function makeState() {
        if (crypto && crypto.getRandomValues) {
            var a = crypto.getRandomValues(new Uint8Array(16));
            return Array.from(a).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        }
        var s = '';
        for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    function base64urlEncode(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function makeCodeVerifier() {
        var bytes = new Uint8Array(32);
        if (crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
        else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return base64urlEncode(bytes);
    }

    function makeCodeChallenge(verifier) {
        // SHA-256(verifier) → base64url
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
            .then(function (buf) { return base64urlEncode(new Uint8Array(buf)); });
    }

    function openGitHubAuth() {
        var state = makeState();
        // 服务端回调：无需 PKCE（Cloudflare 边缘代为换 token）
        var params = new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            redirect_uri: GITHUB_CALLBACK,
            scope: 'user:email',
            state: state
        });
        var popup = window.open(
            'https://github.com/login/oauth/authorize?' + params.toString(),
            'github-oauth',
            'width=600,height=720'
        );
        if (!popup) {
            alert('浏览器拦截了登录弹窗，请允许本站弹出窗口后重试');
            return;
        }
        // 监听服务端回调页回传（/api/github-callback 返回的 HTML → postMessage 给本窗口）
        function onMsg(e) {
                if (!e.data || e.data.type !== 'github-auth') return;
                if (SITE_ORIGINS.indexOf(e.origin) === -1) return;
                if (e.data.state !== state) return;
                window.removeEventListener('message', onMsg);
                if (e.data.error) { alert('GitHub 登录失败：' + e.data.error); return; }
                var profile = e.data.profile;
                var users = getUsers();
                var existing = users[profile.login];
                if (!existing || existing.provider !== 'local') {
                    users[profile.login] = {
                        provider: 'github', githubId: profile.id,
                        email: profile.email || '', name: profile.name || profile.login,
                        avatar: profile.avatar || '', createdAt: (existing && existing.createdAt) || Date.now(),
                        uid: (existing && typeof existing.uid === 'number') ? existing.uid : nextUid(users)
                    };
                    setUsers(users);
                }
                var s = createSession(profile.login, true);
                handleLoginSuccess(s);
            }
            window.addEventListener('message', onMsg);
        }

    // ---- 登录成功后的动作 ----

    var _onLoginCallback = null;

    function handleLoginSuccess(session) {
        // 通知 UI 更新
        if (_onLoginCallback) _onLoginCallback(session);
        // 尝试 postMessage 给已打开的编辑器窗口
        try {
            window.postMessage({ type: 'site-session', session: session }, '*');
        } catch (e) {}
    }

    function logout() {
        removeSession();
        if (_onLoginCallback) _onLoginCallback(null);
    }

    // ---- Session Bridge（供编辑器 iframe 调用） ----

    // 当编辑器嵌入本站的隐藏 iframe 时，iframe 加载后 postMessage 请求 session，
    // 本页面监听并把 session 回传。这实现了「编辑器启动时自动拉取网站登录态」。
    function initSessionBridge() {
        function onBridgeRequest(e) {
            if (!e.data || e.data.type !== 'request-site-session') return;
            var s = getSession();
            try {
                e.source.postMessage({ type: 'site-session-response', session: s }, e.origin);
            } catch (err) {}
        }
        window.addEventListener('message', onBridgeRequest);
    }

    // ---- 公开 API ----

    return {
        init: function (opts) {
            opts = opts || {};
            _onLoginCallback = opts.onLoginChange || null;
            if (opts.enableBridge !== false) initSessionBridge();
            // 页面加载时检查已有会话并通知 UI
            var s = getSession();
            if (s && _onLoginCallback) _onLoginCallback(s);
        },
        login: login,
        register: register,
        logout: logout,
        getSession: getSession,
        openGitHubAuth: openGitHubAuth,
        sendCode: sendCode,
        verifyCode: verifyCode,
        // 供 UI 直接调用的一键流程
        doLogin: function (username, password, remember) {
            return login(username, password, remember)
                .then(handleLoginSuccess);
        },
        doRegister: function (username, password, email, verifiedToken, remember) {
            return register(username, password, email, verifiedToken, remember)
                .then(handleLoginSuccess);
        },
        // 给编辑器 iframe 用的 bridge 端点 URL（返回一段 JS 自动 postMessage session）
        getBridgeUrl: function () {
            return apiBase() + '/session-bridge.html';
        }
    };
})();

// 如果在非模块环境（<script> 标签），挂到全局
if (typeof window !== 'undefined') window.AuthWeb = AuthWeb;
