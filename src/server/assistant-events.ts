/**
 * server/assistant-events.ts — Tipe event SSE lama (kompatibel panel/CLI).
 * Dipisah dari assistant.ts supaya agent/ bisa mengimpornya tanpa
 * melingkar ke facade.
 */
export type AsEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: any }
  | { type: "tool_result"; name: string; text: string }
  | { type: "approval"; id: string; tool: string; args: any }
  | { type: "speak"; text: string };
