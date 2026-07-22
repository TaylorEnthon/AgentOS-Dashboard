/**
 * Timeline page — chronological view of every activity_events row the
 * collectors have ingested. Driven by `/api/timeline` (a pure projection
 * over `activity_events ⨝ sessions`); auto-refreshes on SSE
 * `scan_completed` events from the backend.
 *
 * Filters (all optional, AND-combined):
 *  - agent   AgentType
 *  - project project path
 *  - session session id
 *  - from / to  ISO timestamp range
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type AgentStatusDto,
  type GitCommitDto,
  type GitSessionInfoDto,
  type TimelineItemDto,
} from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn, formatRelative } from '../lib/format';
import { useSse } from '../lib/use-sse';

interface Filters {
  agent?: string;
  project?: string;
  session?: string;
  from?: string;
  to?: string;
  limit?: number;
}

const RANGES: Array<{ key: string; label: string; from: () => string }> = [
  { key: '', label: 'All time', from: () => '' },
  {
    key: 'today',
    label: 'Today',
    from: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    },
  },
  {
    key: '24h',
    label: 'Last 24h',
    from: () => new Date(Date.now() - 24 * 3_600_000).toISOString(),
  },
  {
    key: '7d',
    label: 'Last 7 days',
    from: () => new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
  },
];

export function TimelinePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<TimelineItemDto[]>([]);
  const [agents, setAgents] = useState<AgentStatusDto[]>([]);
  const [git, setGit] = useState<GitSessionInfoDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | undefined>(undefined);

  // Filters live entirely in the URL so the page is shareable / refresh-safe.
  const range = searchParams.get('range') ?? '';
  const filters = useMemo<Filters>(() => ({
    agent: searchParams.get('agent') || undefined,
    project: searchParams.get('project') || undefined,
    session: searchParams.get('session') || undefined,
    from: RANGES.find((r) => r.key === range)?.from() || undefined,
    limit: 500,
  }), [searchParams, range]);

  const load = (silent = false) => {
    if (!silent) setRefreshing(true);
    // When a session is selected, also fetch its git projection so we can
    // interleave commits with activity events in a single ordered feed.
    const gitPromise = filters.session
      ? api.gitSessionCommits(filters.session).catch(() => null)
      : Promise.resolve(null);
    Promise.all([api.timeline(filters), api.agentStatus(), gitPromise])
      .then(([tl, ag, g]) => {
        setItems(tl);
        setAgents(ag);
        setGit(g);
        setLastLoadedAt(new Date().toISOString());
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => { if (!silent) setRefreshing(false); });
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [searchParams.toString()]);

  // Auto-refresh when the backend reports a fresh scan.
  const { connected } = useSse('/api/events/stream', {
    types: ['scan_completed'],
    bufferSize: 5,
  });
  useEffect(() => {
    const t = setInterval(load.bind(null, true), 1500); // SSE debounce: any scan in the last 1.5s → re-load
    return () => clearInterval(t);
  }, [filters]);

  // Merge events + git commits into a single sorted feed. Both already
  // come back newest-first, so concat + re-sort is enough.
  const mergedItems = useMemo<TimelineItemDto[]>(() => {
    if (!git || git.commits.length === 0) return items;
    const gitItems: TimelineItemDto[] = git.commits.map((c) => gitCommitToTimeline(c, filters, agents));
    return [...items, ...gitItems].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [items, git, filters, agents]);

  const setFilter = (key: string, value: string | undefined): void => {
    const next = new URLSearchParams(searchParams);
    if (!value) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const clearAll = (): void => setSearchParams(new URLSearchParams(), { replace: true });

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Timeline</h1>
          <p className="text-sm text-muted-foreground">
            {mergedItems.length.toLocaleString()} events ·{' '}
            <span className={cn(connected ? 'text-emerald-700' : 'text-muted-foreground')}>
              {connected ? 'live' : 'offline'}
            </span>{' '}
            · last loaded {formatRelative(lastLoadedAt ?? null)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
          {refreshing ? 'Loading…' : 'Reload'}
        </Button>
      </header>

      <FilterBar
        filters={filters}
        range={range}
        agents={agents}
        onSet={setFilter}
        onClear={clearAll}
      />

      {mergedItems.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No events match the current filters.
          </CardContent>
        </Card>
      ) : (
        <>
          {git && git.repo && (
            <GitRepoBanner info={git} />
          )}
          {git && !git.repo && git.reason && filters.session && (
            <Card>
              <CardContent className="py-3 text-xs text-muted-foreground">
                <Badge tone="muted" className="mr-2">no git</Badge>
                {git.reason}. Timeline shows activity events only.
              </CardContent>
            </Card>
          )}
          <ol className="relative space-y-6">
            {groupByDay(mergedItems).map(({ day, items: dayItems }) => (
              <li key={day} className="space-y-2">
                <h3 className="sticky top-0 z-10 bg-background/80 px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                  {day}
                </h3>
                <ul className="space-y-1.5">
                  {dayItems.map((item) => (
                    <TimelineRow key={item.id} item={item} />
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function FilterBar({
  filters,
  range,
  agents,
  onSet,
  onClear,
}: {
  filters: Filters;
  range: string;
  agents: AgentStatusDto[];
  onSet: (key: string, value: string | undefined) => void;
  onClear: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Filters</CardTitle>
        <CardDescription>Combine any of: agent, project, session, time range.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Agent">
            <select
              value={filters.agent ?? ''}
              onChange={(e) => onSet('agent', e.target.value || undefined)}
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
              value={filters.project ?? ''}
              placeholder="e.g. /p/ai/dev/loop"
              onChange={(e) => onSet('project', e.target.value || undefined)}
              className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>

          <Field label="Session">
            <input
              type="text"
              value={filters.session ?? ''}
              placeholder="claude-code:abc-123"
              onChange={(e) => onSet('session', e.target.value || undefined)}
              className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>

          <Field label="Range">
            <select
              value={range}
              onChange={(e) => onSet('range', e.target.value || undefined)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {RANGES.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
          </Field>

          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        </div>
      </CardContent>
    </Card>
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

function GitRepoBanner({ info }: { info: GitSessionInfoDto }) {
  if (!info.repo) return null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-3 text-xs">
        <Badge tone="success" className="uppercase">git</Badge>
        <span className="font-mono text-foreground" title={info.repo.root}>
          {info.repo.root}
        </span>
        {info.repo.branch && (
          <span className="text-muted-foreground">
            branch <span className="font-mono text-foreground">{info.repo.branch}</span>
          </span>
        )}
        {info.repo.currentCommit && (
          <span className="text-muted-foreground">
            HEAD{' '}
            <span className="font-mono text-foreground">
              {info.repo.currentCommit.slice(0, 7)}
            </span>
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {info.commits.length} commit{info.commits.length === 1 ? '' : 's'} in window
        </span>
      </CardContent>
    </Card>
  );
}

/** Convert a GitCommit into a TimelineItem so the same row renderer can show it. */
function gitCommitToTimeline(
  c: GitCommitDto,
  filters: Filters,
  agents: AgentStatusDto[],
): TimelineItemDto {
  const agent = agents[0];
  const agentId = agent?.agent ?? 'git';
  return {
    id: `git:${c.hash}`,
    agentId,
    agentType: 'git' as TimelineItemDto['agentType'],
    sessionId: filters.session ?? '',
    sessionTitle: null,
    project: filters.project ?? '',
    projectDisplay: filters.project ?? '',
    timestamp: c.timestamp,
    type: 'git-commit',
    action: `Commit · ${c.shortHash}`,
    detail: c.message,
    meta: {
      hash: c.hash,
      shortHash: c.shortHash,
      author: c.author,
      authorEmail: c.authorEmail,
      body: c.body,
      filesChanged: c.filesChanged,
      insertions: c.insertions,
      deletions: c.deletions,
    },
  };
}

function TimelineRow({ item }: { item: TimelineItemDto }) {
  const tone = typeTone(item.type);
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2">
      <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', tone.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2 text-sm">
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatClock(item.timestamp)}
          </span>
          <Badge tone={tone.badge}>{tone.label}</Badge>
          <span className="text-foreground">{item.action}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{item.agentType}</span>
          {item.projectDisplay && (
            <>
              <span>·</span>
              <span className="truncate" title={item.project}>{item.projectDisplay}</span>
            </>
          )}
          {item.sessionTitle && (
            <>
              <span>·</span>
              <span className="truncate" title={item.sessionTitle}>{item.sessionTitle}</span>
            </>
          )}
          {item.sessionId && item.type !== 'git-commit' && (
            <>
              <span>·</span>
              <Link
                to={`/sessions/${encodeURIComponent(item.sessionId)}`}
                className="text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                session →
              </Link>
            </>
          )}
        </div>
        {item.meta && Object.keys(item.meta).length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground">
              meta
            </summary>
            <pre className="mt-1 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug text-muted-foreground">
              {JSON.stringify(item.meta, null, 2)}
            </pre>
          </details>
        )}
      </div>
      <time className="shrink-0 text-xs tabular-nums text-muted-foreground/70" dateTime={item.timestamp} title={item.timestamp}>
        {formatRelative(item.timestamp)}
      </time>
    </li>
  );
}

function typeTone(type: string): { label: string; badge: 'success' | 'warning' | 'danger' | 'muted' | 'default'; dot: string } {
  switch (type) {
    case 'session-start': return { label: 'start', badge: 'success', dot: 'bg-emerald-500' };
    case 'session-end':   return { label: 'end',   badge: 'muted',    dot: 'bg-muted-foreground/40' };
    case 'message':       return { label: 'msg',   badge: 'default',  dot: 'bg-blue-500' };
    case 'tool-call':     return { label: 'tool',  badge: 'warning',  dot: 'bg-amber-500' };
    case 'file-edit':     return { label: 'edit',  badge: 'warning',  dot: 'bg-amber-500' };
    case 'file-write':    return { label: 'write', badge: 'warning',  dot: 'bg-amber-500' };
    case 'file-read':     return { label: 'read',  badge: 'muted',    dot: 'bg-muted-foreground/40' };
    case 'command':       return { label: 'exec',  badge: 'default',  dot: 'bg-slate-500' };
    case 'git-commit':    return { label: 'commit',badge: 'success',  dot: 'bg-emerald-500' };
    case 'status':        return { label: 'status',badge: 'muted',    dot: 'bg-muted-foreground/40' };
    default:              return { label: type,    badge: 'default',  dot: 'bg-muted-foreground/40' };
  }
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function groupByDay(items: TimelineItemDto[]): Array<{ day: string; items: TimelineItemDto[] }> {
  const out: Array<{ day: string; items: TimelineItemDto[] }> = [];
  for (const it of items) {
    const day = it.timestamp.slice(0, 10); // YYYY-MM-DD
    const last = out[out.length - 1];
    if (last && last.day === day) {
      last.items.push(it);
    } else {
      out.push({ day: formatDay(day), items: [it] });
    }
  }
  return out;
}

function formatDay(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return yyyymmdd;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const t = d.getTime();
  if (t === today.getTime()) return 'Today';
  if (t === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}