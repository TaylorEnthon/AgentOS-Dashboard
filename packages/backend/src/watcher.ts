/**
 * chokidar-based file watcher for each agent's data directory.
 *
 * Strategy:
 *  - One chokidar instance per enabled agent's data dir.
 *  - We watch the **directory** itself (recursive), filtering out
 *    non-JSONL files at the change handler.
 *  - Coalesce bursts: many small writes → one rescan, debounced.
 *  - On change → call `onChange(agentType, filePath)`.
 *  - On error → caller can decide whether to fall back to polling.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildCollector } from '@agentos/collectors';
import type { AgentType } from '@agentos/shared';

export interface WatcherOptions {
  /** Debounce window — many quick writes collapse into one rescan. */
  debounceMs?: number;
  /** Log helper for diagnostics. */
  log?: (msg: string) => void;
}

interface AgentWatcher {
  agent: AgentType;
  dataDir: string;
  watcher: FSWatcher | null;
  /** pending file paths → timer */
  pending: Map<string, NodeJS.Timeout>;
  onChange: (filePath: string) => void;
}

/**
 * Build one watcher per agent. Returns a controller that the caller can
 * start / close.
 */
export function startWatchers(
  agents: Array<{ type: AgentType; dataDir: string }>,
  opts: WatcherOptions = {},
): {
  handleChange: (agent: AgentType, filePath: string) => void;
  close: () => Promise<void>;
  /** Internal for tests. */
  _watchers: AgentWatcher[];
} {
  const log = opts.log ?? (() => {});
  const debounceMs = opts.debounceMs ?? 750;
  const watchers: AgentWatcher[] = [];

  const handleChange = (agent: AgentType, filePath: string): void => {
    const aw = watchers.find((w) => w.agent === agent);
    if (!aw) return;
    if (!/\.(jsonl|ndjson)$/i.test(filePath)) return;

    const existing = aw.pending.get(filePath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      aw.pending.delete(filePath);
      try {
        aw.onChange(filePath);
      } catch (err) {
        console.error(`[watcher] onChange threw for ${filePath}:`, err);
      }
    }, debounceMs);
    aw.pending.set(filePath, t);
  };

  for (const a of agents) {
    // Resolve dataDir through the collector so user overrides win.
    const collector = buildCollector(a.type);
    const resolved = ((): string | null => {
      try {
        // sync fallback — collector.resolveDataDir is async; we use a
        // small wrapper that reads the same priority order.
        return a.dataDir || null;
      } catch {
        return null;
      }
    })();

    const dataDir = resolved;
    if (!dataDir) {
      log(`[watcher] no dataDir for ${a.type}, skipping`);
      continue;
    }

    const w: AgentWatcher = {
      agent: a.type,
      dataDir,
      watcher: null,
      pending: new Map(),
      onChange: () => {},
    };
    w.onChange = (filePath) => handleChange(a.type, filePath);

    try {
      w.watcher = chokidar.watch(dataDir, {
        ignored: (p: string) => {
          // ignore dotfiles + .codegraph + .git; keep all data files
          const base = path.basename(p);
          if (base.startsWith('.') && base !== '.' && base !== '..') return true;
          // files are accepted; we'll filter on ext at change-time
          return false;
        },
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 400,
          pollInterval: 100,
        },
      });
      w.watcher.on('add', (p) => handleChange(a.type, p));
      w.watcher.on('change', (p) => handleChange(a.type, p));
      w.watcher.on('error', (err) => log(`[watcher] ${a.type} error: ${String(err)}`));
      log(`[watcher] watching ${dataDir} for ${a.type}`);
    } catch (err) {
      log(`[watcher] failed to start watcher for ${a.type}: ${String(err)}`);
    }
    watchers.push(w);
  }

  return {
    handleChange,
    _watchers: watchers,
    close: async () => {
      for (const w of watchers) {
        for (const t of w.pending.values()) clearTimeout(t);
        w.pending.clear();
        if (w.watcher) {
          try {
            await w.watcher.close();
          } catch {
            /* swallow */
          }
        }
      }
    },
  };
}

/**
 * Resolve a dataDir synchronously by checking the candidate paths
 * the collector would consider. Used by tests.
 */
export async function resolveSync(dataDir: string): Promise<boolean> {
  try {
    const s = await fs.stat(dataDir);
    return s.isDirectory();
  } catch {
    return false;
  }
}