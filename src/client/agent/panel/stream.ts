/**
 * client/agent/panel/stream.ts — Konsumen SSE /api/assistant/ask-stream dan
 * /api/assistant/approve-stream untuk panel agent (browser).
 *
 * Semua bagian murni (parser & keputusan fallback) dipisah supaya bisa
 * di-unit-test tanpa DOM/jaringan. Protokol koneksi dua-kasus:
 *   - Kasus A: SSE gagal SEBELUM event pertama → loop server kemungkinan
 *     belum jalan. Cek status fresh: busy=false → kirim ulang sekali via
 *     POST /ask; busy=true → request sudah sampai → follow (bus).
 *   - Kasus B: SSE putus setelah ≥1 event → loop server pasti masih jalan →
 *     JANGAN pernah kirim ulang, langsung follow.
 * Defense-in-depth server: POST /ask saat busy ditolak ("masih memproses"),
 * jadi dobel-task mustahil walau protokol klien dilanggar.
 */

export type AsSseEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: any }
  | { type: "tool_result"; name: string; text: string }
  | { type: "approval"; id: string; tool: string; args: any }
  | { type: "speak"; text: string }
  | { type: "done"; ok: boolean; reply?: string; error?: string };

/**
 * Parse buffer SSE ("data: {...}\n\n") menjadi event utuh. Sisa potongan
 * yang belum lengkap dikembalikan lewat `rest` untuk diakumulasi pemanggil.
 * Baris non-JSON / kosong dilewati tanpa melempar error.
 */
export function drainSse(buffer: string): { events: AsSseEvent[]; rest: string } {
  const events: AsSseEvent[] = [];
  const parts = String(buffer || "").split("\n\n");
  const rest = parts.pop() || "";
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (!dataLines.length) continue;
    try {
      const ev = JSON.parse(dataLines.join("\n")) as AsSseEvent;
      if (ev && typeof ev.type === "string") events.push(ev);
    } catch {
      /* frame rusak — lewati, stream tetap lanjut */
    }
  }
  return { events, rest };
}

/**
 * Keputusan fallback dua-kasus (lihat header file). `receivedAnyEvent` =
 * minimal satu event SSE sudah diterima sebelum koneksi putus; `busyNow` =
 * hasil GET /api/assistant/status FRESH (bukan cache) pada saat putus.
 */
export function decideFallback(o: {
  receivedAnyEvent: boolean;
  busyNow: boolean;
}): "resend" | "follow" {
  if (o.receivedAnyEvent) return "follow"; // Kasus B
  return o.busyNow ? "follow" : "resend"; // Kasus A
}

/**
 * Baca body Response sebagai aliran SSE. Mengembalikan event lewat onEvent
 * dan menyelesaikan dengan informasi apakah minimal satu event diterima.
 * Throw hanya bila stream gagal SEBELUM event pertama (pemanggil bisa
 * membedakan Kasus A vs B dari receivedAnyEvent).
 */
export async function readSseStream(
  resp: Response,
  onEvent: (ev: AsSseEvent) => void,
  signal?: AbortSignal,
): Promise<{ receivedAnyEvent: boolean; aborted: boolean }> {
  if (!resp.ok || !resp.body) {
    throw new Error("HTTP " + resp.status);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let receivedAnyEvent = false;
  let aborted = false;
  try {
    for (;;) {
      if (signal?.aborted) { aborted = true; break; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const { events, rest } = drainSse(buffer);
      buffer = rest;
      for (const ev of events) {
        receivedAnyEvent = true;
        onEvent(ev);
        if (ev.type === "done") return { receivedAnyEvent, aborted };
      }
    }
  } catch (e: any) {
    if (signal?.aborted) aborted = true;
    else if (!receivedAnyEvent) throw e;
    // putus di tengah (Kasus B) bukan error — pemanggil lanjut ke follow
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return { receivedAnyEvent, aborted };
}

/** Kirim JSON POST; balikan di-parse, error dilempar sebagai Error. */
export async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) throw new Error(d?.error || "HTTP " + r.status);
  return d;
}
