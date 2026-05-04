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


function escapeScriptJson(value = '') {
  return String(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
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

function renderAdminClientScript() {
  return String.raw`<script>
(function () {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const readJson = (id, fallback) => {
    const node = document.getElementById(id);
    if (!node) return fallback;
    try { return JSON.parse(node.textContent || ''); } catch { return fallback; }
  };

  const presetRule = readJson('presetRuleData', {});
  const defaultRule = readJson('defaultRuleData', {});
  const initialRules = readJson('initialRulesData', []);
  const state = {
    rules: Array.isArray(initialRules) ? clone(initialRules) : []
  };

  const ruleList = $('#ruleList');
  const emptyState = $('#emptyState');
  const rulesJsonEditor = $('#rulesJsonEditor');
  const rulesJsonHidden = $('#rulesJsonHidden');
  const form = $('#configForm');
  const addRuleBtn = $('#addRuleBtn');
  const addGhPresetBtn = $('#addGhPresetBtn');
  const runTestBtn = $('#runTestBtn');
  const testPathInput = $('#testPath');
  const testResult = $('#testResult');
  const ruleCount = $('#ruleCount');
  const enabledCount = $('#enabledCount');

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

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
    const json = JSON.stringify(state.rules, null, 2);
    if (rulesJsonEditor) rulesJsonEditor.value = json;
    if (rulesJsonHidden) rulesJsonHidden.value = json;
    if (ruleCount) ruleCount.textContent = String(state.rules.length);
    if (enabledCount) enabledCount.textContent = String(state.rules.filter(rule => rule.enabled !== false).length);
  }

  function updateRuleFromCard(index, card) {
    state.rules[index] = {
      id: $('[data-field="id"]', card).value.trim(),
      name: $('[data-field="name"]', card).value.trim(),
      enabled: $('[data-field="enabled"]', card).checked,
      priority: Number($('[data-field="priority"]', card).value || 100),
      match: {
        pattern: $('[data-field="pattern"]', card).value,
        flags: $('[data-field="flags"]', card).value
      },
      target: {
        origin: $('[data-field="origin"]', card).value.trim(),
        pathTemplate: $('[data-field="pathTemplate"]', card).value
      },
      headers: {
        forwardClientHeaders: $('[data-field="forwardClientHeaders"]', card).checked,
        set: parseHeadersSetText($('[data-field="headersSet"]', card).value),
        remove: parseHeadersRemoveText($('[data-field="headersRemove"]', card).value)
      }
    };
    syncJsonEditors();
  }

  function renderRules() {
    if (!ruleList) return;
    ruleList.innerHTML = '';
    if (emptyState) emptyState.hidden = state.rules.length > 0;

    state.rules.forEach((rawRule, index) => {
      const rule = ensureRuleShape(rawRule, index);
      state.rules[index] = rule;
      const card = document.createElement('article');
      card.className = 'rule-card';
      card.innerHTML = ''
        + '<div class="rule-head">'
        + '  <div class="rule-title"><span class="rule-index">#' + (index + 1) + '</span><div><strong>' + escapeHtml(rule.name) + '</strong><small>' + escapeHtml(rule.id) + '</small></div></div>'
        + '  <div class="rule-actions">'
        + '    <span class="pill ' + (rule.enabled ? 'ok' : 'off') + '">' + (rule.enabled ? 'Enabled' : 'Disabled') + '</span>'
        + '    <button class="btn ghost" type="button" data-action="up">上移</button>'
        + '    <button class="btn ghost" type="button" data-action="down">下移</button>'
        + '    <button class="btn danger" type="button" data-action="delete">删除</button>'
        + '  </div>'
        + '</div>'
        + '<div class="form-grid">'
        + '  <label><span>规则 ID</span><input data-field="id" value="' + escapeHtml(rule.id) + '"></label>'
        + '  <label><span>名称</span><input data-field="name" value="' + escapeHtml(rule.name) + '"></label>'
        + '  <label><span>优先级</span><input data-field="priority" type="number" value="' + rule.priority + '"></label>'
        + '  <label class="switch-row"><span>启用</span><input data-field="enabled" type="checkbox" ' + (rule.enabled ? 'checked' : '') + '></label>'
        + '  <label><span>Path Regex</span><input data-field="pattern" value="' + escapeHtml(rule.match.pattern) + '"></label>'
        + '  <label><span>Regex Flags</span><input data-field="flags" value="' + escapeHtml(rule.match.flags) + '" placeholder="i"></label>'
        + '  <label><span>Target Origin</span><input data-field="origin" value="' + escapeHtml(rule.target.origin) + '"></label>'
        + '  <label><span>Path Template</span><input data-field="pathTemplate" value="' + escapeHtml(rule.target.pathTemplate) + '"></label>'
        + '  <label class="switch-row"><span>转发客户端 Header</span><input data-field="forwardClientHeaders" type="checkbox" ' + (rule.headers.forwardClientHeaders ? 'checked' : '') + '></label>'
        + '</div>'
        + '<div class="form-grid two" style="margin-top:14px">'
        + '  <label><span>覆盖 Header</span><textarea data-field="headersSet" placeholder="X-Token: value">' + escapeHtml(headersSetToText(rule.headers.set)) + '</textarea></label>'
        + '  <label><span>删除 Header</span><textarea data-field="headersRemove" placeholder="Cookie&#10;Authorization">' + escapeHtml(headersRemoveToText(rule.headers.remove)) + '</textarea></label>'
        + '</div>';

      $$('[data-field]', card).forEach(el => {
        el.addEventListener('input', () => updateRuleFromCard(index, card));
        el.addEventListener('change', () => updateRuleFromCard(index, card));
      });
      $('[data-action="delete"]', card).addEventListener('click', () => {
        state.rules.splice(index, 1);
        renderRules();
      });
      $('[data-action="up"]', card).addEventListener('click', () => {
        if (index === 0) return;
        [state.rules[index - 1], state.rules[index]] = [state.rules[index], state.rules[index - 1]];
        renderRules();
      });
      $('[data-action="down"]', card).addEventListener('click', () => {
        if (index >= state.rules.length - 1) return;
        [state.rules[index + 1], state.rules[index]] = [state.rules[index], state.rules[index + 1]];
        renderRules();
      });
      ruleList.appendChild(card);
    });
    syncJsonEditors();
  }

  addRuleBtn?.addEventListener('click', () => {
    const next = clone(defaultRule);
    next.id = 'rule-' + (state.rules.length + 1);
    next.name = 'New Proxy Rule';
    state.rules.push(next);
    renderRules();
  });

  addGhPresetBtn?.addEventListener('click', () => {
    const existingIndex = state.rules.findIndex(rule => rule.id === presetRule.id || rule.name === presetRule.name);
    if (existingIndex >= 0) state.rules[existingIndex] = clone(presetRule);
    else state.rules.push(clone(presetRule));
    renderRules();
    if (testPathInput) testPathInput.value = '/gh/robots.txt';
  });

  rulesJsonEditor?.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(rulesJsonEditor.value);
      state.rules = Array.isArray(parsed) ? parsed : [];
      renderRules();
    } catch (error) {
      alert('规则 JSON 解析失败：' + error.message);
    }
  });

  form?.addEventListener('submit', () => syncJsonEditors());

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
})();
</script>`;
}

function renderAdminPage(config, options = {}) {
  const ruleJson = JSON.stringify(config.rules, null, 2);
  const previewPath = escapeHtml(options.previewPath || '/gh/robots.txt');
  const initialRulesJson = escapeScriptJson(JSON.stringify(config.rules || []));
  const presetRuleJson = escapeScriptJson(JSON.stringify(githubPresetRule()));
  const defaultRuleJson = escapeScriptJson(JSON.stringify(defaultRule()));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Proxy Console</title>
  <style>
    :root{--bg:#f3f6fb;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#2563eb;--brand2:#7c3aed;--danger:#dc2626;--ok:#16a34a;--shadow:0 20px 50px rgba(15,23,42,.08)}
    *{box-sizing:border-box} body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
    .hero{background:radial-gradient(circle at 12% 20%,rgba(96,165,250,.32),transparent 28%),linear-gradient(135deg,#07111f,#111827 45%,#1d2560);color:#fff;padding:28px 22px 96px}
    .shell{max-width:1180px;margin:0 auto}.nav{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.02em}.logo{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,#60a5fa,#a78bfa);display:grid;place-items:center;box-shadow:0 12px 28px rgba(96,165,250,.35)}
    .nav-actions{display:flex;gap:10px;flex-wrap:wrap}.hero-main{display:grid;grid-template-columns:1.2fr .8fr;gap:28px;align-items:end;margin-top:38px}.eyebrow{color:#bfdbfe;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.18em}.hero h1{font-size:clamp(34px,6vw,64px);line-height:.95;margin:12px 0 16px;letter-spacing:-.06em}.hero p{margin:0;color:#cbd5e1;max-width:660px;font-size:17px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-radius:20px;padding:18px;backdrop-filter:blur(14px)}.stat strong{display:block;font-size:30px}.stat span{color:#cbd5e1;font-size:13px}
    main.shell{margin-top:-68px;padding:0 22px 40px}.panel{background:var(--card);border:1px solid var(--line);border-radius:26px;box-shadow:var(--shadow);overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fff,#f8fafc)}.panel-title h2{margin:0;font-size:20px}.panel-title p{margin:4px 0 0;color:var(--muted);font-size:14px}.panel-body{padding:22px 24px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.btn{appearance:none;border:0;border-radius:13px;padding:10px 14px;font-weight:750;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;background:var(--brand);color:#fff;box-shadow:0 8px 20px rgba(37,99,235,.2)}.btn.secondary{background:#334155}.btn.ghost{background:#eef2ff;color:#1e293b;box-shadow:none}.btn.danger{background:var(--danger)}.btn:hover{filter:brightness(.97)}
    .notice{margin:16px 0 0;padding:12px 14px;border-radius:16px;font-weight:650}.notice.ok{background:#ecfdf5;color:#166534}.notice.err{background:#fef2f2;color:#991b1b}.notice.warn{background:#fffbeb;color:#92400e}
    label span{display:block;color:#334155;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}input,select,textarea{width:100%;border:1px solid #dbe3ef;border-radius:14px;padding:11px 12px;font:inherit;background:#fff;color:var(--ink);outline:none}input:focus,select:focus,textarea:focus{border-color:#93c5fd;box-shadow:0 0 0 4px rgba(147,197,253,.25)}textarea{min-height:104px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.form-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.form-grid.two{grid-template-columns:1fr 1fr}.switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #dbe3ef;border-radius:14px;padding:11px 12px}.switch-row span{margin:0}.switch-row input{width:auto;transform:scale(1.15)}
    .rule-list{display:grid;gap:16px}.rule-card{border:1px solid #dbeafe;border-radius:22px;padding:18px;background:linear-gradient(180deg,#fff,#f8fbff)}.rule-head{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-bottom:16px}.rule-title{display:flex;align-items:center;gap:12px}.rule-title strong{display:block}.rule-title small{display:block;color:var(--muted);margin-top:3px}.rule-index{width:36px;height:36px;border-radius:12px;background:#dbeafe;color:#1d4ed8;display:grid;place-items:center;font-weight:800}.rule-actions{display:flex;gap:8px;flex-wrap:wrap}.pill{border-radius:999px;padding:7px 10px;font-size:12px;font-weight:800}.pill.ok{background:#dcfce7;color:#166534}.pill.off{background:#fee2e2;color:#991b1b}
    .empty{border:1px dashed #cbd5e1;border-radius:20px;padding:28px;text-align:center;color:var(--muted);background:#f8fafc}.subgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.codebox{background:#0f172a;color:#dbeafe;border-radius:18px;padding:16px;min-height:140px;white-space:pre-wrap;word-break:break-word;overflow:auto}.json-details{margin-top:16px}.json-details summary{cursor:pointer;font-weight:800;color:#334155}.json-details textarea{margin-top:12px;min-height:160px}.top-section{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}.metric{border:1px solid var(--line);border-radius:18px;padding:16px;background:#fff}.metric b{display:block;font-size:28px}.metric span{color:var(--muted);font-size:13px}
    @media(max-width:900px){.hero-main,.subgrid{grid-template-columns:1fr}.stats,.top-section{grid-template-columns:1fr}.form-grid,.form-grid.two{grid-template-columns:1fr}.rule-head{align-items:flex-start;flex-direction:column}.panel-head{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <section class="hero">
    <div class="shell">
      <div class="nav">
        <div class="brand"><div class="logo">↯</div><div>Proxy Console</div></div>
        <div class="nav-actions"><a class="btn secondary" href="/api/admin/config">JSON</a><a class="btn ghost" href="/logout">退出</a></div>
      </div>
      <div class="hero-main">
        <div><div class="eyebrow">Cloudflare Worker Reverse Proxy</div><h1>Rules. Headers. Upstreams.</h1><p>以规则驱动的 Worker 代理控制台，面向线上部署和快速变更。</p></div>
        <div class="stats"><div class="stat"><strong id="ruleCount">${config.rules.length}</strong><span>Rules</span></div><div class="stat"><strong id="enabledCount">${config.rules.filter(rule => rule.enabled !== false).length}</strong><span>Enabled</span></div><div class="stat"><strong>${escapeHtml(config.global.noMatchStatus)}</strong><span>No match</span></div></div>
      </div>
    </div>
  </section>

  <main class="shell">
    <div class="panel">
      <div class="panel-head"><div class="panel-title"><h2>Routing Control</h2><p>KV key: <code>${CONFIG_KV_KEY}</code> · ${escapeHtml(config.updatedAt || 'not saved')}</p></div><div class="toolbar"><button class="btn" type="button" id="addRuleBtn">新增规则</button><button class="btn secondary" type="button" id="addGhPresetBtn">添加 /gh</button></div></div>
      <div class="panel-body">
        ${options.saved ? '<div class="notice ok">配置已保存</div>' : ''}
        ${options.error ? `<div class="notice err">${escapeHtml(options.error)}</div>` : ''}
        ${options.kvBound ? '' : '<div class="notice warn">KV 未绑定，保存会失败</div>'}

        <form method="POST" action="/admin" id="configForm">
          <div class="top-section">
            <label class="metric"><span>No Match</span><select id="noMatchStatus" name="noMatchStatus"><option value="404" ${config.global.noMatchStatus === 404 ? 'selected' : ''}>404 Not Found</option><option value="403" ${config.global.noMatchStatus === 403 ? 'selected' : ''}>403 Forbidden</option></select></label>
            <label class="metric"><span>Max Redirects</span><input id="maxRedirects" name="maxRedirects" type="number" min="0" max="10" value="${config.global.maxRedirects}" /></label>
            <label class="metric"><span>Follow Redirects</span><select id="followRedirects" name="followRedirects"><option value="true" ${config.global.followRedirects ? 'selected' : ''}>Enabled</option><option value="false" ${!config.global.followRedirects ? 'selected' : ''}>Disabled</option></select></label>
          </div>

          <div id="emptyState" class="empty" ${config.rules.length ? 'hidden' : ''}>暂无规则，点击右上角新增或添加 /gh 预置。</div>
          <div id="ruleList" class="rule-list"></div>
          <details class="json-details"><summary>底层 JSON</summary><textarea id="rulesJsonEditor" spellcheck="false">${escapeHtml(ruleJson)}</textarea></details>
          <textarea id="rulesJsonHidden" name="rulesJson" hidden>${escapeHtml(ruleJson)}</textarea>
          <div class="toolbar" style="margin-top:18px"><button class="btn" type="submit">保存配置</button></div>
        </form>
      </div>
    </div>

    <div class="subgrid">
      <section class="panel"><div class="panel-head"><div class="panel-title"><h2>Match Preview</h2><p>预览命中规则，不触发真实转发</p></div></div><div class="panel-body"><label><span>Test Path</span><input id="testPath" value="${previewPath}" placeholder="/gh/robots.txt" /></label><button class="btn" id="runTestBtn" type="button" style="margin-top:12px">测试匹配</button><pre id="testResult" class="codebox" style="margin-top:14px">Ready</pre></div></section>
      <section class="panel"><div class="panel-head"><div class="panel-title"><h2>Preset</h2><p>/gh → GitHub</p></div></div><div class="panel-body"><pre class="codebox">${escapeHtml(JSON.stringify(githubPresetRule(), null, 2))}</pre></div></section>
    </div>
  </main>

  <script type="application/json" id="initialRulesData">${initialRulesJson}</script>
  <script type="application/json" id="presetRuleData">${presetRuleJson}</script>
  <script type="application/json" id="defaultRuleData">${defaultRuleJson}</script>
  ${renderAdminClientScript()}
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
    :root{--ink:#0f172a;--muted:#64748b;--brand:#2563eb;--line:#e2e8f0}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:#f8fafc}.hero{min-height:100vh;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 15% 12%,rgba(96,165,250,.32),transparent 30%),radial-gradient(circle at 85% 10%,rgba(167,139,250,.28),transparent 30%),linear-gradient(135deg,#eff6ff,#fff)}.card{width:min(980px,100%);background:rgba(255,255,255,.82);border:1px solid rgba(226,232,240,.9);border-radius:32px;box-shadow:0 28px 80px rgba(15,23,42,.12);padding:48px;backdrop-filter:blur(18px)}.badge{display:inline-flex;gap:8px;align-items:center;border:1px solid #bfdbfe;color:#1d4ed8;background:#eff6ff;border-radius:999px;padding:8px 12px;font-weight:800;font-size:13px}.title{font-size:clamp(42px,7vw,86px);line-height:.92;letter-spacing:-.07em;margin:22px 0 18px}.lead{font-size:19px;line-height:1.7;color:var(--muted);max-width:720px;margin:0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}.btn{border:0;border-radius:14px;padding:13px 18px;text-decoration:none;font-weight:850;display:inline-flex;align-items:center;gap:8px}.btn.primary{background:var(--brand);color:#fff;box-shadow:0 14px 30px rgba(37,99,235,.24)}.btn.secondary{background:#0f172a;color:#fff}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:36px}.item{border:1px solid var(--line);border-radius:22px;background:#fff;padding:20px}.item b{display:block;margin-bottom:8px}.item span{color:var(--muted);font-size:14px;line-height:1.6}@media(max-width:760px){.card{padding:28px}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <section class="hero">
    <div class="card">
      <div class="badge">↯ Worker Proxy</div>
      <h1 class="title">Edge proxy control for real traffic.</h1>
      <p class="lead">基于 Cloudflare Workers 和 KV 的规则代理后台，支持路径正则、上游地址、Header 覆盖和在线匹配预览。</p>
      <div class="actions"><a class="btn primary" href="/login">进入后台</a><a class="btn secondary" href="/gh">测试 /gh</a></div>
      <div class="grid"><div class="item"><b>Regex Routing</b><span>按 path 正则命中第一条启用规则。</span></div><div class="item"><b>KV Config</b><span>后台配置保存到 Cloudflare KV。</span></div><div class="item"><b>Header Control</b><span>支持请求头转发、删除与覆盖。</span></div></div>
    </div>
  </section>
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
