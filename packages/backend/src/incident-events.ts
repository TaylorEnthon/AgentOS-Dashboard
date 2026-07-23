/**
 * v1.8: Health Incident Realtime Events.
 *
 * The internal payload type passed to the reconcileFromQueue callback
 * when a transition is detected (first detected / escalation /
 * recovery). The route handler bridges these to the EventBus.
 *
 * Kept separate from event-bus.ts so health-history.ts can stay
 * unaware of the global EventBus singleton (easier to test).
 */

import type { HealthAnomalyKind, HealthAnomalySeverity } from '@agentos/shared';

/**
 * Notification emitted by the reconcile path. Read-only — never
 * mutates any DB state. The bridge layer translates these into
 * RealtimeEvents on the EventBus.
 */
export type IncidentRealtimeEvent =
  | {
      type: 'incident_detected';
      incidentKey: string;
      executionId: string;
      kind: HealthAnomalyKind;
      severity: HealthAnomalySeverity;
    }
  | {
      type: 'incident_escalated';
      incidentKey: string;
      executionId: string;
      kind: HealthAnomalyKind;
      fromSeverity: HealthAnomalySeverity;
      toSeverity: HealthAnomalySeverity;
      escalationCount: number;
    }
  | {
      type: 'incident_recovered';
      incidentKey: string;
      executionId: string;
      kind: HealthAnomalyKind;
      durationMs: number | null;
    };

/** Callback signature for incident realtime events. */
export type IncidentEventEmitter = (ev: IncidentRealtimeEvent) => void;

/** No-op emitter used as the default. */
export const noopIncidentEmitter: IncidentEventEmitter = () => { /* ignore */ };