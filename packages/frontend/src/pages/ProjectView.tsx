import { useEffect, useMemo, useState } from 'react';
import { api, type ProjectDto, type SessionDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { formatCompact, formatRelative, formatUSD, statusColor } from '../lib/format';

export function ProjectViewPage() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [filter, setFilter] = useState('');
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, SessionDto[]>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setProjects).catch((e) => setErr(String(e)));
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.displayName.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [projects, filter]);

  const loadSessions = async (projectPath: string) => {
    if (sessionsByProject[projectPath]) return;
    const ss = await api.sessions({ project: projectPath, limit: 30 });
    setSessionsByProject((m) => ({ ...m, [projectPath]: ss }));
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">Sessions aggregated by project directory.</p>
        </div>
        <input
          type="search"
          placeholder="Filter projects…"
          className="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All projects ({filtered.length})</CardTitle>
          <CardDescription>Click a row to expand the recent sessions.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Project</TH>
                <TH>Agents</TH>
                <TH className="text-right">Sessions</TH>
                <TH className="text-right">Tokens</TH>
                <TH className="text-right">Est. cost</TH>
                <TH>Last activity</TH>
              </TR>
            </THead>
            <TBody>
              {filtered.map((p) => (
                <ExpandableRow key={p.path} project={p} onExpand={loadSessions} sessions={sessionsByProject[p.path]} />
              ))}
              {filtered.length === 0 && (
                <TR><TD colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No projects match.</TD></TR>
              )}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ExpandableRow({
  project,
  onExpand,
  sessions,
}: {
  project: ProjectDto;
  onExpand: (p: string) => void;
  sessions: SessionDto[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next) onExpand(project.path);
      return next;
    });
  };
  return (
    <>
      <TR className="cursor-pointer" onClick={toggle}>
        <TD>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
            <span className="font-medium" title={project.path}>{project.displayName}</span>
          </div>
        </TD>
        <TD>
          <div className="flex gap-1">
            {project.agents.map((a) => <Badge key={a} tone="muted">{a}</Badge>)}
          </div>
        </TD>
        <TD className="text-right tabular-nums">{formatCompact(project.sessionCount)}</TD>
        <TD className="text-right tabular-nums">{formatCompact(project.totalTokens)}</TD>
        <TD className="text-right tabular-nums">{formatUSD(project.totalCost)}</TD>
        <TD className="text-muted-foreground">{formatRelative(project.lastActivity ?? null)}</TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={6} className="bg-muted/30 p-0">
            <div className="p-4">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">Recent sessions</h4>
              {!sessions && <div className="text-sm text-muted-foreground">Loading…</div>}
              {sessions && sessions.length === 0 && <div className="text-sm text-muted-foreground">No sessions in this project.</div>}
              {sessions && sessions.length > 0 && (
                <Table>
                  <THead>
                    <TR>
                      <TH>When</TH>
                      <TH>Agent</TH>
                      <TH>Model</TH>
                      <TH className="text-right">Tokens</TH>
                      <TH className="text-right">Cost</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {sessions.map((s) => (
                      <TR key={s.id}>
                        <TD className="text-muted-foreground">{formatRelative(s.startTime)}</TD>
                        <TD><Badge tone="muted">{s.agentType}</Badge></TD>
                        <TD className="text-muted-foreground">{s.model ?? '—'}</TD>
                        <TD className="text-right tabular-nums">{formatCompact(s.totalTokens)}</TD>
                        <TD className="text-right tabular-nums">{formatUSD(s.estimatedCost)}</TD>
                        <TD><span className={`rounded-full px-2 py-0.5 text-xs ${statusColor(s.status)}`}>{s.status}</span></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}