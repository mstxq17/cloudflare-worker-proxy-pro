# Cloudflare Worker Proxy Pro

Cloudflare Worker Proxy Pro 是一个运行在 **Cloudflare Workers + KV** 上的 Host-based 反向代理控制台。每个子域名对应一条虚拟主机规则，Worker 根据请求 Host 匹配上游；标准 HTTP/HTTPS 端口使用 Worker `fetch()`，需要非标准端口或特殊 TCP 场景时使用 TCP Sockets。

## 产品能力

- Host-based routing：按子域名匹配代理规则
- Admin console：`admin.<MAIN_DOMAIN>` 独立后台入口
- Hybrid upstream：标准 HTTP/HTTPS 使用 `fetch()`，特殊场景使用 `cloudflare:sockets`
- DNS resolve：域名上游可通过 `node:dns` 的 `resolve4/resolve6` 解析后连接
- IP origin：支持直接代理到 IP 源站
- Header policy：支持请求头转发、删除、覆盖；`Host` 可通过 `headers.set` 定义
- KV storage：代理规则保存到 Cloudflare KV

## 域名模型

以 `MAIN_DOMAIN=rad0.indevs.in` 为例：

| 域名 | 作用 |
|---|---|
| `admin.rad0.indevs.in` | 后台控制台 |
| `proxy.rad0.indevs.in` | 产品落地页 |
| `gh.rad0.indevs.in` | 代理到 GitHub 上游 |

运行时分流：

```text
admin.<MAIN_DOMAIN>  -> 后台控制台
proxy.<MAIN_DOMAIN>  -> 产品落地页
<sub>.<MAIN_DOMAIN>  -> Host Route 代理
其他 Host            -> 404 Not Managed
```

## Cloudflare 配置

### 1. 创建 KV Namespace

在 Cloudflare Dashboard 创建一个 KV Namespace，例如：

```text
cloudflare-worker-proxy-pro-config
```

Dashboard 部署时可以直接选择 namespace 绑定到 Worker。

使用 `wrangler.toml` 部署时必须填写 Cloudflare 提供的真实 Namespace ID：

```toml
[[kv_namespaces]]
binding = "KV"
id = "your-real-kv-namespace-id"
```

`binding = "KV"` 是 Worker 代码里的运行时变量名；`id` 是 Cloudflare KV Namespace ID，不是 namespace 名称。

### 2. 绑定 Custom Domains

将后台、落地页和所有代理子域名都绑定到同一个 Worker：

```text
admin.rad0.indevs.in
proxy.rad0.indevs.in
gh.rad0.indevs.in
```

也可以使用 Worker Routes 覆盖通配子域名，例如 `*.rad0.indevs.in/*`，但需要确保请求最终进入同一个 Worker。

### 3. 配置环境变量

必须配置：

```text
MAIN_DOMAIN=rad0.indevs.in
ADMIN=your-admin-password
```

可选配置：

```text
ADMIN_SUBDOMAIN=admin
LANDING_SUBDOMAIN=proxy
```

## wrangler.toml

推荐配置：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "KV"
id = "your-real-kv-namespace-id"
```

`nodejs_compat` 用于启用 Workers Node.js DNS API。项目会自动查找以下 KV binding：

```text
CONFIG_KV
CF_ACCEL_KV
ACCEL_KV
KV
```

## 安装与部署

安装依赖：

```bash
npm install
```

本地开发：

```bash
npm run dev
```

部署检查：

```bash
npm run deploy:dry
```

发布到 Cloudflare Workers：

```bash
npm run deploy
```

## 首次使用

访问后台：

```text
https://admin.rad0.indevs.in
```

使用 `ADMIN` 环境变量中的密码登录，然后创建 Host Route。

### 域名上游示例

```text
subdomain: gh
transport: fetch
scheme: https
upstreamHost: github.com
upstreamPort: 443
upstreamTimeoutMs: 15000
resolveDns: enabled
dnsRecord: auto
```

访问：

```text
https://gh.rad0.indevs.in/robots.txt
```

## Host Route 字段

| 字段 | 说明 |
|---|---|
| `id` | 规则 ID |
| `name` | 显示名称 |
| `subdomain` | 子域名前缀，例如 `gh` |
| `transport` | 代理方式，`fetch` 或 `tcp` |
| `scheme` | 上游协议，`http` 或 `https` |
| `upstreamHost` | 上游域名或 IP |
| `upstreamPort` | 上游端口，HTTP 默认 `80`，HTTPS 默认 `443` |
| `upstreamTimeoutMs` | 上游超时时间，默认 `15000`，范围 `1000-120000` |
| `resolveDns` | 域名上游是否先执行 DNS 解析 |
| `dnsRecord` | DNS 记录偏好：`auto`、`A`、`AAAA` |
| `upstreamPath` | 可选上游基础路径 |
| `preservePath` | 是否保留客户端请求 path 和 query |
| `headers.forwardClientHeaders` | 是否转发客户端请求头 |
| `headers.set` | 覆盖或新增请求头 |
| `headers.remove` | 删除请求头 |

## TCP Sockets 限制

Cloudflare Workers TCP Sockets 不适合代理标准 HTTP/HTTPS 网站端口。后台可以为每条规则显式选择 `fetch` 或 `tcp`；标准网站反向代理建议使用 `fetch`，特殊端口或特殊 TCP 场景再选择 `tcp`。TCP Sockets 仍遵循平台限制：不能连接 Cloudflare IP、`localhost`、部分私网或被平台禁止的地址；DNS 请求会计入 Worker subrequest limit。

HTTPS 域名上游默认可启用 DNS 解析。若源站强依赖 TLS SNI 且解析到 IP 后握手失败，可在后台关闭 `resolveDns`，让 TCP TLS 直接连接域名。

## 许可

本项目采用非商业使用许可。未经版权持有人书面授权，禁止将本项目或其衍生作品用于销售、付费服务、SaaS、托管平台、商业产品或其他直接商业获利场景。完整条款见 `LICENSE`。

## 检查

```bash
npm run check
```
