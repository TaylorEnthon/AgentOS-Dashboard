/**
 * SessionDetail page (v0.7) — full drill-down view for a single session.
 *
 * Aggregates in one round-trip (via /api/sessions-v2/:id):
 *  - basic info + agent metadata
 *  - session metadata: displayName, note, tags, pinned (editable inline)
 *  - git projection: commits made during the session's time window
 *  - usage / events / cost totals
 *
 * The Resume command comes from a separate endpoint
 * (/api/sessions-v2/:id/resume). It is generated only — never executed —
 * and exposed as copy-to-clipboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type SessionMetadataPatch, type SessionResumeDto, type SessionV2DetailDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { agentColor, cn, formatCompact, formatDate, formatRelative, formatUSD } from '../lib/format';

export function SessionDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<SessionV2DetailDto | null>(null);
  const [resume, setResume] = useState<SessionResumeDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    Promise.all([api.sessionV2(id), api.sessionResume(id).catch(() => null)])
      .then(([d, r]) => { setData(d); setResume(r); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  const copy = async () => {
    if (!resume) return;
    try {
      await navigator.clipboard.writeText(resume.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select the text so the user can Ctrl-C
      const ta = document.getElementById('resume-cmd') as HTMLTextAreaElement | null;
      ta?.select();
    }
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const display = data.displayName || data.title || data.externalId.slice(0, 16);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/sessions" className="text-xs text-muted-foreground hover:underline">← all sessions</Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {data.pinned && <span title="pinned" className="text-amber-500 text-xl">★</span>}
            <h1 className="truncate text-2xl font-semibold" title={display}>{display}</h1>
            <Badge className={agentColor(data.agentType)}>{data.agentType}</Badge>
            <Badge tone={
              data.status === 'completed' ? 'success' :
              data.status === 'running' ? 'info' :
              data.status === 'failed' ? 'danger' : 'muted'
            }>
              {data.status}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground" title={data.project}>{data.projectDisplay || data.project}</p>
          <p className="text-xs text-muted-foreground">
            external id <code className="font-mono">{data.externalId}</code> · started {formatDate(data.startTime)}{data.endTime ? ` · ended ${formatDate(data.endTime)}` : ' · still running'}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Stat label="Tokens" value={formatCompact(data.usageTokens)} />
        <Stat label="Est. cost" value={formatUSD(data.usageCost)} />
        <Stat label="Events" value={formatCompact(data.eventCount)} />
        <Stat label="Duration" value={formatDuration(data.durationMs)} />
      </div>

      {/* Metadata editor — v0.7 user customizations */}
      <MetadataEditor
        sessionId={data.id}
        initial={{
          displayName: data.displayName ?? null,
          note: data.note ?? null,
          tags: data.tags ?? [],
          pinned: data.pinned ?? false,
        }}
        disabled={saving}
        onSaving={setSaving}
        onSaved={(updated) => {
          setData((prev) => prev ? {
            ...prev,
            displayName: updated.displayName ?? null,
            note: updated.note ?? null,
            tags: updated.tags,
            pinned: updated.pinned,
            metadata: updated,
          } : prev);
        }}
      />

      {/* Resume command */}
      <Card>
        <CardHeader>
          <CardTitle>Resume command</CardTitle>
          <CardDescription>
            Generated for <code className="font-mono">{resume?.agent ?? data.agentType}</code>.
            We never execute it — paste into your shell after verifying the session id.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resume ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <textarea
                  id="resume-cmd"
                  readOnly
                  value={resume.command}
                  className="h-12 flex-1 resize-none rounded-md border border-input bg-muted/30 px-3 py-2 font-mono text-sm"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" size="sm" onClick={copy}>
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
              </div>
              {resume.notes && (
                <p className="text-xs text-muted-foreground">{resume.notes}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No resume command available.</p>
          )}
        </CardContent>
      </Card>

      {/* Git projection */}
      {data.git && data.git.repo && (
        <Card>
          <CardHeader>
            <CardTitle>Git activity</CardTitle>
            <CardDescription>
              Commits in this session's time window
              {data.git.repo.branch && <> on branch <code className="font-mono">{data.git.repo.branch}</code></>}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.git.commits.length === 0 ? (
              <p className="text-sm text-muted-foreground">No commits in window.</p>
            ) : (
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
                  {data.git.commits.map((c) => (
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
      )}

      {/* Usage summary */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>{data.usage.length} record{data.usage.length === 1 ? '' : 's'} for this session.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.usage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage records.</p>
          ) : (
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

      {/* Executions (v0.8 derived view) */}
      <ExecutionsSection sessionId={data.id} />

      {/* Recent events */}
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Last {Math.min(data.events.length, 30)} of {data.events.length} event{data.events.length === 1 ? '' : 's'}.
            {' '}
            <Link to={`/timeline?session=${encodeURIComponent(data.id)}`} className="text-primary hover:underline">
              open full timeline →
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity events.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.events.slice(0, 30).map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground tabular-nums">{formatRelative(e.timestamp)}</span>
                  <Badge tone="muted" className="shrink-0 text-[10px]">{e.type}</Badge>
                  <span className="min-w-0 flex-1 truncate text-foreground">{e.detail ?? ''}</span>
                </li>
              ))}
            </ul>
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

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* ---------------- v0.8 Executions section ---------------- */

function ExecutionsSection({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<import('../lib/api').AgentExecutionDto[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.sessionExecutions(sessionId)
      .then(setItems)
      .catch((e) => setErr(String(e)));
  }, [sessionId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Executions</CardTitle>
        <CardDescription>
          Derived from this session's activity using a 30-minute gap rule.
          Each execution groups the work for one logical task.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!err && items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No executions yet — once activity events arrive, they'll be grouped here.
          </p>
        )}
        {items.length > 0 && (
          <ul className="space-y-1.5">
            {items.map((exec) => (
              <li key={exec.id}>
                <Link
                  to={`/executions/${encodeURIComponent(exec.id)}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:border-foreground/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium" title={exec.title ?? exec.id}>
                        {exec.title ?? `Execution #${exec.id.split(':exec-')[1]}`}
                      </span>
                      <StatusBadge status={exec.status} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {formatRelative(exec.startTime)}{exec.endTime ? ` → ${formatRelative(exec.endTime)}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
                    <span>{exec.eventCount} events</span>
                    <span>{formatCompact(exec.tokenUsage)} tokens</span>
                    {exec.commits.length > 0 && <span>{exec.commits.length} commits</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: 'running' | 'completed' | 'unknown' }) {
  switch (status) {
    case 'running':   return <Badge tone="info" className="text-[10px]">● running</Badge>;
    case 'completed': return <Badge tone="success" className="text-[10px]">✓ completed</Badge>;
    case 'unknown':   return <Badge tone="muted" className="text-[10px]">? unknown</Badge>;
  }
}

/* ---------------- Metadata editor ---------------- */

interface MetaFormState {
  displayName: string;
  note: string;
  tagsRaw: string;          // comma-separated for editing convenience
  pinned: boolean;
}

function MetadataEditor({
  sessionId,
  initial,
  disabled,
  onSaving,
  onSaved,
}: {
  sessionId: string;
  initial: { displayName: string | null; note: string | null; tags: string[]; pinned: boolean };
  disabled: boolean;
  onSaving: (saving: boolean) => void;
  onSaved: (updated: NonNullable<SessionV2DetailDto['metadata']>) => void;
}) {
  const [form, setForm] = useState<MetaFormState>({
    displayName: initial.displayName ?? '',
    note: initial.note ?? '',
    tagsRaw: initial.tags.join(', '),
    pinned: initial.pinned,
  });
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Re-seed when initial changes (e.g. after reload).
  useEffect(() => {
    setForm({
      displayName: initial.displayName ?? '',
      note: initial.note ?? '',
      tagsRaw: initial.tags.join(', '),
      pinned: initial.pinned,
    });
  }, [initial.displayName, initial.note, initial.tags.join(','), initial.pinned]);

  const dirty = useMemo(() => {
    return (
      form.displayName !== (initial.displayName ?? '') ||
      form.note !== (initial.note ?? '') ||
      form.tagsRaw !== initial.tags.join(', ') ||
      form.pinned !== initial.pinned
    );
  }, [form, initial]);

  const save = async () => {
    setError(null);
    onSaving(true);
    try {
      const patch: SessionMetadataPatch = {
        displayName: form.displayName.trim() ? form.displayName.trim() : null,
        note: form.note.trim() ? form.note.trim() : null,
        tags: form.tagsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        pinned: form.pinned,
      };
      const updated = await api.patchSessionMetadata(sessionId, patch);
      onSaved(updated);
      setSavedAt(new Date().toISOString());
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      onSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session metadata</CardTitle>
        <CardDescription>
          Customizations live in a separate <code className="font-mono">session_metadata</code> table.
          We never modify the raw session JSONL.
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
              placeholder="e.g. v0.7 session management dev"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tags <span className="text-muted-foreground/70">(comma-separated, max 32)</span></label>
            <input
              type="text"
              value={form.tagsRaw}
              onChange={(e) => setForm((f) => ({ ...f, tagsRaw: e.target.value }))}
              placeholder="agentos, frontend, v0.7"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Note</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="free-form notes (what was this session for?)"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="pinned"
              type="checkbox"
              checked={form.pinned}
              onChange={(e) => setForm((f) => ({ ...f, pinned: e.target.checked }))}
              className="h-4 w-4 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            <label htmlFor="pinned" className="text-sm">
              Pin this session <span className="text-xs text-muted-foreground">(pinned sessions sort first)</span>
            </label>
          </div>
        </div>

        {error && (
          <p className="text-xs text-rose-600">{error}</p>
        )}

        <div className="flex items-center justify-between">
          <span className={cn('text-xs text-muted-foreground', savedAt && 'text-emerald-600')}>
            {savedAt ? 'Saved' : dirty ? 'Unsaved changes' : 'No changes'}
          </span>
          <Button size="sm" onClick={save} disabled={disabled || !dirty}>
            {disabled ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}