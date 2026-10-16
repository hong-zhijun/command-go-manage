# Command Go Manage

多账号 Command Code API 代理 + 额度面板 + 用户管理系统。

合并自 [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)（API 代理核心）和 [commandcode-usage](https://github.com/MAXeaglet/commandcode-usage)（额度面板），新增多用户系统和 Key 池调度。

## 功能

- **API 代理**：OpenAI Chat Completions + Anthropic Messages 双协议兼容
- **CC Key 池**：管理员统一配置，按额度 + 负载自动调度
- **自定义 API Key**：系统签发 `sk-cg-xxx`，用户无感调用
- **用户系统**：注册/登录/JWT 认证，管理员可创建用户
- **额度面板**：5 小时 / 每周 / 月度进度条、余额、告警
- **用量统计**：调用次数、Token 用量、延迟
- **设备伪装**：对齐 CLI 1.53.1，fingerprint + lifecycle

## 快速开始

### Docker（推荐）

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env，至少修改 JWT_SECRET 和 ADMIN_PASSWORD

# 2. 启动
docker compose up -d

# 3. 访问
# Web 面板: http://localhost:3050
# API 代理: http://localhost:3050/v1/chat/completions
```

### 本地开发

```bash
npm install
npm run dev    # 自动重载
```

## 使用流程

1. 管理员登录 → **CC 账号池** → **添加** → 选择输入 CC Key 或浏览器授权
2. 管理员 → **用户管理** → 创建用户
3. 用户登录 → **我的 API Key** → 创建 Key → 得到 `sk-cg-xxxx`
4. 用户拿 `sk-cg-xxxx` 调用代理接口

```bash
curl http://localhost:3050/v1/chat/completions \
  -H "Authorization: Bearer sk-cg-xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}'
```

## API 端点

### 浏览器授权添加账号

官网只允许 localhost 回调，授权链接使用 `http://localhost:5959/callback`。无需配置 `PUBLIC_BASE_URL` 或启动本地 cmdc / callback 服务。

1. “添加 CC 账号” → “浏览器授权” → “生成授权链接” → “打开授权页面”。
2. 在授权页面按 F12 打开 **Network**，勾选 **Preserve log（保留日志）**，再完成官网授权。
3. 找到发往 `localhost:5959/callback` 的 POST 请求，右键 **Copy → Copy as cURL**。本机没有监听服务时请求连接失败属于预期，复制其请求内容即可。
4. 返回面板，在“授权回调内容”中粘贴，点击“解析并保存账号”。服务器验证 Key 后加入账号池，面板刷新。

支持浏览器复制的 cURL（bash / cmd）、JSON 和 URL 编码表单请求体，也支持确实带有 `apiKey` 的 localhost URL。只有 `state` 的地址不包含 Key，无法用于导入。粘贴的 cURL 只解析文本，不执行命令或访问其中的 URL，凭据通过已登录管理员的 POST 请求提交，不返回原始 Key。

授权会话有效期为 10 分钟，绑定发起授权的管理员，仅允许成功处理一次；重新生成链接使该管理员之前的待授权链接失效。关闭添加弹窗取消等待中的授权。会话保存在服务内存中，重启后需重新生成链接，多个实例须让创建和导入请求到达同一实例。

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 兼容代理 |
| `POST /v1/messages` | Anthropic 兼容代理 |
| `GET /v1/models` | 模型列表 |
| `GET /health` | 健康检查 |
| `POST /api/auth/login` | 登录 |
| `POST /api/auth/register` | 注册（管理员） |
| `GET /api/auth/keys` | 我的 API Key |
| `POST /api/auth/keys` | 创建 API Key |
| `GET /api/admin/cc-keys` | CC Key 列表 |
| `POST /api/admin/cc-keys` | 添加 CC Key |
| `POST /api/admin/cc-keys/auth/start` | 创建浏览器授权会话 |
| `GET /api/admin/cc-keys/auth/status/:sessionId` | 查询本人授权状态 |
| `DELETE /api/admin/cc-keys/auth/session/:sessionId` | 取消本人待授权会话 |
| `POST /api/admin/cc-keys/auth/import` | 解析管理员粘贴的回调内容，验证并入池 |
| `POST /api/admin/cc-keys/refresh` | 刷新额度 |
| `GET /api/admin/models` | 模型目录与白名单开关 |
| `POST /api/admin/models/sync` | 立即从所有 Key 同步模型 |
| `PATCH /api/admin/models/settings` | 开关模型白名单 `{ filterEnabled }` |
| `POST /api/admin/models/enabled` | 批量开放/关闭模型 `{ ids, enabled }` |
| `POST /api/admin/models/delete` | 移除已下线的模型 `{ id }` |
| `GET /api/admin/users` | 用户列表 |
| `GET /api/dashboard` | 用户面板数据 |

### 模型管理

模型目录只在管理员手动同步时更新：在面板 **模型管理** 页点 **从账号同步**，服务用池中每个启用的 Key 调上游 `/provider/v1/models` 并合并结果。添加或停用 Key 后需要再同步一次。同一页可以搜索和勾选模型。

- **白名单关闭**（默认）：`/v1/models` 返回全部可用模型，请求不限制模型。
- **白名单开启**：`/v1/models` 只返回勾选的模型，请求其他模型返回 404 `model_not_found`。

新发现的模型默认不勾选，开启白名单后不会自动对外开放。上游不再提供的模型标记为“已下线”，可以移除。

## Key 池调度策略

```
用户请求 → 验证 sk-cg-xxx → 从池中选 CC Key:
  1. 过滤非 active
  2. 过滤 5 小时窗口 exceeded
  3. 按 (剩余额度 / 在途请求数) 打分
  4. 选得分最高
```

额度每 5 分钟自动同步（可配置）。

## 技术栈

| 组件 | 选择 |
|------|------|
| 运行时 | Node.js 22 |
| 框架 | Fastify 5 |
| 数据库 | SQLite (better-sqlite3) |
| 认证 | JWT (@fastify/jwt) |
| 前端 | 纯 HTML，无框架 |
| 部署 | Docker (node:22-alpine) |

## 环境变量

见 [`.env.example`](.env.example)

## License

MIT
