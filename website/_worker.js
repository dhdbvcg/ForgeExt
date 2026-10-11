/**
 * ForgeExt 后端（Cloudflare Pages Worker，Direct Upload 方式）。
 *
 * 为什么用 _worker.js 而不是 functions/ 目录：
 *   Direct Upload（API 直传）不会编译 Pages Functions 的 functions/ 目录 ——
 *   那是 Git 集成部署专有的能力。直传方式下唯一能跑动态逻辑的入口是
 *   项目根目录的 _worker.js（Pages 会把它作为 Worker 运行）。
 *
 * 提供：
 *   POST /github-oauth/device/code        → github.com/login/device/code
 *   POST /github-oauth/oauth/access_token → github.com/login/oauth/access_token
 *   其余路径 → 静态资源（占位页）
 *
 * CORS：前端在 forgeext.github.io，跨域调用必须带 CORS 头；
 * 用来源白名单而非 *，避免被当成公开代理滥用。
 */

const ALLOWED_ORIGINS = [
    'https://forgeext.github.io',
    'https://dhdbvcg.github.io',
    'https://scratchextensioneditor.pages.dev',
    'https://scratchextensioneditor.cc.cd'
];

function corsHeaders(request) {
    const origin = (request && request.headers.get('Origin')) || '';
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const allow = (ALLOWED_ORIGINS.indexOf(origin) >= 0 || isLocal) ? origin : '';
    const h = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
    if (allow) h['Access-Control-Allow-Origin'] = allow;
    return h;
}

function json(obj, status, cors) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }, cors || {})
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const cors = corsHeaders(request);

        // 预检
        if (request.method === 'OPTIONS') {
            return new Response(null, {status: 204, headers: cors});
        }

        // Device Flow 代理：/github-oauth/<path> → github.com/login/<path>
        if (url.pathname.indexOf('/github-oauth/') === 0) {
            if (request.method !== 'POST') {
                return json({error: 'method_not_allowed', error_description: '仅支持 POST'}, 405, cors);
            }
            const seg = url.pathname.slice('/github-oauth/'.length);
            if (!seg) return json({error: 'bad_request', error_description: '缺少转发路径'}, 400, cors);

            const body = await request.text();
            let upstream;
            try {
                upstream = await fetch('https://github.com/login/' + seg, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'ForgeExt-Editor'
                    },
                    body: body
                });
            } catch (e) {
                return json({error: 'github_unreachable', error_description: String((e && e.message) || e)}, 502, cors);
            }
            // 原样透传状态码与 body：轮询期间 GitHub 会返回
            // 200+error=authorization_pending 或 400+error，都要交给前端判断
            const text = await upstream.text();
            return new Response(text, {
                status: upstream.status,
                headers: Object.assign({
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                }, cors)
            });
        }

        // 站点认证等既有接口：/api/<name> → functions/api/<name>.js
        if (url.pathname.indexOf('/api/') === 0) {
            const name = url.pathname.slice('/api/'.length).split('/')[0].replace(/[^a-z0-9-]/gi, '');
            if (env && env.ASSETS) {
                // 交给静态资源处理（这些接口是历史遗留，前端已不依赖）
                return env.ASSETS.fetch(request);
            }
            return json({success: false, error: '接口已迁移，前端请用 forgeext.github.io'}, 410, cors);
        }

        // 其余走静态资源
        if (env && env.ASSETS) return env.ASSETS.fetch(request);
        return new Response('ForgeExt backend is running.', {
            headers: {'Content-Type': 'text/plain; charset=utf-8'}
        });
    }
};
