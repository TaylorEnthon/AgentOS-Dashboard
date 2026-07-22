import { buildCollector } from '@agentos/collectors';
import type { AgentType } from '@agentos/shared';
import { Db } from './db.js';
import type { SettingsStore } from './settings.js';

export interface ScanReport {
  agentId: string;
  agentType: AgentType;
  sessions: number;
  usage: number;
  events: number;
  projects: number;
  ms: number;
  error?: string;
}

/**
 * Polls every enabled collector on an interval and persists results.
 * Safe to call `scanAll()` concurrently with the interval — both calls
 * simply re-run the collectors; the DB layer upserts idempotently.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
  ) {}

  async start(): Promise<void> {
    // initial scan (await so API has data on first request)
    await this.scanAll();
    const intervalMs = this.computeInterval();
    this.timer = setInterval(() => {
      this.scanAll().catch((err) => {
        console.error('[scheduler] scan failed:', err);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  computeInterval(): number {
    // resolve current settings synchronously from DB
    const raw = this.db.getSetting('pollIntervalSec');
    const n = raw ? Number(JSON.parse(raw)) : 60;
    return Math.max(5, Math.min(3600, Number.isFinite(n) ? n : 60)) * 1000;
  }

  async scanAll(): Promise<ScanReport[]> {
    const settings = await this.settings.load();
    this.settings.setLivePricingOverrides(settings.pricingOverrides);
    const agents = this.db.listAgents();
    const reports: ScanReport[] = [];

    for (const row of agents) {
      if (!row.enabled) continue;
      const enabledOverride = settings.enabledAgents[row.type];
      if (enabledOverride === false) continue;

      const override = settings.dataDirOverrides[row.type];
      const collector = buildCollector(row.type);
      const dataDir = await collector.resolveDataDir(override ?? row.data_dir);
      if (!dataDir) {
        reports.push({ agentId: row.id, agentType: row.type, sessions: 0, usage: 0, events: 0, projects: 0, ms: 0, error: 'data dir not found' });
        continue;
      }
      const t0 = Date.now();
      try {
        const result = await collector.scan(
          { id: row.id, type: row.type, dataDir },
          { maxFiles: 1000, pricing: settings.pricingOverrides },
        );
        this.ingest(result);
        const now = new Date().toISOString();
        this.db.setAgentScanned(row.id, now);
        reports.push({
          agentId: row.id,
          agentType: row.type,
          sessions: result.sessions.length,
          usage: result.usage.length,
          events: result.events.length,
          projects: result.projects.length,
          ms: Date.now() - t0,
        });
      } catch (err) {
        reports.push({
          agentId: row.id,
          agentType: row.type,
          sessions: 0,
          usage: 0,
          events: 0,
          projects: 0,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return reports;
  }

  private ingest(result: { agentId: string; sessions: import('@agentos/shared').AgentSession[]; usage: import('@agentos/shared').UsageRecord[]; events: import('@agentos/shared').ActivityEvent[]; projects: Array<{ path: string; displayName: string; lastSeen: string }> }): void {
    const tx = this.db.raw.transaction(() => {
      for (const s of result.sessions) this.db.upsertSession(s);
      for (const u of result.usage) this.db.insertUsage(u);
      for (const e of result.events) this.db.insertEvent(e);
      for (const p of result.projects) this.db.upsertProject(p);
    });
    tx();
  }
}