/**
 * harness-queue-ui.test.ts — S4-B: UI antrean worker (proyeksi murni /status)
 * + cancel per-taskId + visibilitas jawaban antara (B1 contract decision).
 *
 * Konvensi test panel yang sudah ada (agent-panel.test.ts): fungsi murni +
 * source-guard pada teks ASLI panel.ts/view.ts — tanpa DOM mount. Semua bukti
 * deterministik: fixture snapshot status in → projection out, tanpa sleep.
 *
 * Yang dikunci:
 *  - tidak ada queue state client: rows = f(snapshot); dua snapshot sama ⇒
 *    hasil sama; input tidak dimutasi;
 *  - posisi FIFO diturunkan dari urutan array server (bukan di-persist);
 *  - cancel baris parked menarget PERSIS taskId baris itu; task aktif tidak
 *    pernah bisa dibatalkan dari baris antrean;
 *  - hero kartu TASK memprioritaskan server activeTask (stale currentTask
 *    hanya fallback saat idle);
 *  - syncHistory drain (A→B) tepat satu pemicu; A→idle tetap aturan lama;
 *    same-A berulang TIDAK pernah fetch;
 *  - PARKED tidak pernah jadi blok transcript / tidak menyentuh AgentBrain.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  queueRows,
  heroTaskText,
  shouldSyncOnDrain,
  queuedFeedback,
} from "../src/client/agent/panel/transcript";

const repoRoot = resolve(import.meta.dir, "..");
const panelSrc = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "panel.ts"), "utf8");
const viewSrc = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "view.ts"), "utf8");

type St = {
  activeTask?: { taskId: string; text: string; state: "running" | "paused" } | null;
  parkedTasks?: Array<{ taskId: string; text: string }> | null;
  queueCount?: number;
  running?: boolean;
  busy?: boolean;
};

const run = (id: string, text: string) => ({ taskId: id, text, state: "running" as const });
const pau = (id: string, text: string) => ({ taskId: id, text, state: "paused" as const });
const park = (id: string, text: string) => ({ taskId: id, text });

/** Slice badan fungsi kurung-seimbang — cukup untuk guard sumber
 *  atas fungsi tanpa literal kurung di dalam string-nya. */
function extractFnSrc(src: string, header: string): string {
  const i = src.indexOf(header);
  if (i < 0) throw new Error("tidak ditemukan: " + header);
  let j = src.indexOf("{", i);
  let depth = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}

// ═══ PROYEKSI MURNI (B1–B10) ═══════════════════════════════════════════
describe("S4-B queueRows — proyeksi murni dari snapshot /status", () => {
  test("B1: task aktif berasal dari server activeTask, bukan currentTask basi", () => {
    const st: St = { activeTask: run("t_7", "kliren server"), parkedTasks: [] };
    expect(heroTaskText(st, "currentTask client yang basi")).toBe("kliren server");
    // saat idle (tanpa activeTask) fallback client dipertahankan
    expect(heroTaskText({ activeTask: null, parkedTasks: [] }, "terakhir client")).toBe("terakhir client");
    // teks server whitespace-only dianggap tidak ada → fallback jujur
    expect(heroTaskText({ activeTask: run("t_7", "   "), parkedTasks: [] }, "fb")).toBe("fb");
    // hero aktif muncul juga sebagai row pertama projection dengan state running
    const rows = queueRows(st);
    expect(rows[0]).toMatchObject({ taskId: "t_7", kind: "active", state: "running" });
  });

  test("B2: dua task parked dirender FIFO — urutan array server dipegang persis", () => {
    const rows = queueRows({ activeTask: run("t_1", "A"), parkedTasks: [park("t_2", "B"), park("t_3", "C")] });
    expect(rows.map((r) => r.taskId)).toEqual(["t_1", "t_2", "t_3"]);
    expect(rows.map((r) => r.kind)).toEqual(["active", "parked", "parked"]);
  });

  test("B3: setiap row membawa taskId PERSIS (sumber cancel yang aman)", () => {
    const rows = queueRows({ activeTask: run("t_9", "A"), parkedTasks: [park("t_10", "B")] });
    expect(rows.map((r) => r.taskId)).toEqual(["t_9", "t_10"]);
    // teks & posisi tidak boleh menelan identitas
    expect(rows[1]).toMatchObject({ taskId: "t_10", position: 1, state: "parked" });
  });

  test("B6: posisi dihitung ulang dari array — cancel B membuat C jadi #1", () => {
    const before = queueRows({ activeTask: run("t_1", "A"), parkedTasks: [park("t_2", "B"), park("t_3", "C")] });
    expect(before.filter((r) => r.kind === "parked").map((r) => r.position)).toEqual([1, 2]);
    // /status berikutnya tanpa B (server yang berwenang): proyeksi SUDAH
    // benar — bukan edit lokal
    const after = queueRows({ activeTask: run("t_1", "A"), parkedTasks: [park("t_3", "C")] });
    expect(after.map((r) => r.taskId + "#" + r.position)).toEqual(["t_1#0", "t_3#1"]);
  });

  test("B7: snapshot sama dirender dua kali → identik; input tidak dimutasi", () => {
    const st: St = { activeTask: run("t_1", "A"), parkedTasks: [park("t_2", "B"), park("t_3", "C")] };
    const frozen = JSON.stringify(st);
    const a = queueRows(st);
    const b = queueRows(st);
    expect(b).toEqual(a);
    expect(JSON.stringify(st)).toBe(frozen); // zero side effect
    expect(a === b).toBe(false);             // array baru tiap panggilan — bukan state bersama
  });

  test("B9: active PAUSED (approval) + parked tetap terproyeksi benar", () => {
    const rows = queueRows({ activeTask: pau("t_1", "A"), parkedTasks: [park("t_2", "B"), park("t_3", "C")] });
    expect(rows[0]).toMatchObject({ taskId: "t_1", kind: "active", state: "paused" });
    expect(rows.length).toBe(3);
    // paused BUKAN parked & BUKAN approval card — state eksplisit
    expect(rows[1].state).toBe("parked");
  });

  test("B10: stop/restart status → nol row; section antrean lenyap natural", () => {
    expect(queueRows({ running: false, activeTask: null, parkedTasks: [], queueCount: 0 })).toEqual([]);
    expect(queueRows(null)).toEqual([]);
    expect(queueRows(undefined)).toEqual([]);
    // guard render: section cuman dibuat saat queue non-kosong; empty-state
    // kartu tidak lagiEarly-return bila antrean masih ada
    expect(viewSrc).toMatch(/const hasQueue = !!\(queue && queue\.length\);/);
    expect(viewSrc).toMatch(/if \(hasQueue\) renderQueueSection\(queue as QueueRow\[\]\);/);
    expect(viewSrc).toMatch(/if \(!tsk && !hasPlan && !hasQueue\) \{/);
  });

  test("B8: feedback queued/penuh event tetap transien & terpisah dari state", () => {
    const tk = (k: string, v?: Record<string, string | number>) => k + ":" + JSON.stringify(v || {});
    // event feedback (transcript status) — jalur S4-A utuh
    const q = queuedFeedback(tk, { ok: true, queued: true, taskId: "t_2" } as any);
    expect(q.queued).toBe(true);
    expect(q.msg).toContain("t_2");
    const full = queuedFeedback(tk, { error: "antrean tugas penuh (20) — task terbaru DITOLAK" } as any);
    expect(full.kind).toBe("err");
    expect(full.msg).toContain("DITOLAK");
    // panel TIDAK membuat baris queue dari status line — baris hanya dari
    // proyeksi renderTaskCard (satu-satunya jalur queueRows ke DOM)
    const calls = panelSrc.match(/queueRows\(/g) || [];
    expect(calls.length).toBe(1); // hanya renderTaskCard
  });
});

// ═══ TRANISI / SYNC (B11–B13) ══════════════════════════════════════════
describe("S4-B drain visibility — transisi activeTask memicu syncHistory sekali", () => {
  test("B11: A→B (drain) tanpa stream sendiri → syncHistory", () => {
    expect(shouldSyncOnDrain("t_1", "t_2", false)).toBe(true);
  });

  test("B12: A→idle TIDAK lewat aturan drain (aturan busy→false lama tetap)", () => {
    expect(shouldSyncOnDrain("t_1", "", false)).toBe(false);
    expect(shouldSyncOnDrain("", "", false)).toBe(false);
    // aturan lama masih ada apa adanya di panel
    expect(panelSrc).toMatch(/if \(prevBusy && !st\.busy && !liveAsk\) await syncHistory\(\);/);
  });

  test("B13: same-A berulang tidak pernah fetch; stream hidup tidak memotong SSE sendiri", () => {
    expect(shouldSyncOnDrain("t_1", "t_1", false)).toBe(false);
    expect(shouldSyncOnDrain("t_1", "t_2", true)).toBe(false); // liveAsk milik sendiri → finishLive yang sync
    // wiring-nya satu baris sinkron dengan update prevActiveId tiap poll
    expect(panelSrc).toMatch(/if \(shouldSyncOnDrain\(prevActiveId, curActiveId, !!liveAsk\)\) await syncHistory\(\);\s*\n\s*prevActiveId = curActiveId;/);
  });
});

// ═══ WIRING CANCEL + IDEMPOTENSI DOM (B4, B5, B14–B17) ════════════════
describe("S4-B wiring cancel per-taskId & kebersihan remount (teks asli)", () => {
  test("B4/B5: cancel row mem-target persis taskId-nya; aktif tak bisa dibatalkan dari row", () => {
    // view: tombol HANYA untuk baris parked, menutup persis row.taskId
    expect(viewSrc).toMatch(/if \(row\.kind === "parked" && deps\.onTaskCancel\)/);
    expect(viewSrc).toMatch(/deps\.onTaskCancel\?\.\(row\.taskId\)/);
    // panel: alirkan ke cancelTask(taskId) — body { taskId } hanya bila ada target
    expect(panelSrc).toMatch(/onTaskCancel: \(taskId\) => \{\s*\n\s*void cancelTask\(taskId\);/);
    expect(panelSrc).toMatch(/postJson\(API \+ "\/api\/assistant\/cancel", targetTaskId \? \{ taskId: targetTaskId \} : \{\}\)/);
    // cancel parked TIDAK meng-abort stream aktif (hanya utk no-target/active)
    expect(panelSrc).toMatch(/if \(!targetTaskId \|\| d\.cancelled === "active"\) liveAsk\?\.abort\.abort\(\);/);
    // DALAM cancelTask: tidak ada disable tombol global buta — state tombol
    // mengikuti /status berikutnya (task aktif boleh tetap tersisa)
    const cancelBody = extractFnSrc(panelSrc, "async function cancelTask(");
    expect(cancelBody).not.toMatch(/setCancelEnabled\(false\)/);
    expect(cancelBody).toMatch(/refreshStatus\(\);/);
  });

  test("B14: remount — transcript baru per mount; kartu dibangun ulang penuh tiap snapshot", () => {
    expect(panelSrc).toMatch(/let transcript = new Transcript\(\);/);
    expect(viewSrc).toMatch(/function renderTask\(task: string, plan: PlanItem\[\], queue\?: QueueRow\[\]\): void \{\s*\n\s*taskBox\.textContent = "";/);
    // proyeksi murni tidak menyimpan apa pun antar panggilan (B7 sudah
    // membuktikan equal-by-input; ini menegaskan tidak ada module state baru)
    const s: St = { activeTask: run("t_1", "A"), parkedTasks: [park("t_2", "B")] };
    const one = queueRows(s);
    const two = queueRows(s);
    two[0].text = "DIUBAH"; // memutasi hasil TIDAK boleh menular ke panggilan lain
    expect(queueRows(s)[0].text).toBe("A");
    expect(one[0].text).toBe("A");
  });

  test("B15: PARKED tidak pernah menyentuh jalur chat/AgentBrain", () => {
    expect(viewSrc).not.toMatch(/__agent/);
    // modul proyeksi buta terhadap brain & speak
    const tSrc = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "transcript.ts"), "utf8");
    expect(tSrc).not.toMatch(/__agent|__debugSpeak|__live2dAgent/);
    // queueRows hanya diekspor sebagai proyeksi — tidak ada jalur blok
    // transcript darinya (push lokal rows aman; this.push = blok chat)
    expect(tSrc).toMatch(/export function queueRows/);
    const qBody = tSrc.slice(tSrc.indexOf("export function queueRows"), tSrc.indexOf("export function heroTaskText"));
    expect(qBody).not.toMatch(/this\.push\(|registerMsgKey|msgKeys/);
  });

  test("B16/B17: approval card & cancel global lama utuh", () => {
    // approval tetap blok transcript keyed apId (bukan row queue)
    expect(t_approvalIntact()).toBe(true);
    // tombol global: tanpa target = perilaku lama (accepted/cancelSent + Kasus B)
    expect(panelSrc).toMatch(/const onCancel = \(\) => \{ void cancelTask\(\); \};/);
    expect(panelSrc).toMatch(/t\("as\.cancelSent"\)/);
    // enable button: masih dari status, kini termasuk activeTask (S4-A) — utuh
    expect(panelSrc).toMatch(/setCancelEnabled\(!!st\.running && \(st\.busy \|\| !!liveAsk \|\| !!st\.activeTask\)\);/);
  });

  function t_approvalIntact(): boolean {
    const tSrc = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "transcript.ts"), "utf8");
    return (
      /\{ kind: "approval"; id: number; rev: number; apId: string; tool: string; args: any \}/.test(tSrc) &&
      /reconcileApprovals/.test(tSrc) &&
      /push\(\{ kind: "approval", apId: ev\.id/.test(tSrc)
    );
  }
});
