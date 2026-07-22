/**
 * v0.8 Executions page — derived "tasks" view.
 *
 * An Execution is a 30-min-gap-grouped slice of one Session's activity
 * timeline. This page renders the cross-session, time-ordered stream of
 * those slices. Drilling down via `/executions/:id` opens the detail.
 *
 * Backed by `GET /api/executions` (pure projection — no DB writes).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type AgentExecutionDto,
  type AgentStatusDto,
  type EffectiveExecutionStatus,
} from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { agentColor, cn, formatCompact, formatRelative, formatUSD } from '../lib/format';

export function ExecutionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<AgentExecutionDto[]>([]);
  const [agents, setAgents] = useState<AgentStatusDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const agent = searchParams.get('agent') ?? '';
  const session = searchParams.get('session') ?? '';
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
      if (session) params.session = session;
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
    [agent, session, project, tag, status],
  );

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let events = 0;
    let commits = 0;
    for (const it of items) {
      tokens += it.tokenUsage;
      cost += it.cost;
      events += it.eventCount;
      commits += it.commits.length;
    }
    return { tokens, cost, events, commits };
  }, [items]);

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Executions</h1>
          <p className="text-sm text-muted-foreground">
            {items.length.toLocaleString()} executions ·{' '}
            {formatCompact(totals.events)} events ·{' '}
            {formatCompact(totals.tokens)} tokens · ${totals.cost.toFixed(2)} · {totals.commits} commits
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
            Executions are derived from sessions using a 30-min gap rule.
            User customizations (displayName, tags, manualStatus) live in{' '}
            <code className="font-mono">execution_metadata</code>.
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

            <Field label="Session">
              <input
                type="text"
                value={session}
                placeholder="claude-code:abc-123"
                onChange={(e) => setParam('session', e.target.value)}
                className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
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
                placeholder="v0.9"
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

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No executions match the current filters.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((exec) => (
            <ExecutionRow key={exec.id} exec={exec} />
          ))}
        </ul>
      )}
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

function ExecutionRow({ exec }: { exec: AgentExecutionDto }) {
  // v0.9: user-set displayName wins over the auto-derived title.
  const displayName = (exec.displayName ?? '').trim();
  const title = displayName || exec.title || inferFallback(exec);
  return (
    <li>
      <Link
        to={`/executions/${encodeURIComponent(exec.id)}`}
        className={cn(
          'block rounded-lg border bg-card p-4 transition-colors',
          exec.manualStatus
            ? 'border-primary/40 ring-1 ring-primary/20'
            : 'border-border hover:border-foreground/30',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium" title={title}>{title}</h3>
              <Badge className={cn('text-[10px]', agentColor(exec.agentType))}>{exec.agentType}</Badge>
              <StatusBadge status={exec.effectiveStatus} />
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={exec.projectDisplay || exec.project}>
              {exec.projectDisplay || exec.project} · session{' '}
              <span className="text-foreground/70">{exec.sessionId}</span>
            </div>
            {exec.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {exec.tags.slice(0, 8).map((t) => (
                  <Badge key={t} tone="muted" className="text-[10px]">#{t}</Badge>
                ))}
                {exec.tags.length > 8 && (
                  <span className="text-[10px] text-muted-foreground">+{exec.tags.length - 8} more</span>
                )}
              </div>
            )}
          </div>
          <time className="shrink-0 text-xs tabular-nums text-muted-foreground/80" dateTime={exec.startTime} title={exec.startTime}>
            {formatRelative(exec.startTime)}
          </time>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-2 text-xs sm:grid-cols-4">
          <Stat label="Duration" value={formatDuration(exec.durationMs)} />
          <Stat label="Events" value={formatCompact(exec.eventCount)} />
          <Stat label="Tokens" value={formatCompact(exec.tokenUsage)} />
          <Stat label="Cost" value={formatUSD(exec.cost)} />
        </div>
        {exec.commits.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium">commits:</span>
            {exec.commits.slice(0, 3).map((c) => (
              <span key={c.hash} className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/80" title={c.message}>
                {c.shortHash}
              </span>
            ))}
            {exec.commits.length > 3 && (
              <span className="text-muted-foreground">+{exec.commits.length - 3} more</span>
            )}
          </div>
        )}
      </Link>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="font-mono tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: EffectiveExecutionStatus }) {
  switch (status) {
    // Auto-derived (v0.8)
    case 'running':
      return <Badge tone="info" className="text-[10px]">● running</Badge>;
    case 'completed':
      return <Badge tone="success" className="text-[10px]">✓ completed</Badge>;
    case 'unknown':
      return <Badge tone="muted" className="text-[10px]">? unknown</Badge>;
    // Manual (v0.9) — distinct visuals so users can tell them apart
    case 'todo':
      return <Badge tone="muted" className="text-[10px]">○ todo</Badge>;
    case 'in-progress':
      return <Badge tone="info" className="text-[10px]">▸ in-progress</Badge>;
    case 'done':
      return <Badge tone="success" className="text-[10px]">✓ done</Badge>;
    case 'blocked':
      return <Badge tone="danger" className="text-[10px]">✕ blocked</Badge>;
    case 'archived':
      return <Badge tone="muted" className="text-[10px]">▣ archived</Badge>;
  }
}

function inferFallback(exec: AgentExecutionDto): string {
  const dt = new Date(exec.startTime);
  return `${exec.agentType} task · ${dt.toLocaleString()}`;
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