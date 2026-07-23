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
  type AttentionItemDto,
  type DerivedLifecycleStatus,
  type ExecutionBoardColumn,
  type LifecycleConflictDto,
  type LifecycleHealthScoreDto,
  type LifecycleSnapshotDto,
  type WorkspaceHealthSummaryDto,
} from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { agentColor, cn, formatCompact, formatRelative, formatUSD } from '../lib/format';
import { useSse } from '../lib/use-sse';

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
  /** v1.1: derived lifecycle snapshots keyed by execution id. */
  const [lifecycleMap, setLifecycleMap] = useState<Record<string, LifecycleSnapshotDto>>({});
  /** v1.2: manual vs derived conflict map. */
  const [conflictMap, setConflictMap] = useState<Record<string, LifecycleConflictDto>>({});
  /** v1.3: health scores keyed by execution id. */
  const [healthMap, setHealthMap] = useState<Record<string, LifecycleHealthScoreDto>>({});
  /** v1.3: workspace summary + attention queue. */
  const [summary, setSummary] = useState<WorkspaceHealthSummaryDto | null>(null);
  const [attention, setAttention] = useState<AttentionItemDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // v1.2: refetch lifecycle + conflicts when SSE reports activity or
  // lifecycle changes. The handler is debounced lightly so a burst
  // of events doesn't trigger N+1 round trips.
  const { events: realtimeEvents } = useSse('/api/events/stream', {
    types: ['file_changed', 'scan_completed', 'lifecycle_changed'],
    bufferSize: 20,
  });
  useEffect(() => {
    if (realtimeEvents.length === 0) return;
    if (items.length === 0) return;
    // Re-fetch lifecycle + conflict for the whole visible set.
    // Cheap because batch endpoint is one HTTP call.
    const ids = items.map((r) => r.id);
    Promise.all([api.lifecycleBatch(ids), api.conflictBatch(ids)])
      .then(([snap, conf]) => {
        setLifecycleMap(snap);
        setConflictMap(conf);
      })
      .catch(() => undefined);
    // Also refetch executions when activity changes (file_changed / scan_completed)
    // so newly-completed / new events surface.
    const hadActivity = realtimeEvents.some(
      (e) => e.type === 'file_changed' || e.type === 'scan_completed',
    );
    if (hadActivity) {
      load(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeEvents.length]);

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
          // v1.1: fetch derived lifecycle snapshots in one batch call
          // so each card can show its derived state alongside manual.
          // v1.2: also fetch conflict map for the conflict warning.
          // v1.3: also fetch health scores + workspace summary + attention queue.
          if (rows.length > 0) {
            const ids = rows.map((r) => r.id);
            Promise.all([
              api.lifecycleBatch(ids).then(setLifecycleMap).catch(() => undefined),
              api.conflictBatch(ids).then(setConflictMap).catch(() => undefined),
              api.healthBatch(ids).then(setHealthMap).catch(() => undefined),
            ]);
            // Summary + attention: cheap, fetch independently.
            api.workspaceSummary().then(setSummary).catch(() => undefined);
            api.attentionQueue(50).then(setAttention).catch(() => undefined);
          } else {
            setLifecycleMap({});
            setConflictMap({});
            setHealthMap({});
            setSummary({
              healthy: 0, warning: 0, critical: 0, conflictCount: 0,
              longestRunning: null, total: 0, computedAt: new Date().toISOString(),
            });
            setAttention([]);
          }
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

      {/* v1.3: Workspace Health Summary */}
      {summary && <SummaryHeader summary={summary} />}

      {/* v1.7: Incident Overview — anomaly-driven health incidents */}
      <IncidentSection />

      {/* v1.3: Attention Queue */}
      <AttentionQueueSection items={attention} />

      {/* v1.4: Agent Reliability */}
      <AgentReliabilitySection />

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
                    <BoardCard
                      key={e.id}
                      exec={e}
                      lifecycle={lifecycleMap[e.id]}
                      conflict={conflictMap[e.id]}
                    />
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

/**
 * v1.3: top-of-page workspace health summary. Pure presentational —
 * pulls counts from a pre-fetched WorkspaceHealthSummaryDto.
 */
function SummaryHeader({ summary }: { summary: WorkspaceHealthSummaryDto }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
      <SummaryStat label="Healthy" value={summary.healthy} tone="success" />
      <SummaryStat label="Warning" value={summary.warning} tone="warning" />
      <SummaryStat label="Critical" value={summary.critical} tone="danger" />
      <SummaryStat label="Conflicts" value={summary.conflictCount} tone="info" />
      <SummaryLongest summary={summary} />
    </div>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone: 'success' | 'warning' | 'danger' | 'info' }) {
  const toneClass = {
    success: 'border-emerald-300/60 bg-emerald-50/40 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/20 dark:text-emerald-300',
    warning: 'border-amber-300/60 bg-amber-50/40 text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/20 dark:text-amber-300',
    danger:  'border-rose-300/60 bg-rose-50/40 text-rose-700 dark:border-rose-700/60 dark:bg-rose-950/20 dark:text-rose-300',
    info:    'border-blue-300/60 bg-blue-50/40 text-blue-700 dark:border-blue-700/60 dark:bg-blue-950/20 dark:text-blue-300',
  }[tone];
  return (
    <div className={cn('rounded-md border px-3 py-2', toneClass)}>
      <div className="text-[10px] uppercase tracking-wider text-current/70">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SummaryLongest({ summary }: { summary: WorkspaceHealthSummaryDto }) {
  const lr = summary.longestRunning;
  if (!lr) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <div className="text-[10px] uppercase tracking-wider">Longest active</div>
        <div className="mt-2">—</div>
      </div>
    );
  }
  return (
    <Link
      to={`/executions/${encodeURIComponent(lr.executionId)}`}
      className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs hover:border-foreground/30"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Longest active</div>
      <div className="mt-1 font-mono text-[11px] truncate" title={lr.executionId}>
        {lr.executionId.split(':exec-')[1]
          ? `…:exec-${lr.executionId.split(':exec-')[1]}`
          : lr.executionId}
      </div>
      <div className="mt-0.5 text-foreground/90 tabular-nums">{formatDuration(lr.durationMs)} · {lr.derivedStatus}</div>
    </Link>
  );
}

/**
 * v1.3: Attention Queue — items the user should look at.
 * Read-only cards. Empty state when nothing needs attention.
 */
function AttentionQueueSection({ items }: { items: AttentionItemDto[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Attention Queue</CardTitle>
          <CardDescription>
            Items here mean an execution needs human review — conflict,
            blocked too long, or stale. Empty is the happy state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            ✓ Nothing needs your attention right now.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Attention Queue ({items.length})</CardTitle>
        <CardDescription>
          Sorted by severity. Read-only — these are suggestions, not actions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {items.slice(0, 10).map((it) => (
            <li key={it.executionId}>
              <Link
                to={`/executions/${encodeURIComponent(it.executionId)}`}
                className={cn(
                  'flex items-start gap-3 rounded-md border bg-background p-2.5 text-sm transition-colors hover:border-foreground/30',
                  it.severity === 'critical' ? 'border-rose-300/60' :
                  it.severity === 'high' ? 'border-amber-300/60' :
                  it.severity === 'medium' ? 'border-blue-300/60' :
                  'border-border',
                )}
              >
                <AttentionSeverityBadge severity={it.severity} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[11px] text-muted-foreground truncate" title={it.executionId}>
                      {it.executionId}
                    </code>
                    {it.derivedStatus && (
                      <Badge tone="muted" className="text-[10px]">{it.derivedStatus}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-foreground/90">{it.reason}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Suggested: <span className="font-medium text-foreground/80">{it.recommendedAction}</span>
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        {items.length > 10 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Showing 10 of {items.length} items.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * v1.7: Incident Overview — workspace-level rollup of anomaly-driven
 * health incidents. Read-only display of:
 *   - active vs recovered counts (with critical / high breakdown)
 *   - top affected executions (by active incident count)
 *   - most recent recovered incidents
 * Pure presentational — fetches from /api/incidents/summary.
 */
function IncidentSection() {
  const [data, setData] = useState<import('../lib/api').IncidentSummaryDto | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.incidentSummary({ topAffectedLimit: 5, recentRecoveredLimit: 5 })
      .then((d) => { if (!cancelled) { setData(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Health Incidents</CardTitle>
        <CardDescription>
          Anomaly-driven health incidents (score drops / level regressions /
          rapid degradation) tracked through detected → ongoing → recovered.
          Read-only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!err && !data && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!err && data && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone={data.active > 0 ? 'warning' : 'success'} className="text-xs">
                {data.active} active
              </Badge>
              <Badge tone="muted" className="text-xs">
                {data.recovered} recovered
              </Badge>
              <Badge tone={data.criticalCount > 0 ? 'danger' : 'muted'} className="text-xs">
                {data.criticalCount} critical
              </Badge>
              <Badge tone="muted" className="text-xs">
                {data.highCount} high
              </Badge>
            </div>

            {data.topAffected.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Top affected</h4>
                <ul className="space-y-1">
                  {data.topAffected.map((e) => (
                    <li key={e.executionId} className="flex items-baseline gap-2 text-xs">
                      <Link
                        to={`/executions/${encodeURIComponent(e.executionId)}`}
                        className="font-mono text-[11px] text-primary hover:underline truncate flex-1"
                        title={e.executionId}
                      >
                        {e.executionId}
                      </Link>
                      <Badge tone={e.worstSeverity === 'critical' ? 'danger' : 'warning'} className="text-[10px] uppercase">
                        {e.worstSeverity}
                      </Badge>
                      <span className="tabular-nums text-muted-foreground">{e.activeCount}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.recentRecovered.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Recent recoveries</h4>
                <ul className="space-y-0.5">
                  {data.recentRecovered.slice(0, 3).map((inc) => (
                    <li key={inc.incidentKey} className="flex items-baseline gap-2 text-[11px]">
                      <Link
                        to={`/executions/${encodeURIComponent(inc.executionId)}`}
                        className="font-mono text-[10px] text-muted-foreground hover:underline truncate flex-1"
                        title={inc.executionId}
                      >
                        {inc.executionId}
                      </Link>
                      <span className="text-emerald-700 dark:text-emerald-400 uppercase text-[10px]">recovered</span>
                      <span className="tabular-nums text-muted-foreground">{inc.kind}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.active === 0 && data.recovered === 0 && (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">
                ✓ No health incidents detected yet — record health snapshots to start tracking.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * v1.4: per-agent reliability rollup. Shows for each agent:
 *   - reliabilityScore (0-100, where 100 = no failures)
 *   - failureRate (0..1)
 *   - averageRecoveryTimeMs (or null)
 * Pure presentational — fetches from /api/agents/reliability.
 */
function AgentReliabilitySection() {
  const [items, setItems] = useState<import('../lib/api').AgentReliabilitySummaryDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const { events: realtimeEvents } = useSse('/api/events/stream', {
    types: ['lifecycle_changed', 'file_changed', 'scan_completed'],
    bufferSize: 5,
  });

  const refresh = () => {
    api.agentsReliability()
      .then((rows) => { setItems(rows); setErr(null); })
      .catch((e) => setErr(String(e)));
  };
  useEffect(() => { refresh(); }, []);
  // Re-fetch on activity events.
  useEffect(() => {
    if (realtimeEvents.length === 0) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeEvents.length]);

  if (err) return null;
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Agent Reliability</CardTitle>
        <CardDescription>
          Per-agent rollup computed from persistent health snapshots.
          Higher = more reliable (no failures yet).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <li key={it.agentType} className="rounded-md border border-border bg-background p-3 text-xs">
              <div className="flex items-center justify-between">
                <code className="font-mono text-sm">{it.agentType}</code>
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums',
                  it.reliabilityScore >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' :
                  it.reliabilityScore >= 50 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' :
                                             'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
                )}>
                  {it.reliabilityScore}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                <div>
                  <div className="uppercase tracking-wider text-muted-foreground/70">Total</div>
                  <div className="font-mono text-foreground tabular-nums">{it.totalExecutions}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-muted-foreground/70">Failed</div>
                  <div className="font-mono text-foreground tabular-nums">{it.failedExecutions}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-muted-foreground/70">Failure</div>
                  <div className="font-mono text-foreground tabular-nums">{(it.failureRate * 100).toFixed(1)}%</div>
                </div>
              </div>
              {it.averageRecoveryTimeMs != null && (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Avg recovery: <span className="font-mono text-foreground/80 tabular-nums">
                    {formatDuration(it.averageRecoveryTimeMs)}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function AttentionSeverityBadge({ severity }: { severity: AttentionItemDto['severity'] }) {
  const tone = severity === 'critical' ? 'danger' :
               severity === 'high'     ? 'warning' :
               severity === 'medium'   ? 'info'    :
                                         'muted';
  return <Badge tone={tone} className="shrink-0 text-[10px] uppercase">{severity}</Badge>;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function BoardCard({
  exec,
  lifecycle,
  conflict,
}: {
  exec: AgentExecutionDto;
  lifecycle?: LifecycleSnapshotDto;
  conflict?: LifecycleConflictDto;
}) {
  const dn = (exec.displayName ?? '').trim();
  const title = dn || exec.title || `Execution #${exec.id.split(':exec-')[1]}`;
  return (
    <li>
      <Link
        to={`/executions/${encodeURIComponent(exec.id)}`}
        className={cn(
          'block rounded-md border bg-card p-2.5 text-xs shadow-sm transition-colors hover:border-foreground/30',
          conflict?.isConflict ? 'border-rose-400/70 ring-1 ring-rose-300/30' :
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
          {lifecycle && (
            <LifecyclePill status={lifecycle.derivedStatus} confidence={lifecycle.confidence} />
          )}
          {conflict?.isConflict && (
            <Badge tone="danger" className="text-[9px]" title={`conflict: ${conflict.label ?? 'manual vs derived'}`}>
              ⚠ conflict
            </Badge>
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

/**
 * v1.1: small derived-lifecycle pill. Visually subdued so it never
 * competes with the (board-column-determining) effectiveStatus badge
 * shown elsewhere — this is the "Auto" hint, not the source of truth.
 */
function LifecyclePill({
  status,
  confidence,
}: {
  status: DerivedLifecycleStatus;
  confidence: 'high' | 'medium' | 'low';
}) {
  const label = status === 'queued' ? 'queued' :
    status === 'running' ? 'running' :
    status === 'idle' ? 'idle' :
    status === 'blocked' ? 'blocked' :
    status === 'completed' ? 'completed' :
    'failed';
  const tone =
    status === 'running'   ? 'success' :
    status === 'completed' ? 'success' :
    status === 'failed'    ? 'danger' :
    status === 'blocked'   ? 'warning' :
    'muted';
  return (
    <Badge tone={tone} className="text-[9px]" title={`derived (${confidence}) — see detail for reason`}>
      {label}
    </Badge>
  );
}