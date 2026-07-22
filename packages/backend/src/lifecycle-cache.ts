/**
 * v1.2 Lifecycle Cache — minimal in-memory TTL cache.
 *
 * Stores LifecycleSnapshot by executionId. Used to:
 *   1. Skip recomputation when nothing changed (sub-second responses)
 *   2. Detect state transitions (compare new vs previous)
 *
 * Design notes:
 *   - Pure in-memory. NO Redis, NO disk persistence. Process restart
 *     wipes the cache (acceptable: derived data, easy to recompute).
 *   - Bounded size with LRU-ish eviction (oldest `updatedAt` first).
 *   - Per-entry TTL (default 30s) so stale entries don't get served
 *     forever when activity is quiet.
 *   - Module-level singleton, shared across all routes. This matches
 *     the single-process model of the rest of AgentOS.
 */

import type { LifecycleSnapshot } from '@agentos/shared';

interface CacheEntry {
  snapshot: LifecycleSnapshot;
  updatedAt: number; // ms epoch
}

const DEFAULT_TTL_MS = 30_000; // 30s
const DEFAULT_MAX_ENTRIES = 5_000;

/**
 * Process-wide singleton. Tests can call reset() between cases.
 */
class LifecycleCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Read a cached snapshot. Returns null if missing OR expired.
   */
  get(executionId: string): LifecycleSnapshot | null {
    const entry = this.entries.get(executionId);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.entries.delete(executionId);
      return null;
    }
    return entry.snapshot;
  }

  /**
   * Write/overwrite a snapshot. Returns the PREVIOUS cached snapshot
   * (or null if none) so callers can detect transitions.
   *
   * If a transition is detected (different `derivedStatus`), the
   * caller is responsible for emitting the SSE event.
   */
  set(executionId: string, snapshot: LifecycleSnapshot): LifecycleSnapshot | null {
    const prev = this.get(executionId);
    if (this.entries.size >= this.maxEntries && !this.entries.has(executionId)) {
      this.evictOldest();
    }
    this.entries.set(executionId, { snapshot, updatedAt: Date.now() });
    return prev;
  }

  /**
   * Drop one entry. Used by activity-update invalidation hooks.
   * Returns true iff the entry existed.
   */
  invalidate(executionId: string): boolean {
    return this.entries.delete(executionId);
  }

  /**
   * Drop every entry whose execution id starts with `prefix`. Used
   * to invalidate all sessions for an agent when a scan completes.
   */
  invalidateByPrefix(prefix: string): number {
    let dropped = 0;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) {
        this.entries.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Drop every entry. Used by tests and on hard invalidation.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Stats for tests + observability.
   */
  size(): number {
    return this.entries.size;
  }

  has(executionId: string): boolean {
    const e = this.entries.get(executionId);
    if (!e) return false;
    if (Date.now() - e.updatedAt > this.ttlMs) {
      this.entries.delete(executionId);
      return false;
    }
    return true;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [k, v] of this.entries) {
      if (v.updatedAt < oldestMs) {
        oldestMs = v.updatedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }
}

/** Process-wide singleton. */
export const lifecycleCache = new LifecycleCache();

/** For tests that need an isolated cache instance. */
export function createLifecycleCache(opts?: { ttlMs?: number; maxEntries?: number }): LifecycleCache {
  return new LifecycleCache(opts);
}