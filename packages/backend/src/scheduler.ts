import { buildCollector } from '@agentos/collectors';
import type { ScanOptions } from '@agentos/collectors';
import type { AgentType } from '@agentos/shared';
import { Db } from './db.js';
import type { SettingsStore } from './settings.js';

export interface ScanReport {
  agentId: string;
  agentType: AgentType;
  sessions: number;
  usage: number;
  events: number;
  filesScanned: number;
  filesSkipped: number;
  duplicatesPrevented: number;
  ms: number;
  error?: string;
}

/**
 * Polls every enabled collector on an interval and persists results.
 * v0.2: incremental mode, ingestion_files fingerprint table, dedup counter.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
  ) {}

  async start(): Promise<void> {
    await this.scanAll();
    const intervalMs = this.computeInterval();
    this.timer = setInterval(() => {
      this.scanAll().catch((err) => console.error('[scheduler] scan failed:', err));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  computeInterval(): number {
    const raw = this.db.getSetting('pollIntervalSec');
    const n = raw ? Number(JSON.parse(raw)) : 60;
    return Math.max(5, Math.min(3600, Number.isFinite(n) ? n : 60)) * 1000;
  }

  /**
   * v0.2: default scan mode is `incremental` once any prior file state exists.
   * First run against a brand-new DB still has to do a `full` scan.
   */
  async scanAll(opts: { forceFull?: boolean } = {}): Promise<ScanReport[]> {
    const settings = await this.settings.load();
    this.settings.setLivePricingOverrides(settings.pricingOverrides);
    const agents = this.db.listAgents();
    const reports: ScanReport[] = [];

    const anyPrior = (this.db.raw.prepare(`SELECT COUNT(*) AS c FROM ingestion_files`).get() as { c: number }).c > 0;
    const defaultMode: 'full' | 'incremental' = opts.forceFull || !anyPrior ? 'full' : 'incremental';

    for (const row of agents) {
      if (!row.enabled) continue;
      if (settings.enabledAgents[row.type] === false) continue;

      const override = settings.dataDirOverrides[row.type];
      const collector = buildCollector(row.type);
      const dataDir = await collector.resolveDataDir(override ?? row.data_dir);
      if (!dataDir) {
        reports.push({ agentId: row.id, agentType: row.type, sessions: 0, usage: 0, events: 0, filesScanned: 0, filesSkipped: 0, duplicatesPrevented: 0, ms: 0, error: 'data dir not found' });
        continue;
      }

      const priorFiles = this.db.priorFileMap(row.type);
      const mode: 'full' | 'incremental' = opts.forceFull ? 'full' : defaultMode;
      const scanOpts: ScanOptions = {
        mode,
        priorFiles,
        maxFiles: 1000,
        pricing: settings.pricingOverrides,
      };

      const t0 = Date.now();
      try {
        const result = await collector.scan(
          { id: row.id, type: row.type, dataDir },
          scanOpts,
        );

        const tx = this.db.raw.transaction(() => {
          let insertedUsage = 0, insertedEvents = 0, dupUsage = 0, dupEvents = 0;
          for (const s of result.sessions) this.db.upsertSession(s);
          for (const u of result.usage) {
            if (this.db.insertUsage(u)) insertedUsage++;
            else dupUsage++;
          }
          for (const e of result.events) {
            if (this.db.insertEvent(e)) insertedEvents++;
            else dupEvents++;
          }
          for (const p of result.projects) this.db.upsertProject(p);
          for (const f of result.files) {
            // Per-file dedup is approximated as 0 (we don't know which
            // batch rows came from which file without attribution). The
            // cumulative total comes from bumpTotalDuplicates() below.
            this.db.recordIngestionFile({
              provider: row.type,
              filePath: f.sourceFile,
              size: f.size,
              mtimeMs: f.mtimeMs,
              contentHash: f.contentHash,
              sessions: f.sessions,
              usageRecords: f.usageRecords,
              events: f.events,
              inserted: f.usageRecords,
              duplicatesPrevented: 0,
            });
          }
          if (dupUsage + dupEvents > 0) this.db.bumpTotalDuplicates(dupUsage + dupEvents);
          return { insertedUsage, dupUsage, insertedEvents, dupEvents };
        });

        const { insertedUsage, dupUsage, insertedEvents, dupEvents } = tx();

        const now = new Date().toISOString();
        this.db.setAgentScanned(row.id, now);
        reports.push({
          agentId: row.id,
          agentType: row.type,
          sessions: result.sessions.length,
          usage: insertedUsage,
          events: insertedEvents,
          filesScanned: result.files.length,
          filesSkipped: 0,
          duplicatesPrevented: dupUsage + dupEvents,
          ms: Date.now() - t0,
        });
      } catch (err) {
        reports.push({
          agentId: row.id, agentType: row.type,
          sessions: 0, usage: 0, events: 0,
          filesScanned: 0, filesSkipped: 0, duplicatesPrevented: 0,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return reports;
  }
}