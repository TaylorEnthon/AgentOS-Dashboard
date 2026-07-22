import { promises as fs } from 'node:fs';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import { Db } from './db.js';
import { DEFAULT_PRICING, type ModelPricing } from '@agentos/shared';

export interface AppSettings {
  dataDirOverrides: Record<string, string>;        // agentType -> path
  enabledAgents: Record<string, boolean>;
  pollIntervalSec: number;
  pricingOverrides: Record<string, ModelPricing>;
}

const DEFAULT_SETTINGS: AppSettings = {
  dataDirOverrides: {},
  enabledAgents: {},
  pollIntervalSec: 60,
  pricingOverrides: {},
};

export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly configPath: string,
  ) {}

  /** Load settings: prefer DB settings, fall back to JSON file, then defaults. */
  async load(): Promise<AppSettings> {
    let fileSettings: Partial<AppSettings> = {};
    try {
      const text = await fs.readFile(this.configPath, 'utf8');
      fileSettings = JSON.parse(text);
    } catch {
      /* no file yet */
    }

    const dbRaw = this.db.getAllSettings();
    const dbSettings: Partial<AppSettings> = {};
    for (const [k, v] of Object.entries(dbRaw)) {
      try {
        (dbSettings as Record<string, unknown>)[k] = JSON.parse(v);
      } catch {
        /* skip malformed */
      }
    }

    return {
      ...DEFAULT_SETTINGS,
      ...fileSettings,
      ...dbSettings,
      dataDirOverrides: { ...DEFAULT_SETTINGS.dataDirOverrides, ...fileSettings.dataDirOverrides, ...dbSettings.dataDirOverrides },
      enabledAgents: { ...DEFAULT_SETTINGS.enabledAgents, ...fileSettings.enabledAgents, ...dbSettings.enabledAgents },
      pricingOverrides: { ...DEFAULT_SETTINGS.pricingOverrides, ...fileSettings.pricingOverrides, ...dbSettings.pricingOverrides },
      pollIntervalSec: dbSettings.pollIntervalSec ?? fileSettings.pollIntervalSec ?? DEFAULT_SETTINGS.pollIntervalSec,
    };
  }

  async save(s: AppSettings): Promise<void> {
    fssync.mkdirSync(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(s, null, 2), 'utf8');
  }

  async update(partial: Partial<AppSettings>): Promise<AppSettings> {
    const cur = await this.load();
    const next: AppSettings = { ...cur, ...partial };
    await this.save(next);
    return next;
  }

  /** Effective pricing = defaults + user overrides (override beats default). */
  effectivePricing(): Record<string, ModelPricing> {
    return { ...DEFAULT_PRICING, ...this.lastPricingOverrides };
  }

  // ----- internal accessors used by scheduler -----
  private lastPricingOverrides: Record<string, ModelPricing> = {};

  setLivePricingOverrides(p: Record<string, ModelPricing>): void {
    this.lastPricingOverrides = p;
  }
}