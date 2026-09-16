/**
 * harness-queue.test.ts — S4-A: worker TASK IDENTITY + PARK/QUEUE +
 * invariant ACTIVE/PAUSED + cancel task-aware + reset-while-busy guard.
 *
 * Yang diuji = fungsi ASLI facade (assistant.ts) + loop (loop.ts) dijalankan
 * in-process — bukan salinan. Batas jaringan (LLM) distub pada fetch dengan
 * DEFERRED manual per-turn: test mengontrol KAPAN tiap turn selesai, jadi
 * bukti deterministik diambil dari STATE SETELAH titik terminal (promise
 * yang di-await), bukan dari sleep. waitLlm() hanya pompa penjadwal untuk
 * melewati macrotask fs (eksekusi tool nyata di tmp dir), bukan bukti.
 *
 * Invarian terkunci (Behavior Contract S4-A):
 *  I1/I2  satu task active ATAU paused memegang runtime
 *  I3/I4  PARK FIFO cap 20; I5 overflow buang-TERBARU + feedback eksplisit
 *  I6/I7  completion/cancel basi tak bisa melepas atau men-drain milik lain
 *  I8     reset tidak memutasi history saat task memegang slot
 *  I9/I10 cancel parked ≠ sentuh active; cancel active ≠ batalkan antrean
 *  I11    approval pause tidak pernah mengizinkan eksekusi paralel
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { makeRuntime, setRuntime, getRuntime } from "../src/server/agent/state";
import {
  assistantAsk,
  assistantCancel,
  assistantReset,
  assistantStatus,
  assistantResolveApproval,
  assistantSessionCreate,
  assistantSessionSwitch,
  assistantEvents,
} from "../src/server/assistant";
import { queuedFeedback } from "../src/client/agent/panel/transcript";

const repoRoot = resolve(import.meta.dir, "..");
let workDir = mkdtempSync(join(tmpdir(), "harness-queue-"));

// ── Stub LLM: fetch → deferred per turn ─────────────────────────────────
type Pending = {
  body: any;
  respond: (text: string) => void;
  fail: () => void;
};
let pending: Pending[] = [];
const seen: string[] = []; // SEMUA prompt yang pernah keluar (dibuktikan "tepat sekali")
const origFetch = globalThis.fetch;

function stubFetch() {
  pending = [];
  seen.length = 0;
  globalThis.fetch = ((url: any, opts: any) => {
    if (!String(url).startsWith("http://llm-stub")) return origFetch(url as any, opts as any);
    return new Promise((res) => {
      const p: Pending = {
        body: JSON.parse(String((opts as any)?.body || "{}")),
        respond: (text: string) =>
          res({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
            json: async () => ({ choices: [{ message: { content: text } }] }),
          } as any),
        fail: () =>
          res({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ error: { message: "stub mati" } }),
            json: async () => ({ error: { message: "stub mati" } }),
          } as any),
      };
      const msgs = p.body?.messages || [];
      seen.push(String(msgs[msgs.length - 1]?.content || ""));
      pending.push(p);
    });
  }) as typeof fetch;
}

function makeConfig(): any {
  const conn = { id: "stub", name: "stub", provider: "openai-compatible", baseUrl: "http://llm-stub", apiKey: "k", model: "m" };
  return {
    load: () => ({ i18n: { lang: "id" } }),
    connections: [conn],
    activeConnection: conn,
    saveConnections: () => {},
  };
}

const tick = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
/** Pompa macrotask (eksekusi fs tool nyata) SAMPAI observasi tercapai —
 *  batas waktu hanya jaring keselamatan; bukti tetap assertion state. */
async function waitLlm(n: number, maxMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (pending.length < n) {
    await new Promise((r) => setTimeout(r, 5));
    if (Date.now() - t0 > maxMs) throw new Error("timeout menunggu panggilan LLM #" + n);
  }
  await tick();
}
const fresh = () => { const rt = makeRuntime({}, workDir, []); setRuntime(rt); return rt; };
/** prompt call ke-i */
const promptOf = (i: number) => String((pending[i]?.body?.messages || []).slice(-1)[0]?.content || "");
const countSeen = (needle: string) => seen.filter((s) => s.includes(needle)).length;

beforeEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  workDir = mkdtempSync(join(tmpdir(), "harness-queue-"));
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = origFetch;
  const rt = getRuntime();
  if (rt) rt.destroyed = true; // sisa async yang dibangunkan di bawah: no-op aman
  setRuntime(null);
  for (const p of pending) { try { p.respond("(sisa dibersihkan)"); } catch {} }
  pending = [];
});
afterAll(() => { try { rmSync(workDir, { recursive: true, force: true }); } catch {} });

const writeTool = (path = "a.txt") =>
  `Saya akan simpan.\nTOOL: write_file {"path":"${path}","content":"isi-tes"}`;

/** Jalankan A satu turn lalu biarkan loop berhenti di permission gate. */
async function startPausedA(rt: NonNullable<ReturnType<typeof getRuntime>>) {
  const pA = assistantAsk("kerjakan A", makeConfig());
  await tick();
  pending[0].respond(writeTool());
  const r = await pA;
  expect(r.ok).toBe(true);
  expect(rt.activeTask!.state).toBe("paused");
  expect(rt.busy).toBe(false); // loop STOP — ownership lewat activeTask
  return r;
}

// ═══ T1–T7: identitas + park + drain ═══════════════════════════════════
describe("S4-A task identity + PARK FIFO", () => {
  test("T1: task pertama menerima taskId unik, melekat di hasil & state", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    expect(pending.length).toBe(1);
    expect(promptOf(0)).toContain("kerjakan A");
    pending[0].respond("selesai A");
    const rA = await pA;
    expect(rA.ok).toBe(true);
    expect(rA.taskId).toBe("t_1");
    expect(rt.activeTask).toBeNull();
  });

  test("T2: task kedua saat A berjalan di-PARK, BUKAN ditolak/dijalankan", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    const rB = await assistantAsk("tugas B", makeConfig());
    expect(rB.queued).toBe(true);
    expect(rB.taskId).toBe("t_2");
    expect(rB.position).toBe(1);
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2"]);
    expect(rt.activeTask!.taskId).toBe("t_1");
    expect(countSeen("tugas B")).toBe(0);                 // B TIDAK pernah jadi prompt
    pending[0].respond("selesai A");
    await pA;
  });

  test("T3: B dan C PARK tetap FIFO — jalan berurutan B lalu C", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    await assistantAsk("tugas B", makeConfig());
    await assistantAsk("tugas C", makeConfig());
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2", "t_3"]);
    pending[0].respond("selesai A");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");
    await waitLlm(2);
    expect(promptOf(1)).toContain("tugas B");
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask!.taskId).toBe("t_3");
    await waitLlm(3);
    expect(countSeen("tugas C")).toBe(1);
    pending[2].respond("selesai C");
    await tick(40);
    expect(rt.activeTask).toBeNull();
    expect(rt.parkedTasks.length).toBe(0);
  });

  test("T4: antrean penuh → task TERBARU ditolak dengan feedback, isi antrean utuh", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    for (let i = 0; i < 20; i++) {
      const r = await assistantAsk("park-" + i, makeConfig());
      expect(r.queued).toBe(true);
    }
    expect(rt.parkedTasks.length).toBe(20);
    const over = await assistantAsk("park-21", makeConfig());
    expect(over.ok).toBe(false);
    expect(String(over.error)).toContain("penuh");
    expect(rt.parkedTasks.length).toBe(20);               // tidak bermutasi
    expect(rt.parkedTasks[0].taskId).toBe("t_2");
    expect(rt.parkedTasks.some((p) => p.text === "park-21")).toBe(false);
    expect(countSeen("park-21")).toBe(0);                 // dan tidak pernah dijalankan
    pending[0].respond("selesai A");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");            // FIFO head yang jalan
    rt.parkedTasks.length = 0;                            // hygiene — uji drain tunggal di sini
    pending[1].respond("selesai t2");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("T5: A selesai → B mulai TEPAT SATU KALI (drain tunggal)", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    await assistantAsk("tugas B", makeConfig());
    pending[0].respond("selesai A");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");
    await waitLlm(2);
    expect(countSeen("tugas B")).toBe(1);                 // tepat satu prompt B
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("T6: A ERROR → slot terminal, drain lanjut tepat sekali per task (tanpa deadlock)", async () => {
    const rt = fresh();
    const cfg = makeConfig();
    const seq0 = assistantEvents(0).events.slice(-1)[0]?.seq ?? 0;
    const pA = assistantAsk("kerjakan A", cfg);
    await tick();
    await assistantAsk("tugas B", cfg);
    await assistantAsk("tugas C", cfg);
    pending[0].fail();
    const rA = await pA;
    expect(rA.ok).toBe(false);
    // Error provider → client memasang cooldown fallback (classifyError SELALU
    // shouldFallback) — B/C bisa gagal cepat SEBELUM fetch. Yang dibuktikan
    // di sini: rantai drain TEPAT SATU KALI per task (thinking_start via bus)
    // dan antrean KERING tanpa deadlock / tanpa retry loop.
    await tick(80);
    const labels = assistantEvents(0).events
      .filter((e: any) => e.seq > seq0 && e.type === "thinking_start")
      .map((e: any) => String(e.label));
    expect(labels.filter((l: string) => l.includes("tugas B")).length).toBe(1);
    expect(labels.filter((l: string) => l.includes("tugas C")).length).toBe(1);
    expect(rt.parkedTasks.length).toBe(0);
    expect(rt.activeTask).toBeNull();
    expect(rt.busy).toBe(false);
  });

  test("T7: cancel active → flag kooperatif; A terminal → B mulai (drain tak terganggu)", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    await assistantAsk("tugas B", makeConfig());
    const c = assistantCancel();
    expect(c).toMatchObject({ ok: true, accepted: true, cancelled: "active" });
    expect(rt.cancelRequested).toBe(true);                // kooperatif: flag, bukan kill
    pending[0].respond("selesai A");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");
    await waitLlm(2);
    expect(countSeen("tugas B")).toBe(1);
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });
});

// ═══ T8–T13: approval ownership + cancel tertarget ═════════════════════
describe("S4-A approval ownership + task-aware cancel", () => {
  test("T8: cancel PARKED B hanya membuang B — active paused utuh (I9)", async () => {
    const rt = fresh();
    await startPausedA(rt);
    await assistantAsk("tugas B", makeConfig());
    await assistantAsk("tugas C", makeConfig());
    const c = assistantCancel({ taskId: "t_2" });
    expect(c).toMatchObject({ ok: true, accepted: true, cancelled: "parked" });
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_3"]);
    expect(rt.activeTask!.taskId).toBe("t_1");            // paused tak tersentuh
    expect(rt.activeTask!.state).toBe("paused");
    const bad = assistantCancel({ taskId: "t_99" });      // target salah: jangan sentuh apa pun
    expect(bad.accepted).toBe(false);
    expect(rt.activeTask!.taskId).toBe("t_1");
    expect(rt.parkedTasks.length).toBe(1);
    const cA = assistantCancel();                          // bereskan: A terminal, C lanjut
    expect(cA).toMatchObject({ accepted: true, cancelled: "active" });
    expect(rt.activeTask!.taskId).toBe("t_3");
    await waitLlm(2);
    pending[1].respond("selesai C");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("T9: cancel ACTIVE (paused) tidak membatalkan antrean (I10) — B mulai, C antre", async () => {
    const rt = fresh();
    await startPausedA(rt);
    await assistantAsk("tugas B", makeConfig());
    await assistantAsk("tugas C", makeConfig());
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2", "t_3"]);
    const c = assistantCancel();                           // tanpa target → aktif
    expect(c).toMatchObject({ accepted: true, cancelled: "active" });
    expect(rt.approvals.size).toBe(0);                     // approval mati — celah resume basi tertutup
    expect(rt.activeTask!.taskId).toBe("t_2");             // B keluar antrean → aktif
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_3"]); // C TETAP antre
    await waitLlm(2);
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask!.taskId).toBe("t_3");
    await waitLlm(3);
    pending[2].respond("selesai C");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("T10: approval PAUSE mempertahankan kepemilikan — task baru PARK, bukan paralel (I11)", async () => {
    const rt = fresh();
    await startPausedA(rt);
    const rB = await assistantAsk("tugas B", makeConfig());
    expect(rB.queued).toBe(true);                          // bukan DITOLAK, bukan jalan
    expect(rt.activeTask!.taskId).toBe("t_1");             // A tetap pemilik
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2"]);
    expect(countSeen("tugas B")).toBe(0);                  // B tidak pernah dieksekusi
    expect(pending.length).toBe(1);                        // hanya turn A yang pernah keluar
  });

  test("T11: paused + B,C → approve melanjutkan A sekali, lalu FIFO B→C", async () => {
    const rt = fresh();
    await startPausedA(rt);
    await assistantAsk("tugas B", makeConfig());
    await assistantAsk("tugas C", makeConfig());
    const apId = rt.approvals.keys().next().value as string;
    const rP = assistantResolveApproval(apId, true, makeConfig());
    await waitLlm(2);                                      // kelanjutan "Lanjutkan…"
    expect(countSeen("Lanjutkan")).toBe(1);                // tanpa mengulang turn A
    pending[1].respond("selesai A");
    const rr = await rP;
    expect(rr.ok).toBe(true);
    expect(existsSync(join(workDir, "a.txt"))).toBe(true); // tool berjalan SATU kali
    expect(rt.undo.length).toBe(1);
    expect(rt.activeTask!.taskId).toBe("t_2");             // drain B
    await waitLlm(3);
    pending[2].respond("selesai B");
    await tick(40);
    expect(rt.activeTask!.taskId).toBe("t_3");             // lalu C
    await waitLlm(4);
    pending[3].respond("selesai C");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("T12: approve menjalankan tool TANPA duplikasi eksekusi", async () => {
    const rt = fresh();
    await startPausedA(rt);
    const apId = rt.approvals.keys().next().value as string;
    const rP = assistantResolveApproval(apId, true, makeConfig());
    await waitLlm(2);
    pending[1].respond("selesai A final");
    const rr = await rP;
    expect(rr.ok).toBe(true);
    // write_file dieksekusi HANYA oleh agentRunApproved → satu undo, satu file
    expect(rt.undo.length).toBe(1);
    expect(readFileSync(join(workDir, "a.txt"), "utf8")).toBe("isi-tes");
    expect(rt.activeTask).toBeNull();
    expect(rt.parkedTasks.length).toBe(0);
  });

  test("T13: DENY A = terminal → B mulai; tool tidak pernah jalan", async () => {
    const rt = fresh();
    await startPausedA(rt);
    await assistantAsk("tugas B", makeConfig());
    const apId = rt.approvals.keys().next().value as string;
    const r = await assistantResolveApproval(apId, false, makeConfig());
    expect(r.ok).toBe(true);
    expect(String(r.reply)).toContain("Ditolak");
    expect(existsSync(join(workDir, "a.txt"))).toBe(false); // write TIDAK pernah dieksekusi
    expect(rt.activeTask!.taskId).toBe("t_2");              // deny merampungkan A → B mulai
    await waitLlm(2);
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });
});

// ═══ T14–T18: reset guard, stale, status ═══════════════════════════════
describe("S4-A reset guard + stale safety + /status", () => {
  test("T14: reset saat RUNNING ditolak — history tidak tersentuh (I8)", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    const before = rt.history.length;
    const r = assistantReset();
    expect(r).toMatchObject({ ok: false, accepted: false });
    expect(String(r.error)).toContain("ditolak");
    expect(rt.history.length).toBe(before);                // TIDAK dibersihkan
    pending[0].respond("selesai A");
    await pA;
    expect(assistantReset().ok).toBe(true);                // idle → boleh
    expect(rt.history.length).toBe(0);
  });

  test("T15: reset saat APPROVAL-PAUSED ditolak — ownership melindungi history", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    pending[0].respond(writeTool("b.txt"));
    await pA;
    expect(rt.activeTask!.state).toBe("paused");
    const before = rt.history.length;
    const r = assistantReset();
    expect(r.ok).toBe(false);
    expect(rt.history.length).toBe(before);
    expect(rt.activeTask!.taskId).toBe("t_1");             // cancel bukan efek samping reset
    assistantCancel();
    expect(rt.activeTask).toBeNull();
  });

  test("T16: resume BASI pasca-cancel tidak menyentuh task berikutnya (I6)", async () => {
    const rt = fresh();
    await startPausedA(rt);
    await assistantAsk("tugas B", makeConfig());
    const apId = rt.approvals.keys().next().value as string;
    assistantCancel();                                      // A terminal seketika, B mulai
    expect(rt.activeTask!.taskId).toBe("t_2");
    const stale = await assistantResolveApproval(apId, true, makeConfig());
    expect(stale.ok).toBe(false);                           // approval sudah dimatikan
    expect(String(stale.error)).toContain("tidak ditemukan");
    expect(rt.activeTask!.taskId).toBe("t_2");              // B utuh
    await waitLlm(2);
    expect(countSeen("tugas B")).toBe(1);                   // drain tidak terjadi dua kali
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("T17: cancel BASI task lama tidak melepas/men-drain milik task lain", async () => {
    const rt = fresh();
    await startPausedA(rt);
    await assistantAsk("tugas B", makeConfig());
    assistantCancel();                                      // cancel t_1 paused → B aktif
    const parkedBefore = rt.parkedTasks.length;
    const again = assistantCancel({ taskId: "t_1" });       // t_1 sudah mati — no-op
    expect(again.accepted).toBe(false);
    expect(rt.activeTask!.taskId).toBe("t_2");              // tidak dilepas
    expect(rt.parkedTasks.length).toBe(parkedBefore);       // tidak di-drain lagi
    await waitLlm(2);
    expect(countSeen("tugas B")).toBe(1);                   // tetap satu eksekusi
    pending[1].respond("selesai B");
    await tick(40);
  });

  test("T18: /status mengekspos active (state) + parked list + queueCount", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    await assistantAsk("tugas B", makeConfig());
    let st = assistantStatus();
    expect(st.activeTask).toMatchObject({ taskId: "t_1", state: "running" });
    expect(st.parkedTasks.map((p: any) => p.taskId)).toEqual(["t_2"]);
    expect(st.queueCount).toBe(1);
    expect(st.busy).toBe(true);
    // varian paused: busy LEPAS tapi activeTask tetap terlihat (I2 di API)
    pending[0].respond(writeTool("c.txt"));
    await pA;
    st = assistantStatus();
    expect(st.busy).toBe(false);
    expect(st.activeTask).toMatchObject({ taskId: "t_1", state: "paused" });
    expect(st.parkedTasks.length).toBe(1);
    assistantCancel();
    await waitLlm(2);
    pending[1].respond("selesai B");
    await tick(40);
    st = assistantStatus();
    expect(st.activeTask).toBeNull();
    expect(st.queueCount).toBe(0);
  });
});

// ═══ T19–T21: regresi perilaku lama ════════════════════════════════════
describe("S4-A regresi kontrak lama (T19/T20/T21)", () => {
  test("T19: jalur task tunggal lama utuh — ok + reply + speak + history", async () => {
    const rt = fresh();
    rt.persona = ""; // ≤240 char → speak = clean tanpa narrator
    const pA = assistantAsk("halo satu", makeConfig());
    await tick();
    pending[0].respond("jawaban akhir satu");
    const r = await pA;
    expect(r.ok).toBe(true);
    expect(r.reply).toContain("jawaban akhir satu");
    expect(r.speak).toBeTruthy();
    expect(r.taskId).toBe("t_1");
    expect(rt.activeTask).toBeNull();
    expect(rt.history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("T20: semantik cancel lama — idle ditolak, busy manual diterima (flag)", async () => {
    const rt = fresh();
    expect(assistantCancel()).toMatchObject({ ok: true, accepted: false });
    rt.busy = true; // keadaan manual test lama (agent-cancel) — tetap dihormati
    expect(assistantCancel()).toMatchObject({ ok: true, accepted: true, cancelled: "active" });
    expect(rt.cancelRequested).toBe(true);
    rt.busy = false;
    rt.cancelRequested = false;
  });

  test("T21: operasi sesi blokir saat ada task/park dan lolos setelah bersih", async () => {
    const rt = fresh();
    const pA = assistantAsk("kerjakan A", makeConfig());
    await tick();
    await assistantAsk("tugas B", makeConfig());            // parked → guard sesi
    expect(assistantSessionCreate(workDir).ok).toBe(false);
    expect(assistantSessionSwitch("s_tidak_ada").error).toBe("masih memproses pertanyaan sebelumnya");
    pending[0].respond("selesai A");
    await pA;
    await waitLlm(2);
    pending[1].respond("selesai B");
    await tick(40);
    expect(rt.activeTask).toBeNull();
    expect(rt.parkedTasks.length).toBe(0);
    // setelah bersih: guard tidak menghalangi lagi (error store ≠ error busy)
    expect(assistantSessionSwitch("s_tidak_ada").error).toBe("sesi tidak ditemukan");
  });
});

// ═══ T22: feedback panel ═══════════════════════════════════════════════
describe("S4-A feedback panel (queuedFeedback + wiring source)", () => {
  const tk = (k: string, v?: Record<string, string | number>) => k + ":" + JSON.stringify(v || {});

  test("T22a: helper mapping — queued → pesan #id; error → ✗; biasa → diam", () => {
    const q = queuedFeedback(tk, { ok: true, queued: true, taskId: "t_5" } as any);
    expect(q.queued).toBe(true);
    expect(q.msg).toContain("as.queued");
    expect(q.msg).toContain("t_5");
    expect(q.kind).toBe("ok");
    const e = queuedFeedback(tk, { error: "antrean penuh" } as any);
    expect(e.kind).toBe("err");
    expect(e.msg).toContain("antrean penuh");
    const n = queuedFeedback(tk, { ok: true, reply: "x" } as any);
    expect(n.msg).toBe("");
    expect(queuedFeedback(tk, null).msg).toBe("");
  });

  test("T22b: panel mengantar task kedua ke ask non-stream + menampil-kan queued (source)", () => {
    const panel = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "panel.ts"), "utf8");
    expect(panel).toMatch(/if \(liveAsk\) \{[\s\S]{0,360}postJson\(API \+ "\/api\/assistant\/ask", \{ text: txt \}\)/);
    expect(panel).toMatch(/queuedFeedback\(t, d\)/);
    // feedback queued juga untuk jalur SSE-done dan fallback non-stream
    expect(panel).toMatch(/type === "done" && \(ev as any\)\.queued/);
    expect(panel).toMatch(/else if \(d\.queued\) \{/);
    // guard reset: hasil !ok TIDAK menghapus transcript lokal
    expect(panel).toMatch(/d && d\.ok === false/);
    // tombol cancel menghormati task paused (activeTask di status)
    expect(panel).toMatch(/st\.busy \|\| !!liveAsk \|\| !!st\.activeTask/);
    // composer TIDAK lagi dilumpuhkan selama stream sendiri — kunci lama hilang
    expect(panel).not.toMatch(/setInputEnabled/);
  });

  test("T22c: kamus id/en memuat kunci antrean dengan placeholder sama", async () => {
    const { DICT_ID } = await import("../src/client/i18n/dict-id");
    const { DICT_EN } = await import("../src/client/i18n/dict-en");
    expect(DICT_ID["as.queued"]).toContain("{id}");
    expect(DICT_EN["as.queued"]).toContain("{id}");
    expect(DICT_ID["as.queueInfo"]).toContain("{n}");
    expect(DICT_EN["as.queueInfo"]).toContain("{n}");
  });
});
