import * as path from 'node:path';
import { BaseCollector, homeDir, type ScanOptions } from './base.js';
import type { AgentType, RawScanResult } from '@agentos/shared';

/**
 * Generic stub collector for agents we don't yet parse deeply.
 * Detects the data directory if it exists, otherwise returns null.
 */
export abstract class StubCollector extends BaseCollector {
  abstract readonly homeSubdir: string;
  abstract readonly homeEnvVar: string | undefined;

  /** Override the home directory used for auto-detection (mainly for tests). */
  constructor(protected readonly home: string = homeDir()) {
    super();
  }

  async resolveDataDir(userOverride?: string): Promise<string | null> {
    const candidates = [
      userOverride,
      this.homeEnvVar ? process.env[this.homeEnvVar] : undefined,
      path.join(this.home, this.homeSubdir),
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      try {
        const s = await import('node:fs').then((m) => m.promises.stat(c));
        if (s.isDirectory()) return c;
      } catch {
        /* continue */
      }
    }
    return null;
  }

  async scan(): Promise<RawScanResult> {
    // v0.1: stub collectors emit no data; they only expose their existence
    // so the UI can show "installed but not yet parsed".
    return {
      agentId: this.type,
      collectedAt: new Date().toISOString(),
      sessions: [],
      usage: [],
      events: [],
      projects: [],
      files: [],
    };
  }
}

export class GeminiCollector extends StubCollector {
  readonly type: AgentType = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly defaultCapabilities = ['chat', 'tools'];
  readonly homeSubdir = '.gemini';
  readonly homeEnvVar = 'GEMINI_HOME';
}

export class HermesCollector extends StubCollector {
  readonly type: AgentType = 'hermes';
  readonly displayName = 'Hermes';
  readonly defaultCapabilities = ['chat'];
  readonly homeSubdir = '.hermes';
  readonly homeEnvVar = 'HERMES_HOME';
}