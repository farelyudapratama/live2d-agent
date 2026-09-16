/**
 * server/assistant.ts — FACADE mode AI Assistant/Agent.
 * Semua logika berat sudah dipindah ke modul agent/ (otak kerja) dan
 * persona/ (otak akting). File ini hanya:
 *   - kelola runtime (start/stop/reset/status/history),
 *   - jembatan API lama (index.ts & panel web) ke agent loop,
 *   - panggil persona narrator di akhir tugas.
 * Kontrak API TIDAK berubah: index.ts, panel web, dan CLI tetap sama.
 */
import type { ConfigManager } from "../shared/config";
import { appRoot } from "../shared/paths";
import { makeRuntime, getRuntime, setRuntime, loadSession, saveSession, pushMsg, MAX_PARKED } from "./agent/state";
import type { TaskRec } from "./agent/state";
import { makeSessionsStore } from "./agent/sessions";
import { agentAsk, agentRunApproved } from "./agent/loop";
import { stripToolDirective } from "./agent/parse";
import { readEvents, emitEvent } from "./agent/bus";
import { narrate } from "./persona/narrator";
import { cleanForSpeech } from "./persona/clean";
import { TOOLS, publicToolArgs } from "./agent/tools/index";
import { setSubagentConfig } from "./agent/tools/subagent";
import { memoryList, memoryDelete } from "./agent/memory";
import { undoList, revertUndo } from "./agent/undo";

export type { AsMsg, AsApproval, PlanItem } from "./agent/state";
export type { AsEvent } from "./assistant-events";
export { memoryList as assistantMemoryList, memoryDelete as assistantMemoryDelete };

let configWired = false;
/** Store sesi — satu instance untuk proses (path dari appRoot). */
const sessionsStore = makeSessionsStore(appRoot());
/** Dipanggil sekali dari index.ts saat server boot. */
export function initAssistant(config: ConfigManager): void {
  if (!configWired) {
    setSubagentConfig(config);
    configWired = true;
  }
}

// ── Status & lifecycle ─────────────────────────────────────────

export function assistantStatus() {
  const rt = getRuntime();
  const bus = readEvents(0);
  const lastEvent = rt && bus.events.length
    ? bus.events[bus.events.length - 1]
    : null;
  return {
    running: !!rt,
    busy: rt?.busy || false,
    workDir: rt?.workDir || null,
    historyCount: rt?.history.length || 0,
    pendingApprovals: rt ? Array.from(rt.approvals.values(), (ap) => ({
      ...ap,
      args: publicToolArgs(ap.tool, ap.args),
    })) : [],
    /** Rencana kerja aktif (update_plan) — untuk kotak progress di panel. */
    plan: rt?.plan || [],
    /** File yang tersentuh sesi ini (notes) — untuk tab Review panel. */
    notes: { filesTouched: rt ? rt.notes.filesTouched.slice() : [] },
    /** Metadata level tool (safe/mutating) — badge "auto"/"izin" di panel.
     *  Sumber kebenaran tetap registry TOOLS; client tidak menduplikasi. */
    tools: TOOLS.map((t) => ({ name: t.name, level: t.level })),
    /** Aktivitas agent terakhir — stage chip menampilkan apa yang sedang
     *  dikerjakan tanpa membuka panel. Null bila runtime mati/bus kosong. */
    lastEvent: lastEvent ? { type: lastEvent.type, label: lastEvent.label } : null,
    /** S4-A: identitas task worker yang memegangi runtime (running/paused). */
    activeTask: rt?.activeTask
      ? { taskId: rt.activeTask.taskId, text: rt.activeTask.text.slice(0, 120), state: rt.activeTask.state }
      : null,
    /** S4-A: daftar PARK FIFO — taskId + potongan teks, bukan state internal. */
    parkedTasks: rt ? rt.parkedTasks.map((p) => ({ taskId: p.taskId, text: p.text.slice(0, 120) })) : [],
    queueCount: rt?.parkedTasks.length || 0,
  };
}

export function assistantHistory() {
  const rt = getRuntime();
  return rt ? rt.history : [];
}

export function assistantStop() {
  const rt = getRuntime();
  if (rt) rt.destroyed = true;
  setRuntime(null);
  return { ok: true };
}

export function assistantStart(cfg: any): { ok: boolean; error?: string } {
  assistantStop();
  // Default = akar app (bukan process.cwd()) supaya deterministik di portable.
  const saved = loadSession();
  const workDir = String(cfg?.workDir || saved?.workDir || appRoot()).trim();
  const rt = makeRuntime(cfg || {}, workDir, saved?.history ? saved.history.slice() : []);
  rt.sessionId = saved?.sessionId || "";
  setRuntime(rt);
  saveSession(rt);
  return { ok: true };
}

/**
 * Reset history worker. S4-A (I8): TIDAK boleh memutasi history selama ada
 * task memegang slot (running ATAU paused) — ditolak dengan feedback eksplisit.
 * Cancel bukan efek samping reset: tugas aktif TIDAK ikut dibatalkan.
 */
export function assistantReset(): { ok: boolean; accepted: boolean; error?: string } {
  const rt = getRuntime();
  if (!rt) return { ok: true, accepted: true };
  if (rt.activeTask || rt.busy) {
    return { ok: false, accepted: false, error: "tugas masih berjalan/menunggu izin — reset ditolak" };
  }
  rt.history = [];
  saveSession(rt);
  return { ok: true, accepted: true };
}

/**
 * Cancel tugas berjalan TANPA mematikan runtime. S4-A: task-aware.
 *  - taskId cocok PARKED   → buang dari antrean, task aktif TIDAK tersentuh.
 *  - taskId cocok ACTIVE   → running: flag kooperatif; paused: terminal
 *    seketika (tidak ada loop yang membaca flag) + drain antrean.
 *  - tanpa taskId          → task aktif; bila tak ada apa pun: accepted:false
 *    (perilaku lama dipertahankan).
 * Antrean TIDAK pernah dibatalkan otomatis bareng task aktif.
 */
export function assistantCancel(body?: { taskId?: string } | null): {
  ok: boolean;
  accepted: boolean;
  cancelled: "active" | "parked" | null;
} {
  const rt = getRuntime();
  if (!rt) return { ok: true, accepted: false, cancelled: null };
  const raw = body && body.taskId != null ? String(body.taskId) : "";
  if (raw) {
    const i = rt.parkedTasks.findIndex((p) => p.taskId === raw);
    if (i >= 0) {
      rt.parkedTasks.splice(i, 1); // HANYA yang diparkir (I9)
      return { ok: true, accepted: true, cancelled: "parked" };
    }
    if (rt.activeTask && rt.activeTask.taskId === raw) return cancelActive(rt);
    return { ok: true, accepted: false, cancelled: null }; // target salah: jangan sentuh apa pun
  }
  if (rt.activeTask) return cancelActive(rt);
  if (rt.busy) {
    rt.cancelRequested = true; // defensif: busy manual tanpa task (test lama)
    return { ok: true, accepted: true, cancelled: "active" };
  }
  return { ok: true, accepted: false, cancelled: null };
}

function cancelActive(rt: NonNullable<ReturnType<typeof getRuntime>>): {
  ok: boolean;
  accepted: boolean;
  cancelled: "active" | "parked" | null;
} {
  const task = rt.activeTask!;
  if (task.state === "paused") {
    // Tidak ada loop berjalan untuk membaca flag — terminal SEKETIKA.
    // Approval milik task ini dimatikan (celah resume basi tertutup).
    rt.approvals.clear();
    pushMsg(rt, { role: "assistant", content: "(tugas " + task.taskId + " dibatalkan saat menunggu izin)" });
    releaseAndDrain(rt, task);
    return { ok: true, accepted: true, cancelled: "active" };
  }
  rt.cancelRequested = true; // kooperatif lama: tool in-flight selesai dulu
  return { ok: true, accepted: true, cancelled: "active" };
}

// ── Event stream untuk panel/pet/akting (bus ber-seq) ──────────

export function assistantEvents(sinceSeq = 0) {
  const d = readEvents(sinceSeq);
  return { latest: d.latest, busy: !!getRuntime()?.busy, events: d.events };
}

// ── Ask: jembatan ke agent loop + narrator + TASK QUEUE (S4-A) ─
//
// Kontrak worker (Behavior Contract S4-A):
//   - paling banyak SATU task RUNNING/PAUSED memegangi runtime (`activeTask`);
//   - task baru saat slot terisi = PARK ke FIFO antrean (cap MAX_PARKED);
//     overflow menolak yang TERBARU dengan feedback eksplisit — tanpa drop
//     senyap;
//   - tiap task terminal (sukses/error/cancel/limit) MELEPAS slot tepat
//     satu kali, lalu drain berikutnya — pemilik transisi drain hanya
//     pemanggil releaseAndDrain yang lolos guard taskId (completion basi
//     tidak bisa melepas task orang lain atau men-drain dua kali).

function assistantAskNoop(): void {}

export type AssistantAskResult = {
  ok: boolean;
  error?: string;
  reply?: string;
  speak?: string;
  /** S4-A: task di-PARK (bukan dijalankan, bukan ditolak). */
  queued?: boolean;
  taskId?: string;
  /** posisi 1-based di antrean saat queued */
  position?: number;
};

/** taskId unik seumur runtime; deterministik (testable), bukan ID terdistribusi. */
function nextTaskId(rt: NonNullable<ReturnType<typeof getRuntime>>): string {
  return "t_" + ++rt.nextTaskSeq;
}

/** Slot terisi = task memegang runtime (running ATAU paused-approval).
 *  `busy` saja tidak cukup — pause-approval melepas busy (bug lama yang
 *  memungkinkan dua loop atas satu history). */
function slotOccupied(rt: NonNullable<ReturnType<typeof getRuntime>>): boolean {
  return !!rt.activeTask || rt.busy;
}

function parkTask(rt: NonNullable<ReturnType<typeof getRuntime>>, text: string): AssistantAskResult {
  if (rt.parkedTasks.length >= MAX_PARKED) {
    return { ok: false, error: `antrean tugas penuh (${MAX_PARKED}) — task terbaru DITOLAK` };
  }
  const task = { taskId: nextTaskId(rt), text };
  rt.parkedTasks.push(task);
  return { ok: true, queued: true, taskId: task.taskId, position: rt.parkedTasks.length };
}

/** Jalankan task yang slotnya SUDAH diklaim. Lapisan narrator (speak) ikut
 *  berjalan untuk task drain — perlakuannya persis ask non-stream klien luar
 *  hari ini (suara akhir via quip actor atas event final_answer; speak hanya
 *  ke sink SSE pemanggil). Rilis + drain terjadi SETELAH speak layer. */
async function executeTask(
  rt: NonNullable<ReturnType<typeof getRuntime>>,
  task: TaskRec,
  text: string,
  config: ConfigManager,
  onEvent?: (e: any) => void,
): Promise<AssistantAskResult> {
  const r = await agentAsk(rt, text, config, onEvent);
  if (!r.ok) {
    releaseAndDrain(rt, task); // error = terminal — antrean tidak deadlock
    return { ok: false, error: r.error, taskId: task.taskId };
  }
  if (r.pausedForApproval) {
    // PAUSE = tetap ACTIVE/OWNED (I2/I11): task berikutnya HARUS park.
    task.state = "paused";
    return { ok: true, reply: r.reply, taskId: task.taskId };
  }
  task.state = "running"; // kelanjutan pasca-approval
  // Lapisan akting: hasil panjang dipadatkan jadi komentar berkarakter.
  const persona = rt.persona;
  const clean = cleanForSpeech(stripToolDirective(r.reply || "", TOOLS.map((t) => t.name)));
  let speak: string | undefined;
  if (clean && !r.reply?.includes("⏳")) {
    if (clean.length <= 240 && !persona) {
      speak = clean;
    } else {
      const n = await narrate({ event: "", result: clean, isError: false, persona }, config);
      speak = n.speak;
    }
  }
  if (speak) {
    if (onEvent) onEvent({ type: "speak", text: speak });
  }
  releaseAndDrain(rt, task);
  return { ok: true, reply: r.reply, speak, taskId: task.taskId };
}

/** Rilis milik-task-sendiri + drain SATU langkah. Sinkron; tidak ada await
 *  di antara guard dan klaim berikutnya — dua terminal tidak bisa klaim ganda. */
function releaseAndDrain(
  rt: NonNullable<ReturnType<typeof getRuntime>>,
  task: TaskRec,
): void {
  if (rt.destroyed) return; // runtime lama: jangan lahirkan task di atasnya
  if (!rt.activeTask || rt.activeTask.taskId !== task.taskId) return; // rilis basi = no-op (I6)
  rt.activeTask = null;
  const next = rt.parkedTasks.shift();
  if (!next) return;
  const t: TaskRec = { taskId: next.taskId, text: next.text, state: "running", cfg: task.cfg };
  rt.activeTask = t; // klaim SENYAP — pemilik transisi drain satu-satunya (I7)
  void executeTask(rt, t, t.text, task.cfg).catch(() => {});
}

export async function assistantAsk(
  text: string,
  config: ConfigManager,
  onEvent: (e: any) => void = assistantAskNoop,
): Promise<AssistantAskResult> {
  const rt = getRuntime();
  if (!rt) return { ok: false, error: "assistant mode tidak aktif" };
  const txt = String(text || "").slice(0, 4000);
  // S4-A: slot terisi (running ATAU paused) → PARK, BUKAN ditolak.
  if (slotOccupied(rt)) return parkTask(rt, txt);
  const task: TaskRec = { taskId: nextTaskId(rt), text: txt, state: "running", cfg: config };
  rt.activeTask = task; // klaim SENYAP sebelum await pertama — race-free
  return executeTask(rt, task, txt, config, onEvent !== assistantAskNoop ? onEvent : undefined);
}

export async function assistantResolveApproval(
  id: string,
  approve: boolean,
  config: ConfigManager,
  onEvent: (e: any) => void = assistantAskNoop,
): Promise<AssistantAskResult> {
  const rt = getRuntime();
  if (!rt) return { ok: false, error: "assistant mode tidak aktif" };
  const ap = rt.approvals.get(id);
  if (!ap) return { ok: false, error: "approval tidak ditemukan" };
  rt.approvals.delete(id);
  // Event bus permission_resolved: tipe sudah dideklarasikan di bus.ts tapi
  // belum pernah di-emit — kini dipakai supaya panel/pet menutup kartu izin
  // secara reaktif (bukan menunggu poll status berikutnya).
  emitEvent("permission_resolved", (approve ? "disetujui: " : "ditolak: ") + ap.tool);
  const sink = onEvent !== assistantAskNoop ? onEvent : undefined;
  const task = rt.activeTask;
  if (task && task.state === "paused") {
    // Keputusan milik task yang MEMEGANG slot — kelanjutan jalan di slot
    // yang sama (bukan ask baru yang akan/boleh PARK).
    if (!approve) {
      pushMsg(rt, { role: "tool", content: "User MENOLAK " + ap.tool + " — batalkan rencana itu dan tanyakan alternatif." });
      releaseAndDrain(rt, task); // DENIAL = terminal untuk task — antrean lanjut
      return { ok: true, reply: "Ditolak. Aku batalkan.", taskId: task.taskId };
    }
    task.state = "running";
    task.cfg = config;
    await agentRunApproved(rt, ap.tool, ap.args, sink);
    return executeTask(rt, task, "Lanjutkan tugas berdasarkan hasil tool di atas.", config, sink);
  }
  // Defensif — approval tanpa task pemilik (kondisi lama). Perilaku pra-S4-A.
  if (!approve) {
    pushMsg(rt, { role: "tool", content: "User MENOLAK " + ap.tool + " — batalkan rencana itu dan tanyakan alternatif." });
    return { ok: true, reply: "Ditolak. Aku batalkan." };
  }
  await agentRunApproved(rt, ap.tool, ap.args, sink);
  return await assistantAsk("Lanjutkan tugas berdasarkan hasil tool di atas.", config, onEvent);
}

/**
 * S4-C: MODIFIKASI task AKTIF — cancel + replacement, SATU operasi atomik.
 *
 * Kontrak terkunci (Option 1): A' mewarisi posisi pipeline A — ia menjadi
 * eksekusi BERIKUTNYA, di DEPAN seluruh parked B/C. Ini BUKAN pembatalan
 * in-place dan BUKAN rewind dunia: pembatalan tetap kooperatif (tool
 * in-flight A selesai dulu; side effect yang sudah terjadi TIDAK dibatalkan).
 *
 * Atomisitas: fungsi ini TIDAK punya satu pun `await`. Semua mutasi state
 * terjadi dalam satu tick event-loop, sehingga drain tidak pernah bisa
 * menyisipkan B sebelum A' terpasang — kasus paused di-klaim langsung
 * (slot lepas seketika), kasus running hanya menaruh A' di KEPALA parked +
 * memasang flag kooperatif; rilis A (satu-satunya, via guard taskId-nya
 * sendiri) lalu men-shift A' pertama.
 *
 * taskId lama PERMANEN pensiun: semua guard rilis/drain berbasis equality
 * taskId milik A' yang baru — completion/cancel basi untuk id lama no-op
 * (pola S4-A T16/T17). Modifikasi task PARKED ditolak eksplisit (deferred).
 */
export function assistantModify(
  body: { taskId?: string; text?: string } | null,
  config: ConfigManager,
): { ok: boolean; retired?: string; taskId?: string; state?: "pending" | "running"; error?: string } {
  const rt = getRuntime();
  if (!rt || rt.destroyed) return { ok: false, error: "assistant mode tidak aktif" };
  const rawId = String(body?.taskId ?? "");
  const txt = String(body?.text ?? "").trim().slice(0, 4000);
  if (!rawId) return { ok: false, error: "taskId wajib diisi" };
  if (!txt) return { ok: false, error: "teks pengganti tidak boleh kosong" };
  const old = rt.activeTask;
  if (!old || old.taskId !== rawId) {
    if (rt.parkedTasks.some((p) => p.taskId === rawId))
      return { ok: false, error: "hanya task AKTIF yang bisa dimodifikasi — task parked di luar cakupan S4-C" };
    return { ok: false, error: "taskId tidak dikenal/sudah pensiun — tidak ada yang diubah" };
  }
  if (rt.parkedTasks.length >= MAX_PARKED)
    return { ok: false, error: `antrean penuh (${MAX_PARKED}) — modify ditolak (tanpa drop senyap)` };
  const newId = nextTaskId(rt);
  if (old.state === "paused") {
    // Tidak ada loop yang membaca flag — terminal SEKETIKA, klaim A' di
    // tick yang sama: approvals milik A dimatikan permanen (approve/deny
    // basi → "approval tidak ditemukan"), slot berpindah tanpa jeda drain.
    rt.approvals.clear();
    pushMsg(rt, { role: "assistant", content: "(tugas " + old.taskId + " diganti → " + newId + " oleh user)" });
    const t: TaskRec = { taskId: newId, text: txt, state: "running", cfg: config };
    rt.activeTask = t;
    void executeTask(rt, t, txt, config).catch(() => {});
    return { ok: true, retired: old.taskId, taskId: newId, state: "running" };
  }
  // RUNNING: A tetap pemegang slot sampai flag kooperatifnya teramati —
  // rilis tunggal oleh eksekusi A sendiri (guard taskId), dan shift pertama
  // antrean sudah A' (kepala). Urutan akhir: A → A' → B → C.
  rt.parkedTasks.unshift({ taskId: newId, text: txt });
  rt.cancelRequested = true;
  return { ok: true, retired: old.taskId, taskId: newId, state: "pending" };
}

// ── Undo: daftar snapshot & revert (panel tab Review) ────────────

export function assistantUndoList() {
  const rt = getRuntime();
  return rt ? undoList(rt) : [];
}

export function assistantRevert(id: string): string {
  const rt = getRuntime();
  if (!rt) throw new Error("assistant mode tidak aktif");
  return revertUndo(rt, id);
}

// ── Multi-session: list / create / switch / delete ───────────────

export function assistantSessionsList() {
  return sessionsStore.list();
}

export function assistantSessionCreate(workDir?: string): { ok: boolean; error?: string } {
  const rt = getRuntime();
  // S4-A: guard diperluas — task PAUSED maupun PARKED tetap memegang
  // sesi. Operasi sesi TIDAK boleh melewati keduanya (task parked tidak
  // pernah boleh dieksekusi diam-diam terhadap sesi berbeda; migrasi
  // lintas sesi di luar cakupan — lihat STATUS S4-A).
  if (rt && (rt.busy || rt.activeTask || rt.parkedTasks.length > 0)) return { ok: false, error: "masih memproses pertanyaan sebelumnya" };
  const wd = String(workDir || rt?.workDir || appRoot()).trim();
  // Simpan dulu state sesi lama (bila ada), lalu buat & pindah.
  if (rt) saveSession(rt);
  const rec = sessionsStore.create(wd);
  if (rt) {
    rt.history = [];
    rt.workDir = wd;
    rt.sessionId = rec.id;
  }
  return { ok: true };
}

export function assistantSessionSwitch(id: string): { ok: boolean; error?: string } {
  const rt = getRuntime();
  if (rt && (rt.busy || rt.activeTask || rt.parkedTasks.length > 0)) return { ok: false, error: "masih memproses pertanyaan sebelumnya" };
  if (rt) saveSession(rt); // simpan yang lama dulu
  const rec = sessionsStore.switchTo(String(id || ""));
  if (!rec) return { ok: false, error: "sesi tidak ditemukan" };
  if (rt) {
    rt.history = rec.messages.slice();
    if (rec.workDir) rt.workDir = rec.workDir;
    rt.sessionId = rec.id;
    saveSession(rt);
  }
  return { ok: true };
}

export function assistantSessionDelete(id: string): { ok: boolean; error?: string; newActive?: string } {
  const rt = getRuntime();
  if (rt && (rt.busy || rt.activeTask || rt.parkedTasks.length > 0)) return { ok: false, error: "masih memproses pertanyaan sebelumnya" };
  const r = sessionsStore.remove(String(id || ""));
  if (!r.ok) return { ok: false, error: "sesi tidak ditemukan" };
  // Sesi aktif terhapus → runtime dipindah ke sesi sisa terbaru (atau kosong).
  if (rt && r.newActive !== undefined) {
    const rec = sessionsStore.activeRec();
    rt.history = rec ? rec.messages.slice() : [];
    rt.sessionId = rec ? rec.id : "";
    if (rec?.workDir) rt.workDir = rec.workDir;
  }
  return { ok: true, newActive: r.newActive };
}
