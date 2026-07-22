# AgentOS Dashboard

> 本地运行的 AI Agent 运维与智能开发控制中心
> 监控 Claude Code / Codex CLI / Grok Build / Gemini CLI / Hermes 等 AI Coding Agent 的 Session、Token 消耗、成本估算、活动事件

AgentOS Dashboard 是一个面向 **AI 软件工程工作流** 的 Agent 管理平台 —— 不只是 Token 统计，而是 AI Agent Engineering Platform 的早期形态。

## 截图

| Overview | Agents | Projects |
|---|---|---|
| 实时统计 + 近 14 天趋势 + Agent 占比 | 启停 / 跳转到详情 | 按项目聚合 + 可展开 Session |

## 特性（v0.1）

- 🔌 **5 个 Agent 接入**：Claude Code / Codex CLI / Grok Build / Gemini CLI / Hermes（其中 Gemini、Hermes 为 stub，仅探测安装状态）
- 📦 **统一数据模型**：`Agent / AgentSession / UsageRecord / ActivityEvent / Project`
- 🗄️ **本地 SQLite 存储**（`better-sqlite3`），零运维
- ⚙️ **手动 + 定时轮询**：可配置间隔（默认 60s），前端「Refresh now」按钮立即触发
- 💰 **内置价格表 + 用户覆盖**：24 个常用模型，可逐项 Override
- 🖥️ **单端口启动**：Fastify 后端用 `@fastify/static` 托管前端构建产物，开箱即用 `http://127.0.0.1:3000`
- 🧪 **可测试**：collector 解析 + 数据库 + 价格计算均有单元测试

## 目录结构

```
agentos-dashboard/
├── PLAN.md                          # 架构方案
├── package.json                     # npm workspaces 根
├── data/                            # 运行期数据（gitignore）
│   ├── agentos.db
│   └── settings.json
└── packages/
    ├── shared/      # 跨包类型 + 价格表 + 格式化
    ├── collectors/  # 数据采集：claude-code / codex / grok + stub(gemini/hermes)
    ├── backend/     # Fastify + better-sqlite3 + scheduler + REST API
    └── frontend/    # React + Vite + Tailwind + shadcn-style + Recharts-style 自绘 SVG
```

## 环境要求

- Node.js ≥ 20（推荐 22）
- npm ≥ 10
- 可选：`~/.claude`、`~/.codex`、`~/.grok`、`~/.gemini` 等目录存在以采集数据

> 本机无 `pnpm`，故使用 npm workspaces；如需 pnpm，可直接替换根 `package.json` 的 `workspaces` 字段。

## 快速开始

```bash
# 1. 安装依赖（首次启动需要约 30s）
npm install

# 2. 构建所有包
npm run build

# 3. 启动 backend（默认 http://127.0.0.1:3000）
npm run dev
```

也可分别启动：

```bash
npm run dev -w @agentos/backend      # 后端 + 调度 + API
npm run dev -w @agentos/frontend     # 前端 dev server（自带 vite proxy 到 :3000 的 /api）
```

## 测试

```bash
npm test
```

覆盖：

- `packages/shared/tests/pricing.test.ts` — 价格表精确匹配 / 前缀匹配 / cache 默认 / 用户覆盖 / fallback
- `packages/collectors/tests/collectors.test.ts` — Claude / Codex / Grok JSONL 解析 + Gemini/Hermes stub + 时间戳容错 + 坏行处理
- `packages/backend/tests/db.test.ts` — Agent/Session/Usage/Event 增删改查 + overview 聚合 + 项目聚合 + settings roundtrip

## 数据采集策略

每个 Collector 通过 `BaseCollector` 实现：

1. `resolveDataDir()` — 探测数据目录，优先级：用户覆盖 > 环境变量 > `$HOME/.xxx`
2. `scan()` — 增量扫描，输出 `RawScanResult`
3. 后端 `Scheduler` 统一调度，入库前用 SQLite 事务做 upsert

| Agent | 数据目录 | 文件格式 | 关键字段 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/<uuid>.jsonl` | JSONL | `message.usage.{input,output,cache_*}_tokens` |
| Codex CLI | `~/.codex/archived_sessions/rollout-*.jsonl` | JSONL | `payload.response.usage.*`、`payload.items[].function_call` |
| Grok Build | `~/.grok/sessions/<percent-encoded>/<uuid>/prompt_history.jsonl` | JSONL | `usage.*`、`tool_call.name` |
| Gemini CLI | `~/.gemini/` | — | v0.1 仅探测存在性 |
| Hermes | `~/.hermes` / `%HERMES_HOME%` | — | v0.1 仅探测存在性 |

## API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/overview` | 全局统计 + 近 14 天 daily + 最近 sessions |
| GET | `/api/agents` | 所有 Agent + 各自汇总 |
| GET | `/api/agents/:id` | 单 Agent + 100 条 sessions |
| PUT | `/api/agents/:id` | 启/停 Agent |
| GET | `/api/sessions?agent=&project=&limit=&status=` | Session 列表 |
| GET | `/api/sessions/:id` | Session 详情（含 usage、events） |
| GET | `/api/projects` | 按 project 聚合 |
| POST | `/api/refresh` | 手动触发全量扫描 |
| GET | `/api/settings` | 读设置 |
| PUT | `/api/settings` | 写设置（覆盖价格、调整轮询间隔） |

## 后续规划（v0.1 仅留接口）

- **Agent Timeline**：基于已有的 `activity_events` 表做甘特图
- **Git 集成**：通过 git log 反查 Agent session 关联到的 commit
- **MCP Server**：暴露 `agentos://overview`、`agentos://recent-sessions` 给 Agent 自身查询
- **多 Agent 编排视图**：同一任务下 Claude + Codex + Grok 的并行执行链
- **实时文件监听**：用 `chokidar` 替换轮询
- **自定义 Agent**：通过 UI 填任意 JSONL 路径 + 自定义解析脚本

## Development

开发者只需要记住四个命令：

```bash
npm install            # 装依赖（~30s）
npm test               # 跑全部 workspace 的测试
npm run typecheck      # 全部 workspace 的 TypeScript 检查
npm run build          # 全部 workspace 的产物构建
```

启动开发服务器：

```bash
npm run dev            # 后端 dev (http://127.0.0.1:3000，热重载)
npm run dev -w @agentos/frontend   # 前端 vite dev (http://127.0.0.1:5173，代理 /api)
```

生产模式启动：

```bash
npm run build && npm run start     # 后端用 dist 启动，前端由后端托管
```

`package.json` 的根 `scripts` 已经把 test / build / typecheck 全部用 `-ws --if-present` 聚合到 workspace，**无需在子包单独跑**。

## CI

每次 push 到 `main` 或对 `main` 提 PR，`.github/workflows/ci.yml` 会自动跑：

```
install (npm ci)
   ↓
typecheck (npm run typecheck)
   ↓
test    (npm test)
   ↓
build   (npm run build)
   ↓
audit   (npm audit --omit=dev --audit-level=high,  非阻塞)
```

- **触发**：push 到 main / PR 到 main
- **Node**：22（项目 `engines.node >= 20`，CI 跑最新 LTS）
- **缓存**：`actions/setup-node` 内置 npm 缓存，**不缓存 `node_modules` 与 `dist/`**（避免陈旧产物）
- **`concurrency`**：同一分支的新 push 会取消尚未完成的旧 run，避免浪费 CI 分钟
- **超时**：15 分钟
- **失败处理**：核心步骤任一失败即视为 CI 失败；`npm audit` 故意 `continue-on-error: true`，只暴露问题不阻塞合并

如果 CI 红了，先在本地复现：

```bash
npm ci && npm run typecheck && npm test && npm run build
```

## 贡献流程

1. `git checkout -b feat/<short-name>`
2. 改代码 + 补测试
3. `npm test && npm run typecheck && npm run build` 全绿
4. `git commit`（一个阶段一个 commit，不要 amend / squash / force push）
5. `git push` 普通 fast-forward
6. 开 PR → 等 CI 通过 → 合并

## 许可

MIT