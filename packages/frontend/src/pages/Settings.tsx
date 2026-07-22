import { useEffect, useState } from 'react';
import { api, type SettingsDto } from '../lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [poll, setPoll] = useState(60);
  const [overrides, setOverrides] = useState<Record<string, { inputPerMTok: number; outputPerMTok: number }>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      setPoll(s.pollIntervalSec);
      setOverrides(s.pricingOverrides);
    }).catch((e) => setErr(String(e)));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.saveSettings({
        pollIntervalSec: poll,
        pricingOverrides: overrides,
      });
      setSettings(next);
    } finally { setSaving(false); }
  };

  if (err) return <div className="p-6 text-rose-600">Failed to load: {err}</div>;
  if (!settings) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const defaults = settings.defaultPricing;
  const overrideKeys = Object.keys(overrides);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Tune polling interval and per-model cost overrides.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Polling</CardTitle>
          <CardDescription>How often the backend re-scans each agent's data directory.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Interval (seconds)</span>
            <input
              type="number" min={5} max={3600}
              value={poll}
              onChange={(e) => setPoll(Number(e.target.value))}
              className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Built-in pricing ({Object.keys(defaults).length} models)</CardTitle>
          <CardDescription>USD per 1M tokens. Used to estimate session cost.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH className="text-right">Input</TH>
                <TH className="text-right">Output</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {Object.entries(defaults).map(([model, p]) => {
                const ov = overrides[model];
                return (
                  <TR key={model}>
                    <TD className="font-mono text-xs">{model}</TD>
                    <TD className="text-right tabular-nums">
                      {ov ? (
                        <input
                          type="number" step="0.01" value={ov.inputPerMTok}
                          onChange={(e) => setOverrides((o) => ({ ...o, [model]: { ...(o[model] ?? p), inputPerMTok: Number(e.target.value) } }))}
                          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      ) : <span className="text-muted-foreground">${p.inputPerMTok}</span>}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {ov ? (
                        <input
                          type="number" step="0.01" value={ov.outputPerMTok}
                          onChange={(e) => setOverrides((o) => ({ ...o, [model]: { ...(o[model] ?? p), outputPerMTok: Number(e.target.value) } }))}
                          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      ) : <span className="text-muted-foreground">${p.outputPerMTok}</span>}
                    </TD>
                    <TD>
                      {ov ? (
                        <Button size="sm" variant="ghost" onClick={() => setOverrides((o) => { const c = { ...o }; delete c[model]; return c; })}>
                          Reset
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setOverrides((o) => ({ ...o, [model]: { ...p } }))}>
                          Override
                        </Button>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {overrideKeys.length > 0 && <Badge tone="info">{overrideKeys.length} override{overrideKeys.length === 1 ? '' : 's'}</Badge>}
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  );
}