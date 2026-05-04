# cloudflare-worker-proxy-pro

这是一个部署在 **Cloudflare Workers** 上的带后台代理。

后台入口：

- `/login`
- `/admin`

配置存储依赖 **Cloudflare KV**。

---

## 是否一定要获取 KV 的 id？

**是的，要。**

在 `wrangler.toml` 里：

- `binding` 是 Worker 运行时变量名
- `id` 是 Cloudflare 真实 KV Namespace ID

例如：

```toml
[[kv_namespaces]]
binding = "KV"
id = "2f6f0d3f4a4b4f6d9e1234567890abcd"
```

这里：

- `binding = "KV"` 可以自定义成变量名
- `id = "..."` **必须是真实的 namespace id**

**不能直接写命名空间名字。**

比如下面这种是错的：

```toml
[[kv_namespaces]]
binding = "KV"
id = "cloudflare-worker-proxy-pro-config"
```

因为 `id` 字段不认“名字”，只认 Cloudflare 返回的真实 ID。

---

## Cloudflare Worker 部署教程

### 1. 创建 KV Namespace

在 Cloudflare Dashboard 中：

1. 登录 Cloudflare
2. 进入 **Storage & Databases**
3. 找到 **KV**
4. 点击 **Create namespace**
5. 创建一个名字，例如：

```text
cloudflare-worker-proxy-pro-config
```

创建完成后，复制它的 **Namespace ID**。

---

### 2. 修改 `wrangler.toml`

推荐这样写：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "KV"
id = "你的真实-kv-namespace-id"
```

例如：

```toml
name = "cloudflare-worker-proxy-pro"
main = "worker.js"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "KV"
id = "2f6f0d3f4a4b4f6d9e1234567890abcd"
```

说明：

- `binding = "KV"` 表示代码里会用到 `env.KV`
- 本项目代码同时兼容这些绑定名：
  - `CONFIG_KV`
  - `CF_ACCEL_KV`
  - `ACCEL_KV`
  - `KV`

所以你用 `KV` 最简单。

---

### 3. 配置后台密码 `ADMIN`

在 Cloudflare Worker 设置里添加环境变量：

- Name: `ADMIN`
- Value: 你的后台登录密码

例如：

```text
ADMIN=your-password
```

---

### 4. 部署 Worker

如果你在本地项目里部署：

```bash
npm install
npm run deploy
```

如果你先想检查：

```bash
npm run deploy:dry
```

---

### 5. 登录后台

部署成功后访问：

```text
https://你的域名/login
```

登录成功后进入：

```text
https://你的域名/admin
```

然后你就可以在后台：

- 新增规则
- 保存规则
- 测试规则匹配

---

## 推荐首次测试

后台里直接添加 `/gh` 规则，或者使用 `/gh` 预置，保存后测试：

```text
https://你的域名/gh
https://你的域名/gh/robots.txt
```

---

## 本地开发

```bash
npm install
npm run dev
```

默认地址：

```text
http://localhost:8787
```

---

## 检查语法

```bash
npm run check
```
