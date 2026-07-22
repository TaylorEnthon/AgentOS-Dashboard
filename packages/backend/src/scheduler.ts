import { buildCollector } from '@agentos/collectors';
import type { ScanOptions } from '@agentos/collectors';
import type { AgentType } from '@agentos/shared';
import { Db } from './db.js';
import type { SettingsStore } from './settings.js';
import { eventBus, type RealtimeEvent } from './event-bus.js';

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

export type ScanReason = 'startup' | 'interval' | 'file-change' | 'manual' | 'watcher-error';

/**
 * Polls every enabled collector on an interval and persists results.
 * v0.2: incremental mode + ingestion_files fingerprint table + dedup counter.
 * v0.4: per-agent `scanAgent()` + EventBus broadcast + (optional) file
 *        watchers feeding `file-change` events.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private watcherClose: (() => Promise<void>) | null = null;
  private watcherHandleChange:
    | ((agent: AgentType, filePath: string) => void)
    | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
  ) {}

  async start(): Promise<void> {
    await this.scanAll('startup');
    const intervalMs = this.computeInterval();
    this.timer = setInterval(() => {
      this.scanAll('interval').catch((err) =>
        console.error('[scheduler] interval scan failed:', err),
      );
    }, intervalMs);
    // Best-effort: start chokidar watchers. If chokidar isn't installed
    // or data dirs are missing, fall back to polling alone.
    try {
      const { startWatchers } = await import('./watcher.js');
      const agents = this.db
        .listAgents()
        .filter((r) => r.enabled)
        .map((r) => ({ type: r.type, dataDir: r.data_dir }));
      const ctrl = startWatchers(agents, {
        log: (m) => console.log(m),
      });
      this.watcherClose = ctrl.close;
      this.watcherHandleChange = (agent, filePath) => {
        eventBus.emit({
          type: 'file_changed',
          ts: new Date().toISOString(),
          agent,
          filePath,
        });
        // Trigger a per-agent incremental rescan, debounced by watcher
        this.scanAgent(agent, 'file-change').catch((err) =>
          console.error(`[scheduler] watcher-triggered scan failed (${agent}):`, err),
        );
      };
      // wire chokidar events into our handler
      for (const aw of ctrl._watchers) {
        const original = aw.onChange;
        aw.onChange = (filePath) => {
          this.watcherHandleChange!(aw.agent, filePath);
          original(filePath);
        };
      }
    } catch (err) {
      console.error('[scheduler] watcher init failed (will rely on polling):', err);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watcherClose) {
      this.watcherClose().catch(() => {});
      this.watcherClose = null;
    }
  }

  computeInterval(): number {
    const raw = this.db.getSetting('pollIntervalSec');
    const n = raw ? Number(JSON.parse(raw)) : 60;
    return Math.max(5, Math.min(3600, Number.isFinite(n) ? n : 60)) * 1000;
  }

  /** Scan every enabled agent. Used at startup, by setInterval, and on manual refresh. */
  async scanAll(reason: ScanReason = 'interval'): Promise<ScanReport[]> {
    const reports: ScanReport[] = [];
    const agents = this.db.listAgents();
    const firstRun = reason === 'startup' && !this.hasPriorState();
    for (const row of agents) {
      reports.push(await this.scanRow(row, reason, { forceFull: firstRun }));
    }
    return reports;
  }

  /**
   * Scan ONE agent. Triggered by file-watcher events or by the next
   * interval; cheap (incremental by default).
   */
  async scanAgent(agentType: AgentType, reason: ScanReason = 'file-change'): Promise<ScanReport | null> {
    const row = this.db.listAgents().find((r) => r.type === agentType);
    if (!row) return null;
    const report = await this.scanRow(row, reason);
    // After every agent scan, push a refreshed status event so any
    // subscriber that only listens to status updates sees activity.
    this.emitStatus(report.agentType);
    return report;
  }

  private hasPriorState(): boolean {
    return (this.db.raw.prepare(`SELECT COUNT(*) AS c FROM ingestion_files`).get() as { c: number }).c > 0;
  }

  private async scanRow(
    row: { id: string; type: AgentType; data_dir: string; enabled: number },
    reason: ScanReason,
    overrides: { forceFull?: boolean } = {},
  ): Promise<ScanReport> {
    if (!row.enabled) {
      return this.idleReport(row);
    }
    const settings = await this.settings.load();
    if (settings.enabledAgents[row.type] === false) {
      return this.idleReport(row);
    }

    const override = settings.dataDirOverrides[row.type];
    const collector = buildCollector(row.type);
    const dataDir = await collector.resolveDataDir(override ?? row.data_dir);
    if (!dataDir) {
      const r = this.idleReport(row, 'data dir not found');
      this.emitComplete(r, reason);
      return r;
    }

    const priorFiles = this.db.priorFileMap(row.type);
    const anyPrior = this.hasPriorState();
    const mode: 'full' | 'incremental' = overrides.forceFull === true
      ? 'full'
      : anyPrior
        ? 'incremental'
        : 'full';
    const scanOpts: ScanOptions = {
      mode,
      priorFiles,
      maxFiles: 1000,
      pricing: settings.pricingOverrides,
    };

    this.emit({
      type: 'scan_started',
      ts: new Date().toISOString(),
      agent: row.type,
      reason,
    });

    const t0 = Date.now();
    try {
      const result = await collector.scan(
        { id: row.id, type: row.type, dataDir },
        scanOpts,
      );

      const txStats = this.db.raw.transaction(() => {
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
      })();

      const now = new Date().toISOString();
      this.db.setAgentScanned(row.id, now);

      const report: ScanReport = {
        agentId: row.id,
        agentType: row.type,
        sessions: result.sessions.length,
        usage: txStats.insertedUsage,
        events: txStats.insertedEvents,
        filesScanned: result.files.length,
        filesSkipped: 0,
        duplicatesPrevented: txStats.dupUsage + txStats.dupEvents,
        ms: Date.now() - t0,
      };
      this.emitComplete(report, reason);
      return report;
    } catch (err) {
      const report: ScanReport = {
        agentId: row.id,
        agentType: row.type,
        sessions: 0,
        usage: 0,
        events: 0,
        filesScanned: 0,
        filesSkipped: 0,
        duplicatesPrevented: 0,
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
      this.emitComplete(report, reason);
      return report;
    }
  }

  private idleReport(row: { id: string; type: AgentType }, error?: string): ScanReport {
    return {
      agentId: row.id,
      agentType: row.type,
      sessions: 0,
      usage: 0,
      events: 0,
      filesScanned: 0,
      filesSkipped: 0,
      duplicatesPrevented: 0,
      ms: 0,
      error,
    };
  }

  // ---------------- event emission ----------------

  private emit(ev: RealtimeEvent): void {
    eventBus.emit(ev);
  }

  private emitComplete(r: ScanReport, _reason: ScanReason): void {
    this.emit({
      type: 'scan_completed',
      ts: new Date().toISOString(),
      agent: r.agentType,
      ms: r.ms,
      sessions: r.sessions,
      usage: r.usage,
      events: r.events,
      duplicatesPrevented: r.duplicatesPrevented,
      error: r.error,
    });
  }

  /** Compute current status for one agent and broadcast it. */
  private emitStatus(agent: AgentType): void {
    // Dynamic import keeps the dependency lazy and avoids a hard cycle
    // between scheduler.ts ↔ agent-status.ts ↔ db.ts.
    import('./agent-status.js').then(({ deriveAgentStatus }) => {
      const all = deriveAgentStatus(this.db.raw);
      const row = all.find((r) => r.agent === agent);
      if (!row) return;
      this.emit({
        type: 'agent_status',
        ts: new Date().toISOString(),
        agent,
        status: row.status,
        lastActivity: row.lastActivity,
        lastProject: row.lastProject,
        lastAction: row.lastAction,
      });
    });
  }
}