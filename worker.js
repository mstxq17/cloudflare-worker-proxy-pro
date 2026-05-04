const CONFIG_KV_KEY = 'proxy:settings';
const SESSION_COOKIE_NAME = '__proxy_admin_session';
const SESSION_MAX_AGE = 60 * 60 * 12;
const DEFAULT_MAIN_DOMAIN = 'rad0.indevs.in';
const DEFAULT_ADMIN_SUBDOMAIN = 'admin';
const DEFAULT_LANDING_SUBDOMAIN = 'proxy';

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
  version: 3,
  updatedAt: null,
  global: {
    noMatchStatus: 404,
    followRedirects: true,
    maxRedirects: 5
  },
  routes: []
});

function getConfigKV(env) {
  return env?.CONFIG_KV || env?.CF_ACCEL_KV || env?.ACCEL_KV || env?.KV || null;
}

function normalizeHostname(value = '') {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function getRuntime(env) {
  const mainDomain = normalizeHostname(env?.MAIN_DOMAIN || DEFAULT_MAIN_DOMAIN);
  const adminSubdomain = normalizeHostname(env?.ADMIN_SUBDOMAIN || DEFAULT_ADMIN_SUBDOMAIN);
  const landingSubdomain = normalizeHostname(env?.LANDING_SUBDOMAIN || DEFAULT_LANDING_SUBDOMAIN);
  return {
    mainDomain,
    adminSubdomain,
    landingSubdomain,
    adminHost: `${adminSubdomain}.${mainDomain}`,
    landingHost: `${landingSubdomain}.${mainDomain}`
  };
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
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { ...init, headers });
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload, null, 2), { ...init, headers });
}

function redirectResponse(location, headers = {}) {
  const nextHeaders = new Headers(headers);
  nextHeaders.set('Location', location);
  return new Response(null, { status: 302, headers: nextHeaders });
}

function githubPresetRoute() {
  return {
    id: 'gh',
    name: 'GitHub',
    enabled: true,
    subdomain: 'gh',
    origin: 'https://github.com',
    preservePath: true,
    headers: {
      forwardClientHeaders: true,
      set: {},
      remove: []
    }
  };
}

function defaultRoute(index = 0) {
  return {
    id: `route-${index + 1}`,
    name: `Route ${index + 1}`,
    enabled: true,
    subdomain: `app-${index + 1}`,
    origin: 'https://example.com',
    preservePath: true,
    headers: {
      forwardClientHeaders: true,
      set: {},
      remove: []
    }
  };
}

function normalizeHeadersMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key || '').trim();
    if (name) out[name] = String(value ?? '');
  }
  return out;
}

function normalizeHeaderRemoveList(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizeRoute(route = {}, index = 0) {
  const base = defaultRoute(index);
  return {
    id: String(route.id || base.id).trim(),
    name: String(route.name || base.name).trim(),
    enabled: route.enabled !== false,
    subdomain: normalizeHostname(route.subdomain || base.subdomain),
    hostname: normalizeHostname(route.hostname || ''),
    origin: String(route.origin || base.origin).trim(),
    preservePath: route.preservePath !== false,
    headers: {
      forwardClientHeaders: route?.headers?.forwardClientHeaders !== false,
      set: normalizeHeadersMap(route?.headers?.set),
      remove: normalizeHeaderRemoveList(route?.headers?.remove)
    }
  };
}

function normalizeConfig(input = {}) {
  if (!input || input.version !== 3 || !Array.isArray(input.routes)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const global = input.global || {};
  return {
    version: 3,
    updatedAt: input.updatedAt || null,
    global: {
      noMatchStatus: [403, 404].includes(Number(global.noMatchStatus)) ? Number(global.noMatchStatus) : DEFAULT_CONFIG.global.noMatchStatus,
      followRedirects: global.followRedirects !== false,
      maxRedirects: Number.isFinite(Number(global.maxRedirects)) ? Math.max(0, Math.min(10, Number(global.maxRedirects))) : DEFAULT_CONFIG.global.maxRedirects
    },
    routes: input.routes.map((route, index) => normalizeRoute(route, index))
  };
}

function validateHeaderName(name) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function validateSubdomain(subdomain) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain);
}

function validateRoute(route, index, runtime) {
  const label = `Route #${index + 1}`;
  if (!route.id) throw new Error(`${label} 缺少 ID`);
  if (!route.name) throw new Error(`${label} 缺少名称`);
  if (!validateSubdomain(route.subdomain)) throw new Error(`${label} 子域名无效：${route.subdomain}`);
  if ([runtime.adminSubdomain, runtime.landingSubdomain].includes(route.subdomain)) {
    throw new Error(`${label} 子域名 ${route.subdomain} 是系统保留名称`);
  }
  try {
    const origin = new URL(route.origin);
    if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('protocol');
  } catch {
    throw new Error(`${label} upstream 仅支持 http:// 或 https://`);
  }
  for (const [headerName] of Object.entries(route.headers.set)) {
    if (!validateHeaderName(headerName)) throw new Error(`${label} 覆盖 Header 名无效：${headerName}`);
  }
  for (const headerName of route.headers.remove) {
    if (!validateHeaderName(headerName)) throw new Error(`${label} 删除 Header 名无效：${headerName}`);
  }
}

function validateConfig(config, runtime) {
  const normalized = normalizeConfig({ ...config, version: 3 });
  normalized.routes.forEach((route, index) => validateRoute(route, index, runtime));
  return normalized;
}

async function getConfig(env) {
  const kv = getConfigKV(env);
  if (!kv) return structuredClone(DEFAULT_CONFIG);
  try {
    const stored = await kv.get(CONFIG_KV_KEY, 'json');
    return normalizeConfig(stored || DEFAULT_CONFIG);
  } catch (error) {
    console.log(`Failed to read KV config: ${error.message}`);
    return structuredClone(DEFAULT_CONFIG);
  }
}

async function saveConfig(env, config, runtime) {
  const kv = getConfigKV(env);
  if (!kv) throw new Error('KV 未绑定，请绑定 CONFIG_KV / CF_ACCEL_KV / ACCEL_KV / KV');
  const normalized = validateConfig(config, runtime);
  normalized.updatedAt = new Date().toISOString();
  await kv.put(CONFIG_KV_KEY, JSON.stringify(normalized, null, 2));
  return normalized;
}

function getHostKind(request, runtime) {
  const host = normalizeHostname(new URL(request.url).hostname || request.headers.get('Host') || '');
  if (host === runtime.adminHost) return { kind: 'admin', host };
  if (host === runtime.landingHost || host === runtime.mainDomain) return { kind: 'landing', host };
  const suffix = `.${runtime.mainDomain}`;
  if (host.endsWith(suffix)) {
    const subdomain = host.slice(0, -suffix.length);
    if (subdomain === runtime.adminSubdomain) return { kind: 'admin', host };
    if (subdomain === runtime.landingSubdomain) return { kind: 'landing', host };
    return { kind: 'proxy', host, subdomain };
  }
  return { kind: 'unmanaged', host };
}

function getRouteHost(route, runtime) {
  return route.hostname || `${route.subdomain}.${runtime.mainDomain}`;
}

function findRouteForHost(config, hostInfo, runtime) {
  if (hostInfo.kind !== 'proxy') return null;
  const host = normalizeHostname(hostInfo.host);
  return config.routes.find(route => {
    if (!route.enabled) return false;
    if (route.hostname && normalizeHostname(route.hostname) === host) return true;
    return normalizeHostname(route.subdomain) === normalizeHostname(hostInfo.subdomain);
  }) || null;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const chunk of String(cookieHeader || '').split(';')) {
    const [rawKey, ...rest] = chunk.split('=');
    const key = rawKey?.trim();
    if (key) cookies[key] = rest.join('=').trim();
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
    return signature === await signSession(timestamp, env.ADMIN);
  } catch {
    return false;
  }
}

function headerSetToText(headers = {}) {
  return Object.entries(headers || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function headerRemoveToText(headers = []) {
  return Array.isArray(headers) ? headers.join('\n') : '';
}

function parseHeaderSetText(text = '') {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index === -1) out[trimmed] = '';
    else out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}

function parseHeaderRemoveText(text = '') {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function renderLoginPage(runtime, error = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Proxy Console Login</title><style>
:root{--bg:#050816;--card:#0f172a;--line:#233047;--ink:#e5edf8;--muted:#8ea3bd;--brand:#60a5fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,rgba(96,165,250,.28),transparent 28%),linear-gradient(135deg,#020617,#0f172a);font-family:Inter,ui-sans-serif,system-ui;color:var(--ink)}.card{width:min(460px,calc(100vw - 32px));background:rgba(15,23,42,.86);border:1px solid var(--line);border-radius:28px;padding:34px;box-shadow:0 30px 90px rgba(0,0,0,.35)}h1{margin:0 0 8px;font-size:30px;letter-spacing:-.04em}.muted{color:var(--muted);margin:0 0 24px}input{width:100%;border:1px solid #334155;border-radius:16px;background:#020617;color:var(--ink);padding:14px 16px;font:inherit;outline:none}input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(96,165,250,.18)}button{width:100%;border:0;border-radius:16px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;padding:14px 16px;font-weight:850;margin-top:14px;cursor:pointer}.err{background:#450a0a;color:#fecaca;border:1px solid #7f1d1d;border-radius:14px;padding:12px;margin-bottom:14px}.badge{display:inline-flex;border:1px solid #1d4ed8;background:#0b1b3a;color:#bfdbfe;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;margin-bottom:16px}</style></head><body><form class="card" method="POST" action="/login"><div class="badge">${escapeHtml(runtime.adminHost)}</div><h1>Proxy Console</h1><p class="muted">Host routes, upstreams and headers.</p>${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}<input type="password" name="password" placeholder="Admin password" autocomplete="current-password" required><button type="submit">登录</button></form></body></html>`;
}

function renderRouteCard(route, index, runtime) {
  return `<article class="route-card">
    <div class="route-head"><div><strong>${escapeHtml(route.name)}</strong><small>${escapeHtml(getRouteHost(route, runtime))}</small></div><span class="pill ${route.enabled ? 'ok' : 'off'}">${route.enabled ? 'Active' : 'Disabled'}</span></div>
    <div class="grid">
      <label><span>ID</span><input name="route_${index}_id" value="${escapeHtml(route.id)}"></label>
      <label><span>Name</span><input name="route_${index}_name" value="${escapeHtml(route.name)}"></label>
      <label><span>Subdomain</span><input name="route_${index}_subdomain" value="${escapeHtml(route.subdomain)}"></label>
      <label><span>Upstream Origin</span><input name="route_${index}_origin" value="${escapeHtml(route.origin)}"></label>
      <label class="switch"><span>Enabled</span><input name="route_${index}_enabled" type="checkbox" ${route.enabled ? 'checked' : ''}></label>
      <label class="switch"><span>Preserve Path</span><input name="route_${index}_preservePath" type="checkbox" ${route.preservePath ? 'checked' : ''}></label>
      <label class="switch"><span>Forward Headers</span><input name="route_${index}_forwardClientHeaders" type="checkbox" ${route.headers.forwardClientHeaders ? 'checked' : ''}></label>
    </div>
    <div class="grid two"><label><span>Set Headers</span><textarea name="route_${index}_headersSet" placeholder="X-Proxy: edge">${escapeHtml(headerSetToText(route.headers.set))}</textarea></label><label><span>Remove Headers</span><textarea name="route_${index}_headersRemove" placeholder="Cookie\nAuthorization">${escapeHtml(headerRemoveToText(route.headers.remove))}</textarea></label></div>
    <div class="actions"><button name="_action" value="moveUp:${index}" class="btn ghost">上移</button><button name="_action" value="moveDown:${index}" class="btn ghost">下移</button><button name="_action" value="delete:${index}" class="btn danger">删除</button></div>
  </article>`;
}

function renderAdminConsole(config, runtime, options = {}) {
  const normalized = normalizeConfig(config);
  const routes = normalized.routes;
  const previewJson = options.preview ? JSON.stringify(options.preview, null, 2) : 'Ready';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Proxy Console</title><style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#2563eb;--danger:#dc2626;--ok:#16a34a;--shadow:0 24px 70px rgba(15,23,42,.10)}*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:Inter,ui-sans-serif,system-ui;color:var(--ink)}.hero{background:radial-gradient(circle at 12% 20%,rgba(96,165,250,.3),transparent 28%),linear-gradient(135deg,#07111f,#111827 44%,#1d2560);color:#fff;padding:28px 22px 92px}.shell{max-width:1180px;margin:0 auto}.nav{display:flex;justify-content:space-between;align-items:center}.brand{display:flex;align-items:center;gap:12px;font-weight:900}.logo{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,#60a5fa,#a78bfa);display:grid;place-items:center}.nav a{color:#dbeafe;text-decoration:none;font-weight:800}.hero-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:28px;margin-top:36px;align-items:end}.eyebrow{color:#bfdbfe;font-size:12px;font-weight:850;letter-spacing:.18em;text-transform:uppercase}h1{font-size:clamp(36px,6vw,64px);line-height:.95;margin:12px 0 14px;letter-spacing:-.06em}.hero p{color:#cbd5e1;margin:0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-radius:20px;padding:18px}.stat strong{font-size:30px;display:block}.stat span{color:#cbd5e1;font-size:13px}main.shell{margin-top:-64px;padding:0 22px 44px}.panel{background:var(--card);border:1px solid var(--line);border-radius:28px;box-shadow:var(--shadow);overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fff,#f8fafc)}.panel-title h2{margin:0}.panel-title p{margin:5px 0 0;color:var(--muted);font-size:14px}.panel-body{padding:22px 24px}.toolbar,.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{border:0;border-radius:13px;padding:10px 14px;background:var(--brand);color:#fff;font-weight:850;cursor:pointer;text-decoration:none}.btn.secondary{background:#334155}.btn.ghost{background:#eef2ff;color:#1e293b}.btn.danger{background:var(--danger)}.notice{margin-bottom:16px;padding:12px 14px;border-radius:16px;font-weight:750}.notice.ok{background:#ecfdf5;color:#166534}.notice.err{background:#fef2f2;color:#991b1b}.notice.warn{background:#fffbeb;color:#92400e}.top-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}.field span,label span{display:block;font-size:12px;font-weight:850;letter-spacing:.06em;text-transform:uppercase;color:#334155;margin-bottom:7px}input,select,textarea{width:100%;border:1px solid #dbe3ef;border-radius:14px;padding:11px 12px;background:#fff;color:var(--ink);font:inherit}textarea{min-height:96px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.route-list{display:grid;gap:16px}.route-card{border:1px solid #dbeafe;border-radius:22px;padding:18px;background:linear-gradient(180deg,#fff,#f8fbff)}.route-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:16px}.route-head strong{display:block}.route-head small{display:block;color:var(--muted);margin-top:4px}.pill{border-radius:999px;padding:7px 10px;font-size:12px;font-weight:850}.pill.ok{background:#dcfce7;color:#166534}.pill.off{background:#fee2e2;color:#991b1b}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.grid.two{grid-template-columns:1fr 1fr;margin-top:14px}.switch{display:flex;align-items:center;justify-content:space-between;border:1px solid #dbe3ef;border-radius:14px;padding:11px 12px}.switch input{width:auto}.empty{border:1px dashed #cbd5e1;border-radius:20px;padding:26px;text-align:center;color:var(--muted);background:#f8fafc}.subgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.code{background:#0f172a;color:#dbeafe;border-radius:18px;padding:16px;min-height:140px;white-space:pre-wrap;word-break:break-word;overflow:auto}@media(max-width:900px){.hero-grid,.stats,.top-grid,.subgrid,.grid,.grid.two{grid-template-columns:1fr}.panel-head,.route-head{align-items:flex-start;flex-direction:column}}
</style></head><body>
<section class="hero"><div class="shell"><div class="nav"><div class="brand"><div class="logo">↯</div><div>Proxy Console</div></div><a href="/logout">退出</a></div><div class="hero-grid"><div><div class="eyebrow">Host-based Reverse Proxy</div><h1>Virtual hosts for edge routing.</h1><p>${escapeHtml(runtime.mainDomain)} · admin: ${escapeHtml(runtime.adminHost)}</p></div><div class="stats"><div class="stat"><strong>${routes.length}</strong><span>Routes</span></div><div class="stat"><strong>${routes.filter(route => route.enabled).length}</strong><span>Enabled</span></div><div class="stat"><strong>${escapeHtml(normalized.global.noMatchStatus)}</strong><span>No match</span></div></div></div></div></section>
<main class="shell">
  <div class="panel"><div class="panel-head"><div class="panel-title"><h2>Host Routes</h2><p>subdomain → upstream origin</p></div><div class="toolbar"><button form="routeForm" class="btn" name="_action" value="addRoute">新增 Route</button><button form="routeForm" class="btn secondary" name="_action" value="addGh">添加 GitHub</button></div></div><div class="panel-body">
    ${options.saved ? '<div class="notice ok">配置已保存</div>' : ''}${options.error ? `<div class="notice err">${escapeHtml(options.error)}</div>` : ''}${options.kvBound ? '' : '<div class="notice warn">KV 未绑定，保存会失败</div>'}
    <form method="POST" action="/" id="routeForm"><div class="top-grid"><label class="field"><span>No Match</span><select name="noMatchStatus"><option value="404" ${normalized.global.noMatchStatus === 404 ? 'selected' : ''}>404</option><option value="403" ${normalized.global.noMatchStatus === 403 ? 'selected' : ''}>403</option></select></label><label class="field"><span>Max Redirects</span><input name="maxRedirects" type="number" min="0" max="10" value="${normalized.global.maxRedirects}"></label><label class="field"><span>Follow Redirects</span><select name="followRedirects"><option value="true" ${normalized.global.followRedirects ? 'selected' : ''}>Enabled</option><option value="false" ${!normalized.global.followRedirects ? 'selected' : ''}>Disabled</option></select></label></div><input type="hidden" name="routeCount" value="${routes.length}">${routes.length ? `<div class="route-list">${routes.map((route, index) => renderRouteCard(route, index, runtime)).join('')}</div>` : '<div class="empty">暂无 Host Route，添加一个子域名映射开始使用。</div>'}<div class="toolbar" style="margin-top:18px"><button class="btn" name="_action" value="save">保存配置</button></div></form>
  </div></div>
  <div class="subgrid"><section class="panel"><div class="panel-head"><div class="panel-title"><h2>Preview</h2><p>host + path → upstream</p></div></div><div class="panel-body"><form method="GET" action="/"><label><span>Host</span><input name="previewHost" value="${escapeHtml(options.previewHost || `gh.${runtime.mainDomain}`)}"></label><label style="margin-top:12px"><span>Path</span><input name="previewPath" value="${escapeHtml(options.previewPath || '/robots.txt')}"></label><button class="btn" style="margin-top:12px">预览</button></form><pre class="code" style="margin-top:14px">${escapeHtml(previewJson)}</pre></div></section><section class="panel"><div class="panel-head"><div class="panel-title"><h2>GitHub Preset</h2><p>gh.${escapeHtml(runtime.mainDomain)}</p></div></div><div class="panel-body"><pre class="code">${escapeHtml(JSON.stringify(githubPresetRoute(), null, 2))}</pre></div></section></div>
</main></body></html>`;
}

async function parseAdminConfigFromForm(request) {
  const form = await request.formData();
  const routeCount = Math.max(0, Number.parseInt(String(form.get('routeCount') || '0'), 10) || 0);
  const routes = [];
  for (let index = 0; index < routeCount; index++) {
    routes.push({
      id: String(form.get(`route_${index}_id`) || `route-${index + 1}`).trim(),
      name: String(form.get(`route_${index}_name`) || `Route ${index + 1}`).trim(),
      enabled: form.get(`route_${index}_enabled`) === 'on',
      subdomain: String(form.get(`route_${index}_subdomain`) || '').trim(),
      origin: String(form.get(`route_${index}_origin`) || '').trim(),
      preservePath: form.get(`route_${index}_preservePath`) === 'on',
      headers: {
        forwardClientHeaders: form.get(`route_${index}_forwardClientHeaders`) === 'on',
        set: parseHeaderSetText(form.get(`route_${index}_headersSet`)),
        remove: parseHeaderRemoveText(form.get(`route_${index}_headersRemove`))
      }
    });
  }
  return {
    action: String(form.get('_action') || 'save'),
    config: {
      version: 3,
      global: {
        noMatchStatus: Number(form.get('noMatchStatus') || DEFAULT_CONFIG.global.noMatchStatus),
        maxRedirects: Number(form.get('maxRedirects') || DEFAULT_CONFIG.global.maxRedirects),
        followRedirects: String(form.get('followRedirects') || 'true') === 'true'
      },
      routes
    }
  };
}

function applyAdminAction(config, action) {
  const next = normalizeConfig({ ...config, version: 3 });
  if (action === 'addRoute') next.routes.push(normalizeRoute(defaultRoute(next.routes.length), next.routes.length));
  if (action === 'addGh') {
    const preset = githubPresetRoute();
    const index = next.routes.findIndex(route => route.subdomain === preset.subdomain || route.id === preset.id);
    if (index >= 0) next.routes[index] = normalizeRoute(preset, index);
    else next.routes.push(normalizeRoute(preset, next.routes.length));
  }
  const [kind, rawIndex] = String(action || '').split(':');
  const index = Number.parseInt(rawIndex, 10);
  if (Number.isInteger(index) && index >= 0 && index < next.routes.length) {
    if (kind === 'delete') next.routes.splice(index, 1);
    if (kind === 'moveUp' && index > 0) [next.routes[index - 1], next.routes[index]] = [next.routes[index], next.routes[index - 1]];
    if (kind === 'moveDown' && index < next.routes.length - 1) [next.routes[index + 1], next.routes[index]] = [next.routes[index], next.routes[index + 1]];
  }
  return next;
}

async function parseAdminConfigFromJson(request) {
  const body = await request.json();
  return {
    version: 3,
    global: body?.global || {},
    routes: body?.routes || []
  };
}

function renderLandingPage(runtime) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Edge Proxy</title><style>
:root{--ink:#0f172a;--muted:#64748b;--brand:#2563eb;--line:#e2e8f0}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui;color:var(--ink);background:#f8fafc}.hero{min-height:100vh;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 15% 12%,rgba(96,165,250,.32),transparent 30%),radial-gradient(circle at 85% 10%,rgba(167,139,250,.28),transparent 30%),linear-gradient(135deg,#eff6ff,#fff)}.card{width:min(980px,100%);background:rgba(255,255,255,.84);border:1px solid rgba(226,232,240,.9);border-radius:32px;box-shadow:0 28px 80px rgba(15,23,42,.12);padding:48px;backdrop-filter:blur(18px)}.badge{display:inline-flex;border:1px solid #bfdbfe;color:#1d4ed8;background:#eff6ff;border-radius:999px;padding:8px 12px;font-weight:850;font-size:13px}.title{font-size:clamp(42px,7vw,86px);line-height:.92;letter-spacing:-.07em;margin:22px 0 18px}.lead{font-size:19px;line-height:1.7;color:var(--muted);max-width:720px;margin:0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}.btn{border:0;border-radius:14px;padding:13px 18px;text-decoration:none;font-weight:850;display:inline-flex}.btn.primary{background:var(--brand);color:#fff;box-shadow:0 14px 30px rgba(37,99,235,.24)}.btn.secondary{background:#0f172a;color:#fff}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:36px}.item{border:1px solid var(--line);border-radius:22px;background:#fff;padding:20px}.item b{display:block;margin-bottom:8px}.item span{color:var(--muted);font-size:14px;line-height:1.6}@media(max-width:760px){.card{padding:28px}.grid{grid-template-columns:1fr}}
</style></head><body><section class="hero"><div class="card"><div class="badge">${escapeHtml(runtime.mainDomain)}</div><h1 class="title">Host-based proxy at the edge.</h1><p class="lead">将每个子域名映射到独立 upstream，使用 Cloudflare Workers 在边缘完成反向代理。</p><div class="actions"><a class="btn primary" href="https://${escapeHtml(runtime.adminHost)}">进入控制台</a><a class="btn secondary" href="https://gh.${escapeHtml(runtime.mainDomain)}">GitHub Route</a></div><div class="grid"><div class="item"><b>Virtual Host</b><span>按 Host 匹配，而不是按路径前缀。</span></div><div class="item"><b>KV Config</b><span>Host Routes 保存在 Cloudflare KV。</span></div><div class="item"><b>Header Policy</b><span>支持请求头转发、删除和覆盖。</span></div></div></div></section></body></html>`;
}

function renderNotManaged(host, runtime, status = 404) {
  return htmlResponse(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Managed</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020617;color:#e5e7eb;font-family:ui-sans-serif,system-ui}.card{max-width:560px;padding:34px;border:1px solid #1e293b;border-radius:24px;background:#0f172a}code{background:#1e293b;padding:2px 6px;border-radius:6px;color:#bfdbfe}</style></head><body><div class="card"><h1>Host not managed</h1><p><code>${escapeHtml(host)}</code> is not configured under <code>${escapeHtml(runtime.mainDomain)}</code>.</p></div></body></html>`, { status });
}

function renderConfigError(message) {
  return htmlResponse(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configuration Required</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020617;color:#e5e7eb;font-family:ui-sans-serif,system-ui}.card{max-width:620px;padding:34px;border:1px solid #7f1d1d;border-radius:24px;background:#1e0b0b}.muted{color:#fecaca}code{background:#450a0a;padding:2px 6px;border-radius:6px}</style></head><body><div class="card"><h1>Configuration required</h1><p class="muted">${escapeHtml(message)}</p><p>Set <code>MAIN_DOMAIN</code>, <code>ADMIN</code>, and bind KV before production use.</p></div></body></html>`, { status: 500 });
}

function buildPreview(previewHost, previewPath, config, runtime) {
  const path = String(previewPath || '/').startsWith('/') ? String(previewPath || '/') : `/${previewPath}`;
  const request = new Request(`https://${normalizeHostname(previewHost || '')}${path}`);
  const hostInfo = getHostKind(request, runtime);
  if (hostInfo.kind !== 'proxy') {
    return { ok: true, matched: false, host: hostInfo.host, kind: hostInfo.kind, message: 'not a proxy host' };
  }
  const route = findRouteForHost(config, hostInfo, runtime);
  if (!route) {
    return { ok: true, matched: false, host: hostInfo.host, subdomain: hostInfo.subdomain, message: 'no host route matched' };
  }
  return { ok: true, matched: true, host: hostInfo.host, subdomain: hostInfo.subdomain, route: { id: route.id, name: route.name, origin: route.origin }, upstreamUrl: buildUpstreamUrl(request.url, route) };
}

async function handleAdminRequest(request, env, runtime) {
  const url = new URL(request.url);
  const kvBound = Boolean(getConfigKV(env));

  if (!env?.ADMIN) return renderConfigError('ADMIN environment variable is not configured.');

  if (url.pathname === '/login' && request.method === 'POST') {
    const form = await request.formData();
    const password = String(form.get('password') || '');
    if (password !== env.ADMIN) return htmlResponse(renderLoginPage(runtime, '密码错误'), { status: 401 });
    const token = await createSessionToken(env.ADMIN);
    return redirectResponse('/', { 'Set-Cookie': `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}` });
  }

  if (url.pathname === '/logout') {
    return redirectResponse('/', { 'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (!(await verifySession(request, env))) {
    if (request.method === 'GET') return htmlResponse(renderLoginPage(runtime));
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  if (url.pathname === '/api/config') {
    if (request.method === 'GET') return jsonResponse(await getConfig(env));
    if (request.method === 'POST') {
      try {
        const nextConfig = await parseAdminConfigFromJson(request);
        return jsonResponse({ ok: true, config: await saveConfig(env, nextConfig, runtime) });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, { status: 400 });
      }
    }
    return new Response('Method Not Allowed\n', { status: 405 });
  }

  if (url.pathname !== '/') return new Response('Not Found\n', { status: 404 });

  const config = await getConfig(env);
  if (request.method === 'GET') {
    const previewHost = String(url.searchParams.get('previewHost') || '').trim();
    const previewPath = String(url.searchParams.get('previewPath') || '').trim();
    const preview = previewHost ? buildPreview(previewHost, previewPath || '/', config, runtime) : null;
    return htmlResponse(renderAdminConsole(config, runtime, { saved: url.searchParams.get('saved') === '1', preview, previewHost, previewPath, kvBound }));
  }

  if (request.method === 'POST') {
    let nextConfig = null;
    try {
      const parsed = await parseAdminConfigFromForm(request);
      nextConfig = applyAdminAction(parsed.config, parsed.action);
      await saveConfig(env, nextConfig, runtime);
      return redirectResponse('/?saved=1');
    } catch (error) {
      return htmlResponse(renderAdminConsole(nextConfig || config, runtime, { error: error.message, kvBound }), { status: 400 });
    }
  }

  return new Response('Method Not Allowed\n', { status: 405 });
}

function joinPath(basePath, requestPath) {
  const base = basePath && basePath !== '/' ? basePath.replace(/\/$/, '') : '';
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  return `${base}${path}` || '/';
}

function buildUpstreamUrl(requestUrl, route) {
  const inbound = new URL(requestUrl);
  const upstream = new URL(route.origin);
  if (route.preservePath !== false) upstream.pathname = joinPath(upstream.pathname, inbound.pathname);
  upstream.search = inbound.search;
  return upstream.toString();
}

function canHaveBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

async function getReusableBody(request) {
  if (!canHaveBody(request.method) || !request.body) return undefined;
  return await request.clone().arrayBuffer();
}

function sanitizeRequestHeaders(request, targetUrl, route) {
  const target = new URL(targetUrl);
  const headers = new Headers();
  const sourceHeaders = route.headers.forwardClientHeaders ? request.headers : new Headers();
  for (const [key, value] of sourceHeaders.entries()) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
  }
  for (const headerName of route.headers.remove) headers.delete(headerName);
  headers.set('Host', target.host);
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', new URL(request.url).protocol.replace(':', ''));
  const clientIp = request.headers.get('CF-Connecting-IP');
  const previousForwardedFor = request.headers.get('X-Forwarded-For');
  const nextForwardedFor = [previousForwardedFor, clientIp].filter(Boolean).join(', ');
  if (nextForwardedFor) headers.set('X-Forwarded-For', nextForwardedFor);
  if (clientIp) headers.set('X-Real-IP', clientIp);
  for (const [key, value] of Object.entries(route.headers.set)) headers.set(key, value);
  return headers;
}

async function proxyFetch(targetUrl, init, maxRedirects) {
  let currentUrl = targetUrl;
  let currentInit = { ...init };
  for (let index = 0; index <= maxRedirects; index++) {
    const response = await fetch(currentUrl, { ...currentInit, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('Location');
    if (!location || index === maxRedirects) return response;
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
    currentInit = { ...currentInit, method: nextMethod, body: nextBody, headers: nextHeaders };
  }
  return new Response('Too many redirects\n', { status: 508 });
}

async function handleProxyRequest(request, env, runtime, hostInfo) {
  const config = await getConfig(env);
  const route = findRouteForHost(config, hostInfo, runtime);
  if (!route) return renderNotManaged(hostInfo.host, runtime, config.global.noMatchStatus);
  const targetUrl = buildUpstreamUrl(request.url, route);
  const headers = sanitizeRequestHeaders(request, targetUrl, route);
  const body = await getReusableBody(request);
  const init = { method: request.method, headers, body, cf: { scrapeShield: false } };
  const upstreamResponse = config.global.followRedirects
    ? await proxyFetch(targetUrl, init, config.global.maxRedirects)
    : await fetch(targetUrl, { ...init, redirect: 'manual' });
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('X-Proxy-Route-Id', route.id);
  responseHeaders.set('X-Proxy-Route-Name', route.name);
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders });
}

export default {
  async fetch(request, env) {
    const runtime = getRuntime(env);
    if (!runtime.mainDomain) return renderConfigError('MAIN_DOMAIN is required.');
    const hostInfo = getHostKind(request, runtime);
    if (hostInfo.kind === 'admin') return handleAdminRequest(request, env, runtime);
    if (hostInfo.kind === 'landing') return htmlResponse(renderLandingPage(runtime));
    if (hostInfo.kind === 'proxy') return handleProxyRequest(request, env, runtime, hostInfo);
    return renderNotManaged(hostInfo.host, runtime, 404);
  }
};
