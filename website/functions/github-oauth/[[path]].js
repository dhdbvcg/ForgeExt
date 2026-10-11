/**
 * GitHub OAuth Device Flow 代理（Cloudflare Pages Function）
 *
 * 部署在 Cloudflare，前端在 forgeext.github.io —— 跨域调用，因此这里
 * 必须返回 CORS 头（原版是同源部署，没有这层需求）。
 *
 * 为什么需要它：GitHub 的 /login/device/code 与 /login/oauth/access_token
 * 不返回 Access-Control-Allow-Origin，浏览器从编辑器页面直连会直接
 * TypeError: Failed to fetch。而 GitHub Pages 是纯静态托管，POST 会被
 * SPA fallback 挡成 405 —— 所以只能把这一小段后端放到 Cloudflare。
 *
 * 路由：/github-oauth/<path>  →  https://github.com/login/<path>
 *   POST /github-oauth/device/code        → /login/device/code
 *   POST /github-oauth/oauth/access_token → /login/oauth/access_token
 *
 * 安全说明：Device Flow 全程不需要 client_secret，因此这里不注入、也不持有
 * 任何凭据；前端只带公开的 client_id。本 Function 是纯粹的透明转发。
 *
 * CORS 策略：Access-Control-Allow-Origin 用白名单而不是 * ——
 * 这个代理会被公开访问，限制来源能减少被当成免费 GitHub 代理滥用。
 * 允许：本项目自己的站点（forgeext.github.io、dhdbvcg.github.io/ForgeExt）
 * 以及本地开发（localhost / 127.0.0.1）。
 */

const ALLOWED_ORIGINS = [
    'https://forgeext.github.io',
    'https://dhdbvcg.github.io',
    'https://scratchextensioneditor.pages.dev',
    'https://scratchextensioneditor.cc.cd'
];

function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    // 本地开发：http://localhost:8601 / http://127.0.0.1:8601 等任意端口
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

/** 预检请求：浏览器在跨域 POST（JSON Content-Type）前会先发 OPTIONS */
export async function onRequestOptions(context) {
    return new Response(null, {status: 204, headers: corsHeaders(context.request)});
}

export async function onRequestPost(context) {
    const { request, params } = context;
    const cors = corsHeaders(request);

    // [[path]] 捕获段：可能是数组（多段）或字符串（单段）
    const seg = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
    if (!seg) {
        return json({ error: 'bad_request', error_description: '缺少转发路径' }, 400, cors);
    }

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
        return json({
            error: 'github_unreachable',
            error_description: String((e && e.message) || e)
        }, 502, cors);
    }

    // 原样透传：轮询期间 GitHub 会返回 200 + body.error=authorization_pending，
    // 也可能返回 400 + error，两种都要让前端自己判断，不能在这里吞掉。
    const text = await upstream.text();
    return new Response(text, {
        status: upstream.status,
        headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }, cors)
    });
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
