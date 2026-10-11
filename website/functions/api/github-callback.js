/**
 * GitHub OAuth 服务端回调（Cloudflare Pages Function）v3
 * 流程：登录页 location.href 整页跳转 → GitHub 授权 → 重定向到本函数（?code=xxx&state=yyy）
 * → 本函数在 Cloudflare 边缘节点代为换 token + 拉用户资料
 * → 返回 HTML 页面：把会话写入「同域」localStorage，然后整页跳转回首页
 *
 * 说明：采用整页跳转（非弹窗）模式。登录页与 /api/github-callback 同属
 *   scratchextensioneditor.cc.cd 源，localStorage 互通，因此回调页写入的会话
 *   首页直接可见，无需 postMessage / window.close（弹窗模式才需要）。
 *
 * 优势：token 交换在服务端完成，不受浏览器 CORS / 国内网络限制
 */
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    const error = url.searchParams.get('error');

    // GitHub 授权被拒绝
    if (error) {
        return new Response(htmlPage('GitHub 授权被拒绝（' + error + '），请关闭此页面重试。', true), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    if (!code) {
        return new Response(htmlPage('GitHub 未返回授权码，请关闭此页面重试。', true), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    const CLIENT_ID = 'Ov23liyPHcuvhocCJCws';
    const CLIENT_SECRET = env.GH_CLIENT_SECRET || '';
    const REDIRECT_URI = 'https://scratchextensioneditor.cc.cd/api/github-callback';

    try {
        // 1) 用 code 换 access_token（服务端→GitHub，无 CORS 问题）
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            })
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            throw new Error(tokenData.error_description || tokenData.error || '换取令牌失败');
        }

        const token = tokenData.access_token;

        // 2) 拉取用户资料
        const userRes = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'Scratch-Extension-Editor'
            }
        });
        const user = await userRes.json();

        if (!user.login) {
            throw new Error('无法获取用户资料');
        }

        // 3) 拉取主邮箱
        let email = user.email || '';
        try {
            const emailRes = await fetch('https://api.github.com/user/emails', {
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'Scratch-Extension-Editor'
                }
            });
            const emails = await emailRes.json();
            if (Array.isArray(emails) && !email) {
                const p = emails.find(function (e) { return e.primary && e.verified; })
                    || emails.find(function (e) { return e.verified; });
                email = p ? p.email : '';
            }
        } catch (e) { /* 邮箱获取失败不阻断 */ }

        const profile = JSON.stringify({
            id: user.id,
            login: user.login,
            name: user.name || user.login,
            email: email,
            avatar: user.avatar_url || ''
        });

        // 4) 返回 HTML：存 session + postMessage + 关闭
        const html = htmlCallbackPage(profile, state);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });

    } catch (e) {
        return new Response(htmlPage('🔧V3 GitHub 登录失败：' + (e.message || e), true), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }
}

function htmlPage(msg, isError) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
        + '<title>GitHub 登录</title>'
        + '<style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;'
        + 'background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;'
        + 'font-size:15px;text-align:center;padding:0 24px;}'
        + (isError ? '.msg{color:#f87171}' : '.msg{color:#34d399}')
        + '</style></head><body><div class="msg">' + escapeHtml(msg) + '</div></body></html>';
}

function htmlCallbackPage(profileJson, state) {
    // 此 HTML 在「整页跳转」的回调页中执行（与登录页同源 scratchextensioneditor.cc.cd）：
    // 1. 把 profile 写入 localStorage（创建/更新账号 + session）
    // 2. 立即整页跳回首页（首页 AuthWeb 会读取同源 localStorage 的会话）
    // 注意：不再使用 window.opener / window.close（那是弹窗模式才需要），
    //      整页跳转模式下没有 opener，那些调用会静默失败。
    // ⚠️ 关键：<script> 是 raw text 元素，其中的 **HTML 实体不会被浏览器解码**，会原样交给 JS 引擎。
    // 若像以前那样把 JSON 的引号转成 &quot;，JS 会直接 SyntaxError（Unexpected token '&'），
    // 导致整段脚本不执行——表现就是"页面显示登录成功，但既不存会话也不跳转"。
    // 正确做法：JSON 本身即合法的 JS 字面量，原样嵌入；只处理可能提前结束脚本块的 </script 与 <!--。
    var escapedProfile = String(profileJson)
        .replace(/<\/script/gi, '<\\/script')
        .replace(/<!--/g, '<\\!--');
    // state 走 JS 字符串上下文：用 JSON.stringify 生成合法字面量（自动处理引号/反斜杠/换行）
    var escapedState = JSON.stringify(String(state || ''));
    var origin = 'https://scratchextensioneditor.cc.cd';
    // state 格式：[s:|g:]btoa(编辑器地址) + '~' + random
    //   s: → 网站登录页（?return=）发起；g: → 编辑器登录弹窗发起（带回编辑器地址做兜底）
    //   无前缀 → 旧格式，等价于 s:
    // 整页跳转会丢失 ?return=，故借 state 把地址带回；有地址时即使 opener 不可用也能靠 URL 回传会话。
    var retUrl = '';       // 网站登录页带回的编辑器回跳地址
    var editorOrigin = ''; // 编辑器弹窗流程带回的编辑器地址（兜底用）
    try {
      var _sep = state.indexOf('~');
      if (_sep > 0) {
        var _prefix = state.slice(0, _sep);
        var _kind = '';
        var _b64 = _prefix;
        if (_prefix.length > 2 && _prefix.charAt(1) === ':') {
          _kind = _prefix.charAt(0);
          _b64 = _prefix.slice(2);
        }
        var _decoded = atob(_b64);
        if (/^https?:\/\//i.test(_decoded)) {
          if (_kind === 'g') editorOrigin = _decoded;
          else retUrl = _decoded;
        }
      }
    } catch (e) { retUrl = ''; editorOrigin = ''; }
    // 编辑器侧落地页（postMessage 不可用时的兜底目标）；为空表示本次登录与编辑器无关
    var editorLanding = retUrl || editorOrigin;
    var returnUrl = editorLanding || (origin + '/users/index.html');

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
        + '<title>登录成功</title>'
        + '<style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;'
        + 'background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;'
        + 'font-size:15px;text-align:center;padding:0 24px;}'
        + '.msg{color:#34d399;margin-bottom:8px;}'
        + '.sub{color:#8b949e;font-size:13px;}'
        + '.btn{display:inline-block;padding:10px 24px;border-radius:8px;background:#8b5cf6;color:#fff;'
        + 'text-decoration:none;font-weight:600;font-size:14px;margin-top:18px;cursor:pointer;border:none;}'
        + '.btn:hover{background:#7c3aed;}'
        + '</style></head><body>'
        + '<div class="msg">✓ GitHub 登录成功</div>'
        + '<div class="sub" id="status">正在处理登录结果…</div>'
        + '<a class="btn" id="returnBtn" href="' + returnUrl + '">继续</a>'
        + '<script>(function(){'
        + 'var profile=' + escapedProfile + ';'
        + 'var state=' + escapedState + ';'
        + 'var USERS_KEY="extbuilder_users",SESSION_KEY="extbuilder_session";'
        + 'var returnUrl=' + JSON.stringify(returnUrl) + ';'
        + 'var retUrl=' + JSON.stringify(retUrl) + ';'
        + 'var editorLanding=' + JSON.stringify(editorLanding) + ';'
        + '/* 兜底：把会话塞进 URL hash（#gh=...）一起跳回编辑器。'
        + '当浏览器因 COOP/弹窗拦截导致 window.opener 为空时，postMessage 不可用，靠这条路径完成登录。*/'
        + 'function ghUrl(base){'
        + '  var target=base||returnUrl;'
        + '  if(!editorLanding) return target;'
        + '  try{'
        + '    var payload=encodeURIComponent(JSON.stringify(session));'
        + '    return String(target)+(String(target).indexOf("#")===-1?"#gh="+payload:"&gh="+payload);'
        + '  }catch(e){ return target; }'
        + '}'
        + 'try{'
        + 'var users=JSON.parse(localStorage.getItem(USERS_KEY)||"{}");'
        + 'var existing=users[profile.login];'
        + 'if(!existing||existing.provider!=="local"){'
        + 'users[profile.login]={provider:"github",githubId:profile.id,email:profile.email||"",name:profile.name||profile.login,avatar:profile.avatar||"",createdAt:(existing&&existing.createdAt)||Date.now()};'
        + 'localStorage.setItem(USERS_KEY,JSON.stringify(users));'
        + '}'
        + 'var session={username:profile.login,remember:true,expires:Date.now()+30*86400000,token:Math.random().toString(36).slice(2)+Date.now().toString(36)};'
        + 'localStorage.setItem(SESSION_KEY,JSON.stringify(session));'
        + '}catch(e){'
        + 'document.body.insertAdjacentHTML("beforeend","<div class=\\"sub\\" style=\\"color:#f87171;margin-top:12px\\">会话保存失败："+(e&&e.message||e)+"</div>");'
        + '}'
        + 'var statusEl=document.getElementById("status");'
        + 'function setStatus(t){ try{ statusEl.textContent=t; }catch(e){} }'
        + 'try{ document.getElementById("returnBtn").href=ghUrl(returnUrl); }catch(e){}'
        + 'if(retUrl && window.opener){'
        + '  /* 网站登录页（?return=）发起：把会话回传给编辑器标签页并关闭本页 */'
        + '  try{ window.opener.postMessage({type:"site-session-response",session:session},"*"); }catch(e){}'
        + '  setStatus("已把登录状态回传给编辑器窗口，正在关闭本页…");'
        + '  try{ document.getElementById("returnBtn").textContent="若未自动关闭，点此返回编辑器"; }catch(e){}'
        + '  setTimeout(function(){ try{ window.close(); }catch(e){} if(!window.closed) location.href = ghUrl(retUrl); }, 600);'
        + '} else if(window.opener){'
        + '  /* 编辑器登录弹窗发起：回传 github-auth（编辑器校验 state 后建立本地会话），并关闭弹窗 */'
        + '  try{ window.opener.postMessage({type:"github-auth",state:state,profile:profile},"*"); }catch(e){}'
        + '  /* 同时发会话消息：编辑器若因页面刷新丢失了 state（github-auth 校验会失败），仍能凭此登录 */'
        + '  try{ window.opener.postMessage({type:"site-session-response",session:session},"*"); }catch(e){}'
        + '  setStatus("已把 GitHub 登录结果回传给编辑器弹窗，正在关闭本页…");'
        + '  try{ document.getElementById("returnBtn").textContent="若未自动关闭，点此返回编辑器"; }catch(e){}'
        + '  setTimeout(function(){ try{ window.close(); }catch(e){} if(!window.closed) location.href = ghUrl(returnUrl); }, 600);'
        + '} else {'
        + '  /* 无 opener：postMessage 不可用。有编辑器地址则带 #gh= 会话跳回编辑器，否则跳「我的资料」页 */'
        + '  setStatus(editorLanding ? "未检测到编辑器窗口，改用链接回传会话…" : "未检测到编辑器窗口，正在跳转到资料页…");'
        + '  setTimeout(function(){ location.href = ghUrl(returnUrl); }, 800);'
        + '}'
        + '})()<\/script></body></html>';
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
