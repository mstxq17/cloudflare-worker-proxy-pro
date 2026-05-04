import { connect } from 'cloudflare:sockets';
import dns from 'node:dns';

const CONFIG_KV_KEY = 'proxy:settings';
const SESSION_COOKIE_NAME = '__proxy_admin_session';
const SESSION_MAX_AGE = 60 * 60 * 12;
const DEFAULT_MAIN_DOMAIN = 'rad0.indevs.in';
const DEFAULT_ADMIN_SUBDOMAIN = 'admin';
const DEFAULT_LANDING_SUBDOMAIN = 'proxy';
const DEFAULT_DNS_RECORD = 'auto';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;
const MIN_UPSTREAM_TIMEOUT_MS = 1000;
const MAX_UPSTREAM_TIMEOUT_MS = 120000;
const MAX_RESPONSE_HEADER_BYTES = 256 * 1024;
const MAX_CHUNK_LINE_BYTES = 16 * 1024;

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
  'x-real-ip',
  'content-length'
];

const UNSAFE_RESPONSE_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
];

const DEFAULT_CONFIG = Object.freeze({
  version: 4,
  updatedAt: null,
  global: {
    noMatchStatus: 404
  },
  routes: []
});

class ProxyUpstreamError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') {
    super(message);
    this.name = 'ProxyUpstreamError';
    this.status = status;
    this.code = code;
  }
}

function getConfigKV(env) {
  return env?.CONFIG_KV || env?.CF_ACCEL_KV || env?.ACCEL_KV || env?.KV || null;
}

function normalizeHostname(value = '') {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  const bracketMatch = raw.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/i);
  if (bracketMatch) return bracketMatch[1];
  if ((raw.match(/:/g) || []).length > 1) return raw;
  return raw.replace(/:\d+$/, '');
}

function normalizeHostHeader(value = '') {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
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

function isIPv4(value = '') {
  const parts = String(value || '').trim().split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isIPv6(value = '') {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '');
  return host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host);
}

function isIpAddress(value = '') {
  return isIPv4(value) || isIPv6(value);
}

function validateUpstreamHost(host = '') {
  const value = String(host || '').trim();
  if (!value) return false;
  if (isIpAddress(value)) return true;
  if (value.length > 253) return false;
  return value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function formatHostForHeader(host, port, scheme) {
  const normalized = normalizeHostname(host);
  const defaultPort = scheme === 'https' ? 443 : 80;
  const hostPart = isIPv6(normalized) ? `[${normalized}]` : normalized;
  return Number(port) && Number(port) !== defaultPort ? `${hostPart}:${Number(port)}` : hostPart;
}

function formatConnectHostname(host) {
  const normalized = normalizeHostname(host);
  return isIPv6(normalized) ? normalized.replace(/^\[|\]$/g, '') : normalized;
}

function routeOrigin(route) {
  const scheme = route.scheme || 'https';
  return `${scheme}://${formatHostForHeader(route.upstreamHost, route.upstreamPort, scheme)}`;
}

function getHeaderValue(headers = {}, name = '') {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value ?? '');
  }
  return '';
}

function routeHostHeader(route) {
  return normalizeHostHeader(getHeaderValue(route?.headers?.set, 'host')) || formatHostForHeader(route.upstreamHost, route.upstreamPort, route.scheme);
}

function githubPresetRoute() {
  return {
    id: 'gh',
    name: 'GitHub',
    enabled: true,
    subdomain: 'gh',
    transport: 'fetch',
    scheme: 'https',
    upstreamHost: 'github.com',
    upstreamPort: 443,
    upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    resolveDns: true,
    dnsRecord: DEFAULT_DNS_RECORD,
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
    transport: 'fetch',
    scheme: 'https',
    upstreamHost: 'example.com',
    upstreamPort: 443,
    upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    resolveDns: true,
    dnsRecord: DEFAULT_DNS_RECORD,
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

function normalizeDnsRecord(value = DEFAULT_DNS_RECORD) {
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'A' || upper === 'AAAA') return upper;
  return DEFAULT_DNS_RECORD;
}

function normalizeTransport(value = 'fetch') {
  return String(value || '').trim().toLowerCase() === 'tcp' ? 'tcp' : 'fetch';
}

function normalizeUpstreamTimeoutMs(value = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const timeout = Number(value || DEFAULT_UPSTREAM_TIMEOUT_MS);
  if (!Number.isFinite(timeout)) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.max(MIN_UPSTREAM_TIMEOUT_MS, Math.round(timeout)));
}

function isStandardHttpTransport(route = {}) {
  const port = Number(route.upstreamPort);
  return (route.scheme === 'http' && port === 80) || (route.scheme === 'https' && port === 443);
}

function normalizeRoute(route = {}, index = 0) {
  const base = defaultRoute(index);
  const scheme = String(route.scheme || base.scheme).trim().toLowerCase() === 'http' ? 'http' : 'https';
  const upstreamHost = normalizeHostname(route.upstreamHost || base.upstreamHost);
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = Number(route.upstreamPort || defaultPort);
  const transport = normalizeTransport(route.transport || base.transport);
  const upstreamTimeoutMs = normalizeUpstreamTimeoutMs(route.upstreamTimeoutMs || base.upstreamTimeoutMs);
  const resolveDns = !isIpAddress(upstreamHost) && (route.resolveDns !== undefined ? route.resolveDns === true : true);
  const dnsRecord = normalizeDnsRecord(route.dnsRecord);
  return {
    id: String(route.id || base.id).trim(),
    name: String(route.name || base.name).trim(),
    enabled: route.enabled !== false,
    subdomain: normalizeHostname(route.subdomain || base.subdomain),
    hostname: normalizeHostname(route.hostname || ''),
    transport,
    scheme,
    upstreamHost,
    upstreamPort: Number.isFinite(port) ? port : defaultPort,
    upstreamTimeoutMs,
    upstreamPath: String(route.upstreamPath ?? '').trim(),
    resolveDns,
    dnsRecord,
    preservePath: route.preservePath !== false,
    headers: {
      forwardClientHeaders: route?.headers?.forwardClientHeaders !== false,
      set: normalizeHeadersMap(route?.headers?.set),
      remove: normalizeHeaderRemoveList(route?.headers?.remove)
    }
  };
}

function normalizeConfig(input = {}) {
  if (!input || input.version !== 4 || !Array.isArray(input.routes)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const global = input.global || {};
  return {
    version: 4,
    updatedAt: input.updatedAt || null,
    global: {
      noMatchStatus: [403, 404].includes(Number(global.noMatchStatus)) ? Number(global.noMatchStatus) : DEFAULT_CONFIG.global.noMatchStatus
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
  if (!['fetch', 'tcp'].includes(route.transport)) throw new Error(`${label} transport 仅支持 fetch 或 tcp`);
  if (!['http', 'https'].includes(route.scheme)) throw new Error(`${label} scheme 仅支持 http 或 https`);
  if (!validateUpstreamHost(route.upstreamHost)) throw new Error(`${label} upstream host 无效：${route.upstreamHost}`);
  if (!Number.isInteger(Number(route.upstreamPort)) || Number(route.upstreamPort) < 1 || Number(route.upstreamPort) > 65535) {
    throw new Error(`${label} upstream port 必须在 1-65535`);
  }
  if (!Number.isInteger(Number(route.upstreamTimeoutMs)) || Number(route.upstreamTimeoutMs) < MIN_UPSTREAM_TIMEOUT_MS || Number(route.upstreamTimeoutMs) > MAX_UPSTREAM_TIMEOUT_MS) {
    throw new Error(`${label} upstream timeout 必须在 ${MIN_UPSTREAM_TIMEOUT_MS}-${MAX_UPSTREAM_TIMEOUT_MS}ms`);
  }
  if (!['auto', 'A', 'AAAA'].includes(route.dnsRecord)) throw new Error(`${label} DNS 记录类型无效`);
  for (const [headerName, headerValue] of Object.entries(route.headers.set)) {
    if (!validateHeaderName(headerName)) throw new Error(`${label} 覆盖 Header 名无效：${headerName}`);
    if (/[\r\n]/.test(String(headerValue))) throw new Error(`${label} 覆盖 Header 值不能包含换行：${headerName}`);
  }
  for (const headerName of route.headers.remove) {
    if (!validateHeaderName(headerName)) throw new Error(`${label} 删除 Header 名无效：${headerName}`);
  }
}

function validateConfig(config, runtime) {
  const normalized = normalizeConfig({ ...config, version: 4 });
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
  const url = new URL(request.url);
  const host = normalizeHostname(url.hostname || request.headers.get('Host') || '');
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

function findRouteForHost(config, hostInfo) {
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
:root{--bg:#050816;--card:#0f172a;--line:#233047;--ink:#e5edf8;--muted:#8ea3bd;--brand:#60a5fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,rgba(96,165,250,.28),transparent 28%),linear-gradient(135deg,#020617,#0f172a);font-family:Inter,ui-sans-serif,system-ui;color:var(--ink)}.card{width:min(460px,calc(100vw - 32px));background:rgba(15,23,42,.86);border:1px solid var(--line);border-radius:28px;padding:34px;box-shadow:0 30px 90px rgba(0,0,0,.35)}h1{margin:0 0 8px;font-size:30px;letter-spacing:-.04em}.muted{color:var(--muted);margin:0 0 24px}input{width:100%;border:1px solid #334155;border-radius:16px;background:#020617;color:var(--ink);padding:14px 16px;font:inherit;outline:none}input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(96,165,250,.18)}button{width:100%;border:0;border-radius:16px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;padding:14px 16px;font-weight:850;margin-top:14px;cursor:pointer}.err{background:#450a0a;color:#fecaca;border:1px solid #7f1d1d;border-radius:14px;padding:12px;margin-bottom:14px}.badge{display:inline-flex;border:1px solid #1d4ed8;background:#0b1b3a;color:#bfdbfe;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;margin-bottom:16px}</style></head><body><form class="card" method="POST" action="/login"><div class="badge">${escapeHtml(runtime.adminHost)}</div><h1>Proxy Console</h1><p class="muted">TCP upstreams, DNS and headers.</p>${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}<input type="password" name="password" placeholder="Admin password" autocomplete="current-password" required><button type="submit">登录</button></form></body></html>`;
}

function renderRouteCard(route, index, runtime) {
  const origin = routeOrigin(route);
  const transportLabel = route.transport === 'tcp' ? 'TCP' : 'Fetch';
  const tcpWarning = route.transport === 'tcp' && isStandardHttpTransport(route)
    ? '<div class="route-warning">当前规则使用 TCP Socket 连接标准 HTTP/HTTPS 端口。Cloudflare Workers 对这类上游通常要求使用 Fetch；如访问返回 Bad Gateway，请将 Transport 切换为 Fetch。</div>'
    : '';
  return `<article class="route-card">
    <div class="route-head"><div><strong>${escapeHtml(route.name)}</strong><small>${escapeHtml(getRouteHost(route, runtime))} → ${escapeHtml(origin)}</small><div class="meta-row"><span>${escapeHtml(transportLabel)}</span><span>${escapeHtml(route.scheme.toUpperCase())}</span><span>${escapeHtml(route.upstreamHost)}:${escapeHtml(route.upstreamPort)}</span></div></div><span class="pill ${route.enabled ? 'ok' : 'off'}">${route.enabled ? 'Active' : 'Disabled'}</span></div>
    <div class="grid primary-grid">
      <label><span>Name</span><input name="route_${index}_name" value="${escapeHtml(route.name)}"></label>
      <label><span>Subdomain</span><input name="route_${index}_subdomain" value="${escapeHtml(route.subdomain)}"></label>
      <label><span>Transport</span><select name="route_${index}_transport"><option value="fetch" ${route.transport === 'fetch' ? 'selected' : ''}>Fetch</option><option value="tcp" ${route.transport === 'tcp' ? 'selected' : ''}>TCP Socket</option></select></label>
      <label><span>Scheme</span><select name="route_${index}_scheme"><option value="http" ${route.scheme === 'http' ? 'selected' : ''}>HTTP</option><option value="https" ${route.scheme === 'https' ? 'selected' : ''}>HTTPS</option></select></label>
      <label class="span-2"><span>Upstream Host / IP</span><input name="route_${index}_upstreamHost" value="${escapeHtml(route.upstreamHost)}" placeholder="github.com"></label>
      <label><span>Port</span><input name="route_${index}_upstreamPort" type="number" min="1" max="65535" value="${escapeHtml(route.upstreamPort)}"></label>
      <label class="switch"><span>Enabled</span><input name="route_${index}_enabled" type="checkbox" ${route.enabled ? 'checked' : ''}></label>
      <label class="switch"><span>Preserve Path</span><input name="route_${index}_preservePath" type="checkbox" ${route.preservePath ? 'checked' : ''}></label>
    </div>
    ${tcpWarning}
    <details class="advanced"><summary><span>高级设置</span><b>ID · Timeout · DNS · Headers</b></summary><div class="grid advanced-grid"><label><span>Route ID</span><input name="route_${index}_id" value="${escapeHtml(route.id)}"></label><label><span>Base Path</span><input name="route_${index}_upstreamPath" value="${escapeHtml(route.upstreamPath)}" placeholder="/optional-base"></label><label><span>Timeout (ms)</span><input name="route_${index}_upstreamTimeoutMs" type="number" min="${MIN_UPSTREAM_TIMEOUT_MS}" max="${MAX_UPSTREAM_TIMEOUT_MS}" step="1000" value="${escapeHtml(route.upstreamTimeoutMs)}"></label><label><span>DNS Record</span><select name="route_${index}_dnsRecord"><option value="auto" ${route.dnsRecord === 'auto' ? 'selected' : ''}>AUTO</option><option value="A" ${route.dnsRecord === 'A' ? 'selected' : ''}>A</option><option value="AAAA" ${route.dnsRecord === 'AAAA' ? 'selected' : ''}>AAAA</option></select></label><label class="switch"><span>Resolve DNS</span><input name="route_${index}_resolveDns" type="checkbox" ${route.resolveDns ? 'checked' : ''}></label><label class="switch"><span>Forward Headers</span><input name="route_${index}_forwardClientHeaders" type="checkbox" ${route.headers.forwardClientHeaders ? 'checked' : ''}></label></div><div class="grid two"><label><span>Set Headers</span><textarea name="route_${index}_headersSet" placeholder="Host: github.com\nX-Proxy: edge">${escapeHtml(headerSetToText(route.headers.set))}</textarea></label><label><span>Remove Headers</span><textarea name="route_${index}_headersRemove" placeholder="Cookie\nAuthorization">${escapeHtml(headerRemoveToText(route.headers.remove))}</textarea></label></div></details>
    <div class="actions"><button name="_action" value="moveUp:${index}" class="btn ghost">上移</button><button name="_action" value="moveDown:${index}" class="btn ghost">下移</button><button name="_action" value="delete:${index}" class="btn danger">删除</button></div>
  </article>`;
}


function renderAdminScript() {
  return `<script>
(() => {
  if (window.__proxyConsoleAsync) return;
  window.__proxyConsoleAsync = true;
  function swapPage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nextRoot = doc.querySelector('[data-console-root]');
    const currentRoot = document.querySelector('[data-console-root]');
    const y = window.scrollY;
    if (nextRoot && currentRoot) {
      currentRoot.replaceWith(nextRoot);
      window.scrollTo(0, y);
      return;
    }
    if (doc.body) document.body.replaceWith(doc.body);
  }
  function showToast(message, type = 'ok') {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }
  function setBusy(form, busy) {
    form.querySelectorAll('button,input,select,textarea').forEach(el => {
      if (el.matches('[readonly]')) return;
      el.disabled = busy;
    });
    form.classList.toggle('is-busy', busy);
  }
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'routeForm') {
      event.preventDefault();
      const submitter = event.submitter;
      const body = new FormData(form);
      if (submitter && submitter.name) body.set(submitter.name, submitter.value);
      setBusy(form, true);
      try {
        const response = await fetch(form.action || '/', {
          method: 'POST',
          body,
          headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' }
        });
        const payload = await response.json();
        if (payload.html) swapPage(payload.html);
        if (payload.ok) showToast('配置已保存', 'ok');
        else showToast(payload.error || '保存失败', 'err');
      } catch (error) {
        showToast('保存失败：' + (error && error.message ? error.message : error), 'err');
      } finally {
        setBusy(form, false);
      }
      return;
    }
    if (form.dataset.asyncPreview === '1') {
      event.preventDefault();
      const url = new URL(form.action || '/', location.href);
      for (const [key, value] of new FormData(form).entries()) url.searchParams.set(key, value);
      try {
        const response = await fetch(url.toString(), { headers: { 'X-Requested-With': 'fetch' } });
        swapPage(await response.text());
        history.replaceState(null, '', url.toString());
      } catch (error) {
        showToast('预览失败：' + (error && error.message ? error.message : error), 'err');
      }
    }
  });
})();
</script>`;
}

function renderAdminConsole(config, runtime, options = {}) {
  const normalized = normalizeConfig(config);
  const routes = normalized.routes;
  const previewJson = options.preview ? JSON.stringify(options.preview, null, 2) : 'Ready';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Proxy Console</title><style>
:root{--bg:#f5f7fb;--card:rgba(255,255,255,.88);--ink:#0f172a;--muted:#64748b;--line:#e5edf6;--line-strong:#cbd8ea;--brand:#2563eb;--brand2:#7c3aed;--danger:#e11d48;--ok:#16a34a;--shadow:0 28px 90px rgba(15,23,42,.12);--soft:0 12px 30px rgba(37,99,235,.14);--ring:0 0 0 4px rgba(37,99,235,.13)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 8% 0,rgba(59,130,246,.10),transparent 30%),linear-gradient(180deg,#f8fbff,#eef4fb);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}.hero{position:relative;overflow:hidden;background:radial-gradient(circle at 12% 20%,rgba(14,165,233,.36),transparent 28%),radial-gradient(circle at 86% 8%,rgba(124,58,237,.30),transparent 28%),linear-gradient(135deg,#06111f,#101827 48%,#1e1b4b);color:#fff;padding:30px 22px 96px}.hero:after{content:"";position:absolute;inset:auto -15% -42% -15%;height:260px;background:radial-gradient(circle,rgba(255,255,255,.13),transparent 62%);pointer-events:none}.shell{max-width:1240px;margin:0 auto;position:relative}.nav{display:flex;justify-content:space-between;align-items:center}.brand{display:flex;align-items:center;gap:12px;font-weight:900;letter-spacing:-.02em}.logo{width:44px;height:44px;border-radius:16px;background:linear-gradient(135deg,#38bdf8,#8b5cf6);display:grid;place-items:center;box-shadow:0 18px 42px rgba(56,189,248,.28)}.nav a{color:#dbeafe;text-decoration:none;font-weight:850;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);padding:10px 14px;border-radius:999px;transition:.18s ease}.nav a:hover{background:rgba(255,255,255,.14);transform:translateY(-1px)}.hero-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:28px;margin-top:38px;align-items:end}.eyebrow{color:#bfdbfe;font-size:12px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}h1{font-size:clamp(38px,6vw,66px);line-height:.94;margin:12px 0 14px;letter-spacing:-.065em}.hero p{color:#cbd5e1;margin:0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat{background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.08));border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:18px;backdrop-filter:blur(18px);box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}.stat strong{font-size:31px;display:block;letter-spacing:-.05em}.stat span{color:#cbd5e1;font-size:13px;font-weight:750}main.shell{margin-top:-66px;padding:0 22px 48px}.panel{background:var(--card);border:1px solid rgba(226,232,240,.86);border-radius:30px;box-shadow:var(--shadow);overflow:hidden;backdrop-filter:blur(18px)}.panel+.panel{margin-top:18px}.subgrid>.panel{margin-top:0}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:23px 25px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(248,250,252,.9))}.panel-title h2{margin:0;font-size:22px;letter-spacing:-.035em}.panel-title p{margin:6px 0 0;color:var(--muted);font-size:14px;font-weight:650}.panel-body{padding:23px 25px}.toolbar,.actions,.save-bar{display:flex;gap:10px;flex-wrap:wrap}.btn{appearance:none;border:0;border-radius:15px;padding:11px 16px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;font-weight:900;cursor:pointer;text-decoration:none;box-shadow:var(--soft);transition:transform .16s ease,box-shadow .16s ease,filter .16s ease,opacity .16s ease;letter-spacing:-.01em}.btn:hover{transform:translateY(-1px);box-shadow:0 16px 34px rgba(37,99,235,.20);filter:saturate(1.08)}.btn:active{transform:translateY(0);box-shadow:0 8px 18px rgba(37,99,235,.14)}.btn:disabled,.is-busy .btn{cursor:wait;opacity:.62;transform:none}.btn.secondary{background:#0f172a;box-shadow:0 12px 26px rgba(15,23,42,.16)}.btn.ghost{background:#fff;color:#334155;border:1px solid #dbe6f4;box-shadow:0 8px 20px rgba(15,23,42,.06)}.btn.danger{background:linear-gradient(135deg,#f43f5e,#dc2626);box-shadow:0 12px 26px rgba(225,29,72,.16)}.notice{margin-bottom:16px;padding:13px 15px;border-radius:18px;font-weight:800;border:1px solid transparent}.notice.ok{background:#ecfdf5;color:#166534;border-color:#bbf7d0}.notice.err{background:#fff1f2;color:#9f1239;border-color:#fecdd3}.notice.warn{background:#fffbeb;color:#92400e;border-color:#fde68a}.top-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}.top-grid.compact{grid-template-columns:minmax(180px,260px);margin-bottom:20px}.field span,label span{display:block;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#475569;margin-bottom:8px}.route-card label:not(.switch),.top-grid label,.subgrid label{display:block}.route-card input,.route-card select,.route-card textarea,.top-grid input,.top-grid select,.subgrid input,.subgrid select,.subgrid textarea{width:100%;border:1px solid #dbe6f3;border-radius:16px;padding:12px 13px;background:linear-gradient(180deg,#fff,#fbfdff);color:var(--ink);font:inherit;outline:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 1px 2px rgba(15,23,42,.02);transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}.route-card input:hover,.route-card select:hover,.route-card textarea:hover,.top-grid input:hover,.top-grid select:hover,.subgrid input:hover,.subgrid textarea:hover{border-color:#b9c8dc}.route-card input:focus,.route-card select:focus,.route-card textarea:focus,.top-grid input:focus,.top-grid select:focus,.subgrid input:focus,.subgrid textarea:focus{border-color:#60a5fa;box-shadow:var(--ring),inset 0 1px 0 rgba(255,255,255,.9);background:#fff}input[readonly]{color:#64748b;background:#f8fafc}textarea{min-height:106px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.55}.route-list{display:grid;gap:18px}.route-card{position:relative;border:1px solid #dbeafe;border-radius:26px;padding:20px;background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(248,251,255,.94));box-shadow:0 14px 38px rgba(30,64,175,.07);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.route-card:hover{border-color:#bfdbfe;box-shadow:0 18px 46px rgba(30,64,175,.10);transform:translateY(-1px)}.route-card:before{content:"";position:absolute;left:20px;right:20px;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(59,130,246,.38),transparent)}.route-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}.route-head strong{display:block;font-size:18px;letter-spacing:-.03em}.route-head small{display:block;color:var(--muted);margin-top:5px;font-weight:650}.meta-row{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.meta-row span{display:inline-flex;margin:0;padding:5px 8px;border-radius:999px;background:#eef6ff;color:#1e40af;border:1px solid #dbeafe;font-size:11px;font-weight:900;letter-spacing:.02em;text-transform:none}.pill{border-radius:999px;padding:8px 11px;font-size:12px;font-weight:900;border:1px solid transparent}.pill.ok{background:#dcfce7;color:#166534;border-color:#bbf7d0}.pill.off{background:#fee2e2;color:#991b1b;border-color:#fecaca}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px}.primary-grid{align-items:end}.advanced-grid{margin-top:15px}.span-2{grid-column:span 2}.grid.two{grid-template-columns:1fr 1fr;margin-top:15px}.route-warning{margin-top:15px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:16px;padding:12px 14px;font-size:13px;font-weight:800;line-height:1.55}.advanced{margin-top:16px;border:1px solid #dbeafe;border-radius:20px;background:rgba(248,251,255,.72);overflow:hidden}.advanced summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;cursor:pointer;font-weight:900;color:#1e293b}.advanced summary::-webkit-details-marker{display:none}.advanced summary:after{content:"⌄";color:#64748b;transition:.16s ease}.advanced[open] summary:after{transform:rotate(180deg)}.advanced summary b{font-size:12px;color:#64748b;font-weight:800}.advanced>div{padding:0 16px 16px}.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #dbe6f3;border-radius:18px;padding:12px 13px;background:linear-gradient(180deg,#fff,#f8fbff);min-height:68px}.switch input{appearance:none;width:42px;height:24px;border-radius:999px;border:1px solid #cbd5e1;background:#cbd5e1;position:relative;cursor:pointer;transition:.18s ease;flex:0 0 auto}.switch input:before{content:"";position:absolute;width:18px;height:18px;border-radius:50%;left:2px;top:2px;background:#fff;box-shadow:0 2px 6px rgba(15,23,42,.22);transition:.18s ease}.switch input:checked{background:linear-gradient(135deg,#2563eb,#7c3aed);border-color:#2563eb}.switch input:checked:before{transform:translateX(18px)}.actions{margin-top:16px;justify-content:flex-end}.save-bar{margin-top:18px;justify-content:flex-end;padding-top:16px;border-top:1px solid var(--line)}.empty{border:1px dashed #cbd5e1;border-radius:22px;padding:30px;text-align:center;color:var(--muted);background:rgba(248,250,252,.74);font-weight:750}.subgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.code{background:linear-gradient(180deg,#0f172a,#111827);color:#dbeafe;border:1px solid rgba(148,163,184,.18);border-radius:20px;padding:17px;min-height:150px;white-space:pre-wrap;word-break:break-word;overflow:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}.tcp-badge{display:inline-flex;gap:8px;align-items:center;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.1);border-radius:999px;padding:8px 12px;color:#dbeafe;font-weight:850;font-size:13px;backdrop-filter:blur(14px)}.toast{position:fixed;right:22px;bottom:22px;z-index:30;max-width:min(420px,calc(100vw - 44px));border-radius:16px;padding:13px 16px;font-weight:900;box-shadow:0 18px 42px rgba(15,23,42,.18);animation:toast-in .18s ease}.toast.ok{background:#ecfdf5;color:#166534;border:1px solid #bbf7d0}.toast.err{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3}@keyframes toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@media(max-width:980px){.hero-grid,.stats,.top-grid,.top-grid.compact,.subgrid,.grid,.grid.two{grid-template-columns:1fr}.span-2{grid-column:span 1}.panel-head,.route-head{align-items:flex-start;flex-direction:column}.actions,.save-bar{justify-content:flex-start}}
</style></head><body><div id="consoleRoot" data-console-root>
<section class="hero"><div class="shell"><div class="nav"><div class="brand"><div class="logo">↯</div><div>Proxy Console</div></div><a href="/logout">退出</a></div><div class="hero-grid"><div><div class="eyebrow">HTTP Reverse Proxy</div><h1>Edge upstreams done right.</h1><p>${escapeHtml(runtime.mainDomain)} · admin: ${escapeHtml(runtime.adminHost)}</p><div style="margin-top:18px"><span class="tcp-badge">select fetch or tcp</span></div></div><div class="stats"><div class="stat"><strong>${routes.length}</strong><span>Routes</span></div><div class="stat"><strong>${routes.filter(route => route.enabled).length}</strong><span>Enabled</span></div><div class="stat"><strong>v4</strong><span>KV Schema</span></div></div></div></div></section>
<main class="shell">
  <div class="panel"><div class="panel-head"><div class="panel-title"><h2>Host Routes</h2><p>subdomain → upstream · explicit transport</p></div><div class="toolbar"><button form="routeForm" class="btn" name="_action" value="addRoute">新增 Route</button><button form="routeForm" class="btn secondary" name="_action" value="addGh">添加 GitHub</button></div></div><div class="panel-body">
    ${options.saved ? '<div class="notice ok">配置已保存</div>' : ''}${options.error ? `<div class="notice err">${escapeHtml(options.error)}</div>` : ''}${options.kvBound ? '' : '<div class="notice warn">KV 未绑定，保存会失败</div>'}
    <form method="POST" action="/" id="routeForm"><div class="top-grid compact"><label class="field"><span>No Match</span><select name="noMatchStatus"><option value="404" ${normalized.global.noMatchStatus === 404 ? 'selected' : ''}>404</option><option value="403" ${normalized.global.noMatchStatus === 403 ? 'selected' : ''}>403</option></select></label></div><input type="hidden" name="routeCount" value="${routes.length}">${routes.length ? `<div class="route-list">${routes.map((route, index) => renderRouteCard(route, index, runtime)).join('')}</div>` : '<div class="empty">暂无 Host Route，添加一个 upstream 开始使用。</div>'}<div class="save-bar"><button class="btn" name="_action" value="save">保存配置</button></div></form>
  </div></div>
  <div class="subgrid"><section class="panel"><div class="panel-head"><div class="panel-title"><h2>Preview</h2><p>host + path → upstream request</p></div></div><div class="panel-body"><form method="GET" action="/" data-async-preview="1"><label><span>Host</span><input name="previewHost" value="${escapeHtml(options.previewHost || `gh.${runtime.mainDomain}`)}"></label><label style="margin-top:12px"><span>Path</span><input name="previewPath" value="${escapeHtml(options.previewPath || '/robots.txt')}"></label><button class="btn" style="margin-top:12px">预览</button></form><pre class="code" style="margin-top:14px">${escapeHtml(previewJson)}</pre></div></section><section class="panel"><div class="panel-head"><div class="panel-title"><h2>Presets</h2><p>production-ready examples</p></div></div><div class="panel-body"><pre class="code">${escapeHtml(JSON.stringify({ github: githubPresetRoute() }, null, 2))}</pre></div></section></div>
</main></div>${renderAdminScript()}</body></html>`;
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
      transport: String(form.get(`route_${index}_transport`) || 'fetch').trim(),
      scheme: String(form.get(`route_${index}_scheme`) || 'https').trim(),
      upstreamHost: String(form.get(`route_${index}_upstreamHost`) || '').trim(),
      upstreamPort: Number(form.get(`route_${index}_upstreamPort`) || 0),
      upstreamTimeoutMs: Number(form.get(`route_${index}_upstreamTimeoutMs`) || DEFAULT_UPSTREAM_TIMEOUT_MS),
      upstreamPath: String(form.get(`route_${index}_upstreamPath`) || '').trim(),
      resolveDns: form.get(`route_${index}_resolveDns`) === 'on',
      dnsRecord: String(form.get(`route_${index}_dnsRecord`) || DEFAULT_DNS_RECORD).trim(),
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
      version: 4,
      global: {
        noMatchStatus: Number(form.get('noMatchStatus') || DEFAULT_CONFIG.global.noMatchStatus)
      },
      routes
    }
  };
}

function applyAdminAction(config, action) {
  const next = normalizeConfig({ ...config, version: 4 });
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
    version: 4,
    global: body?.global || {},
    routes: body?.routes || []
  };
}

function renderLandingPage(runtime) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Edge Proxy</title><style>
:root{--ink:#0f172a;--muted:#64748b;--brand:#2563eb;--line:#e2e8f0}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui;color:var(--ink);background:#f8fafc}.hero{min-height:100vh;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 15% 12%,rgba(14,165,233,.32),transparent 30%),radial-gradient(circle at 85% 10%,rgba(124,58,237,.28),transparent 30%),linear-gradient(135deg,#eff6ff,#fff)}.card{width:min(980px,100%);background:rgba(255,255,255,.84);border:1px solid rgba(226,232,240,.9);border-radius:32px;box-shadow:0 28px 80px rgba(15,23,42,.12);padding:48px;backdrop-filter:blur(18px)}.badge{display:inline-flex;border:1px solid #bfdbfe;color:#1d4ed8;background:#eff6ff;border-radius:999px;padding:8px 12px;font-weight:850;font-size:13px}.title{font-size:clamp(42px,7vw,86px);line-height:.92;letter-spacing:-.07em;margin:22px 0 18px}.lead{font-size:19px;line-height:1.7;color:var(--muted);max-width:720px;margin:0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}.btn{border:0;border-radius:14px;padding:13px 18px;text-decoration:none;font-weight:850;display:inline-flex}.btn.primary{background:var(--brand);color:#fff;box-shadow:0 14px 30px rgba(37,99,235,.24)}.btn.secondary{background:#0f172a;color:#fff}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:36px}.item{border:1px solid var(--line);border-radius:22px;background:#fff;padding:20px}.item b{display:block;margin-bottom:8px}.item span{color:var(--muted);font-size:14px;line-height:1.6}@media(max-width:760px){.card{padding:28px}.grid{grid-template-columns:1fr}}
</style></head><body><section class="hero"><div class="card"><div class="badge">${escapeHtml(runtime.mainDomain)}</div><h1 class="title">Reverse proxy at the edge.</h1><p class="lead">将每个子域名映射到独立 HTTP/HTTPS upstream，通过 Cloudflare Workers 连接域名或 IP 源站。</p><div class="actions"><a class="btn primary" href="https://${escapeHtml(runtime.adminHost)}">进入控制台</a><a class="btn secondary" href="https://gh.${escapeHtml(runtime.mainDomain)}">GitHub Route</a></div><div class="grid"><div class="item"><b>Virtual Host</b><span>按 Host 匹配子域名。</span></div><div class="item"><b>Hybrid Transport</b><span>标准 HTTP/HTTPS 使用 fetch，特殊场景可选 TCP Sockets。</span></div><div class="item"><b>Headers</b><span>支持请求头转发、删除和覆盖，Host 可通过 Set Headers 定义。</span></div></div></div></section></body></html>`;
}

function renderNotManaged(host, runtime, status = 404) {
  return htmlResponse(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Managed</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020617;color:#e5e7eb;font-family:ui-sans-serif,system-ui}.card{max-width:560px;padding:34px;border:1px solid #1e293b;border-radius:24px;background:#0f172a}code{background:#1e293b;padding:2px 6px;border-radius:6px;color:#bfdbfe}</style></head><body><div class="card"><h1>Host not managed</h1><p><code>${escapeHtml(host)}</code> is not configured under <code>${escapeHtml(runtime.mainDomain)}</code>.</p></div></body></html>`, { status });
}

function renderConfigError(message) {
  return htmlResponse(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configuration Required</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020617;color:#e5e7eb;font-family:ui-sans-serif,system-ui}.card{max-width:620px;padding:34px;border:1px solid #7f1d1d;border-radius:24px;background:#1e0b0b}.muted{color:#fecaca}code{background:#450a0a;padding:2px 6px;border-radius:6px}</style></head><body><div class="card"><h1>Configuration required</h1><p class="muted">${escapeHtml(message)}</p><p>Set <code>MAIN_DOMAIN</code>, <code>ADMIN</code>, and bind KV before production use.</p></div></body></html>`, { status: 500 });
}

function joinPath(basePath, requestPath) {
  const base = basePath && basePath !== '/' ? `/${String(basePath).replace(/^\/+|\/+$/g, '')}` : '';
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  return `${base}${path}` || '/';
}

function buildUpstreamPath(requestUrl, route) {
  const inbound = new URL(requestUrl);
  const path = route.preservePath !== false ? joinPath(route.upstreamPath || '', inbound.pathname) : (route.upstreamPath || '/');
  return `${path || '/'}${inbound.search || ''}`;
}

function buildUpstreamUrl(requestUrl, route) {
  return `${routeOrigin(route)}${buildUpstreamPath(requestUrl, route)}`;
}

function buildPreview(previewHost, previewPath, config, runtime) {
  const path = String(previewPath || '/').startsWith('/') ? String(previewPath || '/') : `/${previewPath}`;
  const request = new Request(`https://${normalizeHostname(previewHost || '')}${path}`);
  const hostInfo = getHostKind(request, runtime);
  if (hostInfo.kind !== 'proxy') {
    return { ok: true, matched: false, host: hostInfo.host, kind: hostInfo.kind, message: 'not a proxy host' };
  }
  const route = findRouteForHost(config, hostInfo);
  if (!route) {
    return { ok: true, matched: false, host: hostInfo.host, subdomain: hostInfo.subdomain, message: 'no host route matched' };
  }
  const dnsNeeded = route.transport === 'tcp' && route.resolveDns && !isIpAddress(route.upstreamHost);
  return {
    ok: true,
    matched: true,
    host: hostInfo.host,
    subdomain: hostInfo.subdomain,
    route: {
      id: route.id,
      name: route.name,
      transport: route.transport,
      scheme: route.scheme,
      upstreamHost: route.upstreamHost,
      upstreamPort: route.upstreamPort,
      upstreamTimeoutMs: route.upstreamTimeoutMs,
      effectiveHostHeader: routeHostHeader(route),
      resolveDns: route.resolveDns,
      dnsRecord: route.dnsRecord
    },
    upstreamRequest: {
      transport: route.transport,
      connectHost: dnsNeeded ? '(resolved by node:dns at request time)' : route.upstreamHost,
      connectPort: route.upstreamPort,
      timeoutMs: route.upstreamTimeoutMs,
      secureTransport: route.transport === 'tcp' ? (route.scheme === 'https' ? 'on' : 'off') : '(fetch managed)',
      requestLine: `GET ${buildUpstreamPath(request.url, route)} HTTP/1.1`,
      effectiveHostHeader: routeHostHeader(route)
    },
    upstreamUrl: buildUpstreamUrl(request.url, route)
  };
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
    const wantsJson = request.headers.get('X-Requested-With') === 'fetch' || request.headers.get('Accept')?.includes('application/json');
    try {
      const parsed = await parseAdminConfigFromForm(request);
      nextConfig = applyAdminAction(parsed.config, parsed.action);
      const savedConfig = await saveConfig(env, nextConfig, runtime);
      if (wantsJson) {
        return jsonResponse({
          ok: true,
          html: renderAdminConsole(savedConfig, runtime, { saved: true, kvBound })
        });
      }
      return redirectResponse('/?saved=1');
    } catch (error) {
      if (wantsJson) {
        return jsonResponse({
          ok: false,
          error: error.message,
          html: renderAdminConsole(nextConfig || config, runtime, { error: error.message, kvBound })
        }, { status: 400 });
      }
      return htmlResponse(renderAdminConsole(nextConfig || config, runtime, { error: error.message, kvBound }), { status: 400 });
    }
  }

  return new Response('Method Not Allowed\n', { status: 405 });
}

function canHaveBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

async function getReusableBody(request) {
  if (!canHaveBody(request.method) || !request.body) return new Uint8Array();
  return new Uint8Array(await request.clone().arrayBuffer());
}

function appendHeaderLine(lines, key, value) {
  const cleanKey = String(key || '').trim();
  const cleanValue = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (cleanKey && validateHeaderName(cleanKey)) lines.push(`${cleanKey}: ${cleanValue}`);
}

function sanitizeRequestHeaders(request, route, bodyLength, options = {}) {
  const headers = new Headers();
  const sourceHeaders = route.headers.forwardClientHeaders ? request.headers : new Headers();
  for (const [key, value] of sourceHeaders.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'host' || !HOP_BY_HOP_HEADERS.includes(lower)) headers.set(key, value);
  }
  for (const headerName of route.headers.remove) headers.delete(headerName);
  headers.delete('Host');
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', new URL(request.url).protocol.replace(':', ''));
  const clientIp = request.headers.get('CF-Connecting-IP');
  const previousForwardedFor = request.headers.get('X-Forwarded-For');
  const nextForwardedFor = [previousForwardedFor, clientIp].filter(Boolean).join(', ');
  if (nextForwardedFor) headers.set('X-Forwarded-For', nextForwardedFor);
  if (clientIp) headers.set('X-Real-IP', clientIp);
  for (const [key, value] of Object.entries(route.headers.set)) {
    headers.set(key, value);
  }
  if (options.transport === 'tcp') {
    if (!headers.has('Host')) headers.set('Host', routeHostHeader(route));
    headers.set('Connection', 'close');
    if (bodyLength > 0) headers.set('Content-Length', String(bodyLength));
  }
  if (bodyLength <= 0) headers.delete('Content-Length');
  return headers;
}

function buildTcpHttpRequest(request, route, bodyBytes) {
  const path = buildUpstreamPath(request.url, route);
  const lines = [`${request.method.toUpperCase()} ${path} HTTP/1.1`];
  const headers = sanitizeRequestHeaders(request, route, bodyBytes.byteLength, { transport: 'tcp' });
  for (const [key, value] of headers.entries()) appendHeaderLine(lines, key, value);
  const head = `${lines.join('\r\n')}\r\n\r\n`;
  return new TextEncoder().encode(head);
}

function concatUint8Arrays(chunks, totalLength = null) {
  const size = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function findHeaderEnd(buffer) {
  for (let index = 0; index <= buffer.byteLength - 4; index++) {
    if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index;
  }
  return -1;
}

function parseHttpResponseHead(headBytes) {
  const text = new TextDecoder().decode(headBytes);
  const lines = text.split('\r\n');
  const statusLine = lines.shift() || '';
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) throw new ProxyUpstreamError(`Invalid upstream status line: ${statusLine}`, 502, 'BAD_STATUS_LINE');
  const headers = new Headers();
  let transferEncoding = '';
  for (const line of lines) {
    if (!line) continue;
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key.toLowerCase() === 'transfer-encoding') transferEncoding = value;
    if (!UNSAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) headers.append(key, value);
  }
  return { status: Number(match[1]), statusText: match[2] || '', headers, transferEncoding };
}

async function readResponseHead(reader) {
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new ProxyUpstreamError('Upstream closed before response headers', 502, 'NO_RESPONSE_HEAD');
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_HEADER_BYTES) throw new ProxyUpstreamError('Upstream response headers too large', 502, 'HEADER_TOO_LARGE');
    const buffer = concatUint8Arrays(chunks, total);
    const headerEnd = findHeaderEnd(buffer);
    if (headerEnd >= 0) {
      return {
        headBytes: buffer.slice(0, headerEnd),
        remainder: buffer.slice(headerEnd + 4)
      };
    }
  }
}

function makePrefixedStream(prefix, reader) {
  let prefixSent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        if (prefix && prefix.byteLength > 0) {
          controller.enqueue(prefix);
          return;
        }
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    }
  });
}

function makeContentLengthStream(prefix, reader, length) {
  let remaining = Math.max(0, Number(length) || 0);
  let prefixOffset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        try { await reader.cancel(); } catch {}
        return;
      }
      if (prefixOffset < prefix.byteLength) {
        const take = Math.min(remaining, prefix.byteLength - prefixOffset);
        controller.enqueue(prefix.slice(prefixOffset, prefixOffset + take));
        prefixOffset += take;
        remaining -= take;
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const take = Math.min(remaining, chunk.byteLength);
      controller.enqueue(take === chunk.byteLength ? chunk : chunk.slice(0, take));
      remaining -= take;
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    }
  });
}

function makeBufferedReader(prefix, reader) {
  let buffer = prefix || new Uint8Array();
  let doneReading = false;
  async function fill(minBytes = 1) {
    while (!doneReading && buffer.byteLength < minBytes) {
      const { value, done } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      buffer = concatUint8Arrays([buffer, chunk]);
    }
  }
  return {
    async readLine(maxBytes = MAX_CHUNK_LINE_BYTES) {
      while (true) {
        for (let i = 0; i < buffer.byteLength - 1; i++) {
          if (buffer[i] === 13 && buffer[i + 1] === 10) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            return new TextDecoder().decode(line);
          }
        }
        if (buffer.byteLength > maxBytes) throw new ProxyUpstreamError('Chunk line too large', 502, 'CHUNK_LINE_TOO_LARGE');
        if (doneReading) {
          if (buffer.byteLength === 0) return null;
          const line = buffer;
          buffer = new Uint8Array();
          return new TextDecoder().decode(line);
        }
        await fill(buffer.byteLength + 1);
      }
    },
    async readExact(size) {
      await fill(size);
      const take = Math.min(size, buffer.byteLength);
      const out = buffer.slice(0, take);
      buffer = buffer.slice(take);
      return out;
    },
    async discardCrlf() {
      await this.readExact(2);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    }
  };
}

function makeChunkedDecodedStream(prefix, reader) {
  const buffered = makeBufferedReader(prefix, reader);
  let currentChunkRemaining = 0;
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      while (currentChunkRemaining === 0) {
        const line = await buffered.readLine();
        if (line === null) {
          finished = true;
          controller.close();
          return;
        }
        const sizeText = line.split(';')[0].trim();
        currentChunkRemaining = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(currentChunkRemaining) || currentChunkRemaining < 0) {
          throw new ProxyUpstreamError(`Invalid chunk size: ${line}`, 502, 'BAD_CHUNK_SIZE');
        }
        if (currentChunkRemaining === 0) {
          while (true) {
            const trailer = await buffered.readLine();
            if (trailer === null || trailer === '') break;
          }
          finished = true;
          controller.close();
          return;
        }
      }
      const chunk = await buffered.readExact(Math.min(currentChunkRemaining, 64 * 1024));
      currentChunkRemaining -= chunk.byteLength;
      if (currentChunkRemaining === 0) await buffered.discardCrlf();
      if (chunk.byteLength > 0) controller.enqueue(chunk);
    },
    async cancel(reason) {
      await buffered.cancel(reason);
    }
  });
}

async function resolveDnsTarget(route) {
  const host = formatConnectHostname(route.upstreamHost);
  if (!route.resolveDns || isIpAddress(host)) {
    return { connectHost: host, resolved: false, family: isIPv6(host) ? 6 : isIPv4(host) ? 4 : null, addresses: [host] };
  }
  const attempts = route.dnsRecord === 'A'
    ? [{ family: 4, fn: () => dns.promises.resolve4(host) }]
    : route.dnsRecord === 'AAAA'
      ? [{ family: 6, fn: () => dns.promises.resolve6(host) }]
      : [{ family: 4, fn: () => dns.promises.resolve4(host) }, { family: 6, fn: () => dns.promises.resolve6(host) }];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const addresses = (await attempt.fn()).filter(Boolean);
      if (addresses.length > 0) return { connectHost: addresses[0], resolved: true, family: attempt.family, addresses };
    } catch (error) {
      errors.push(`${attempt.family === 4 ? 'A' : 'AAAA'}: ${error.message}`);
    }
  }
  throw new ProxyUpstreamError(`DNS resolve failed for ${host}${errors.length ? ` (${errors.join('; ')})` : ''}`, 502, 'DNS_FAILED');
}

function addProxyDiagnosticHeaders(headers, route, extra = {}) {
  const transport = extra.transport || 'tcp';
  headers.set('X-Proxy-Route-Id', route.id);
  headers.set('X-Proxy-Route-Name', route.name);
  headers.set('X-Proxy-Upstream', routeOrigin(route));
  headers.set('X-Proxy-Transport', transport);
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'transport') continue;
    if (value !== undefined && value !== null) headers.set(key, String(value));
  }
}

function upstreamErrorResponse(error, route) {
  const status = Number(error?.status || 502);
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  addProxyDiagnosticHeaders(headers, route, { 'X-Proxy-Error-Code': error?.code || 'UPSTREAM_ERROR' });
  return new Response(`Bad Gateway: ${error?.message || String(error)}\n`, { status, headers });
}

function withUpstreamTimeout(promise, timeoutMs, message, code = 'UPSTREAM_TIMEOUT') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProxyUpstreamError(message, 504, code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeTcpProxyError(error, route) {
  if (!isStandardHttpTransport(route)) return error;
  const message = String(error?.message || error || '');
  const shouldExplainFetch =
    error?.code === 'NO_RESPONSE_HEAD' ||
    /http-based service|consider using fetch|upstream closed before response headers/i.test(message);
  if (!shouldExplainFetch) return error;
  return new ProxyUpstreamError(
    `TCP Socket cannot proxy standard ${route.scheme.toUpperCase()} port ${route.upstreamPort} reliably on Cloudflare Workers. Switch this route Transport to Fetch in the admin console. Original error: ${message}`,
    Number(error?.status || 502),
    'TCP_HTTP_PORT_REQUIRES_FETCH'
  );
}


async function proxyFetchHttp(request, route) {
  const bodyBytes = await getReusableBody(request);
  const targetUrl = buildUpstreamUrl(request.url, route);
  const headers = sanitizeRequestHeaders(request, route, bodyBytes.byteLength, { transport: 'fetch' });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), route.upstreamTimeoutMs);
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: bodyBytes.byteLength > 0 ? bodyBytes : undefined,
      redirect: 'manual',
      signal: controller.signal,
      cf: { scrapeShield: false }
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ProxyUpstreamError(`Fetch upstream timed out after ${route.upstreamTimeoutMs}ms`, 504, 'UPSTREAM_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  const responseHeaders = new Headers(upstreamResponse.headers);
  addProxyDiagnosticHeaders(responseHeaders, route, { transport: 'fetch' });
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}

async function proxyTcpHttp(request, route) {
  const bodyBytes = await getReusableBody(request);
  const dnsTarget = await resolveDnsTarget(route);
  const timeoutMs = route.upstreamTimeoutMs;
  const socket = connect(
    { hostname: dnsTarget.connectHost, port: Number(route.upstreamPort) },
    { secureTransport: route.scheme === 'https' ? 'on' : 'off' }
  );

  await withUpstreamTimeout(
    socket.opened,
    timeoutMs,
    `TCP upstream connect timed out after ${timeoutMs}ms`,
    'UPSTREAM_CONNECT_TIMEOUT'
  );
  const writer = socket.writable.getWriter();
  try {
    await withUpstreamTimeout(
      writer.write(buildTcpHttpRequest(request, route, bodyBytes)),
      timeoutMs,
      `TCP upstream request write timed out after ${timeoutMs}ms`,
      'UPSTREAM_WRITE_TIMEOUT'
    );
    if (bodyBytes.byteLength > 0) {
      await withUpstreamTimeout(
        writer.write(bodyBytes),
        timeoutMs,
        `TCP upstream body write timed out after ${timeoutMs}ms`,
        'UPSTREAM_WRITE_TIMEOUT'
      );
    }
  } catch (error) {
    try { writer.releaseLock(); } catch {}
    throw error;
  } finally {
    try { writer.releaseLock(); } catch {}
  }

  const reader = socket.readable.getReader();
  const { headBytes, remainder } = await withUpstreamTimeout(
    readResponseHead(reader),
    timeoutMs,
    `TCP upstream response headers timed out after ${timeoutMs}ms`,
    'UPSTREAM_HEADER_TIMEOUT'
  );
  const parsed = parseHttpResponseHead(headBytes);
  const responseHeaders = new Headers(parsed.headers);
  const contentLength = responseHeaders.get('Content-Length');
  const transferEncoding = parsed.transferEncoding || '';
  let bodyStream;
  if (/chunked/i.test(transferEncoding)) {
    responseHeaders.delete('Transfer-Encoding');
    responseHeaders.delete('Content-Length');
    bodyStream = makeChunkedDecodedStream(remainder, reader);
  } else if (contentLength !== null && /^\d+$/.test(contentLength)) {
    bodyStream = makeContentLengthStream(remainder, reader, Number(contentLength));
  } else {
    bodyStream = makePrefixedStream(remainder, reader);
  }
  addProxyDiagnosticHeaders(responseHeaders, route, {
    'X-Proxy-Connect-Host': dnsTarget.connectHost,
    'X-Proxy-DNS-Resolved': dnsTarget.resolved ? '1' : '0',
    'X-Proxy-DNS-Family': dnsTarget.family || ''
  });
  const mustNotHaveBody = request.method === 'HEAD' || [101, 204, 205, 304].includes(parsed.status);
  if (mustNotHaveBody) {
    try { await reader.cancel(); } catch {}
  }
  return new Response(mustNotHaveBody ? null : bodyStream, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: responseHeaders
  });
}

async function handleProxyRequest(request, env, runtime, hostInfo) {
  const config = await getConfig(env);
  const route = findRouteForHost(config, hostInfo);
  if (!route) return renderNotManaged(hostInfo.host, runtime, config.global.noMatchStatus);
  if (route.transport === 'fetch') {
    try {
      return await proxyFetchHttp(request, route);
    } catch (error) {
      console.log(`Fetch proxy failed route=${route.id}: ${error.stack || error.message}`);
      return upstreamErrorResponse(error, route);
    }
  }
  try {
    return await proxyTcpHttp(request, route);
  } catch (error) {
    console.log(`TCP proxy failed route=${route.id}: ${error.stack || error.message}`);
    return upstreamErrorResponse(normalizeTcpProxyError(error, route), route);
  }
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
