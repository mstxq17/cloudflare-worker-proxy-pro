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

---

## 目录

```text
.
├── worker.js
├── wrangler.toml
├── package.json
├── package-lock.json
└── README.md
```

---

## 先解释：什么叫“配置可用的 KV namespace 到 wrangler.toml”

意思是：

> 给这个 Worker 绑定一个 **Cloudflare KV 命名空间**，让代码里的 `env.CONFIG_KV` 真正指向一块可读写的 KV 存储。

因为这个项目的后台配置不是写在代码里，而是保存在 KV 里。

例如后台保存规则时，代码会写：

- KV key: `proxy:settings`

如果你**没有绑定 KV**：

- `/admin` 页面可以打开
- 但点击“保存配置”会失败
- 因为 Worker 找不到 `CONFIG_KV`

### `wrangler.toml` 里这段配置的作用

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "your-kv-namespace-id"
```

含义：

- `binding = "CONFIG_KV"`
  - 把这个 KV 挂载到 Worker 运行时变量 `env.CONFIG_KV`
- `id = "your-kv-namespace-id"`
  - 指向你在 Cloudflare 里创建的那一个 KV 命名空间

也就是说，代码里的：

```js
const kv = env.CONFIG_KV
```

会真的可用。

### 为什么我没法直接替你写死一个“可用的” KV id

因为 **KV namespace id 是你 Cloudflare 账号下实际创建出来的资源 ID**，只有你自己的账号里才有。

我现在能做的是：

- 把 `wrangler.toml` 结构准备好
- 把教程写清楚
- 告诉你去哪里创建 KV
- 告诉你把哪个 id 填回来

但我**不能凭空生成一个真实可用的 Cloudflare KV id**。

---

## 安装

```bash
npm install
```

---

## 本地开发

```bash
npm run dev
```

默认会启动：

- `wrangler dev --local --port 8787`

然后访问：

- `http://localhost:8787/login`

> 本地 `wrangler dev --local` 主要用于调试页面和逻辑。真正部署到 Cloudflare 前，仍然建议按下面教程创建 KV 和环境变量。

---

## Cloudflare Worker 配置教程（完整）

下面按 **Cloudflare Dashboard 手工配置** 讲一遍，最适合你先跑通一版。

### 第 1 步：创建 Worker

1. 登录 Cloudflare Dashboard
2. 左侧进入 **Workers & Pages**
3. 点击 **Create application** / **Create Worker**
4. 新建一个 Worker
5. 名称可以用：

```text
cloudflare-worker-proxy-pro
```

---

### 第 2 步：创建 KV Namespace

1. 在 Cloudflare Dashboard 中进入：
   - **Storage & Databases**
   - 或 **Workers & Pages** 里对应的 KV 页面
2. 找到 **KV**
3. 点击 **Create namespace**
4. 创建一个命名空间，例如：

```text
cloudflare-worker-proxy-pro-config
```

创建完成后你会看到一个 **Namespace ID**。

这个 ID 长得像：

```text
2f6f0d3f4a4b4f6d9e1234567890abcd
```

这个就是后面要填进 `wrangler.toml` 的值。

---

### 第 3 步：在 `wrangler.toml` 里绑定 KV

把你的 `wrangler.toml` 改成这样：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "你的-kv-namespace-id"
```

例如：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "2f6f0d3f4a4b4f6d9e1234567890abcd"
```

### 这一步配置完后会发生什么

运行时：

- `env.CONFIG_KV` 可用
- 后台保存配置会写到 KV
- 配置 key 为：`proxy:settings`

---

### 第 4 步：配置后台密码 `ADMIN`

这个项目后台登录依赖环境变量：

```text
ADMIN
```

你需要在 Cloudflare Worker 的设置里添加它。

#### Dashboard 方式

1. 进入你的 Worker
2. 打开 **Settings**
3. 找到 **Variables**
4. 添加一个变量：

- Name: `ADMIN`
- Value: 你的后台密码

例如：

```text
ADMIN = my-strong-password-123
```

保存后，`/login` 页面就会拿这个密码做验证。

---

### 第 5 步：部署 Worker

如果你用本地项目发布：

```bash
npm run deploy:dry
npm run deploy
```

如果你是直接在 Dashboard 里粘贴 `worker.js`：

1. 打开 Worker 编辑器
2. 粘贴 `worker.js`
3. 保存并部署
4. 再确保 KV 和 `ADMIN` 已配置好

---

### 第 6 步：首次登录后台

部署成功后访问：

```text
https://你的域名/login
```

登录成功后进入：

```text
https://你的域名/admin
```

然后你可以：

- 新增空规则
- 点击 **添加 /gh 预置**
- 保存配置
- 再测试 `/gh`

---

### 第 7 步：推荐的第一个测试

在后台点击 **添加 /gh 预置**，保存后测试：

- `/gh`
- `/gh/robots.txt`

对应效果：

- `/gh` → `https://github.com/`
- `/gh/robots.txt` → `https://github.com/robots.txt`

---

## 如果你更想用 wrangler CLI 来创建 KV

也可以用命令行：

```bash
npx wrangler kv namespace create CONFIG_KV
```

执行后 wrangler 会输出一段类似内容：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "2f6f0d3f4a4b4f6d9e1234567890abcd"
```

你把它复制进 `wrangler.toml` 即可。

> 如果你有 `preview_id`，也可以一起写进去，但这个项目当前不是必须。

---

## 推荐的 `wrangler.toml` 示例

你最终可以用这个：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "2f6f0d3f4a4b4f6d9e1234567890abcd"
```

---

## 本地开发命令

```bash
npm run dev
```

默认会启动：

- `wrangler dev --local --port 8787`

访问：

- `http://localhost:8787/login`

---

## 发布命令

```bash
npm run deploy:dry
npm run deploy
```

---

## 启动方式

把 `worker.js` 部署到 Cloudflare Workers 后：

- 访问 `/login` 登录后台
- 登录成功后进入 `/admin`
- 在后台修改全局设置和规则
- 保存后配置写入 KV key：`proxy:settings`

---

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

---

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

---

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

---

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

---

## 常见问题

### 1. `/admin` 能打开，但保存失败

通常是因为：

- 没有绑定 KV
- `CONFIG_KV` 没有配置

请检查：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "你的真实 namespace id"
```

### 2. `/login` 无法登录

通常是因为没有设置：

```text
ADMIN
```

### 3. 为什么我不能直接让你“写一个可用的 KV id”

因为那是 Cloudflare 真实资源 ID，必须由：

- 你的账号创建
- Cloudflare 实际返回

不是一个可以凭空猜出来的值。

---

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

---

## 检查

```bash
npm run check
```
