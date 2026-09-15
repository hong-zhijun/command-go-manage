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

1. 管理员登录 → **CC Key 池** → 添加 CC 原始 Key（`user_xxx`）
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
