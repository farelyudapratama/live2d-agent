/**
 * server/agent/bus.ts — Event bus aktivitas agent.
 * Loop menulis event kanonik di titik penting; dua konsumen:
 *   1. Ring buffer ber-seq → GET /api/assistant/events (panel web / pet shell).
 *   2. onEvent callback (SSE /api/assistant/ask-stream untuk CLI).
 * Event ini JUGA jembatan ke lapisan akting Live2D — persona/narrator hanya
 * menerima ringkasan event ini, tidak pernah menyentuh history penuh agent.
 */

export type AgentEventType =
  | "thinking_start"
  | "tool_call_start"
  | "tool_call_end"
  | "permission_request"
  | "permission_resolved"
  | "verification_start"
  | "verification_result"
  | "plan_updated"
  | "plan_revised"
  | "subagent_spawned"
  | "subagent_completed"
  | "final_answer"
  | "error";

export type AgentEvent = {
  seq: number;
  type: AgentEventType;
  /** Ringkasan singkat untuk tampilan/akting — BUKAN full history. */
  label: string;
  ts: number;
};

const MAX_EVENTS = 120;

type BusState = {
  events: AgentEvent[];
  seq: number;
  sinks: Set<(e: AgentEvent) => void>;
};

const bus: BusState = { events: [], seq: 0, sinks: new Set() };

export function emitEvent(type: AgentEventType, label = ""): AgentEvent {
  const ev: AgentEvent = { seq: ++bus.seq, type, label: String(label || "").slice(0, 200), ts: Date.now() };
  bus.events.push(ev);
  if (bus.events.length > MAX_EVENTS) bus.events.splice(0, bus.events.length - MAX_EVENTS);
  for (const s of bus.sinks) {
    try {
      s(ev);
    } catch {
      /* sink mati tidak boleh menjatuhkan loop */
    }
  }
  return ev;
}

export function onEvent(sink: (e: AgentEvent) => void): () => void {
  bus.sinks.add(sink);
  return () => bus.sinks.delete(sink);
}

export function readEvents(sinceSeq = 0): { latest: number; events: AgentEvent[] } {
  return {
    latest: bus.seq,
    events: bus.events.filter((e) => e.seq > sinceSeq),
  };
}

export function resetBus(): void {
  bus.events = [];
  bus.seq = 0;
}
