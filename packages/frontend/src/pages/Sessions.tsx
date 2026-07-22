/**
 * Sessions page — AgentOS's "Session Center" (v0.7).
 *
 * Inspired by CC Switch's session list UX but composed on top of our
 * existing Session + Timeline + Git + Usage + Cost capabilities:
 *  - search across display_name / title / project
 *  - filter by agent, project, status, pinned
 *  - sort: pinned first, then most recent
 *  - one-click drill-down to the full session detail
 *
 * The data source is `/api/sessions-v2`, which already JOINs the
 * user-customizable `session_metadata` (displayName, note, tags, pinned)
 * and aggregates event / usage counts so we don't N+1 the dashboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type AgentStatusDto, type SessionListItemDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { agentColor, cn, formatCompact, formatRelative, formatUSD } from '../lib/format';

type StatusFilter = '' | 'running' | 'completed' | 'failed' | 'unknown';
type PinnedFilter = '' | 'true' | 'false';

export function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<SessionListItemDto[]>([]);
  const [agents, setAgents] = useState<AgentStatusDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');

  const agent = searchParams.get('agent') ?? '';
  const project = searchParams.get('project') ?? '';
  const search = searchParams.get('q') ?? '';
  const status = (searchParams.get('status') ?? '') as StatusFilter;
  const pinned = (searchParams.get('pinned') ?? '') as PinnedFilter;

  const load = useCallback(
    (silent = false) => {
      if (!silent) setRefreshing(true);
      const params: Parameters<typeof api.sessionsV2>[0] = { limit: 500 };
      if (agent) params.agent = agent;
      if (project) params.project = project;
      if (search.trim()) params.search = search.trim();
      if (status) params.status = status;
      if (pinned === 'true' || pinned === 'false') params.pinned = pinned;
      Promise.all([api.sessionsV2(params), api.agentStatus()])
        .then(([rows, ag]) => {
          setItems(rows);
          setAgents(ag);
          setErr(null);
        })
        .catch((e) => setErr(String(e)))
        .finally(() => { if (!silent) setRefreshing(false); });
    },
    [agent, project, search, status, pinned],
  );

  useEffect(() => { load(); }, [load]);

  // Keep searchInput in sync if URL changes externally (e.g. browser back).
  useEffect(() => {
    const urlQ = searchParams.get('q') ?? '';
    if (urlQ !== searchInput) setSearchInput(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (!value) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const submitSearch = () => setParam('q', searchInput.trim() || undefined);

  const totals = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let events = 0;
    for (const it of items) {
      tokens += it.usageTokens;
      cost += it.usageCost;
      events += it.eventCount;
    }
    return { tokens, cost, events };
  }, [items]);

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            {items.length.toLocaleString()} sessions ·{' '}
            {formatCompact(totals.tokens)} tokens · {formatCompact(totals.events)} events · ${totals.cost.toFixed(2)} est. cost
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
          {refreshing ? 'Loading…' : 'Reload'}
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Filter</CardTitle>
          <CardDescription>Search across display name, title, and project path. Pinned sessions sort first.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="search" className="text-xs font-medium text-muted-foreground">Search</label>
              <form
                onSubmit={(e) => { e.preventDefault(); submitSearch(); }}
                className="flex gap-2"
              >
                <input
                  id="search"
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="name, title, project…"
                  className="h-9 w-72 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button size="sm" variant="outline" type="submit">Go</Button>
              </form>
            </div>

            <Field label="Agent">
              <select
                value={agent}
                onChange={(e) => setParam('agent', e.target.value || undefined)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">All</option>
                {agents.map((a) => (
                  <option key={a.agent} value={a.agent}>{a.agent}</option>
                ))}
              </select>
            </Field>

            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setParam('status', e.target.value || undefined)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">All</option>
                <option value="running">running</option>
                <option value="completed">completed</option>
                <option value="failed">failed</option>
                <option value="unknown">unknown</option>
              </select>
            </Field>

            <Field label="Pinned">
              <select
                value={pinned}
                onChange={(e) => setParam('pinned', e.target.value || undefined)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">All</option>
                <option value="true">Pinned only</option>
                <option value="false">Unpinned only</option>
              </select>
            </Field>

            <Button variant="ghost" size="sm" onClick={() => { setSearchParams(new URLSearchParams(), { replace: true }); setSearchInput(''); }}>
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No sessions match the current filters.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((s) => (
            <SessionCard key={s.id} session={s} />
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

function SessionCard({ session }: { session: SessionListItemDto }) {
  const display = session.displayName || session.title || session.externalId.slice(0, 16);
  const isRunning = session.status === 'running';
  return (
    <li>
      <Link
        to={`/sessions/${encodeURIComponent(session.id)}`}
        className={cn(
          'block h-full rounded-lg border bg-card p-4 transition-colors',
          session.pinned
            ? 'border-amber-300 ring-1 ring-amber-200/50 dark:border-amber-700 dark:ring-amber-900/30'
            : 'border-border hover:border-foreground/30',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {session.pinned && <span title="pinned" className="text-amber-500">★</span>}
              <h3 className="truncate font-medium" title={display}>{display}</h3>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge className={cn(agentColor(session.agentType), 'text-[10px]')}>{session.agentType}</Badge>
              <span className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                session.status === 'running' ? 'bg-blue-100 text-blue-700' :
                session.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                session.status === 'failed' ? 'bg-rose-100 text-rose-700' :
                'bg-muted text-muted-foreground',
              )}>
                {isRunning ? '● running' : session.status}
              </span>
            </div>
          </div>
          <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80" dateTime={session.startTime} title={session.startTime}>
            {formatRelative(session.startTime)}
          </time>
        </div>

        <div className="mt-3 truncate font-mono text-xs text-muted-foreground" title={session.projectDisplay || session.project}>
          {session.projectDisplay || session.project}
        </div>

        {session.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {session.tags.slice(0, 5).map((t) => (
              <Badge key={t} tone="muted" className="text-[10px]">#{t}</Badge>
            ))}
            {session.tags.length > 5 && (
              <span className="text-[10px] text-muted-foreground">+{session.tags.length - 5}</span>
            )}
          </div>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
          <Stat label="Events" value={formatCompact(session.eventCount)} />
          <Stat label="Tokens" value={formatCompact(session.usageTokens)} />
          <Stat label="Cost" value={formatUSD(session.usageCost)} />
        </div>
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