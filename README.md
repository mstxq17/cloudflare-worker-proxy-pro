# cloudflare-worker-proxy-pro

一个运行在 **Cloudflare Workers** 上的带后台反向代理：

- 后台入口：`/login` → `/admin`
- 后台内置规则测试器
- 后台支持**表单化规则管理**
- 一键添加 **`/gh` 预置规则**
- 后台认证：环境变量 `ADMIN`
- 配置存储：Cloudflare KV
- 规则能力：
  - 自定义 path regex
  - `http://` / `https://` upstream
  - path rewrite
  - 请求头转发 / 删除 / 覆盖
- 系统保留路由：
  - `/login`
  - `/logout`
  - `/admin`
  - `/api/admin/*`

## 目录

```text
.
├── worker.js
├── wrangler.toml
├── package.json
├── package-lock.json
└── README.md
```

## 安装

```bash
npm install
```

## 本地开发

```bash
npm run dev
```

默认会启动：

- `wrangler dev --local --port 8787`

> 首次运行前请先配置 KV 绑定和 `ADMIN` 环境变量。

## 部署前准备

1. 创建一个 Cloudflare Worker
2. 创建一个 KV Namespace
3. 在 `wrangler.toml` 或 Cloudflare Dashboard 中绑定 KV：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "your-kv-namespace-id"
```

> 代码会自动查找这些绑定名之一：`CONFIG_KV` / `CF_ACCEL_KV` / `ACCEL_KV` / `KV`

4. 设置环境变量：

```text
ADMIN=your-admin-password
```

## 发布

```bash
npm run deploy:dry
npm run deploy
```

## 启动方式

把 `worker.js` 部署到 Cloudflare Workers 后：

- 访问 `/login` 登录后台
- 登录成功后进入 `/admin`
- 在后台修改全局设置和规则
- 保存后配置写入 KV key：`proxy:settings`

## 后台功能

### 表单化规则管理

`/admin` 页面支持：

- 新增空规则
- 删除规则
- 规则上移 / 下移
- 修改：
  - `id`
  - `name`
  - `priority`
  - `enabled`
  - `match.pattern`
  - `match.flags`
  - `target.origin`
  - `target.pathTemplate`
  - `headers.forwardClientHeaders`
  - `headers.set`
  - `headers.remove`

### `/gh` 预置规则

后台按钮 **“添加 /gh 预置”** 会生成：

- path: `/gh` / `/gh/*`
- upstream: `https://github.com`

对应规则：

```json
{
  "id": "gh",
  "name": "GitHub Root Proxy",
  "enabled": true,
  "priority": 10,
  "match": {
    "pattern": "^/gh(?:/(.*))?$",
    "flags": ""
  },
  "target": {
    "origin": "https://github.com",
    "pathTemplate": "/$1"
  },
  "headers": {
    "forwardClientHeaders": true,
    "set": {},
    "remove": []
  }
}
```

效果：

- `/gh` → `https://github.com/`
- `/gh/robots.txt` → `https://github.com/robots.txt`

## 配置结构

后台保存的是单个 JSON 文档，结构如下：

```json
{
  "version": 1,
  "updatedAt": "2026-05-04T12:00:00.000Z",
  "global": {
    "noMatchStatus": 404,
    "followRedirects": true,
    "maxRedirects": 5
  },
  "rules": [
    {
      "id": "api",
      "name": "API Proxy",
      "enabled": true,
      "priority": 10,
      "match": {
        "pattern": "^/api/(.*)$",
        "flags": ""
      },
      "target": {
        "origin": "https://backend.example.com",
        "pathTemplate": "/$1"
      },
      "headers": {
        "forwardClientHeaders": true,
        "set": {
          "X-Proxy-By": "cloudflare-worker-proxy-pro"
        },
        "remove": [
          "Cookie"
        ]
      }
    }
  ]
}
```

## 规则说明

### 匹配顺序

- 先处理系统保留路由
- 再对 `rules` 按 `priority` 升序排序
- 第一个命中的启用规则生效

### path rewrite

示例：

- 请求路径：`/api/user/42?full=1`
- 正则：`^/api/(.*)$`
- `pathTemplate`: `/$1`
- upstream：`https://backend.example.com`

最终转发到：

```text
https://backend.example.com/user/42?full=1
```

### 请求头处理顺序

1. 清洗 hop-by-hop / 不安全代理头
2. 设置 `Host` 为 upstream host
3. 注入：
   - `X-Forwarded-Host`
   - `X-Forwarded-Proto`
   - `X-Forwarded-For`
   - `X-Real-IP`
4. 应用规则中的 `remove`
5. 应用规则中的 `set`（最终覆盖）

## 后台接口

### HTML

- `GET /login`
- `POST /login`
- `GET /admin`
- `POST /admin`
- `GET /logout`

### JSON API

- `GET /api/admin/config`
- `POST /api/admin/config`
- `POST /api/admin/test-match`

`POST /api/admin/config` 的 body 直接使用配置 JSON。

`POST /api/admin/test-match` 示例：

```json
{
  "path": "/api/hello?x=1"
}
```

返回会包含：

- 是否命中规则
- 命中的规则信息
- 最终 upstream URL
- 请求头预览
- 或保留路由/未命中的说明

## 首次部署建议

先在后台点击 **“添加 /gh 预置”**，保存后直接测试：

- `/gh`
- `/gh/robots.txt`

## 已验证场景

本地已验证这些代表性行为：

- 后台未登录访问 `/admin` 会跳转 `/login`
- 正确 `ADMIN` 密码可登录并写入签名 Cookie
- `GET /api/admin/config` 可读 KV 配置
- `POST /api/admin/config` 可保存 KV 配置
- 无命中时返回配置指定状态码（`403` / `404`）
- regex 路由支持 query string 保留
- 自定义请求头覆盖生效
- 指定请求头删除生效
- `Host` 会改写为 upstream host
- 开启 `followRedirects` 时会跟随上游重定向
- `/api/admin/test-match` 可预览命中规则和最终 upstream
- `/gh -> https://github.com` 已实际代理成功

## 检查

```bash
npm run check
```
