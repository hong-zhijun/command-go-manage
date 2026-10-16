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

在部署环境设置 `PUBLIC_BASE_URL=https://你的面板域名`，重新构建并启动服务。
Docker Compose 已透传该环境变量；本地运行请在进程环境中设置。
域名的反向代理应将 `/api/admin/cc-keys/auth/callback` 的 POST 请求转发到本服务，且不要额外加登录拦截。

在“添加 CC 账号”中选择“浏览器授权”，点击“生成授权链接”，在新标签页登录 Command Code 并授权。账号验证完成后自动入池，面板自动刷新。浏览器阻止弹窗时，可点击弹窗内的“打开授权页面”。不需要安装或登录本地 cmdc。

授权会话有效期为 10 分钟，绑定发起授权的管理员，仅允许使用一次；重新生成链接使该管理员之前的待授权链接失效。关闭添加弹窗取消等待中的授权。会话保存在服务内存中，重启后需重新生成链接，部署多个实例时须让授权和轮询请求到达同一实例。

该实现依据 CLI 1.56.0 的 POST 回调格式。Command Code 官网是否允许公网 callback，仍需在实际域名完成一次授权验证；若官网拒绝回调地址，界面手动输入 Key 的方式仍可使用。

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
| `POST /api/admin/cc-keys/auth/callback` | 接收授权结果，验证并入池 |
| `POST /api/admin/cc-keys/refresh` | 刷新额度 |
| `GET /api/admin/users` | 用户列表 |
| `GET /api/dashboard` | 用户面板数据 |

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
