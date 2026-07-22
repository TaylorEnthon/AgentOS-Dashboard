import { useEffect, useState } from 'react';
import { api, type OverviewDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { BarChart, LineChart } from '../components/charts';
import { formatCompact, formatRelative, formatUSD, statusColor } from '../lib/format';
import { formatCost } from '@agentos/shared';

const AGENT_COLOR: Record<string, string> = {
  'claude-code': '#f59e0b',
  codex: '#10b981',
  grok: '#64748b',
  gemini: '#6366f1',
  hermes: '#d946ef',
  custom: '#94a3b8',
};

export function OverviewPage() {
  const [data, setData] = useState<OverviewDto | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.overview().then(setData).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh(); await load(); }
    finally { setRefreshing(false); }
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Live snapshot across {data.enabledAgents}/{data.totalAgents} agents · auto-refresh every minute.
          </p>
        </div>
        <Button onClick={refresh} disabled={refreshing} variant="outline" size="sm">
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active agents" value={`${data.enabledAgents}`} sub={`of ${data.totalAgents} installed`} />
        <StatCard label="Total sessions" value={formatCompact(data.totalSessions)} sub={`${data.activeSessions} running`} />
        <StatCard label="Today tokens" value={formatCompact(data.todayTokens)} sub={`${data.todaySessions} sessions`} />
        <StatCard label="Today cost" value={formatCost(data.todayCost, undefined)} sub={`lifetime ${formatCost(data.totalCost, undefined)}`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Token usage · last 14 days</CardTitle>
            <CardDescription>Sum of input + output tokens across all agents.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              data={data.daily.map((d) => ({ label: d.date.slice(5), value: d.tokens }))}
              format={formatCompact}
              color="#0f172a"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cost trend · last 14 days</CardTitle>
            <CardDescription>Estimated USD using built-in model pricing.</CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart
              data={data.daily.map((d) => ({ label: d.date.slice(5), value: d.cost }))}
              format={formatUSD}
              color="#10b981"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By agent</CardTitle>
          <CardDescription>Aggregate stats grouped by installed Agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH className="text-right">Sessions</TH>
                <TH className="text-right">Tokens</TH>
                <TH className="text-right">Est. cost</TH>
                <TH className="w-24">Share</TH>
              </TR>
            </THead>
            <TBody>
              {data.byAgent.map((a) => {
                const totalTokens = data.byAgent.reduce((s, x) => s + x.tokens, 0) || 1;
                const pct = (a.tokens / totalTokens) * 100;
                return (
                  <TR key={a.agentId}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-sm" style={{ background: AGENT_COLOR[a.agentType] ?? '#94a3b8' }} />
                        <span className="font-medium">{a.name}</span>
                        <Badge tone="muted">{a.agentType}</Badge>
                      </div>
                    </TD>
                    <TD className="text-right tabular-nums">{formatCompact(a.sessions)}</TD>
                    <TD className="text-right tabular-nums">{formatCompact(a.tokens)}</TD>
                    <TD className="text-right tabular-nums">{formatUSD(a.cost)}</TD>
                    <TD>
                      <div className="h-1.5 rounded bg-muted">
                        <div className="h-1.5 rounded" style={{ width: `${pct}%`, background: AGENT_COLOR[a.agentType] ?? '#94a3b8' }} />
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
          <CardDescription>Newest sessions across all agents.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Agent</TH>
                <TH>Project</TH>
                <TH>Model</TH>
                <TH className="text-right">Tokens</TH>
                <TH className="text-right">Cost</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {data.recentSessions.map((s) => (
                <TR key={s.id}>
                  <TD className="text-muted-foreground">{formatRelative(s.startTime)}</TD>
                  <TD>
                    <Badge tone="muted">{s.agentType}</Badge>
                  </TD>
                  <TD className="max-w-[280px] truncate" title={s.projectDisplay}>{s.projectDisplay}</TD>
                  <TD className="text-muted-foreground">{s.model ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(s.totalTokens)}</TD>
                  <TD className="text-right tabular-nums">{formatUSD(s.estimatedCost)}</TD>
                  <TD>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor(s.status)}`}>{s.status}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}