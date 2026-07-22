/**
 * Live Activity Panel — derives the current "what is the AI doing right
 * now?" picture from the SSE stream (`/api/events/stream`) plus the
 * `/api/agents/status` snapshot.
 *
 * No manual refresh — every event from the backend (file change, scan
 * complete, agent status) re-renders the relevant rows.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AgentStatusDto, type OverviewDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { cn, formatRelative } from '../lib/format';
import { useSse, type SseEvent } from '../lib/use-sse';

interface LiveActivityProps {
  /** Snapshot for the "Working on" project name. */
  initialOverview?: OverviewDto | null;
}

export function LiveActivity({ initialOverview = null }: LiveActivityProps) {
  const [status, setStatus] = useState<AgentStatusDto[]>([]);
  const [overview, setOverview] = useState<OverviewDto | null>(initialOverview);

  // Initial fetch (so the panel paints even before any SSE event arrives).
  useEffect(() => {
    api.agentStatus().then(setStatus).catch(() => undefined);
  }, []);

  // Subscribe to the realtime stream.
  const { events, connected, lastEventAt } = useSse('/api/events/stream', {
    types: ['scan_completed', 'file_changed', 'agent_status'],
    bufferSize: 30,
  });

  // Whenever the backend pushes an agent_status event, fold it into
  // local status state. We don't trust the row from a single snapshot —
  // a busy session may have moved on by the time the user looks.
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    if (latest.type !== 'agent_status') return;
    const ev = latest as SseEvent & { agent?: string; status?: string; lastActivity?: string; lastProject?: string; lastAction?: string };
    if (!ev.agent || ev.agent === '__snapshot__') return;
    setStatus((prev) => {
      const next = prev.slice();
      const i = next.findIndex((r) => r.agent === ev.agent);
      const row: AgentStatusDto = {
        agent: ev.agent!,
        status: (ev.status ?? 'unknown') as AgentStatusDto['status'],
        lastActivity: ev.lastActivity,
        lastProject: ev.lastProject,
        lastAction: ev.lastAction,
      };
      if (i >= 0) next[i] = row;
      else next.push(row);
      return next;
    });
    // Periodically refresh the Overview (totals/daily) so cost / token
    // numbers stay roughly in sync with the live counters.
    if (overview) {
      const t = setTimeout(() => {
        api.overview().then(setOverview).catch(() => undefined);
      }, 600);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  const sorted = useMemo(() => {
    const order = { active: 0, idle: 1, unknown: 2 } as const;
    return status.slice().sort((a, b) => order[a.status] - order[b.status] || a.agent.localeCompare(b.agent));
  }, [status]);

  const activeCount = sorted.filter((s) => s.status === 'active').length;
  const recentEvents = events.slice(-6).reverse();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Live Activity</CardTitle>
            <CardDescription>
              {activeCount > 0
                ? `${activeCount} agent${activeCount === 1 ? '' : 's'} active right now`
                : 'No active agents. Idle / unknown.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                connected ? 'bg-emerald-500' : 'bg-rose-500',
              )}
              title={connected ? 'Connected to event stream' : 'Disconnected'}
            />
            <span className="text-xs text-muted-foreground">
              {connected ? 'live' : 'offline'}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents registered yet.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {sorted.map((row) => (
              <AgentStatusRow key={row.agent} row={row} />
            ))}
          </ul>
        )}

        {overview && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">Today</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
              <span>
                Tokens:{' '}
                <strong className="text-foreground">
                  {formatCompact(overview.todayTokens)}
                </strong>
              </span>
              <span>
                Sessions:{' '}
                <strong className="text-foreground">{overview.todaySessions}</strong>
              </span>
              <span>
                Cost:{' '}
                <strong className="text-foreground">${overview.todayCost.toFixed(2)}</strong>
              </span>
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Recent events</div>
          {recentEvents.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Waiting for the first event…
              {lastEventAt ? '' : ''}
            </p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-muted-foreground">
              {recentEvents.map((ev, i) => (
                <li key={i}>
                  <span className="text-foreground">{ev.type}</span>{' '}
                  <span className="text-muted-foreground/70">
                    {(ev as Record<string, unknown>).agent as string ?? ''}
                  </span>
                  {(ev as Record<string, unknown>).filePath ? (
                    <span className="ml-1 truncate">
                      {(ev as Record<string, unknown>).filePath as string}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function AgentStatusRow({ row }: { row: AgentStatusDto }) {
  const tone =
    row.status === 'active' ? 'success' :
    row.status === 'idle' ? 'warning' : 'muted';
  const dotColor =
    row.status === 'active' ? 'bg-emerald-500' :
    row.status === 'idle' ? 'bg-amber-500' : 'bg-muted-foreground/40';

  // Each row is a link to the full timeline filtered by this agent.
  // v0.5: drill-down from Live → Timeline in one click.
  return (
    <li>
      <Link
        to={`/timeline?agent=${encodeURIComponent(row.agent)}`}
        className="block rounded-md border border-border bg-background p-3 transition-colors hover:border-foreground/30 hover:bg-muted/40"
      >
        <div className="flex items-start gap-3">
          <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', dotColor)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{row.agent}</span>
              <Badge tone={tone}>{row.status}</Badge>
            </div>
            {row.lastProject && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground" title={row.lastProject}>
                Project: <span className="font-mono">{row.lastProject}</span>
              </div>
            )}
            {row.lastAction && (
              <div className="truncate text-xs text-muted-foreground" title={row.lastAction}>
                Last action: <span className="text-foreground">{row.lastAction}</span>
              </div>
            )}
            {row.lastActivity && (
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                Updated {formatRelative(row.lastActivity)} · open timeline →
              </div>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}