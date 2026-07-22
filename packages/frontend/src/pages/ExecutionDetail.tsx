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
  type ManualExecutionStatus,
} from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { agentColor, cn, formatCompact, formatDate, formatRelative, formatUSD } from '../lib/format';

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

/* ---------------- v0.9: Workspace editor ---------------- */

interface WorkspaceFormState {
  displayName: string;
  note: string;
  tagsRaw: string;
  manualStatus: '' | ManualExecutionStatus;
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