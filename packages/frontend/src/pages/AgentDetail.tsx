import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type SessionDto, type AgentDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { BarChart } from '../components/charts';
import { formatCompact, formatRelative, formatUSD, statusColor, agentColor, formatDate } from '../lib/format';

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<(AgentDto & { sessions: SessionDto[] }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.agent(id).then(setData).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, [id]);

  const toggle = async () => {
    if (!data) return;
    await api.setAgentEnabled(data.id, !data.enabled);
    load();
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <Link to="/" className="text-xs text-muted-foreground hover:underline">← back to overview</Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{data.name}</h1>
            <Badge className={agentColor(data.type)}>{data.type}</Badge>
            <span className={`rounded-full px-2 py-0.5 text-xs ${data.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
              {data.enabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">data dir: <code className="font-mono">{data.dataDir}</code></p>
          <p className="text-xs text-muted-foreground">last scanned: {formatRelative(data.lastScannedAt ?? null)}</p>
        </div>
        <Button variant="outline" size="sm" onClick={toggle}>
          {data.enabled ? 'Disable' : 'Enable'}
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Stat label="Sessions" value={formatCompact(data.sessions)} />
        <Stat label="Tokens" value={formatCompact(data.tokens)} />
        <Stat label="Est. cost" value={formatUSD(data.cost)} />
        <Stat label="Capabilities" value={(data.capabilities ?? []).join(', ') || '—'} small />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
          <CardDescription>Most recent {data.sessions.length} sessions for this agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Project</TH>
                <TH>Title</TH>
                <TH>Model</TH>
                <TH className="text-right">Tokens</TH>
                <TH className="text-right">Cost</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {data.sessions.map((s) => (
                <TR key={s.id}>
                  <TD className="whitespace-nowrap text-muted-foreground" title={formatDate(s.startTime)}>
                    {formatRelative(s.startTime)}
                  </TD>
                  <TD className="max-w-[260px] truncate" title={s.projectDisplay}>{s.projectDisplay}</TD>
                  <TD className="max-w-[260px] truncate" title={s.title ?? ''}>{s.title ?? '—'}</TD>
                  <TD className="text-muted-foreground">{s.model ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(s.totalTokens)}</TD>
                  <TD className="text-right tabular-nums">{formatUSD(s.estimatedCost)}</TD>
                  <TD><span className={`rounded-full px-2 py-0.5 text-xs ${statusColor(s.status)}`}>{s.status}</span></TD>
                </TR>
              ))}
              {data.sessions.length === 0 && (
                <TR><TD colSpan={7} className="text-center text-sm text-muted-foreground">No sessions yet.</TD></TR>
              )}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Token distribution (top 10)</CardTitle>
          <CardDescription>Per-session total tokens.</CardDescription>
        </CardHeader>
        <CardContent>
          <BarChart
            data={data.sessions.slice(0, 10).map((s) => ({
              label: s.title ?? s.externalId.slice(0, 8),
              value: s.totalTokens,
            }))}
            format={formatCompact}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle>{label}</CardTitle></CardHeader>
      <CardContent>
        <div className={`tabular-nums tracking-tight ${small ? 'text-base' : 'text-2xl'} font-semibold`}>{value}</div>
      </CardContent>
    </Card>
  );
}