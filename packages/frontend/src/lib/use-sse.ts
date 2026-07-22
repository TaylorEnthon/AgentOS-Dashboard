/**
 * React hook for Server-Sent Events.
 *
 * Connects to `/api/events/stream` and exposes:
 *  - `events`:  rolling buffer of received events (most recent N)
 *  - `connected`:  whether the EventSource is open
 *  - `clearEvents()`:  reset the buffer
 *
 * Reconnects automatically on disconnect with exponential backoff.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

export interface SseEvent {
  type: string;
  ts?: string;
  [key: string]: unknown;
}

export interface UseSseOptions {
  /** Rolling buffer size; default 100. */
  bufferSize?: number;
  /** Filter to only these event types (case-sensitive). */
  types?: string[];
  /** Reconnect base delay in ms (exponential). Default 1000. */
  reconnectBaseMs?: number;
  /** Max reconnect delay. Default 15000. */
  reconnectMaxMs?: number;
}

export interface UseSseResult {
  events: SseEvent[];
  connected: boolean;
  lastEventAt?: string;
  clearEvents: () => void;
}

export function useSse(path: string, opts: UseSseOptions = {}): UseSseResult {
  const bufferSize = opts.bufferSize ?? 100;
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
  const reconnectMaxMs = opts.reconnectMaxMs ?? 15_000;
  const allowedTypes = opts.types ? new Set(opts.types) : null;

  const [events, setEvents] = useState<SseEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<string | undefined>(undefined);
  const esRef = useRef<EventSource | null>(null);
  const attemptsRef = useRef(0);
  const closedRef = useRef(false);

  const clearEvents = useCallback(() => setEvents([]), []);

  useEffect(() => {
    closedRef.current = false;

    const connect = (): void => {
      if (closedRef.current) return;
      const es = new EventSource(path);
      esRef.current = es;

      es.onopen = () => {
        attemptsRef.current = 0;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        es.close();
        esRef.current = null;
        if (closedRef.current) return;
        const delay = Math.min(
          reconnectMaxMs,
          reconnectBaseMs * Math.pow(2, Math.min(attemptsRef.current, 6)),
        );
        attemptsRef.current++;
        setTimeout(connect, delay);
      };

      // Generic handler — each EventSource `on<type>` is attached below.
      const onMessage = (e: MessageEvent): void => {
        if (allowedTypes && !allowedTypes.has(e.type)) return;
        try {
          const data = JSON.parse(e.data) as SseEvent;
          setLastEventAt(new Date().toISOString());
          setEvents((prev) => {
            const next = prev.concat(data);
            return next.length > bufferSize ? next.slice(-bufferSize) : next;
          });
        } catch {
          /* non-JSON heartbeat line — ignore */
        }
      };

      // Register a default onmessage handler — the SSE server emits typed
      // events ("event: foo"), which EventSource surfaces via `addEventListener`.
      // We listen to all known event names from the backend.
      for (const t of [
        'scan_started',
        'scan_completed',
        'file_changed',
        'agent_status',
        'lifecycle_changed', // v1.2: lifecycle runtime
      ]) {
        es.addEventListener(t, onMessage as EventListener);
      }
      // also a generic catch-all (the backend doesn't send bare 'message'
      // events but be defensive).
      es.onmessage = onMessage;
    };

    connect();

    return () => {
      closedRef.current = true;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [path, bufferSize, reconnectBaseMs, reconnectMaxMs, allowedTypes]);

  return { events, connected, lastEventAt, clearEvents };
}