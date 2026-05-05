# Cloudflare Worker Proxy Pro

Cloudflare Worker Proxy Pro 是一个运行在 **Cloudflare Workers + KV** 上的 Host-based 反向代理控制台。每个子域名对应一条虚拟主机规则，Worker 根据请求 Host 匹配上游；标准 HTTP/HTTPS 端口使用 Worker `fetch()`，需要非标准端口或特殊 TCP 场景时使用 TCP Sockets。

## 产品能力

- Host-based routing：按子域名匹配代理规则
- Admin console：`admin.<MAIN_DOMAIN>` 独立后台入口
- Hybrid upstream：标准 HTTP/HTTPS 使用 `fetch()`，特殊场景使用 `cloudflare:sockets`
- DNS resolve：域名上游可通过 `node:dns` 的 `resolve4/resolve6` 解析后连接
- IP origin：支持直接代理到 IP 源站
- Header policy：支持请求头转发、删除、覆盖；`Host` 可通过 `headers.set` 定义
- Upstream health：后台显示每条规则的上游响应状态、HTTP 状态码与延迟
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

部署前先准备好 Cloudflare 侧资源：

1. 创建 KV Namespace，并把真实 `id` 填入 `wrangler.toml`。
2. 配置 `MAIN_DOMAIN`、`ADMIN_SUBDOMAIN`、`LANDING_SUBDOMAIN` 等变量。
3. 推荐用 Custom Domains 绑定需要接入 Worker 的域名；如果使用 classic Routes，则对应 DNS 记录必须已在 Cloudflare 中启用代理。

### 方式一：自动部署（推荐）

适合代码仓库部署或本机一键部署。Wrangler 作为项目依赖安装，命令通过 `npx` 调用，不需要全局安装 Wrangler。

```bash
npm install
npx wrangler login
npx wrangler deploy --config wrangler.toml
```

如果已经通过 `CLOUDFLARE_API_TOKEN` 配置了 API Token，可跳过 `npx wrangler login`，适合 CI/CD 自动部署：

```bash
npm install
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token npx wrangler deploy --config wrangler.toml
```

也可以使用项目脚本：

```bash
npm run deploy:dry
npm run deploy
```

> 如果你的真实域名、KV ID 或后台密码不希望写入公开仓库，可以复制一份本地配置，例如 `wrangler.local.toml`，然后执行 `npx wrangler deploy --config wrangler.local.toml`。

### 方式二：手动部署

适合不使用项目依赖、直接在服务器或本机环境中手动操作。先全局安装并登录 Wrangler：

```bash
npm install -g wrangler
wrangler login
wrangler deploy --config wrangler.toml
```

如果使用本地私有配置文件：

```bash
wrangler deploy --config wrangler.local.toml
```

### 本地开发与检查

安装依赖：

```bash
npm install
```

本地开发：

```bash
npm run dev
```

部署前检查：

```bash
npm run check
npm run deploy:dry
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
locationPath: /
transport: fetch
upstreamProxyPass: https://github.com
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
| `locationPath` | Host 内的路径前缀，默认 `/`，多条同 Host 规则按最长前缀优先匹配 |
| `transport` | 代理方式，`fetch` 或 `tcp` |
| `upstreamProxyPass` | 完整上游地址，例如 `https://github.com`、`https://api.example.com/v1/`、`http://127.0.0.1:8080/` |
| `upstreamTimeoutMs` | 上游超时时间，默认 `15000`，范围 `1000-120000` |
| `resolveDns` | 域名上游是否先执行 DNS 解析 |
| `dnsRecord` | DNS 记录偏好：`auto`、`A`、`AAAA` |
| `headers.forwardClientHeaders` | 是否转发客户端请求头 |
| `headers.set` | 覆盖或新增请求头 |
| `headers.remove` | 删除请求头 |

## Upstream Proxy Pass 规则

现在后台把原先的 `scheme`、`upstreamHost`、`upstreamPort`、`proxyPassPath` 合并成一个完整字段：`upstreamProxyPass`。

示例：

```text
https://github.com
http://117.50.186.158
https://api.example.com:8443/v1/
http://127.0.0.1:8080/
```

说明：

- 协议、Host/IP、端口、基础 URI 一起由 `upstreamProxyPass` 表达
- `locationPath` 仍然保留，用于定义当前 Host 下匹配哪段请求路径
- 如果 `upstreamProxyPass` 中包含路径前缀，例如 `https://api.example.com/v1/`，则请求会以该前缀作为上游基路径
- 如果同一个 `subdomain` 下存在多条规则，Worker 会选择 `locationPath` 最长的匹配项

例如：

```text
locationPath: /api/
upstreamProxyPass: https://backend.example.com/v1/
```

请求：

```text
/api/user
```

会上游转发为：

```text
https://backend.example.com/v1/api/user
```

## TCP Sockets 限制

Cloudflare Workers TCP Sockets 不适合代理标准 HTTP/HTTPS 网站端口。后台可以为每条规则显式选择 `fetch` 或 `tcp`；标准网站反向代理建议使用 `fetch`，特殊端口或特殊 TCP 场景再选择 `tcp`。TCP Sockets 仍遵循平台限制：不能连接 Cloudflare IP、`localhost`、部分私网或被平台禁止的地址；DNS 请求会计入 Worker subrequest limit。

HTTPS 域名上游默认可启用 DNS 解析。若源站强依赖 TLS SNI 且解析到 IP 后握手失败，可在后台关闭 `resolveDns`，让 TCP TLS 直接连接域名。

## 许可

本项目采用 MIT License。完整条款见 `LICENSE`。

## 检查

```bash
npm run check
```
