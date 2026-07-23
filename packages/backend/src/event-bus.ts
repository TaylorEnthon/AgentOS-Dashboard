/**
 * Tiny typed pub/sub used to broadcast scan / ingestion / status changes
 * to SSE subscribers and any future consumers (e.g. MCP server).
 *
 * - Synchronous dispatch (in-process): the backend runs in a single Node
 *   process, so we don't need a queue. Subscribers are called inline.
 * - Subscribers can't unsubscribe by accident: the returned `unsubscribe`
 *   function removes only that callback.
 * - Bounded history: callers that connect to `/api/events/stream` late
 *   can pull the last `historySize` events so the UI gets immediate state.
 */

export type AgentStatus = 'active' | 'idle' | 'unknown';

export type RealtimeEvent =
  | {
      type: 'scan_started';
      ts: string;
      agent: string; // AgentType — avoid circular import with @agentos/shared
      reason: 'startup' | 'interval' | 'file-change' | 'manual' | 'watcher-error';
    }
  | {
      type: 'scan_completed';
      ts: string;
      agent: string;
      ms: number;
      sessions: number;
      usage: number;
      events: number;
      duplicatesPrevented: number;
      error?: string;
    }
  | {
      type: 'file_changed';
      ts: string;
      agent: string;
      filePath: string;
    }
  | {
      type: 'agent_status';
      ts: string;
      agent: string;
      status: AgentStatus;
      lastActivity?: string;
      lastProject?: string;
      lastAction?: string;
    }
  | {
      // v1.2: emitted when a cached LifecycleSnapshot's derivedStatus
      // differs from the previous cached value. Slim payload — the
      // frontend refetches the full snapshot via /api/executions/:id/lifecycle.
      type: 'lifecycle_changed';
      ts: string;
      executionId: string;
      derivedStatus: import('@agentos/shared').DerivedLifecycleStatus;
      previousDerivedStatus: import('@agentos/shared').DerivedLifecycleStatus | null;
      confidence: import('@agentos/shared').LifecycleConfidence;
      reason: string;
    }
  | {
      // v1.8: emitted when an anomaly-derived incident is FIRST detected
      // (i.e. the (exec, kind) pair was never seen before). Slim payload —
      // the frontend can call /api/incidents/:key for full detail.
      type: 'incident_detected';
      ts: string;
      incidentKey: string;
      executionId: string;
      kind: import('@agentos/shared').HealthAnomalyKind;
      severity: import('@agentos/shared').HealthAnomalySeverity;
    }
  | {
      // v1.8: emitted when an active incident's severity escalates
      // (high → critical). Slim payload — same source as incident_detected.
      type: 'incident_escalated';
      ts: string;
      incidentKey: string;
      executionId: string;
      kind: import('@agentos/shared').HealthAnomalyKind;
      fromSeverity: import('@agentos/shared').HealthAnomalySeverity;
      toSeverity: import('@agentos/shared').HealthAnomalySeverity;
      escalationCount: number;
    }
  | {
      // v1.8: emitted when a previously-active incident transitions
      // to 'recovered' (the anomaly stopped firing across reconciliations).
      type: 'incident_recovered';
      ts: string;
      incidentKey: string;
      executionId: string;
      kind: import('@agentos/shared').HealthAnomalyKind;
      durationMs: number | null;
    }
  | {
      // v1.9: emitted when the cross-incident correlation snapshot may
      // have changed (i.e. a new incident transition just happened).
      // Read-only notification: clients should refetch
      // /api/incidents/correlations to refresh the workspace view.
      // Does NOT mutate incident lifecycle.
      type: 'incident_correlation_refresh';
      ts: string;
      reason: 'incident_detected' | 'incident_escalated' | 'incident_recovered';
    };

export type RealtimeEventListener = (ev: RealtimeEvent) => void;

export class EventBus {
  private listeners = new Set<RealtimeEventListener>();
  private history: RealtimeEvent[] = [];
  private readonly historySize: number;

  constructor(opts: { historySize?: number } = {}) {
    this.historySize = opts.historySize ?? 50;
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    // replay recent history so a late subscriber sees current state
    for (const ev of this.history) listener(ev);
    return () => this.listeners.delete(listener);
  }

  /**
   * Test helper: drop replay history so subsequent `subscribe()` calls
   * don't see events emitted by earlier tests.
   */
  clearHistory(): void {
    this.history = [];
  }

  emit(ev: RealtimeEvent): void {
    this.history.push(ev);
    if (this.history.length > this.historySize) {
      this.history.splice(0, this.history.length - this.historySize);
    }
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (err) {
        console.error('[event-bus] subscriber threw:', err);
      }
    }
  }

  size(): number {
    return this.listeners.size;
  }

  snapshot(): RealtimeEvent[] {
    return [...this.history];
  }
}

/** Process-wide singleton. Use this everywhere. */
export const eventBus = new EventBus();