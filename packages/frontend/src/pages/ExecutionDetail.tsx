/**
 * v0.8 ExecutionDetail — one Execution (a 30-min-gap-grouped slice of
 * a Session) shown with full events + usage + commits.
 *
 * Source: `GET /api/executions/:id` (where id = `${sessionId}:exec-${n}`)
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ExecutionDetailDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { agentColor, cn, formatCompact, formatDate, formatRelative, formatUSD } from '../lib/format';

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

  const title = data.title ?? `${data.agentType} execution`;
  const statusBadge = (() => {
    switch (data.status) {
      case 'running':   return <Badge tone="info" className="text-[10px]">● running</Badge>;
      case 'completed': return <Badge tone="success" className="text-[10px]">✓ completed</Badge>;
      case 'unknown':   return <Badge tone="muted" className="text-[10px]">? unknown</Badge>;
    }
  })();

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