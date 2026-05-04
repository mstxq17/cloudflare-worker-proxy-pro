# Cloudflare Worker Proxy Pro

Cloudflare Worker Proxy Pro 是一个基于 **Cloudflare Workers + KV** 的 Host-based 反向代理控制台。它使用子域名作为虚拟主机入口，将不同 Host 映射到不同 upstream，适合把多个代理服务统一部署在同一个 Worker 上。

## 核心能力

- Host-based routing：按请求 Host 匹配，不使用路径前缀作为主路由模型
- Admin domain console：通过 `admin.<MAIN_DOMAIN>` 管理所有代理规则
- KV configuration：代理规则保存到 Cloudflare KV
- Upstream proxy：支持 `http://` 与 `https://` upstream
- Header policy：支持请求头转发、删除、覆盖
- Preview：后台预览 `host + path -> upstream URL`

## 域名模型

以主域名 `rad0.indevs.in` 为例：

| 域名 | 作用 |
|---|---|
| `admin.rad0.indevs.in` | 后台控制台 |
| `proxy.rad0.indevs.in` | 产品落地页 |
| `gh.rad0.indevs.in` | Host Route，代理到 `https://github.com` |
| `api.rad0.indevs.in` | Host Route，代理到自定义 API upstream |

代理示例：

```text
https://gh.rad0.indevs.in/robots.txt
  -> https://github.com/robots.txt
```

## 项目文件

```text
.
├── worker.js
├── wrangler.toml
├── package.json
├── package-lock.json
└── README.md
```

## Cloudflare 准备

### 1. 创建 KV Namespace

在 Cloudflare Dashboard 创建一个 KV Namespace，例如：

```text
cloudflare-worker-proxy-pro-config
```

如果使用 Dashboard 绑定，可以直接选择这个 namespace。

如果使用 `wrangler.toml` 部署，需要复制 Cloudflare 提供的 Namespace ID。

### 2. 绑定 Custom Domains

将需要的子域名全部绑定到同一个 Worker：

```text
admin.rad0.indevs.in
proxy.rad0.indevs.in
gh.rad0.indevs.in
api.rad0.indevs.in
```

Cloudflare 路由应确保这些 Host 的请求都进入同一个 Worker。

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

默认值：

| 变量 | 默认值 |
|---|---|
| `MAIN_DOMAIN` | `rad0.indevs.in` |
| `ADMIN_SUBDOMAIN` | `admin` |
| `LANDING_SUBDOMAIN` | `proxy` |

## wrangler 配置

推荐 `wrangler.toml`：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "KV"
id = "your-real-kv-namespace-id"
```

说明：

- `binding = "KV"` 是 Worker 运行时变量名
- `id` 必须是 Cloudflare KV Namespace ID
- 不能把 `id` 写成 namespace 名称

Worker 代码会自动查找以下 KV binding：

```text
CONFIG_KV
CF_ACCEL_KV
ACCEL_KV
KV
```

## 安装

```bash
npm install
```

## 本地开发

```bash
npm run dev
```

默认端口：

```text
http://localhost:8787
```

本地开发时可通过请求不同 Host 测试虚拟主机逻辑。

## 部署

执行 dry-run：

```bash
npm run deploy:dry
```

发布到 Cloudflare Workers：

```bash
npm run deploy
```

## 首次配置

1. 访问后台域名：

```text
https://admin.rad0.indevs.in
```

2. 使用 `ADMIN` 环境变量中的密码登录。

3. 添加 Host Route，例如：

```text
subdomain: gh
origin: https://github.com
```

4. 保存配置。

5. 测试代理：

```text
https://gh.rad0.indevs.in/robots.txt
```

## Host Route 字段

| 字段 | 说明 |
|---|---|
| `id` | 规则 ID |
| `name` | 显示名称 |
| `subdomain` | 子域名前缀，例如 `gh` |
| `origin` | upstream，例如 `https://github.com` |
| `enabled` | 是否启用 |
| `preservePath` | 是否保留请求 path 和 query |
| `headers.forwardClientHeaders` | 是否转发客户端请求头 |
| `headers.set` | 覆盖或新增请求头 |
| `headers.remove` | 删除请求头 |

## 运行时行为

```text
admin.<MAIN_DOMAIN>  -> 后台控制台
proxy.<MAIN_DOMAIN>  -> 产品落地页
<sub>.<MAIN_DOMAIN>  -> 查询 Host Route 并代理
其他 Host            -> 404 Not Managed
```

旧的 path-based 路由不再保留。`/gh`、`/admin` 等路径不会在非 admin host 上触发代理或后台兼容逻辑。

## 检查

```bash
npm run check
```
