import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  Agent,
  AgentType,
  RawScanResult,
} from '@agentos/shared';

/**
 * Abstract base for every collector.
 *
 * Subclasses are responsible for:
 *  - detecting the agent's data dir
 *  - scanning it into a {@link RawScanResult}
 *
 * Cross-cutting concerns (DB upsert, retries, scheduling) live in the backend.
 */
export abstract class BaseCollector {
  abstract readonly type: AgentType;
  abstract readonly displayName: string;
  abstract readonly defaultCapabilities: string[];

  /**
   * Resolve the absolute path to the agent's data directory.
   * Implementations should check `userOverrides[this.type]` first,
   * then fall back to auto-detection (well-known env vars, $HOME).
   * Return null if the agent is not installed.
   */
  abstract resolveDataDir(userOverride?: string): Promise<string | null>;

  /**
   * Build the canonical {@link Agent} descriptor for this collector.
   * Calls {@link resolveDataDir} internally.
   */
  async describe(userOverride?: string): Promise<Agent | null> {
    const dataDir = await this.resolveDataDir(userOverride);
    if (!dataDir) return null;
    return {
      id: this.type,
      name: this.displayName,
      type: this.type,
      dataDir,
      enabled: true,
      capabilities: this.defaultCapabilities,
    };
  }

  /**
   * Scan the agent's data directory and return normalized records.
   * MUST be safe to call repeatedly — it is incremental by design.
   * Only the minimal `id / type / dataDir` are required; collectors do
   * not need the display fields.
   */
  abstract scan(
    agent: { id: string; type: AgentType; dataDir: string },
    opts?: ScanOptions,
  ): Promise<RawScanResult>;
}

export interface ScanOptions {
  /** Only process files modified after this ISO timestamp (incremental). */
  since?: string;
  /** Hard cap on files to read (safety net for huge data dirs). */
  maxFiles?: number;
  /** Optional pricing overrides forwarded to computeCost(). */
  pricing?: Record<string, import('@agentos/shared').ModelPricing>;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

/** Read a file as UTF-8 text. Returns empty string if the file is missing. */
export async function safeReadFile(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Stream-read a JSONL file line-by-line and call `cb` for each parsed JSON. */
export async function forEachJsonl<T>(
  file: string,
  cb: (record: T, raw: string, lineNo: number) => void,
): Promise<number> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as T;
      cb(record, line, i + 1);
      count++;
    } catch {
      /* skip malformed line */
    }
  }
  return count;
}

/** Recursively list files under `dir` matching one of `extensions`. */
export async function listFilesByExt(
  dir: string,
  extensions: string[],
  opts: { max?: number } = {},
): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase().replace(/^\./, '');
        if (extensions.includes(ext)) {
          out.push(full);
          if (opts.max && out.length >= opts.max) return;
        }
      }
    }
  }
  await walk(dir);
  return out;
}

/** Cross-platform $HOME (Windows-safe). */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Normalise any timestamp-ish value into an ISO string, or undefined. */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    // Heuristic: seconds vs milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return undefined;
  }
  return undefined;
}

/** Convert `D--project-MY-foo` style names back into readable paths. */
export function decodeClaudeProjectDir(name: string): string {
  // Claude encodes paths by replacing separators with `-`. We can't tell
  // `\` from `/` apart after decoding, so we just collapse runs of `-`
  // (which always appear between segments) and restore the drive letter.
  if (process.platform === 'win32' && /^[A-Za-z]--/.test(name)) {
    const drive = name[0];
    const rest = name.slice(3).replace(/-+/g, '/');
    return `${drive}:/${rest}`;
  }
  return name.replace(/-+/g, '/');
}

/** Build a deterministic composite session id. */
export function makeSessionId(agentId: string, externalId: string): string {
  return `${agentId}:${externalId}`;
}