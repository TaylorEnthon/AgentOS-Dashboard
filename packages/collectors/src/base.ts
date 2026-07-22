import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  Agent,
  AgentType,
  RawScanResult,
  SourceMeta,
  FileFingerprint,
} from '@agentos/shared';

/**
 * Abstract base for every collector.
 *
 * v0.2 changes:
 *  - scan() now returns `RawScanResult` with `collectedAt` + `files[]`
 *    (full provenance & per-file fingerprints).
 *  - ScanOptions supports `mode: 'full' | 'incremental'` and `since`.
 *    `incremental` is best-effort: if no prior fingerprint exists for a
 *    file, the file is read (a future chokidar watcher will narrow this).
 */
export abstract class BaseCollector {
  abstract readonly type: AgentType;
  abstract readonly displayName: string;
  abstract readonly defaultCapabilities: string[];

  abstract resolveDataDir(userOverride?: string): Promise<string | null>;

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
   * MUST be safe to call repeatedly.
   */
  abstract scan(
    agent: { id: string; type: AgentType; dataDir: string },
    opts?: ScanOptions,
  ): Promise<RawScanResult>;
}

export type ScanMode = 'full' | 'incremental';

export interface ScanOptions {
  /** Only process files modified after this ISO timestamp (incremental). */
  since?: string;
  /** Hard cap on files to read (safety net for huge data dirs). */
  maxFiles?: number;
  /** Optional pricing overrides forwarded to computeCost(). */
  pricing?: Record<string, import('@agentos/shared').ModelPricing>;
  /** 'full' reads everything; 'incremental' skips files matching prior state. */
  mode?: ScanMode;
  /**
   * Optional prior state — backend passes `ingestion_files` rows in here
   * so the collector can skip files that haven't changed. Key is the
   * absolute file path. If a file is absent from this map, it's read.
   */
  priorFiles?: Map<string, { size: number; mtimeMs: number; contentHash: string }>;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

export async function safeReadFile(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

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

export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Normalise any timestamp-ish value into an ISO string, or undefined. */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
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

/* ------------------------------------------------------------------ */
/* Source provenance + file fingerprint helpers (v0.2)                 */
/* ------------------------------------------------------------------ */

/** Build a SourceMeta for a single collector run. */
export function buildSourceMeta(
  provider: AgentType,
  filePath: string,
  recordId: string,
  collectedAt: string,
): SourceMeta {
  return {
    sourceProvider: provider,
    sourceFile: filePath,
    sourceId: recordId,
    collectedAt,
  };
}

/**
 * SHA-256 of the file contents. For very large files we hash the first
 * `SAMPLE_BYTES` bytes + the total size — exact enough to detect edits
 * without reading 100MB into memory.
 */
const SAMPLE_BYTES = 256 * 1024; // 256 KiB head sample
export async function hashFile(filePath: string): Promise<{ size: number; mtimeMs: number; contentHash: string }> {
  const stat = await fs.stat(filePath);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath, { start: 0, end: SAMPLE_BYTES - 1 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      // include total size so two zero-byte files don't collide
      hash.update(`|size=${stat.size}|mtime=${stat.mtimeMs}`);
      resolve({ size: stat.size, mtimeMs: stat.mtimeMs, contentHash: hash.digest('hex') });
    });
    stream.on('error', reject);
  });
}

/**
 * Check whether a file has changed since its last-known fingerprint.
 * Returns `false` (skip) only if size + mtime + contentHash all match.
 */
export function isFileUnchanged(
  current: { size: number; mtimeMs: number; contentHash: string },
  prior: { size: number; mtimeMs: number; contentHash: string } | undefined,
): boolean {
  if (!prior) return false;
  return (
    current.size === prior.size &&
    current.mtimeMs === prior.mtimeMs &&
    current.contentHash === prior.contentHash
  );
}

/** Convenience builder for {@link FileFingerprint}. */
export function buildFingerprint(
  sourceFile: string,
  stat: { size: number; mtimeMs: number; contentHash: string },
  counts: { sessions: number; usageRecords: number; events: number },
): FileFingerprint {
  return {
    sourceFile,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash: stat.contentHash,
    sessions: counts.sessions,
    usageRecords: counts.usageRecords,
    events: counts.events,
  };
}