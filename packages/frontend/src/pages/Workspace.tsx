/**
 * v1.0 Execution Workspace Board (Kanban).
 *
 * Six-column view of every Execution's effective status. The data
 * source is the same `/api/executions` endpoint as the list page —
 * we DON'T duplicate execution logic. We just bucket each row by
 * `effectiveStatus` and the `manualStatus` override.
 *
 * Column mapping:
 *   - manualStatus wins (column = the manual status itself, except
 *     `done` which maps to DONE).
 *   - else derived: `running` → RUNNING, `unknown` → TODO, `completed` → DONE.
 *
 * Card click → `/executions/:id`. Cards also expose the
 * "manual override" badge so users can tell what they touched.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type AgentExecutionDto,
  type AgentStatusDto,
  type ExecutionBoardColumn,
} from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { agentColor, cn, formatCompact, formatRelative, formatUSD } from '../lib/format';

interface ColumnDef {
  key: ExecutionBoardColumn;
  label: string;
  /** Subtle background tint. */
  tint: string;
}

const COLUMNS: ColumnDef[] = [
  { key: 'todo',        label: 'Todo',         tint: 'bg-muted/40' },
  { key: 'in-progress', label: 'In Progress',  tint: 'bg-blue-50/40 dark:bg-blue-950/20' },
  { key: 'running',     label: 'Running',      tint: 'bg-emerald-50/40 dark:bg-emerald-950/20' },
  { key: 'blocked',     label: 'Blocked',      tint: 'bg-rose-50/40 dark:bg-rose-950/20' },
  { key: 'done',        label: 'Done',         tint: 'bg-emerald-50/40 dark:bg-emerald-950/20' },
  { key: 'archived',    label: 'Archived',     tint: 'bg-muted/30' },
];

/** Map an AgentExecutionDto → its Board column. */
function toBoardColumn(e: AgentExecutionDto): ExecutionBoardColumn {
  if (e.manualStatus) {
    // Map manualStatus directly; `done` → DONE.
    return e.manualStatus as ExecutionBoardColumn;
  }
  switch (e.status) {
    case 'running':   return 'running';
    case 'completed': return 'done';
    case 'unknown':   return 'todo';
  }
}

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<AgentExecutionDto[]>([]);
  const [agents, setAgents] = useState<AgentStatusDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const agent = searchParams.get('agent') ?? '';
  const project = searchParams.get('project') ?? '';
  const tag = searchParams.get('tag') ?? '';
  const status = searchParams.get('status') ?? '';

  const setParam = (key: string, value: string) => {
    setSearchParams((p) => {
      const n = new URLSearchParams(p);
      if (value) n.set(key, value);
      else n.delete(key);
      return n;
    }, { replace: true });
  };

  const load = useCallback(
    (silent = false) => {
      if (!silent) setRefreshing(true);
      const params: Parameters<typeof api.executions>[0] = { limit: 500 };
      if (agent) params.agent = agent;
      if (project) params.project = project;
      if (tag) params.tag = tag;
      if (status) params.status = status;
      Promise.all([api.executions(params), api.agentStatus()])
        .then(([rows, ag]) => {
          setItems(rows);
          setAgents(ag);
          setErr(null);
        })
        .catch((e) => setErr(String(e)))
        .finally(() => { if (!silent) setRefreshing(false); });
    },
    [agent, project, tag, status],
  );

  useEffect(() => { load(); }, [load]);

  // Group executions by column. We render columns even when empty
  // (with a "— no items —" placeholder) so the user sees the full
  // status taxonomy at a glance.
  const grouped = useMemo(() => {
    const map = new Map<ExecutionBoardColumn, AgentExecutionDto[]>();
    for (const c of COLUMNS) map.set(c.key, []);
    for (const e of items) {
      const col = toBoardColumn(e);
      map.get(col)!.push(e);
    }
    return map;
  }, [items]);

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Workspace</h1>
          <p className="text-sm text-muted-foreground">
            {items.length.toLocaleString()} executions across {COLUMNS.length} status columns ·
            manual overrides ({items.filter((e) => e.manualStatus).length})
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
          {refreshing ? 'Loading…' : 'Reload'}
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Filter</CardTitle>
          <CardDescription>
            Same data source as <Link to="/executions" className="text-primary hover:underline">/executions</Link>;
            here it's bucketed into a Kanban by effective status.
            Pinned sessions / agent filters apply across the whole board.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Agent">
              <select
                value={agent}
                onChange={(e) => setParam('agent', e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">All</option>
                {agents.map((a) => (
                  <option key={a.agent} value={a.agent}>{a.agent}</option>
                ))}
              </select>
            </Field>

            <Field label="Project">
              <input
                type="text"
                value={project}
                placeholder="/p/agentos"
                onChange={(e) => setParam('project', e.target.value)}
                className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>

            <Field label="Tag">
              <input
                type="text"
                value={tag}
                placeholder="v1.0"
                onChange={(e) => setParam('tag', e.target.value)}
                className="h-9 w-32 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>

            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setParam('status', e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Any</option>
                <optgroup label="Auto">
                  <option value="running">running</option>
                  <option value="completed">completed</option>
                  <option value="unknown">unknown</option>
                </optgroup>
                <optgroup label="Manual">
                  <option value="todo">todo</option>
                  <option value="in-progress">in-progress</option>
                  <option value="done">done</option>
                  <option value="blocked">blocked</option>
                  <option value="archived">archived</option>
                </optgroup>
              </select>
            </Field>

            <Button variant="ghost" size="sm" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Six-column board */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {COLUMNS.map((col) => {
          const colItems = grouped.get(col.key) ?? [];
          return (
            <div key={col.key} className={cn('rounded-lg border border-border p-2', col.tint)}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground/80">
                  {col.label}
                </h2>
                <span className="text-xs tabular-nums text-muted-foreground">{colItems.length}</span>
              </div>
              {colItems.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-muted-foreground/70">—</p>
              ) : (
                <ul className="space-y-2">
                  {colItems.map((e) => (
                    <BoardCard key={e.id} exec={e} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function BoardCard({ exec }: { exec: AgentExecutionDto }) {
  const dn = (exec.displayName ?? '').trim();
  const title = dn || exec.title || `Execution #${exec.id.split(':exec-')[1]}`;
  return (
    <li>
      <Link
        to={`/executions/${encodeURIComponent(exec.id)}`}
        className={cn(
          'block rounded-md border bg-card p-2.5 text-xs shadow-sm transition-colors hover:border-foreground/30',
          exec.manualStatus ? 'border-primary/40' : 'border-border',
        )}
      >
        <div className="flex items-start justify-between gap-1">
          <h3 className="line-clamp-2 font-medium leading-snug" title={title}>{title}</h3>
          <span title="updated" className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {formatRelative(exec.startTime)}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge className={cn('text-[9px]', agentColor(exec.agentType))}>{exec.agentType}</Badge>
          {exec.manualStatus && (
            <Badge tone="info" className="text-[9px]" title="user-set">manual</Badge>
          )}
        </div>

        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={exec.projectDisplay || exec.project}>
          {exec.projectDisplay || exec.project}
        </div>

        {exec.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-0.5">
            {exec.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded bg-muted px-1 py-0.5 text-[9px] text-foreground/70">#{t}</span>
            ))}
            {exec.tags.length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{exec.tags.length - 3}</span>
            )}
          </div>
        )}

        <div className="mt-1.5 grid grid-cols-3 gap-1 border-t border-border/60 pt-1 text-[10px] tabular-nums text-muted-foreground">
          <span title="duration">{formatCompact(exec.durationMs / 1000)}s</span>
          <span title="tokens">{formatCompact(exec.tokenUsage)}</span>
          <span title="cost" className="text-right">{formatUSD(exec.cost)}</span>
        </div>
        {exec.commits.length > 0 && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            {exec.commits.length} commit{exec.commits.length === 1 ? '' : 's'}
          </div>
        )}
      </Link>
    </li>
  );
}