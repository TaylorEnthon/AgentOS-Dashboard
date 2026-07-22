import { useEffect, useState } from 'react';
import { api, type DataHealthDto, type IngestionFileDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';
import { formatCompact, formatRelative, formatUSD } from '../lib/format';

export function DataHealthPage() {
  const [health, setHealth] = useState<DataHealthDto | null>(null);
  const [files, setFiles] = useState<IngestionFileDto[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    Promise.all([api.dataHealth(), api.ingestionFiles()])
      .then(([h, f]) => { setHealth(h); setFiles(f); })
      .catch((e) => setErr(String(e)));
  };
  useEffect(() => { load(); }, []);

  const refresh = async (forceFull: boolean) => {
    setRefreshing(true);
    try {
      await api.refresh(forceFull);
      load();
    } finally { setRefreshing(false); }
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;
  if (!health) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const totalU = health.usage.exact + health.usage.estimated + health.usage.unknown;
  const totalC = health.cost.exact + health.cost.estimated + health.cost.unknown;
  const pct = (n: number, d: number) => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Data Health</h1>
          <p className="text-sm text-muted-foreground">
            Where every number comes from, how confident we are in it, and what we deduplicated.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => refresh(true)}>
            {refreshing ? 'Refreshing…' : 'Full rescan'}
          </Button>
          <Button variant="default" size="sm" disabled={refreshing} onClick={() => refresh(false)}>
            {refreshing ? 'Refreshing…' : 'Incremental scan'}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions" value={formatCompact(health.totalSessions)} />
        <Stat label="Usage rows" value={formatCompact(health.totalUsageRecords)} />
        <Stat label="Activity events" value={formatCompact(health.totalEvents)} />
        <Stat label="Files tracked" value={formatCompact(health.ingestionFiles)} sub={formatBytes(health.ingestionFileSize)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Usage confidence</CardTitle>
            <CardDescription>Where the token numbers came from.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <BucketBar label="Exact" tone="success" value={health.usage.exact} total={totalU} hint="Read directly from a structured usage field." />
            <BucketBar label="Estimated" tone="warning" value={health.usage.estimated} total={totalU} hint="Derived from partial data; treat as approximate." />
            <BucketBar label="Unknown" tone="danger" value={health.usage.unknown} total={totalU} hint="No reliable token source; do not use for billing." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cost confidence</CardTitle>
            <CardDescription>Whether the dollar figure is real or a fallback.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <BucketBar label="Exact" tone="success" value={health.cost.exact} total={totalC} hint="Model resolved via override or default exact match." />
            <BucketBar label="Estimated" tone="warning" value={health.cost.estimated} total={totalC} hint="Resolved via prefix-match — close but not exact." />
            <BucketBar label="Unknown" tone="danger" value={health.cost.unknown} total={totalC} hint="Model unrecognized → $1/$1 per MTok fallback. NOT billable." />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deduplication</CardTitle>
          <CardDescription>Usage + event rows skipped on recent scans because the id already existed.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-3">
            <div className="text-3xl font-semibold tabular-nums">{formatCompact(health.duplicatesPrevented)}</div>
            <div className="text-sm text-muted-foreground">duplicates prevented across all scans</div>
          </div>
          <div className="mt-3 text-sm text-muted-foreground">
            Last scan: {health.lastScanAt ? formatRelative(health.lastScanAt) : '—'}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per agent</CardTitle>
          <CardDescription>File-level ingest state, joined with agents.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH className="text-right">Files</TH>
                <TH className="text-right">Sessions</TH>
                <TH className="text-right">Usage</TH>
                <TH className="text-right">Dedup</TH>
                <TH>Last scan</TH>
              </TR>
            </THead>
            <TBody>
              {health.perAgent.length === 0 && (
                <TR><TD colSpan={6} className="py-6 text-center text-sm text-muted-foreground">No scans yet.</TD></TR>
              )}
              {health.perAgent.map((a) => (
                <TR key={a.agentId}>
                  <TD className="font-medium">{a.agentId}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(a.files)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(a.sessions)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(a.usage)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(a.duplicates)}</TD>
                  <TD className="text-muted-foreground">{formatRelative(a.lastScanAt ?? null)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tracked files ({files.length})</CardTitle>
          <CardDescription>Every source file the collector has touched. SHA-256 fingerprint + last seen.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Provider</TH>
                <TH>File</TH>
                <TH className="text-right">Size</TH>
                <TH className="text-right">Sessions</TH>
                <TH className="text-right">Usage</TH>
                <TH className="text-right">Dedup</TH>
                <TH>Last scan</TH>
              </TR>
            </THead>
            <TBody>
              {files.length === 0 && (
                <TR><TD colSpan={7} className="py-6 text-center text-sm text-muted-foreground">No files tracked yet — run a scan.</TD></TR>
              )}
              {files.map((f) => (
                <TR key={f.id}>
                  <TD><Badge tone="muted">{f.provider}</Badge></TD>
                  <TD className="max-w-[420px] truncate font-mono text-xs" title={f.file_path}>{f.file_path}</TD>
                  <TD className="text-right tabular-nums">{formatBytes(f.size)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(f.sessions)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(f.usage_records)}</TD>
                  <TD className="text-right tabular-nums">{formatCompact(f.duplicates_prevented)}</TD>
                  <TD className="text-muted-foreground">{formatRelative(f.last_scanned_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle>{label}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function BucketBar({ label, tone, value, total, hint }: {
  label: string; tone: 'success' | 'warning' | 'danger'; value: number; total: number; hint: string;
}) {
  const pctNum = total === 0 ? 0 : (value / total) * 100;
  const barColor = tone === 'success' ? 'bg-emerald-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-rose-500';
  const textColor = tone === 'success' ? 'text-emerald-700' : tone === 'warning' ? 'text-amber-700' : 'text-rose-700';
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${barColor}`} />
          <span className={`font-medium ${textColor}`}>{label}</span>
        </div>
        <div className="tabular-nums">
          <span className="font-medium">{formatCompact(value)}</span>
          <span className="ml-2 text-muted-foreground">({total === 0 ? '0%' : `${pctNum.toFixed(1)}%`})</span>
        </div>
      </div>
      <div className="mt-1 h-1.5 w-full rounded bg-muted">
        <div className={`h-1.5 rounded ${barColor}`} style={{ width: `${pctNum}%` }} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// formatUSD is re-exported via format.ts already; explicit import silences unused.
void formatUSD;