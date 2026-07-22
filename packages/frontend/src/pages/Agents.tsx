import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AgentDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { formatCompact, formatRelative, formatUSD, agentColor, formatDate } from '../lib/format';

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.agents().then(setAgents).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const toggle = async (a: AgentDto) => {
    await api.setAgentEnabled(a.id, !a.enabled);
    load();
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">All installed AI Coding Agents tracked by AgentOS.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{agents.length} agents</CardTitle>
          <CardDescription>Click an agent to drill into sessions and per-agent stats.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH>Data dir</TH>
                <TH className="text-right">Sessions</TH>
                <TH className="text-right">Tokens</TH>
                <TH className="text-right">Cost</TH>
                <TH>Last scanned</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {agents.map((a) => (
                <TR key={a.id}>
                  <TD>
                    <Link to={`/agents/${a.id}`} className="flex items-center gap-2 hover:underline">
                      <span className={`rounded px-2 py-0.5 text-xs ${agentColor(a.type)}`}>{a.type}</span>
                      <span className="font-medium">{a.name}</span>
                    </Link>
                  </TD>
                  <TD className="max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={a.dataDir}>
                    {a.dataDir || '—'}
                  </TD>
                  <TD className="text-right tabular-nums">{formatCompact(a.sessions)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(a.tokens)}</TD>
                  <TD className="text-right tabular-nums">{formatUSD(a.cost)}</TD>
                  <TD className="text-muted-foreground" title={formatDate(a.lastScannedAt ?? null)}>
                    {formatRelative(a.lastScannedAt ?? null)}
                  </TD>
                  <TD>
                    <Button variant={a.enabled ? 'outline' : 'default'} size="sm" onClick={() => toggle(a)}>
                      {a.enabled ? 'Disable' : 'Enable'}
                    </Button>
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