const CONFIG_KV_KEY = 'proxy:settings';
const SESSION_COOKIE_NAME = '__proxy_admin_session';
const SESSION_MAX_AGE = 60 * 60 * 12;
const RESERVED_PREFIXES = ['/api/admin/'];
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-ew-via',
  'cf-worker',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'x-real-ip'
];

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  updatedAt: null,
  global: {
    noMatchStatus: 404,
    followRedirects: true,
    maxRedirects: 5
  },
  rules: []
});

function getConfigKV(env) {
  return env?.CONFIG_KV || env?.CF_ACCEL_KV || env?.ACCEL_KV || env?.KV || null;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
  }
  return new Response(body, { ...init, headers });
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(payload, null, 2), { ...init, headers });
}

function redirectResponse(location, headers = {}) {
  const nextHeaders = new Headers(headers);
  nextHeaders.set('Location', location);
  return new Response(null, { status: 302, headers: nextHeaders });
}

function isReservedRoute(pathname) {
  return pathname === '/login' || pathname === '/logout' || pathname === '/admin' || RESERVED_PREFIXES.some(prefix => pathname.startsWith(prefix));
}


function githubPresetRule() {
  return {
    id: 'gh',
    name: 'GitHub Root Proxy',
    enabled: true,
    priority: 10,
    match: {
      pattern: '^/gh(?:/(.*))?$',
      flags: ''
    },
    target: {
      origin: 'https://github.com',
      pathTemplate: '/$1'
    },
    headers: {
      forwardClientHeaders: true,
      set: {},
      remove: []
    }
  };
}

function defaultRule() {
  return {
    id: '',
    name: '',
    enabled: true,
    priority: 100,
    match: {
      pattern: '^/(.*)$',
      flags: ''
    },
    target: {
      origin: 'https://example.com',
      pathTemplate: '/$1'
    },
    headers: {
      forwardClientHeaders: true,
      set: {},
      remove: []
    }
  };
}

function normalizeHeadersMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key || '').trim();
    if (!name) continue;
    out[name] = String(value ?? '');
  }
  return out;
}

function normalizeHeaderRemoveList(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return [...new Set(input.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizeRule(rule = {}, index = 0) {
  const base = defaultRule();
  const normalized = {
    id: String(rule.id || `rule-${index + 1}`),
    name: String(rule.name || `Rule ${index + 1}`),
    enabled: rule.enabled !== false,
    priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : base.priority,
    match: {
      pattern: String(rule?.match?.pattern || base.match.pattern),
      flags: String(rule?.match?.flags || base.match.flags)
    },
    target: {
      origin: String(rule?.target?.origin || base.target.origin).trim(),
      pathTemplate: String(rule?.target?.pathTemplate || base.target.pathTemplate)
    },
    headers: {
      forwardClientHeaders: rule?.headers?.forwardClientHeaders !== false,
      set: normalizeHeadersMap(rule?.headers?.set),
      remove: normalizeHeaderRemoveList(rule?.headers?.remove)
    }
  };
  return normalized;
}

function normalizeConfig(input = {}) {
  const global = input?.global || {};
  const rules = Array.isArray(input?.rules) ? input.rules : [];
  return {
    version: 1,
    updatedAt: input?.updatedAt || null,
    global: {
      noMatchStatus: [403, 404].includes(Number(global.noMatchStatus)) ? Number(global.noMatchStatus) : DEFAULT_CONFIG.global.noMatchStatus,
      followRedirects: global.followRedirects !== false,
      maxRedirects: Number.isFinite(Number(global.maxRedirects))
        ? Math.max(0, Math.min(10, Number(global.maxRedirects)))
        : DEFAULT_CONFIG.global.maxRedirects
    },
    rules: rules.map((rule, index) => normalizeRule(rule, index))
  };
}

function validateHeaderName(name) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function validateRule(rule, index) {
  const label = `规则 #${index + 1}`;
  if (!rule.name.trim()) {
    throw new Error(`${label} 缺少名称`);
  }
  let regex;
  try {
    regex = new RegExp(rule.match.pattern, rule.match.flags);
  } catch (error) {
    throw new Error(`${label} 正则无效：${error.message}`);
  }
  let origin;
  try {
    origin = new URL(rule.target.origin);
  } catch {
    throw new Error(`${label} target.origin 不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(origin.protocol)) {
    throw new Error(`${label} target.origin 仅支持 http:// 或 https://`);
  }

  if (!rule.target.pathTemplate.startsWith('/')) {
    throw new Error(`${label} target.pathTemplate 必须以 / 开头`);
  }

  for (const [headerName] of Object.entries(rule.headers.set)) {
    if (!validateHeaderName(headerName)) {
      throw new Error(`${label} 自定义请求头名无效：${headerName}`);
    }
  }
  for (const headerName of rule.headers.remove) {
    if (!validateHeaderName(headerName)) {
      throw new Error(`${label} 待移除请求头名无效：${headerName}`);
    }
  }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('配置必须是 JSON 对象');
  }
  const normalized = normalizeConfig(config);
  normalized.rules.forEach((rule, index) => validateRule(rule, index));
  return normalized;
}

async function getConfig(env) {
  const kv = getConfigKV(env);
  if (!kv) {
    return normalizeConfig(DEFAULT_CONFIG);
  }
  try {
    const stored = await kv.get(CONFIG_KV_KEY, 'json');
    if (!stored) {
      return normalizeConfig(DEFAULT_CONFIG);
    }
    return normalizeConfig(stored);
  } catch (error) {
    console.log(`Failed to load config from KV: ${error.message}`);
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

async function saveConfig(env, config) {
  const kv = getConfigKV(env);
  if (!kv) {
    throw new Error('未绑定 KV Namespace，请绑定 CONFIG_KV / CF_ACCEL_KV / ACCEL_KV / KV 之一');
  }
  const normalized = validateConfig(config);
  normalized.updatedAt = new Date().toISOString();
  await kv.put(CONFIG_KV_KEY, JSON.stringify(normalized, null, 2));
  return normalized;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const chunk of String(cookieHeader || '').split(';')) {
    const [rawKey, ...rest] = chunk.split('=');
    const key = rawKey?.trim();
    if (!key) continue;
    cookies[key] = rest.join('=').trim();
  }
  return cookies;
}

function encodeBase64Url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signSession(timestamp, adminSecret) {
  return sha256Hex(`${timestamp}.${adminSecret}`);
}

async function createSessionToken(adminSecret) {
  const timestamp = Date.now().toString();
  const signature = await signSession(timestamp, adminSecret);
  return encodeBase64Url(`${timestamp}.${signature}`);
}

async function verifySession(request, env) {
  if (!env?.ADMIN) return false;
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return false;

  try {
    const decoded = new TextDecoder().decode(decodeBase64Url(decodeURIComponent(token)));
    const [timestamp, signature] = decoded.split('.');
    if (!timestamp || !signature) return false;
    if ((Date.now() - Number(timestamp)) / 1000 > SESSION_MAX_AGE) return false;
    const expected = await signSession(timestamp, env.ADMIN);
    return signature === expected;
  } catch {
    return false;
  }
}

function renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Proxy Admin Login</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0f172a;color:#0f172a;margin:0}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;width:100%;max-width:420px;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.25);padding:28px}
    input{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px;box-sizing:border-box}
    button{width:100%;margin-top:16px;padding:12px 14px;background:#2563eb;color:#fff;border:0;border-radius:10px;font-size:16px;font-weight:700}
    .err{background:#fef2f2;color:#b91c1c;padding:10px 12px;border-radius:10px;margin-bottom:14px}
    .help{color:#64748b;font-size:14px;margin-top:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="POST" action="/login">
      <h1 style="margin:0 0 8px">Worker Proxy Admin</h1>
      <p style="color:#475569;margin:0 0 20px">使用环境变量 <code>ADMIN</code> 登录后台。</p>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
      <input type="password" name="password" placeholder="Admin password" autocomplete="current-password" required />
      <button type="submit">登录</button>
      <div class="help">登录成功后会写入签名 Cookie，用于访问 <code>/admin</code> 和 <code>/api/admin/*</code>。</div>
    </form>
  </div>
</body>
</html>`;
}

function renderAdminPage(config, options = {}) {
  const ruleJson = JSON.stringify(config.rules, null, 2);
  const previewPath = escapeHtml(options.previewPath || '/api/hello?x=1');
  const presetRuleJson = JSON.stringify(githubPresetRule());
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Worker Proxy Admin</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0}
    main{max-width:1180px;margin:0 auto;padding:24px}
    .top{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;box-shadow:0 8px 20px rgba(15,23,42,.05);margin-top:18px}
    label{display:block;font-weight:700;margin-bottom:8px}
    input,select,textarea{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #cbd5e1;font:inherit;background:#fff}
    textarea{min-height:140px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
    .msg{padding:12px 14px;border-radius:10px;margin-top:16px}
    .ok{background:#ecfdf5;color:#166534}.err{background:#fef2f2;color:#b91c1c}.warn{background:#fffbeb;color:#92400e}
    .btn{display:inline-block;padding:10px 14px;background:#2563eb;color:#fff;text-decoration:none;border:0;border-radius:10px;font-weight:700;cursor:pointer}
    .btn.secondary{background:#475569}.btn.danger{background:#dc2626}.btn.ghost{background:#e2e8f0;color:#0f172a}
    .muted{color:#64748b;font-size:14px}
    code{background:#e2e8f0;padding:2px 6px;border-radius:6px}
    pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:12px}
    .row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.row > div{flex:1 1 260px}
    .rule-card{border:1px solid #dbeafe;border-radius:14px;padding:16px;background:#f8fbff;margin-top:14px}
    .rule-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
    .rule-actions{display:flex;gap:8px;flex-wrap:wrap}
    .json-preview{min-height:120px}
  </style>
</head>
<body>
  <main>
    <div class="top">
      <div>
        <h1 style="margin:0">Cloudflare Worker Proxy Admin</h1>
        <div class="muted">KV key: <code>${CONFIG_KV_KEY}</code> · updatedAt: ${escapeHtml(config.updatedAt || 'never')}</div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn secondary" href="/api/admin/config">查看 JSON</a>
        <a class="btn secondary" href="/logout">退出</a>
      </div>
    </div>

    ${options.saved ? '<div class="msg ok">配置已保存。</div>' : ''}
    ${options.error ? `<div class="msg err">${escapeHtml(options.error)}</div>` : ''}
    ${options.kvBound ? '' : '<div class="msg warn">当前未检测到 KV 绑定，可查看默认配置，但保存会失败。</div>'}

    <form class="card" method="POST" action="/admin" id="configForm">
      <h2 style="margin-top:0">全局设置</h2>
      <div class="grid">
        <div>
          <label for="noMatchStatus">无命中状态码</label>
          <select id="noMatchStatus" name="noMatchStatus">
            <option value="404" ${config.global.noMatchStatus === 404 ? 'selected' : ''}>404</option>
            <option value="403" ${config.global.noMatchStatus === 403 ? 'selected' : ''}>403</option>
          </select>
        </div>
        <div>
          <label for="maxRedirects">最大重定向次数</label>
          <input id="maxRedirects" name="maxRedirects" type="number" min="0" max="10" value="${config.global.maxRedirects}" />
        </div>
        <div>
          <label for="followRedirects">是否跟随重定向</label>
          <select id="followRedirects" name="followRedirects">
            <option value="true" ${config.global.followRedirects ? 'selected' : ''}>true</option>
            <option value="false" ${!config.global.followRedirects ? 'selected' : ''}>false</option>
          </select>
        </div>
      </div>

      <h2>代理规则</h2>
      <p class="muted">规则按 <code>priority</code> 升序匹配；同优先级按名称排序。系统保留路由 <code>/login</code>、<code>/logout</code>、<code>/admin</code>、<code>/api/admin/*</code> 不会参与代理。</p>
      <div class="row" style="margin-bottom:10px">
        <div style="flex:0 0 auto"><button class="btn" type="button" id="addRuleBtn">新增空规则</button></div>
        <div style="flex:0 0 auto"><button class="btn secondary" type="button" id="addGhPresetBtn">添加 /gh 预置</button></div>
        <div class="muted">/gh 预置：<code>/gh/* -> https://github.com/*</code></div>
      </div>
      <div id="ruleList"></div>
      <details style="margin-top:14px">
        <summary style="cursor:pointer;font-weight:700">查看/编辑底层 JSON</summary>
        <textarea id="rulesJsonEditor" class="json-preview" spellcheck="false">${escapeHtml(ruleJson)}</textarea>
      </details>
      <textarea id="rulesJsonHidden" name="rulesJson" hidden>${escapeHtml(ruleJson)}</textarea>
      <button class="btn" type="submit" style="margin-top:16px">保存配置</button>
    </form>

    <div class="card">
      <h2 style="margin-top:0">规则测试器</h2>
      <p class="muted">输入一个 path，Worker 会返回命中的规则、最终 upstream URL 和请求头预览，不会真的转发到上游。</p>
      <div class="row">
        <div>
          <label for="testPath">测试 path</label>
          <input id="testPath" value="${previewPath}" placeholder="/api/hello?x=1" />
        </div>
        <div style="flex:0 0 auto">
          <button class="btn" id="runTestBtn" type="button">测试匹配</button>
        </div>
      </div>
      <pre id="testResult" style="margin-top:16px">点击“测试匹配”查看结果</pre>
    </div>

    <div class="card">
      <h2 style="margin-top:0">示例规则</h2>
      <pre>${escapeHtml(JSON.stringify([defaultRule()], null, 2))}</pre>
    </div>
  </main>
  <script>
    const presetRule = ${presetRuleJson};
    const defaultRuleFactory = () => (${JSON.stringify(defaultRule())});
    const initialRules = ${JSON.stringify(config.rules)};
    const ruleList = document.getElementById('ruleList');
    const rulesJsonEditor = document.getElementById('rulesJsonEditor');
    const rulesJsonHidden = document.getElementById('rulesJsonHidden');
    const form = document.getElementById('configForm');
    const addRuleBtn = document.getElementById('addRuleBtn');
    const addGhPresetBtn = document.getElementById('addGhPresetBtn');
    const runTestBtn = document.getElementById('runTestBtn');
    const testPathInput = document.getElementById('testPath');
    const testResult = document.getElementById('testResult');
    let rules = Array.isArray(initialRules) ? structuredClone(initialRules) : [];

    const escapeHtmlClient = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const headersSetToText = (headers = {}) => Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\n');
    const headersRemoveToText = (headers = []) => Array.isArray(headers) ? headers.join('\n') : '';
    const parseHeadersSetText = (text = '') => Object.fromEntries(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return [line, ''];
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }).filter(([k]) => k));
    const parseHeadersRemoveText = (text = '') => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const ensureRuleShape = (rule = {}, index = 0) => ({
      id: rule.id || 'rule-' + (index + 1),
      name: rule.name || 'Rule ' + (index + 1),
      enabled: rule.enabled !== false,
      priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 100,
      match: {
        pattern: rule?.match?.pattern || '^/(.*)$',
        flags: rule?.match?.flags || ''
      },
      target: {
        origin: rule?.target?.origin || 'https://example.com',
        pathTemplate: rule?.target?.pathTemplate || '/$1'
      },
      headers: {
        forwardClientHeaders: rule?.headers?.forwardClientHeaders !== false,
        set: rule?.headers?.set || {},
        remove: Array.isArray(rule?.headers?.remove) ? rule.headers.remove : []
      }
    });

    function syncJsonEditors() {
      const json = JSON.stringify(rules, null, 2);
      rulesJsonEditor.value = json;
      rulesJsonHidden.value = json;
    }

    function renderRules() {
      ruleList.innerHTML = '';
      if (!rules.length) {
        ruleList.innerHTML = '<div class="muted">当前没有规则，点击“新增空规则”或“添加 /gh 预置”。</div>';
      }
      rules.forEach((rawRule, index) => {
        const rule = ensureRuleShape(rawRule, index);
        rules[index] = rule;
        const card = document.createElement('div');
        card.className = 'rule-card';
        card.innerHTML = ''
          + '<div class="rule-head">'
          + '  <div><strong>规则 ' + (index + 1) + '</strong> <span class="muted">id=' + escapeHtmlClient(rule.id) + '</span></div>'
          + '  <div class="rule-actions">'
          + '    <button class="btn ghost" type="button" data-action="up">上移</button>'
          + '    <button class="btn ghost" type="button" data-action="down">下移</button>'
          + '    <button class="btn danger" type="button" data-action="delete">删除</button>'
          + '  </div>'
          + '</div>'
          + '<div class="grid">'
          + '  <div><label>规则 ID</label><input data-field="id" value="' + escapeHtmlClient(rule.id) + '"></div>'
          + '  <div><label>名称</label><input data-field="name" value="' + escapeHtmlClient(rule.name) + '"></div>'
          + '  <div><label>优先级</label><input data-field="priority" type="number" value="' + rule.priority + '"></div>'
          + '  <div><label>启用</label><select data-field="enabled"><option value="true"' + (rule.enabled ? ' selected' : '') + '>true</option><option value="false"' + (!rule.enabled ? ' selected' : '') + '>false</option></select></div>'
          + '  <div><label>Regex Pattern</label><input data-field="pattern" value="' + escapeHtmlClient(rule.match.pattern) + '"></div>'
          + '  <div><label>Regex Flags</label><input data-field="flags" value="' + escapeHtmlClient(rule.match.flags) + '" placeholder="例如 i"></div>'
          + '  <div><label>Target Origin</label><input data-field="origin" value="' + escapeHtmlClient(rule.target.origin) + '"></div>'
          + '  <div><label>Path Template</label><input data-field="pathTemplate" value="' + escapeHtmlClient(rule.target.pathTemplate) + '"></div>'
          + '  <div><label>转发客户端 Header</label><select data-field="forwardClientHeaders"><option value="true"' + (rule.headers.forwardClientHeaders ? ' selected' : '') + '>true</option><option value="false"' + (!rule.headers.forwardClientHeaders ? ' selected' : '') + '>false</option></select></div>'
          + '</div>'
          + '<div class="grid" style="margin-top:12px">'
          + '  <div><label>覆盖 Header（每行 Name: Value）</label><textarea data-field="headersSet">' + escapeHtmlClient(headersSetToText(rule.headers.set)) + '</textarea></div>'
          + '  <div><label>删除 Header（每行一个）</label><textarea data-field="headersRemove">' + escapeHtmlClient(headersRemoveToText(rule.headers.remove)) + '</textarea></div>'
          + '</div>';
        card.querySelectorAll('[data-field]').forEach(el => {
          el.addEventListener('input', () => updateRuleFromCard(index, card));
          el.addEventListener('change', () => updateRuleFromCard(index, card));
        });
        card.querySelector('[data-action="delete"]').addEventListener('click', () => {
          rules.splice(index, 1);
          renderRules();
        });
        card.querySelector('[data-action="up"]').addEventListener('click', () => {
          if (index === 0) return;
          [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
          renderRules();
        });
        card.querySelector('[data-action="down"]').addEventListener('click', () => {
          if (index >= rules.length - 1) return;
          [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
          renderRules();
        });
        ruleList.appendChild(card);
      });
      syncJsonEditors();
    }

    function updateRuleFromCard(index, card) {
      rules[index] = {
        id: card.querySelector('[data-field="id"]').value.trim(),
        name: card.querySelector('[data-field="name"]').value.trim(),
        enabled: card.querySelector('[data-field="enabled"]').value === 'true',
        priority: Number(card.querySelector('[data-field="priority"]').value || 100),
        match: {
          pattern: card.querySelector('[data-field="pattern"]').value,
          flags: card.querySelector('[data-field="flags"]').value
        },
        target: {
          origin: card.querySelector('[data-field="origin"]').value.trim(),
          pathTemplate: card.querySelector('[data-field="pathTemplate"]').value
        },
        headers: {
          forwardClientHeaders: card.querySelector('[data-field="forwardClientHeaders"]').value === 'true',
          set: parseHeadersSetText(card.querySelector('[data-field="headersSet"]').value),
          remove: parseHeadersRemoveText(card.querySelector('[data-field="headersRemove"]').value)
        }
      };
      syncJsonEditors();
    }

    addRuleBtn?.addEventListener('click', () => {
      rules.push(defaultRuleFactory());
      renderRules();
    });

    addGhPresetBtn?.addEventListener('click', () => {
      const existingIndex = rules.findIndex(rule => rule.id === presetRule.id || rule.name === presetRule.name);
      if (existingIndex >= 0) {
        rules[existingIndex] = structuredClone(presetRule);
      } else {
        rules.push(structuredClone(presetRule));
      }
      renderRules();
    });

    rulesJsonEditor?.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(rulesJsonEditor.value);
        rules = Array.isArray(parsed) ? parsed : [];
        renderRules();
      } catch (error) {
        alert('规则 JSON 解析失败：' + error.message);
      }
    });

    form?.addEventListener('submit', () => {
      syncJsonEditors();
    });

    runTestBtn?.addEventListener('click', async () => {
      const path = testPathInput.value.trim() || '/';
      testResult.textContent = 'Testing...';
      try {
        const response = await fetch('/api/admin/test-match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path })
        });
        const data = await response.json();
        testResult.textContent = JSON.stringify(data, null, 2);
      } catch (error) {
        testResult.textContent = JSON.stringify({ ok: false, error: error.message || 'Test failed' }, null, 2);
      }
    });

    renderRules();
  </script>
</body>
</html>`;
}

async function parseAdminConfigFromForm(request) {
  const form = await request.formData();
  let rules = [];
  const rawRulesJson = String(form.get('rulesJson') || '[]');
  try {
    rules = JSON.parse(rawRulesJson);
  } catch (error) {
    throw new Error(`rulesJson 不是合法 JSON：${error.message}`);
  }

  return {
    version: 1,
    global: {
      noMatchStatus: Number(form.get('noMatchStatus') || DEFAULT_CONFIG.global.noMatchStatus),
      maxRedirects: Number(form.get('maxRedirects') || DEFAULT_CONFIG.global.maxRedirects),
      followRedirects: String(form.get('followRedirects') || 'true') === 'true'
    },
    rules
  };
}

async function parseAdminConfigFromJson(request) {
  const body = await request.json();
  return {
    version: 1,
    global: body?.global || {},
    rules: body?.rules || []
  };
}

async function handleAdminRoutes(request, env, pathname) {
  const url = new URL(request.url);
  const kvBound = Boolean(getConfigKV(env));

  if (pathname === '/login') {
    if (!env?.ADMIN) {
      return htmlResponse(renderLoginPage('未设置环境变量 ADMIN，后台登录不可用。'), { status: 500 });
    }
    if (request.method === 'GET') {
      if (await verifySession(request, env)) {
        return redirectResponse('/admin');
      }
      return htmlResponse(renderLoginPage());
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const password = String(form.get('password') || '');
      if (password !== env.ADMIN) {
        return htmlResponse(renderLoginPage('密码错误'), { status: 401 });
      }
      const token = await createSessionToken(env.ADMIN);
      return redirectResponse('/admin', {
        'Set-Cookie': `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
      });
    }
    return new Response('Method Not Allowed\n', { status: 405 });
  }

  if (pathname === '/logout') {
    return redirectResponse('/login', {
      'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    });
  }

  if (!(await verifySession(request, env))) {
    if (pathname.startsWith('/api/admin/')) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }
    return redirectResponse('/login');
  }

  if (pathname === '/admin') {
    const config = await getConfig(env);
    if (request.method === 'GET') {
      return htmlResponse(renderAdminPage(config, {
        saved: url.searchParams.get('saved') === '1',
        kvBound
      }));
    }
    if (request.method === 'POST') {
      try {
        const nextConfig = await parseAdminConfigFromForm(request);
        const savedConfig = await saveConfig(env, nextConfig);
        return htmlResponse(renderAdminPage(savedConfig, { saved: true, kvBound }));
      } catch (error) {
        const fallbackConfig = await getConfig(env);
        return htmlResponse(renderAdminPage(fallbackConfig, {
          error: error.message || '保存失败',
          kvBound
        }), { status: 400 });
      }
    }
    return new Response('Method Not Allowed\n', { status: 405 });
  }

  if (pathname === '/api/admin/config') {
    if (request.method === 'GET') {
      const config = await getConfig(env);
      return jsonResponse(config);
    }
    if (request.method === 'POST') {
      try {
        const nextConfig = await parseAdminConfigFromJson(request);
        const savedConfig = await saveConfig(env, nextConfig);
        return jsonResponse({ ok: true, config: savedConfig });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message || '保存失败' }, { status: 400 });
      }
    }
    return new Response('Method Not Allowed\n', { status: 405 });
  }

  if (pathname === '/api/admin/test-match') {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed\n', { status: 405 });
    }
    try {
      const body = await request.json();
      const path = String(body?.path || '/').trim() || '/';
      const config = await getConfig(env);
      return jsonResponse(previewRuleMatch(path, config, url.origin));
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message || '测试失败' }, { status: 400 });
    }
  }

  return new Response('Not Found\n', { status: 404 });
}

function sortRules(rules) {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}

function matchRule(pathname, config) {
  for (const rule of sortRules(config.rules).filter(rule => rule.enabled)) {
    const regex = new RegExp(rule.match.pattern, rule.match.flags);
    const match = pathname.match(regex);
    if (match) {
      return { rule, match, regex };
    }
  }
  return null;
}

function buildUpstreamUrl(requestUrl, rule) {
  const inbound = new URL(requestUrl);
  const regex = new RegExp(rule.match.pattern, rule.match.flags);
  const rewrittenPath = inbound.pathname.replace(regex, rule.target.pathTemplate);
  const upstream = new URL(rule.target.origin);
  upstream.pathname = rewrittenPath;
  upstream.search = inbound.search;
  return upstream.toString();
}

function previewRuleMatch(pathOrUrl, config, origin = 'https://preview.local') {
  const previewUrl = new URL(pathOrUrl, origin);
  const pathname = previewUrl.pathname;

  if (isReservedRoute(pathname)) {
    return {
      ok: true,
      reserved: true,
      pathname,
      message: '该路径属于系统保留路由，不参与普通代理匹配。'
    };
  }

  const matched = matchRule(pathname, config);
  if (!matched) {
    return {
      ok: true,
      reserved: false,
      pathname,
      matched: false,
      noMatchStatus: config.global.noMatchStatus,
      message: '没有命中任何启用规则。'
    };
  }

  const requestUrl = new URL(previewUrl.pathname + previewUrl.search, origin).toString();
  const targetUrl = buildUpstreamUrl(requestUrl, matched.rule);
  const previewHeaders = Object.fromEntries(
    sanitizeRequestHeaders(new Request(requestUrl), targetUrl, matched.rule).entries()
  );

  return {
    ok: true,
    reserved: false,
    matched: true,
    pathname,
    rule: {
      id: matched.rule.id,
      name: matched.rule.name,
      priority: matched.rule.priority,
      pattern: matched.rule.match.pattern,
      flags: matched.rule.match.flags
    },
    upstreamUrl: targetUrl,
    requestHeadersPreview: previewHeaders
  };
}

function canHaveBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

async function getReusableBody(request) {
  if (!canHaveBody(request.method) || !request.body) {
    return undefined;
  }
  return await request.clone().arrayBuffer();
}

function sanitizeRequestHeaders(request, targetUrl, rule) {
  const target = new URL(targetUrl);
  const headers = new Headers();
  const sourceHeaders = rule.headers.forwardClientHeaders ? request.headers : new Headers();

  for (const [key, value] of sourceHeaders.entries()) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  for (const headerName of rule.headers.remove) {
    headers.delete(headerName);
  }

  headers.set('Host', target.host);
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', new URL(request.url).protocol.replace(':', ''));

  const clientIp = request.headers.get('CF-Connecting-IP');
  const previousForwardedFor = request.headers.get('X-Forwarded-For');
  const nextForwardedFor = [previousForwardedFor, clientIp].filter(Boolean).join(', ');
  if (nextForwardedFor) {
    headers.set('X-Forwarded-For', nextForwardedFor);
  }
  if (clientIp) {
    headers.set('X-Real-IP', clientIp);
  }

  for (const [key, value] of Object.entries(rule.headers.set)) {
    headers.set(key, value);
  }

  return headers;
}

async function proxyFetch(targetUrl, init, maxRedirects) {
  let currentUrl = targetUrl;
  let currentInit = { ...init };

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, {
      ...currentInit,
      redirect: 'manual'
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get('Location');
    if (!location || i === maxRedirects) {
      return response;
    }

    const nextUrl = new URL(location, currentUrl).toString();
    const nextHeaders = new Headers(currentInit.headers || {});
    nextHeaders.set('Host', new URL(nextUrl).host);

    let nextMethod = currentInit.method || 'GET';
    let nextBody = currentInit.body;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && canHaveBody(nextMethod))) {
      nextMethod = 'GET';
      nextBody = undefined;
      nextHeaders.delete('Content-Type');
      nextHeaders.delete('Content-Length');
    }

    currentUrl = nextUrl;
    currentInit = {
      ...currentInit,
      method: nextMethod,
      body: nextBody,
      headers: nextHeaders
    };
  }

  return new Response('Too many redirects\n', { status: 508 });
}

async function handleProxyRequest(request, env) {
  const config = await getConfig(env);
  const pathname = new URL(request.url).pathname;
  const matched = matchRule(pathname, config);

  if (!matched) {
    return new Response(`No proxy rule matched: ${pathname}\n`, { status: config.global.noMatchStatus });
  }

  const targetUrl = buildUpstreamUrl(request.url, matched.rule);
  const headers = sanitizeRequestHeaders(request, targetUrl, matched.rule);
  const body = await getReusableBody(request);

  const init = {
    method: request.method,
    headers,
    body,
    cf: { scrapeShield: false }
  };

  const upstreamResponse = config.global.followRedirects
    ? await proxyFetch(targetUrl, init, config.global.maxRedirects)
    : await fetch(targetUrl, { ...init, redirect: 'manual' });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('X-Proxy-Rule-Id', matched.rule.id);
  responseHeaders.set('X-Proxy-Rule-Name', matched.rule.name);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cloudflare Worker Proxy</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#020617;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
    .card{max-width:760px;background:#0f172a;border:1px solid #1e293b;border-radius:18px;padding:28px}
    code{background:#1e293b;padding:2px 6px;border-radius:6px}
    a{color:#93c5fd}
  </style>
</head>
<body>
  <div class="card">
    <h1>Cloudflare Worker Proxy</h1>
    <p>这是一个基于 Cloudflare Workers + KV 的带后台规则代理。管理员访问 <code>/login</code> 登录，再到 <code>/admin</code> 配置 path regex、upstream 和请求头策略。</p>
    <p>系统保留路由：<code>/login</code>、<code>/logout</code>、<code>/admin</code>、<code>/api/admin/*</code>。</p>
    <p><a href="/login">进入后台</a></p>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return htmlResponse(renderHomePage());
    }

    if (url.pathname === '/favicon.ico') {
      return new Response('', { status: 204 });
    }

    if (isReservedRoute(url.pathname)) {
      return handleAdminRoutes(request, env, url.pathname);
    }

    return handleProxyRequest(request, env);
  }
};
