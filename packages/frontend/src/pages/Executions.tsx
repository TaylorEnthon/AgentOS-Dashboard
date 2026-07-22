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
import { api, type AgentExecutionDto, type AgentStatusDto, type ExecutionStatus } from '../lib/api';
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

  const load = useCallback(
    (silent = false) => {
      if (!silent) setRefreshing(true);
      const params: Parameters<typeof api.executions>[0] = { limit: 500 };
      if (agent) params.agent = agent;
      if (session) params.session = session;
      if (project) params.project = project;
      Promise.all([api.executions(params), api.agentStatus()])
        .then(([rows, ag]) => {
          setItems(rows);
          setAgents(ag);
          setErr(null);
        })
        .catch((e) => setErr(String(e)))
        .finally(() => { if (!silent) setRefreshing(false); });
    },
    [agent, session, project],
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
            Pinned sessions surface first; sessions of the same agent group together.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Agent">
              <select
                value={agent}
                onChange={(e) => setSearchParams((p) => {
                  const n = new URLSearchParams(p);
                  if (e.target.value) n.set('agent', e.target.value);
                  else n.delete('agent');
                  return n;
                }, { replace: true })}
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
                onChange={(e) => setSearchParams((p) => {
                  const n = new URLSearchParams(p);
                  if (e.target.value) n.set('session', e.target.value);
                  else n.delete('session');
                  return n;
                }, { replace: true })}
                className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>

            <Field label="Project">
              <input
                type="text"
                value={project}
                placeholder="/p/agentos"
                onChange={(e) => setSearchParams((p) => {
                  const n = new URLSearchParams(p);
                  if (e.target.value) n.set('project', e.target.value);
                  else n.delete('project');
                  return n;
                }, { replace: true })}
                className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
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
  const title = exec.title ?? inferFallback(exec);
  return (
    <li>
      <Link
        to={`/executions/${encodeURIComponent(exec.id)}`}
        className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium" title={title}>{title}</h3>
              <Badge className={cn('text-[10px]', agentColor(exec.agentType))}>{exec.agentType}</Badge>
              <StatusBadge status={exec.status} />
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={exec.projectDisplay || exec.project}>
              {exec.projectDisplay || exec.project} · session{' '}
              <span className="text-foreground/70">{exec.sessionId}</span>
            </div>
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

function StatusBadge({ status }: { status: ExecutionStatus }) {
  switch (status) {
    case 'running':
      return <Badge tone="info" className="text-[10px]">● running</Badge>;
    case 'completed':
      return <Badge tone="success" className="text-[10px]">✓ completed</Badge>;
    case 'unknown':
      return <Badge tone="muted" className="text-[10px]">? unknown</Badge>;
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