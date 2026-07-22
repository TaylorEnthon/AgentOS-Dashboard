# AgentOS Dashboard v0.1 — 实现方案

## 1. 项目定位

本地运行的 AI Agent 运维与智能开发控制中心。监控 Claude Code / Codex CLI / Grok Build / Gemini CLI / Hermes 等 AI Coding Agent 的 Session、Token 消耗、成本估算、活动事件。

本轮目标：**先建立稳定架构与端到端骨架**，跑通"采集 → 入库 → API → 前端展示"的最小闭环。

## 2. 关键技术决策（已与用户对齐）

| 决策点 | 选型 |
| --- | --- |
| 数据采集 | 手动 + 定时轮询（前端可触发 refresh） |
| 前后端集成 | Monorepo（npm workspaces），后端用 @fastify/static 托管前端构建产物 |
| 前端 UI | React + TypeScript + Vite + Tailwind + shadcn/ui 风格 |
| 成本估算 | 内置模型价格表 + `settings.json` 可覆盖 |
| 后端框架 | Fastify（更轻、原生 TypeScript 友好） |
| 数据库 | SQLite via `better-sqlite3`（同步 API，简单可靠） |
| 包管理 | npm workspaces（pnpm 未安装） |

## 3. 目录结构

```
agentos-dashboard/
├── package.json                # 根 workspaces
├── tsconfig.base.json
├── README.md
├── PLAN.md
├── .gitignore
├── data/                       # 运行期数据（gitignore）
│   └── agentos.db
├── packages/
│   ├── shared/                 # 跨包共享类型 + 价格表
│   │   └── src/{types,pricing,index}.ts
│   ├── collectors/             # 数据采集抽象与实现
│   │   └── src/{base,claude,codex,grok,gemini,hermes,index}.ts
│   ├── backend/                # Fastify 服务
│   │   └── src/
│   │       ├── server.ts
│   │       ├── db.ts
│   │       ├── scheduler.ts
│   │       ├── settings.ts
│   │       └── routes/{overview,agents,sessions,projects,refresh,settings}.ts
│   └── frontend/               # Vite + React
│       ├── index.html
│       ├── vite.config.ts
│       ├── tailwind.config.js
│       ├── postcss.config.js
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── pages/{Overview,AgentDetail,ProjectView,Settings}.tsx
│       │   ├── components/ui/{card,button,table,tabs,badge,...}.tsx
│       │   └── lib/{api,format,types}.ts
└── tests/                      # 跨包测试
    └── collectors.test.ts
    └── pricing.test.ts
```

## 4. 统一数据模型

```ts
type AgentType = 'claude-code' | 'codex' | 'grok' | 'gemini' | 'hermes' | 'custom';

interface Agent {
  id: string;            // 内部 id
  name: string;
  type: AgentType;
  dataDir: string;
  enabled: boolean;
  capabilities?: string[];
  lastScannedAt?: string;
}

interface AgentSession {
  id: string;            // `${agentId}:${externalId}`
  agentId: string;
  externalId: string;
  project: string;       // 绝对路径或编码后路径
  projectDisplay: string;
  title?: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  model?: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fileOps: number;
  toolCalls: number;
}

interface UsageRecord {
  id: string;
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  estimatedCost: number;
  timestamp: string;
}

interface ActivityEvent {
  id: string;
  sessionId: string;
  agentId: string;
  type: 'session-start'|'session-end'|'message'|'tool-call'|'file-read'|'file-write'|'file-edit'|'command'|'git-commit'|'status';
  timestamp: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

interface Project {
  path: string;
  displayName: string;
  agents: AgentType[];
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  lastActivity?: string;
}
```

## 5. Collector 架构

每个 Collector 继承 `BaseCollector`：

```ts
abstract class BaseCollector {
  abstract readonly type: AgentType;
  abstract readonly displayName: string;
  abstract detectDataDir(): string | null;   // 自动探测 + 用户覆盖
  abstract scan(): Promise<RawScanResult>;
}
```

`RawScanResult` 内含 `sessions / usage / events`，由 `ingest` 层统一 upsert 到 SQLite。

**各 Agent 实现要点**：

- **Claude Collector**:
  - 数据目录：自动探测 `~/.claude/projects`，可被 settings 覆盖
  - 扫描每个子目录下的 `*.jsonl`，逐行解析
  - 提取 `assistant.message.usage`（input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens）
  - 提取 `toolUse` 块统计 file_ops / tool_calls

- **Codex Collector**:
  - 数据目录：`~/.codex/archived_sessions/*.jsonl` + `~/.codex/config.toml`
  - 解析 rollout JSONL，提取 `response.usage` 和 `function_call`

- **Grok Collector**:
  - 数据目录：`~/.grok/sessions/<encoded>/<uuid>/prompt_history.jsonl`
  - 解析 prompt_history（按行 JSON），提取 model + tokens

- **Gemini / Hermes**: v0.1 stub，发现目录就登记，没有就标记 `enabled=false`，不报错

## 6. 数据库 schema

```sql
CREATE TABLE agents (...);
CREATE TABLE sessions (...);                -- UNIQUE(agent_id, external_id)
CREATE TABLE usage_records (...);
CREATE TABLE activity_events (...);
CREATE TABLE projects (...);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

入库策略：upsert + 增量（按 session_id + timestamp 去重），扫描记录 `agents.last_scanned_at`。

## 7. API 设计

```
GET  /api/health
GET  /api/overview            -- 全局统计：agents / 今日 tokens / 今日 cost / 最近 sessions
GET  /api/agents              -- 所有 agent + 状态
GET  /api/agents/:id          -- 单个 agent 详情 + sessions
GET  /api/sessions?agent=&project=&limit=   -- session 列表
GET  /api/sessions/:id        -- session 详情（含 usage、events）
GET  /api/projects            -- 按 project 聚合
POST /api/refresh             -- 手动触发全量扫描
GET  /api/settings            -- 读 settings
PUT  /api/settings            -- 写 settings（覆盖价格等）
```

## 8. 前端页面

- **Overview**: 顶部 4 张卡片（Agent 数 / 今日 token / 今日 cost / 活跃 session），下方两个图：近 7 天 token 趋势柱状、近 7 天成本趋势折线；最近 sessions 表。
- **Agent Detail**: 左侧 Agent 元信息 + 启用开关；右侧该 Agent 的 sessions 列表 + token/cost 分布。
- **Project View**: 项目分组表 + 点击展开 sessions。
- **Settings**: 数据目录覆盖、价格覆盖、扫描间隔、Agent 启停。

## 9. 测试

- `tests/collectors.test.ts`: 给每个 Collector 喂合成 JSONL，验证解析 → 统一模型
- `tests/pricing.test.ts`: 验证价格表计算、override 逻辑

## 10. 后续扩展（v0.1 不做，仅留接口）

- Agent Timeline 可视化（已有 `ActivityEvent` 表，UI 待补）
- Git commit 关联（依赖 Git log 反查）
- MCP server（暴露 `agentos://` 资源给 Agent 查询）
- 多 Agent 编排视图

## 11. 与实际环境的差异说明

- **Hermes 未安装**：Collector 仍存在，但 `enabled=false`，数据目录探测返回 null，不影响其他 Agent。
- **pnpm 不可用**：改用 npm workspaces（功能等价）。
- **Codex 实际 sessions 位置**：`~/.codex/archived_sessions/*.jsonl`（不在 `log/`）。
- **Gemini 格式未知**：v0.1 只做存在性探测，暂不解析 token；保留 schema 兼容位。