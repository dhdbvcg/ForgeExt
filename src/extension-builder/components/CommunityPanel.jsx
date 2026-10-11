/**
 * 社区面板（发布到 GitHub Gist / 从社区载入）
 * ================================================================
 *
 * 挂在设置面板左侧导航里，与「插件管理 / 快捷键 / WorkBuddy」并列。
 * 两件事：
 *   发布 —— 把当前扩展打包成快照发到 GitHub Gist（需 gist 权限）
 *   社区 —— 列出社区里的扩展，一键载入为「我的新扩展」
 *
 * 关于 token：现有登录走 Device Flow 但 scope 只有 user:email，且
 * 拿到 access_token 后立即丢弃（只用来取 profile 资料）—— 这是对的，
 * 不该为了发个 Gist 就长期存一枚 token。所以这里按需再走一次 Device Flow，
 * scope 要 gist，token 只留在本组件的内存里供本次会话用，组件卸载即丢。
 */

import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
    fetchCommunity, fetchGistDetail, publishToCommunity,
    publishToCloud, cloudBackendReady,
    buildCommunityEntry, buildImportPayload
} from '../lib/community';
import {startGitHubDeviceFlow, pollGitHubDeviceToken} from '../lib/auth';

const GIST_SCOPE = 'gist';
/* 品牌改名后换新键；旧键里可能还留着一枚有效的 gist 授权，顺手读过来，
   省得用户重新授权一遍。写只写新键。 */
const TOKEN_KEYS = ['forgeext_gist_token', 'extforge_gist_token'];

const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
};

const ICON = {
    upload: ['M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4', 'M7 10l5-5 5 5', 'M12 5v13'],
    users: ['M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2', 'M9 11a4 4 0 100-8 4 4 0 000 8', 'M23 21v-2a4 4 0 00-3-3.87'],
    code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
    use: ['M5 12h14', 'M13 6l6 6-6 6']
};

const svgIcon = (paths) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('strokeWidth', '2');
    s.setAttribute('strokeLinecap', 'round');
    s.setAttribute('strokeLinejoin', 'round');
    paths.forEach((d) => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        s.appendChild(p);
    });
    return s;
};

/* ── 内存里的 gist token（不落盘）── */
let memToken = null;
function getToken() {
    if (memToken) return memToken;
    try {
        for (const k of TOKEN_KEYS) {
            const v = sessionStorage.getItem(k);
            if (v) { memToken = v; break; }
        }
    } catch (e) { /* 无痕模式 */ }
    return memToken;
}
function setToken(t) {
    memToken = t;
    // sessionStorage 语义就是「关掉浏览器就没了」，比 localStorage 保守
    try {
        if (t) {
            sessionStorage.setItem(TOKEN_KEYS[0], t);
            for (let i = 1; i < TOKEN_KEYS.length; i++) sessionStorage.removeItem(TOKEN_KEYS[i]);
        } else {
            for (const k of TOKEN_KEYS) sessionStorage.removeItem(k);
        }
    } catch (e) { /* 无痕模式 */ }
}

/**
 * 拿 gist 权限的 token。
 * 优先用 PAT 登录时存下的 token（forgeext_gist_token —— 登录时若探测到
 * gist 权限就会写入）；没有时才走 Device Flow（仅本地 devServer 可用，
 * 线上会直接报错并引导用户用带 gist 权限的 PAT 重新登录）。
 */
async function acquireGistToken() {
    const existing = getToken();
    if (existing) return existing;
    // 线上无法代理 Device Flow —— 直接给出可操作的提示而不是让它失败
    if (location.protocol === 'https:' && !location.hostname.startsWith('127.') && !location.hostname.startsWith('localhost')) {
        throw new Error('当前 Token 没有 gist 权限。请到 GitHub 生成一个勾选了 gist 权限的 Personal Access Token（github.com/settings/tokens），退出后用它重新登录，即可发布。');
    }
    const d = await startGitHubDeviceFlow(GIST_SCOPE);
    // 打开授权页（可能被拦截，但用户码已展示）
    try { window.open(d.verificationUriComplete || d.verificationUri, 'gh-gist', 'width=600,height=720'); } catch (e) { /* 无妨 */ }
    const deadline = Date.now() + d.expiresIn * 1000;
    let interval = d.interval;
    // 轮询到拿到 token 或超时
    for (;;) {
        if (Date.now() > deadline) throw new Error('设备码已过期，请重试');
        // eslint-disable-next-line no-await-in-loop
        const r = await pollGitHubDeviceToken(d.deviceCode);
        if (r && r.access_token) { setToken(r.access_token); return r.access_token; }
        if (r && r.error === 'authorization_pending') {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((res) => setTimeout(res, interval * 1000));
            continue;
        }
        if (r && r.error === 'slow_down') { interval += 5; continue; }
        throw new Error((r && (r.error_description || r.error)) || '未获得授权');
    }
}

export default function CommunityPanel({collectSnapshot, restoreSnapshot, session}) {
    const [tab, setTab] = useState('browse');       // browse | publish
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');
    const [q, setQ] = useState('');
    const [backend, setBackend] = useState(null);   // 'cloud' | 'gist'

    // 发布表单
    const [desc, setDesc] = useState('');
    const [busy, setBusy] = useState(false);
    const [device, setDevice] = useState(null);     // {userCode, uri}

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const r = await fetchCommunity({token: getToken()});
            setItems(r.items);
            setBackend(r.backend || null);
            if (r.notice) setError(r.notice);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const filtered = items.filter((it) => {
        if (!q) return true;
        const s = (it.name + ' ' + it.description).toLowerCase();
        return s.indexOf(q.toLowerCase()) >= 0;
    });

    const onLoadIntoEditor = useCallback(async (it) => {
        setError('');
        try {
            let entry = it.entry;
            if (!entry) {
                // 大 Gist 内容被 GitHub 截断，要单独拉
                const d = await fetchGistDetail(it.gistId, getToken());
                entry = d.entry;
            }
            if (!entry) throw new Error('这个扩展的数据读不出来');
            // 载入：直接替换当前项目状态，并给一个新 ID（避免与原作者冲突）
            const snapshot = (typeof collectSnapshot === 'function') ? collectSnapshot() : null;
            const payload = buildImportPayload(entry);
            const data = payload.data;
            // 换 ID + 名字，标明是改编自谁
            const origId = data.extInfo && data.extInfo.id;
            const origName = data.extInfo && data.extInfo.name;
            data.extInfo = Object.assign({}, data.extInfo, {
                id: (origId || 'myext') + '-fork',
                name: (origName || '扩展') + '（改编）',
                description: '改编自 @' + it.author + ' 的「' + origName + '」'
            });
            restoreSnapshot(data);
            setMsg('已载入「' + (origName || '扩展') + '」的改编版。可直接编辑，改完另存。');
        } catch (e) {
            setError('载入失败：' + (e.message || e));
        }
    }, [collectSnapshot, restoreSnapshot]);

    const onPublish = useCallback(async () => {
        setBusy(true);
        setError('');
        setMsg('');
        setDevice(null);
        try {
            const snapshot = collectSnapshot();
            const entry = buildCommunityEntry(snapshot, {description: desc});
            const author = (session && session.username) || '';

            // 优先走云端：不需要任何 GitHub 授权。
            // 这条路径的存在意义是绕开 GitHub Pages 上 Device Flow 不可用的问题
            // （Pages 纯静态，POST 被 SPA fallback 挡成 405）。
            if (cloudBackendReady() && author) {
                const r = await publishToCloud(entry, author);
                setMsg('已发布到云端社区！打开「' + (entry.extInfo && entry.extInfo.name) +
                    '」即可看到。');
                setDesc('');
                load();
                return;
            }

            // 回退：Gist 发布（需要一次 GitHub 授权）
            const token = await acquireGistToken();
            const gist = await publishToCommunity(entry, token);
            setMsg('云端未配置，已改用 GitHub Gist 发布：' + gist.html_url);
            setDesc('');
            load();
        } catch (e) {
            const msgText = e.message || String(e);
            if (/设备码|授权|过期/.test(msgText)) setError(msgText);
            else setError('发布失败：' + msgText);
        } finally {
            setBusy(false);
        }
    }, [collectSnapshot, desc, load, session]);

    // 设备码授权界面（如果用户要 gist 权限）
    const startAuth = useCallback(async () => {
        setError('');
        try {
            const d = await startGitHubDeviceFlow(GIST_SCOPE);
            setDevice({userCode: d.userCode, uri: d.verificationUriComplete || d.verificationUri});
            try { window.open(d.verificationUriComplete || d.verificationUri, 'gh-gist', 'width=600,height=720'); } catch (e) { /* 无妨 */ }
        } catch (e) {
            setError('无法发起授权：' + (e.message || e));
        }
    }, []);

    const style = {
        pane: {
            display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
            fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
            fontSize: 13, color: '#202124', overflow: 'hidden'
        },
        scroll: {flex: 1, overflowY: 'auto', padding: '20px 22px 28px'},
        tabs: {display: 'flex', gap: 6, marginBottom: 16},
        tab: {
            padding: '7px 14px', borderRadius: 8, border: '1px solid #dadce0', background: '#fff',
            cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#5f6368'
        },
        tabOn: {background: '#1a73e8', borderColor: '#1a73e8', color: '#fff'},
        search: {
            width: '100%', boxSizing: 'border-box', padding: '9px 12px', marginBottom: 14,
            border: '1px solid #dadce0', borderRadius: 8, fontSize: 13, fontFamily: 'inherit'
        },
        card: {
            border: '1px solid #e8eaed', borderRadius: 10, padding: '14px 16px',
            marginBottom: 12, background: '#fff', display: 'flex', flexDirection: 'column', gap: 10
        },
        btn: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: '1px solid transparent',
            background: '#1a73e8', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer'
        },
        btnGhost: {background: '#fff', color: '#202124', borderColor: '#dadce0'},
        input: {
            width: '100%', boxSizing: 'border-box', padding: '9px 11px', marginBottom: 12,
            border: '1px solid #dadce0', borderRadius: 8, fontSize: 13, fontFamily: 'inherit'
        },
        msg: {padding: '9px 12px', borderRadius: 7, fontSize: 12.5, marginBottom: 14, lineHeight: 1.6},
        err: {background: '#fce8e6', color: '#a50e0e'},
        ok: {background: '#e6f4ea', color: '#0d652d'},
        muted: {fontSize: 11.5, color: '#80868b', lineHeight: 1.6}
    };

    const card = (title) => React.createElement('div', {
        style: {border: '1px solid #e8eaed', borderRadius: 8, padding: '14px 16px', marginBottom: 14, background: '#fff'}
    }, title ? React.createElement('div', {
        style: {fontSize: 13, fontWeight: 600, marginBottom: 10}
    }, title) : null);

    const renderItem = (it) => React.createElement('div', {key: it.gistId, style: style.card},
        React.createElement('div', {style: {display: 'flex', gap: 10, alignItems: 'center'}},
            React.createElement('div', {
                style: {
                    width: 34, height: 34, borderRadius: 8, background: '#1a73e8', color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0
                }
            }, (it.author || it.name || '?').charAt(0).toUpperCase()),
            React.createElement('div', null,
                React.createElement('div', {style: {fontWeight: 600, fontSize: 14}}, it.name),
                React.createElement('div', {style: {fontSize: 11.5, color: '#80868b'}},
                    '@' + it.author + (it.blockCount != null ? ' · ' + it.blockCount + ' 个积木' : '')))
        ),
        it.description ? React.createElement('p', {
            style: {margin: 0, fontSize: 12.5, color: '#4a5058', lineHeight: 1.6}
        }, it.description) : null,
        React.createElement('div', {style: {display: 'flex', gap: 8, alignItems: 'center'}},
            React.createElement('button', {
                style: {...style.btn, flex: 1},
                onClick: () => onLoadIntoEditor(it),
                disabled: !it.entry
            }, '以此为基础修改'),
            React.createElement('a', {
                style: {...style.btn, ...style.btnGhost, textDecoration: 'none'},
                href: it.url, target: '_blank', rel: 'noopener'
            }, 'Gist')
        )
    );

    return React.createElement('div', {style: style.pane},
        React.createElement('div', {style: style.scroll},
            React.createElement('h3', {style: {fontSize: 16, fontWeight: 600, margin: '0 0 4px'}}, '社区'),
            React.createElement('p', {style: {margin: '0 0 16px', fontSize: 12, color: '#80868b', lineHeight: 1.6}},
                '把做好的扩展发布到社区，或把别人的扩展一键载入改成自己的。存储走 GitHub Gist。'),

            // 页签
            React.createElement('div', {style: style.tabs},
                React.createElement('button', {
                    style: tab === 'browse' ? {...style.tab, ...style.tabOn} : style.tab,
                    onClick: () => setTab('browse')
                }, '浏览社区'),
                React.createElement('button', {
                    style: tab === 'publish' ? {...style.tab, ...style.tabOn} : style.tab,
                    onClick: () => setTab('publish')
                }, '发布我的扩展')
            ),

            error ? React.createElement('div', {style: {...style.msg, ...style.err}}, error) : null,
            msg ? React.createElement('div', {style: {...style.msg, ...style.ok}}, msg) : null,

            tab === 'browse' ? React.createElement(React.Fragment, null,
                backend ? React.createElement('p', {style: {...style.muted, marginBottom: 10}},
                    backend === 'cloud'
                        ? '数据来自云端（Supabase），无需登录即可浏览。'
                        : '云端暂不可用，当前显示的是 GitHub Gist 上的扩展。') : null,
                React.createElement('input', {
                    style: style.search, type: 'search', placeholder: '搜索社区扩展…', value: q,
                    onChange: (e) => setQ(e.target.value)
                }),
                loading ? React.createElement('div', {style: {padding: '32px 0', textAlign: 'center', color: '#80868b'}}, '正在拉取社区…')
                    : filtered.length === 0 ? React.createElement('div', {style: {padding: '32px 0', textAlign: 'center', color: '#80868b'}}, '社区还没有扩展。发布你的第一个！')
                        : filtered.map(renderItem)
            ) : React.createElement(React.Fragment, null,
                card('发布当前扩展到社区'),
                React.createElement('p', {style: style.muted},
                    cloudBackendReady()
                        ? '发布不需要 GitHub 授权 —— 当前走云端存储（Supabase），只需已登录以标记作者。发布后社区页立即可见，' +
                          '其他人可一键载入你的扩展并改编成他自己的版本。'
                        : '云端尚未配置，发布会回退到 GitHub Gist（需要一次含 gist 权限的 GitHub 授权）。' +
                          '在 supabase-config.js 填好项目凭据即可切换到无需授权的云端发布。'),
                !session ? React.createElement('p', {style: {...style.muted, color: '#a50e0e'}},
                    '发布需要先登录（用于标记作者）。点击顶部「GitHub 登录」或任意本地账号登录后再来。') : null,
                React.createElement('input', {
                    style: style.input, type: 'text', placeholder: '一句话介绍这个扩展（可选）', value: desc,
                    onChange: (e) => setDesc(e.target.value)
                }),
                React.createElement('button', {
                    style: style.btn, onClick: onPublish, disabled: busy || !session
                }, busy ? '发布中…' : '发布到社区'),
                device ? React.createElement('div', {style: {...style.msg, background: '#e8f0fe', color: '#174ea6', marginTop: 14}},
                    '请在打开的 GitHub 页面确认授权。若没弹窗，请手动打开：',
                    React.createElement('a', {href: device.uri, target: '_blank', rel: 'noopener', style: {color: '#174ea6'}},
                        device.uri)) : null,
                React.createElement('p', {style: {...style.muted, marginTop: 16}},
                    '提示：发布是公开的，任何人都能看到和复制你的扩展源码。')
            )
        )
    );
}