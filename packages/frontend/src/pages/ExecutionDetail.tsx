/**
 * v0.8 ExecutionDetail — one Execution (a 30-min-gap-grouped slice of
 * a Session) shown with full events + usage + commits.
 *
 * Source: `GET /api/executions/:id` (where id = `${sessionId}:exec-${n}`)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type EffectiveExecutionStatus,
  type ExecutionDetailDto,
  type ExecutionMetadataDto,
  type LifecycleConflictDto,
  type ManualExecutionStatus,
} from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { agentColor, cn, formatCompact, formatDate, formatRelative, formatUSD } from '../lib/format';
import { useSse } from '../lib/use-sse';

const MANUAL_STATUSES: Array<{ value: '' | ManualExecutionStatus; label: string }> = [
  { value: '',                label: 'Auto (use derived status)' },
  { value: 'todo',            label: 'Todo' },
  { value: 'in-progress',     label: 'In Progress' },
  { value: 'done',            label: 'Done' },
  { value: 'blocked',         label: 'Blocked' },
  { value: 'archived',        label: 'Archived' },
];

export function ExecutionDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<ExecutionDetailDto | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.execution(id)
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [id]);

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Loading…</div>;

  // v0.9: displayName wins when set; otherwise fall back to auto title.
  const displayName = (data.displayName ?? '').trim();
  const title = displayName || data.title || `${data.agentType} execution`;
  const statusBadge = <StatusBadge status={data.effectiveStatus} />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/executions" className="text-xs text-muted-foreground hover:underline">← all executions</Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold" title={title}>{title}</h1>
            <Badge className={agentColor(data.agentType)}>{data.agentType}</Badge>
            {statusBadge}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            execution <code className="font-mono">{data.id}</code> · session{' '}
            <Link to={`/sessions/${encodeURIComponent(data.sessionId)}`} className="text-primary hover:underline font-mono">
              {data.sessionId}
            </Link>
          </p>
          <p className="font-mono text-xs text-muted-foreground" title={data.projectDisplay || data.project}>
            {data.projectDisplay || data.project}
          </p>
        </div>
      </header>

      {/* v0.9: Execution Workspace — user customizations */}
      <WorkspaceEditor
        executionId={data.id}
        initial={{
          displayName: data.displayName ?? null,
          note: data.note ?? null,
          tags: data.tags ?? [],
          manualStatus: data.manualStatus ?? null,
        }}
        derivedStatus={data.status}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Duration" value={formatDuration(data.durationMs)} />
        <Stat label="Events" value={formatCompact(data.eventCount)} />
        <Stat label="Tokens" value={formatCompact(data.tokenUsage)} />
        <Stat label="Cost" value={formatUSD(data.cost)} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Time window</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row label="Started" value={formatDate(data.startTime)} hint={formatRelative(data.startTime)} />
            <Row label="Ended" value={data.endTime ? formatDate(data.endTime) : '—'} hint={data.endTime ? formatRelative(data.endTime) : 'still running?'} />
          </dl>
        </CardContent>
      </Card>

      {/* v1.0: Lifecycle Timeline — manual status changes (and future auto). */}
      <LifecycleTimeline executionId={data.id} />

      {/* v1.1: derived lifecycle snapshot (read-only intelligence). */}
      <LifecycleSnapshotCard executionId={data.id} />

      {/* v1.4: persistent health trend + history */}
      <HealthTrendBlock executionId={data.id} />

      {/* v1.4: attention lifecycle history */}
      <AttentionLifecycleBlock executionId={data.id} />

      {/* Commits produced by this execution */}
      <Card>
        <CardHeader>
          <CardTitle>Git result</CardTitle>
          <CardDescription>
            {data.commits.length === 0
              ? 'No commits in this execution window.'
              : `${data.commits.length} commit${data.commits.length === 1 ? '' : 's'} in this execution window.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.commits.length === 0 ? null : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Commit</TH>
                  <TH>Author</TH>
                  <TH className="text-right">Files</TH>
                  <TH className="text-right">+/−</TH>
                </TR>
              </THead>
              <TBody>
                {data.commits.map((c) => (
                  <TR key={c.hash}>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground" title={formatDate(c.timestamp)}>
                      {formatRelative(c.timestamp)}
                    </TD>
                    <TD>
                      <div className="font-mono text-xs">{c.shortHash}</div>
                      <div className="truncate text-xs" title={c.message}>{c.message}</div>
                    </TD>
                    <TD className="text-xs">{c.author}</TD>
                    <TD className="text-right tabular-nums">{c.filesChanged}</TD>
                    <TD className="text-right tabular-nums">
                      <span className="text-emerald-700">+{c.insertions}</span>{' '}
                      <span className="text-rose-700">−{c.deletions}</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Timeline / events */}
      <Card>
        <CardHeader>
          <CardTitle>Timeline summary</CardTitle>
          <CardDescription>
            {data.events.length === 0
              ? 'No activity events in this execution window.'
              : `${data.events.length} event${data.events.length === 1 ? '' : 's'} in chronological order.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.events.length === 0 ? null : (
            <ul className="space-y-1.5">
              {data.events.map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatRelative(e.timestamp)}</span>
                  <Badge tone="muted" className="shrink-0 text-[10px]">{e.type}</Badge>
                  <span className="min-w-0 flex-1 truncate" title={e.detail ?? ''}>{e.detail ?? e.action}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Usage */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>
            {data.usage.length === 0
              ? 'No usage records in this execution window.'
              : `${data.usage.length} record${data.usage.length === 1 ? '' : 's'} totaling ${formatCompact(data.tokenUsage)} tokens.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.usage.length === 0 ? null : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Model</TH>
                  <TH className="text-right">Input</TH>
                  <TH className="text-right">Output</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Cost</TH>
                </TR>
              </THead>
              <TBody>
                {data.usage.map((u) => (
                  <TR key={u.id}>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground" title={formatDate(u.timestamp)}>
                      {formatRelative(u.timestamp)}
                    </TD>
                    <TD className="font-mono text-xs">{u.model}</TD>
                    <TD className="text-right tabular-nums">{formatCompact(u.inputTokens)}</TD>
                    <TD className="text-right tabular-nums">{formatCompact(u.outputTokens)}</TD>
                    <TD className="text-right tabular-nums">{formatCompact(u.totalTokens)}</TD>
                    <TD className="text-right tabular-nums">{formatUSD(u.estimatedCost)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle>{label}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/40 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">
        {value}
        {hint && <span className="ml-2 text-[10px] text-muted-foreground/70">({hint})</span>}
      </dd>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* ---------------- v0.9: StatusBadge ---------------- */

function StatusBadge({ status }: { status: EffectiveExecutionStatus }) {
  switch (status) {
    case 'running':
      return <Badge tone="info" className="text-[10px]">● running</Badge>;
    case 'completed':
      return <Badge tone="success" className="text-[10px]">✓ completed</Badge>;
    case 'unknown':
      return <Badge tone="muted" className="text-[10px]">? unknown</Badge>;
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

/* ---------------- v1.1: Lifecycle Snapshot ---------------- */

function LifecycleSnapshotCard({ executionId }: { executionId: string }) {
  const [snap, setSnap] = useState<import('../lib/api').LifecycleSnapshotDto | null>(null);
  const [conflict, setConflict] = useState<LifecycleConflictDto | null>(null);
  const [health, setHealth] = useState<{
    score: import('../lib/api').LifecycleHealthScoreDto;
    explanation: import('../lib/api').LifecycleExplanationDto;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    Promise.all([
      api.executionLifecycle(executionId),
      api.executionConflict(executionId),
      api.executionHealth(executionId),
    ])
      .then(([s, c, h]) => {
        setSnap(s);
        setConflict(c);
        setHealth(h);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (cancelled) return;
      refresh();
    };
    load();
    // 30s polling fallback (covers SSE gaps / backend restart).
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId]);

  // v1.2: subscribe to lifecycle_changed events. Refresh on any event
  // for THIS executionId (other executions' changes are ignored).
  const { events: lifecycleEvents } = useSse('/api/events/stream', {
    types: ['lifecycle_changed'],
    bufferSize: 10,
  });
  useEffect(() => {
    if (lifecycleEvents.length === 0) return;
    const last = lifecycleEvents[lifecycleEvents.length - 1] as { executionId?: string };
    if (last.executionId === executionId) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifecycleEvents.length, executionId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lifecycle Intelligence</CardTitle>
        <CardDescription>
          Read-only snapshot derived from activity events, commits, and
          timestamps. Refreshes via SSE on lifecycle changes + every 30s
          fallback. Manual status (above) takes precedence over this view.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!err && !snap && (
          <p className="text-sm text-muted-foreground">Analyzing…</p>
        )}
        {snap && (
          <div className="space-y-3">
            {conflict?.isConflict && (
              <div className="rounded-md border border-rose-300/60 bg-rose-50/60 px-3 py-2 text-xs text-rose-900 dark:border-rose-700/60 dark:bg-rose-950/30 dark:text-rose-200">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">⚠ Manual vs derived conflict</span>
                  <span className="text-rose-700 dark:text-rose-300">{conflict.label ?? `${conflict.manualStatus} vs ${conflict.derivedStatus}`}</span>
                </div>
                <p className="mt-1 text-[11px] text-rose-700/90 dark:text-rose-300/80">
                  You set this to <strong>{conflict.manualStatus}</strong>, but the
                  system thinks it's <strong>{conflict.derivedStatus}</strong>{' '}
                  ({conflict.confidence} confidence). The manual value wins — review
                  if your intent is stale.
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Derived:</span>
              <DerivedBadge status={snap.derivedStatus} />
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase',
                snap.confidence === 'high'   ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' :
                snap.confidence === 'medium' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' :
                                             'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
              )}>
                {snap.confidence} confidence
              </span>
              {snap.lastActivityAt && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  last activity {formatRelative(snap.lastActivityAt)}
                </span>
              )}
            </div>
            <p className="text-sm text-foreground/90">{snap.reason}</p>
            {snap.indicators.length > 0 && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {snap.indicators.map((i, idx) => (
                  <li key={idx} className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] uppercase">{i.type}</span>
                    <span className="text-foreground/80">— {i.label}</span>
                    <span className="ml-auto text-[10px] tabular-nums">w {i.weight.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* v1.3: Health + Explanation */}
            {health && <HealthBlock health={health} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HealthBlock({ health }: {
  health: { score: import('../lib/api').LifecycleHealthScoreDto; explanation: import('../lib/api').LifecycleExplanationDto };
}) {
  const scoreTone =
    health.score.level === 'healthy'   ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' :
    health.score.level === 'warning'   ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' :
                                         'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300';
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Health:</span>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', scoreTone)}>
          {health.score.score}
        </span>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {health.score.level}
        </span>
      </div>
      <p className="text-sm text-foreground/90">{health.explanation.headline}</p>
      {health.explanation.bullets.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
          {health.explanation.bullets.map((b, idx) => (
            <li key={idx}>{b}</li>
          ))}
        </ul>
      )}
      {health.score.factors.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider">
            {health.score.factors.length} factors
          </summary>
          <ul className="mt-1 space-y-0.5">
            {health.score.factors.map((f, idx) => (
              <li key={idx} className="flex items-baseline gap-2">
                <span className="font-mono text-[10px]">{f.name}</span>
                <span className="text-foreground/80">— {f.reason}</span>
                <span className={cn(
                  'ml-auto text-[10px] tabular-nums',
                  f.impact > 0 ? 'text-emerald-600' : f.impact < 0 ? 'text-rose-600' : '',
                )}>
                  {f.impact > 0 ? '+' : ''}{f.impact}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ---------------- v1.4: Health Trend + History ---------------- */

function HealthTrendBlock({ executionId }: { executionId: string }) {
  const [trend, setTrend] = useState<import('../lib/api').HealthTrendDto | null>(null);
  const [history, setHistory] = useState<import('../lib/api').HealthSnapshotHistoryDto[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    Promise.all([
      api.executionHealthTrend(executionId, 50).catch(() => null),
      api.executionHealthHistory(executionId, 50).catch(() => []),
    ])
      .then(([t, h]) => { setTrend(t); setHistory(h); setErr(null); })
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    let cancelled = false;
    refresh();
    const t = setInterval(() => { if (!cancelled) refresh(); }, 30_000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Health Trend</CardTitle>
        <CardDescription>
          Persistent history of this execution's health. Records when the
          level changes or every 5 minutes (whichever comes first). Read-only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!err && !trend && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {trend && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Direction:</span>
              <TrendBadge direction={trend.direction} />
              <span className="text-xs tabular-nums text-muted-foreground">
                {trend.samples} sample{trend.samples === 1 ? '' : 's'} · scoreDelta {trend.scoreDelta >= 0 ? '+' : ''}{trend.scoreDelta}
              </span>
            </div>
            <p className="text-sm text-foreground/90">{trend.summary}</p>
            {history.length > 0 && (
              <MiniSparkline history={history} />
            )}
            {history.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wider">
                  Show {history.length} snapshot{history.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-1 space-y-0.5 max-h-48 overflow-auto">
                  {history.slice().reverse().map((h) => (
                    <li key={h.id ?? h.createdAt} className="flex items-baseline gap-2 text-[11px]">
                      <time className="font-mono text-[10px] tabular-nums">{formatRelative(h.createdAt)}</time>
                      <span className="text-foreground/80 tabular-nums">{h.score}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80">{h.level}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TrendBadge({ direction }: { direction: import('../lib/api').HealthTrendDirection }) {
  const tone =
    direction === 'improving' ? 'success' :
    direction === 'degrading' ? 'danger'  :
                                    'muted';
  const icon = direction === 'improving' ? '↗' :
                direction === 'degrading' ? '↘' :
                                              '→';
  return <Badge tone={tone} className="text-[10px]">{icon} {direction}</Badge>;
}

function MiniSparkline({ history }: { history: import('../lib/api').HealthSnapshotHistoryDto[] }) {
  if (history.length < 2) return null;
  const width = 100;
  const height = 30;
  const scores = history.map((h) => h.score);
  const min = 0;
  const max = 100;
  const stepX = width / (history.length - 1);
  const points = history.map((h, i) => {
    const x = i * stepX;
    const y = height - ((h.score - min) / (max - min)) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const path = `M ${points.join(' L ')}`;
  const lastScore = scores[scores.length - 1]!;
  const lastX = (history.length - 1) * stepX;
  const lastY = height - ((lastScore - min) / (max - min)) * (height - 4) - 2;
  return (
    <div className="rounded border border-border bg-muted/20 p-1">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1" className="text-primary" />
        <circle cx={lastX} cy={lastY} r="1.5" className="fill-primary" />
      </svg>
    </div>
  );
}

/* ---------------- v1.4: Attention Lifecycle ---------------- */

function AttentionLifecycleBlock({ executionId }: { executionId: string }) {
  const [items, setItems] = useState<import('../lib/api').AttentionHistoryEntryDto[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.executionAttentionHistory(executionId, 50)
      .then((rows) => { if (!cancelled) { setItems(rows); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attention Lifecycle</CardTitle>
        <CardDescription>
          Detected / ongoing / recovered transitions for this execution's
          attention items. Updates when the queue changes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!err && items.length === 0 && (
          <p className="text-sm text-muted-foreground">No attention history yet.</p>
        )}
        {items.length > 0 && (
          <ol className="space-y-1">
            {items.slice().reverse().map((it) => (
              <li key={it.id ?? `${it.createdAt}-${it.attentionKey}`} className="flex items-start gap-2 text-xs">
                <span className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                  it.lifecycle === 'detected'  ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' :
                  it.lifecycle === 'ongoing'   ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' :
                                                'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
                )}>
                  {it.lifecycle}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <code className="font-mono text-[10px] text-muted-foreground">{it.attentionKey}</code>
                    <span className="text-[10px] text-muted-foreground/80">{formatRelative(it.createdAt)}</span>
                  </div>
                  <p className="text-foreground/90 truncate" title={it.reason}>{it.reason}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function DerivedBadge({ status }: { status: import('../lib/api').DerivedLifecycleStatus }) {
  switch (status) {
    case 'queued':
      return <Badge tone="muted" className="text-[10px]">○ queued</Badge>;
    case 'running':
      return <Badge tone="success" className="text-[10px]">● running</Badge>;
    case 'idle':
      return <Badge tone="muted" className="text-[10px]">~ idle</Badge>;
    case 'blocked':
      return <Badge tone="warning" className="text-[10px]">✕ blocked</Badge>;
    case 'completed':
      return <Badge tone="success" className="text-[10px]">✓ completed</Badge>;
    case 'failed':
      return <Badge tone="danger" className="text-[10px]">! failed</Badge>;
  }
}

/* ---------------- v0.9: Workspace editor ---------------- */

interface WorkspaceFormState {
  displayName: string;
  note: string;
  tagsRaw: string;
  manualStatus: '' | ManualExecutionStatus;
}

/* ---------------- v1.0: Lifecycle Timeline ---------------- */

function LifecycleTimeline({ executionId }: { executionId: string }) {
  const [history, setHistory] = useState<import('../lib/api').ExecutionStatusHistoryDto[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.executionHistory(executionId)
      .then(setHistory)
      .catch((e) => setErr(String(e)));
  }, [executionId]);

  // Also re-fetch when the WorkspaceEditor saves (parent state flips).
  // Cheap: history rarely grows past a few rows.
  useEffect(() => {
    const t = setTimeout(() => {
      api.executionHistory(executionId)
        .then(setHistory)
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [executionId, history.length]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lifecycle Timeline</CardTitle>
        <CardDescription>
          Status changes for this execution. Currently we only record
          manual changes (from the Workspace editor); auto-derived
          status shifts will appear here in a later release.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!err && history.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No status changes recorded yet. Use the Workspace editor
            above to set a manual status — every change appears here.
          </p>
        )}
        {history.length > 0 && (
          <ol className="space-y-0">
            {history.map((h, i) => (
              <li key={h.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={cn(
                    'mt-1.5 h-2.5 w-2.5 rounded-full',
                    h.source === 'manual' ? 'bg-primary' : 'bg-muted-foreground/40',
                  )} />
                  {i < history.length - 1 && (
                    <span className="min-h-[24px] w-px flex-1 bg-border" />
                  )}
                </div>
                <div className="flex-1 pb-3">
                  <div className="flex flex-wrap items-baseline gap-2 text-xs">
                    <time
                      className="font-mono tabular-nums text-muted-foreground"
                      dateTime={h.createdAt}
                      title={h.createdAt}
                    >
                      {formatClock(h.createdAt)}
                    </time>
                    {h.fromStatus ? (
                      <>
                        <StatusBadge status={h.fromStatus} />
                        <span className="text-muted-foreground">→</span>
                      </>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">initial</span>
                    )}
                    <StatusBadge status={h.toStatus} />
                    {h.source === 'manual' && (
                      <span className="text-[10px] uppercase tracking-wider text-primary/70">manual</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                    {formatRelative(h.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function WorkspaceEditor({
  executionId,
  initial,
  derivedStatus,
}: {
  executionId: string;
  initial: { displayName: string | null; note: string | null; tags: string[]; manualStatus: ManualExecutionStatus | null };
  derivedStatus: import('../lib/api').ExecutionStatus;
}) {
  const [form, setForm] = useState<WorkspaceFormState>({
    displayName: initial.displayName ?? '',
    note: initial.note ?? '',
    tagsRaw: initial.tags.join(', '),
    manualStatus: initial.manualStatus ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed when initial changes (parent reloaded).
  useEffect(() => {
    setForm({
      displayName: initial.displayName ?? '',
      note: initial.note ?? '',
      tagsRaw: initial.tags.join(', '),
      manualStatus: initial.manualStatus ?? '',
    });
  }, [initial.displayName, initial.note, initial.tags.join('|'), initial.manualStatus]);

  const dirty = useMemo(() => {
    return (
      form.displayName !== (initial.displayName ?? '') ||
      form.note !== (initial.note ?? '') ||
      form.tagsRaw !== initial.tags.join(', ') ||
      form.manualStatus !== (initial.manualStatus ?? '')
    );
  }, [form, initial]);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const patch: import('../lib/api').ExecutionMetadataPatch = {
        displayName: form.displayName.trim() ? form.displayName.trim() : null,
        note: form.note.trim() ? form.note.trim() : null,
        tags: form.tagsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        // `''` means "Auto" — clears the manual override.
        manualStatus: form.manualStatus === '' ? null : form.manualStatus,
      };
      const updated: ExecutionMetadataDto = await api.patchExecutionMetadata(executionId, patch);
      setForm({
        displayName: updated.displayName ?? '',
        note: updated.note ?? '',
        tagsRaw: (updated.tags ?? []).join(', '),
        manualStatus: updated.manualStatus ?? '',
      });
      setSavedAt(new Date().toISOString());
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution Workspace</CardTitle>
        <CardDescription>
          Customizations live in the <code className="font-mono">execution_metadata</code> table.
          We never modify the derived execution (events / commits / usage).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Display name</label>
            <input
              type="text"
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="e.g. Implement Workspace v0.9"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-[10px] text-muted-foreground/70">
              Wins over the auto-inferred title when set.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tags <span className="text-muted-foreground/70">(comma-separated, max 32)</span></label>
            <input
              type="text"
              value={form.tagsRaw}
              onChange={(e) => setForm((f) => ({ ...f, tagsRaw: e.target.value }))}
              placeholder="v0.9, feature, important"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Note</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="Goal, leftover issues, post-mortem…"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <select
              value={form.manualStatus}
              onChange={(e) => setForm((f) => ({ ...f, manualStatus: e.target.value as WorkspaceFormState['manualStatus'] }))}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {MANUAL_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground/70">
              Auto currently shows <strong>{derivedStatus}</strong>. Manual overrides win when set.
            </p>
          </div>
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}

        <div className="flex items-center justify-between">
          <span className={cn('text-xs text-muted-foreground', savedAt && 'text-emerald-600')}>
            {savedAt ? 'Saved' : dirty ? 'Unsaved changes' : 'No changes'}
          </span>
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}