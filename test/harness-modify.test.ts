/**
 * harness-modify.test.ts — S4-C: MODIFIKASI task worker AKTIF (Option 1
 * terkunci: A' mewarisi posisi pipeline — eksekusi BERIKUTNYA, di depan
 * parked B/C; operasi server-side ATOMIK tanpa await; taskId lama pensiun
 * permanen; parked-modification ditolak eksplisit/deferred).
 *
 * Konvensi test sama persis dengan harness-queue.test.ts (S4-A): facade +
 * loop ASLI in-process, LLM = fetch stub deferred per-turn, workDir tmp,
 * bukti dari STATE setelah titik terminal — tanpa sleep-sebagai-bukti.
 *
 * Invarian terkunci:
 *  M-A  modify(running) = flag kooperatif + A' di KEPALA parked; drain
 *       pertama A' (bukan B) — urutan akhir A → A' → B → C.
 *  M-B  modify(paused) = terminal seketika + klaim A' pada TICK YANG SAMA
 *       (assert SENYAP setelah return, tanpa tick) + approvals.clear.
 *  M-C  id lama mati permanen: cancel stale, approve/deny stale, release
 *       stale — semua no-op terhadap A'.
 *  M-D  A' dieksekusi TEPAT satu kali (hitung prompt stub + thinking_start).
 *  M-E  validasi: id tak dikenal/parked/destroyed/teks kosong/antrean penuh
 *       → tolak eksplisit, ZERO mutation.
 *  M-F  modifikasi tidak menyentuh jalur Companion/otak (server murni).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { makeRuntime, setRuntime, getRuntime } from "../src/server/agent/state";
import {
  assistantAsk,
  assistantCancel,
  assistantModify,
  assistantResolveApproval,
  assistantEvents,
} from "../src/server/assistant";

const repoRoot = resolve(import.meta.dir, "..");
let workDir = mkdtempSync(join(tmpdir(), "harness-modify-"));

// ── Stub LLM deferred (pola harness-queue S4-A) ────────────────────────
type Pending = { body: any; respond: (text: string) => void; fail: () => void };
let pending: Pending[] = [];
const seen: string[] = [];
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
          res({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }), json: async () => ({ choices: [{ message: { content: text } }] }) } as any),
        fail: () =>
          res({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: "stub mati" } }), json: async () => ({ error: { message: "stub mati" } }) } as any),
      };
      const msgs = p.body?.messages || [];
      seen.push(String(msgs[msgs.length - 1]?.content || ""));
      pending.push(p);
    });
  }) as typeof fetch;
}

function makeConfig(): any {
  const conn = { id: "stub", name: "stub", provider: "openai-compatible", baseUrl: "http://llm-stub", apiKey: "k", model: "m" };
  return { load: () => ({ i18n: { lang: "id" } }), connections: [conn], activeConnection: conn, saveConnections: () => {} };
}

const tick = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
async function waitLlm(n: number, maxMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (pending.length < n) {
    await new Promise((r) => setTimeout(r, 5));
    if (Date.now() - t0 > maxMs) throw new Error("timeout menunggu panggilan LLM #" + n);
  }
  await tick();
}
const fresh = () => { const rt = makeRuntime({}, workDir, []); setRuntime(rt); return rt; };
const countSeen = (needle: string) => seen.filter((s) => s.includes(needle)).length;
const writeTool = () => `Simpan dulu.\nTOOL: write_file {"path":"m.txt","content":"x"}`;

beforeEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  workDir = mkdtempSync(join(tmpdir(), "harness-modify-"));
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = origFetch;
  const rt = getRuntime();
  if (rt) rt.destroyed = true;
  setRuntime(null);
  for (const p of pending) { try { p.respond("(sisa)"); } catch {} }
  pending = [];
});
afterAll(() => { try { rmSync(workDir, { recursive: true, force: true }); } catch {} });

// ═══ MODIFY RUNNING (M-A, M-C, M-D) ════════════════════════════════════
describe("S4-C modify task RUNNING — cooperatif + A' di kepala antrean", () => {
  test("M1/M4: modify running → flag + A' parked[0]; A rilis sendiri lalu A' EKSAK satu kali", async () => {
    const rt = fresh();
    const pA = assistantAsk("tugas lama", makeConfig());
    await tick();
    const r = assistantModify({ taskId: "t_1", text: "tugas BARU" }, makeConfig());
    expect(r.ok).toBe(true);
    expect(r.retired).toBe("t_1");
    expect(r.taskId).toBe("t_2");            // M2: id REPLACEMENT baru
    expect(r.state).toBe("pending");
    expect(rt.cancelRequested).toBe(true);    // kooperatif — A belum mati
    expect(rt.activeTask!.taskId).toBe("t_1");// A tetap pemegang slot
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2"]); // A' di KEPALA
    // A menyelesaikan turn in-flight (side effect lama TIDAK di-rewind)
    pending[0].respond("jawaban lama (stale, mungkin lolos)");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");          // drain pertama A'
    await waitLlm(2);
    expect(countSeen("tugas BARU")).toBe(1);            // M-D: tepat satu
    expect(countSeen("tugas lama")).toBe(1);            // A sendiri juga satu
    pending[1].respond("jawaban baru");
    await tick(40);
    expect(rt.activeTask).toBeNull();
    expect(rt.parkedTasks.length).toBe(0);
  });

  test("M3: taskId lama mati permanen — cancel/modify stale no-op terhadap A'", async () => {
    const rt = fresh();
    const pA = assistantAsk("tugas lama", makeConfig());
    await tick();
    assistantModify({ taskId: "t_1", text: "tugas BARU" }, makeConfig());
    pending[0].respond("selesai");
    await pA;
    await waitLlm(2);
    expect(rt.activeTask!.taskId).toBe("t_2");
    const c = assistantCancel({ taskId: "t_1" });       // id pensiun
    expect(c.accepted).toBe(false);
    expect(rt.activeTask!.taskId).toBe("t_2");          // A' tak tersentuh
    const m2 = assistantModify({ taskId: "t_1", text: "hantu" }, makeConfig());
    expect(m2.ok).toBe(false);
    expect(String(m2.error)).toContain("pensiun");
    expect(rt.parkedTasks.length).toBe(0);              // no mutation
    expect(countSeen("hantu")).toBe(0);
    pending[1].respond("jawaban baru");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("M8/M9/M10: A + B,C parked → modify A → urutan EKSAK A' → B → C", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    await assistantAsk("parkedB", makeConfig());
    await assistantAsk("parkedC", makeConfig());
    const r = assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual([r.taskId, "t_2", "t_3"]); // A' DEPAN
    pending[0].respond("selesai-lama");
    await pA;
    expect(rt.activeTask!.taskId).toBe(r.taskId);       // A' dulu, B menunggu
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2", "t_3"]);
    await waitLlm(2);
    expect(seen[1]).toContain("GANTI");                 // urutan prompt: A', lalu B, lalu C
    pending[1].respond("a-prime-done");
    await tick(40);
    expect(rt.activeTask!.taskId).toBe("t_2");
    await waitLlm(3);
    expect(seen[2]).toContain("parkedB");
    pending[2].respond("b-done");
    await tick(40);
    expect(rt.activeTask!.taskId).toBe("t_3");
    await waitLlm(4);
    expect(seen[3]).toContain("parkedC");
    pending[3].respond("c-done");
    await tick(40);
    expect(rt.activeTask).toBeNull();
    expect(countSeen("GANTI")).toBe(1);
  });

  test("M12: modify lalu CANCEL parked A' sebelum A mati → A' pensiun tanpa pernah jalan", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    const r = assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    const c = assistantCancel({ taskId: String(r.taskId) });
    expect(c).toMatchObject({ accepted: true, cancelled: "parked" });
    expect(rt.parkedTasks.length).toBe(0);
    pending[0].respond("selesai-lama");
    await pA;
    expect(rt.activeTask).toBeNull();                   // tak ada yang di-drain
    expect(countSeen("GANTI")).toBe(0);                 // A' tak pernah dieksekusi
  });

  test("M12b: modify lalu cancel(id lama) — flag sama, rilis tetap tunggal", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    const c = assistantCancel({ taskId: "t_1" });        // masih active
    expect(c.accepted).toBe(true);
    pending[0].respond("selesai");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");          // drain A' TEPAT sekali
    await waitLlm(2);
    expect(countSeen("GANTI")).toBe(1);
    pending[1].respond("g");
    await tick(40);
  });
});

// ═══ MODIFY PAUSED (M-B, approvals) ════════════════════════════════════
describe("S4-C modify task APPROVAL-PAUSED — terminal seketika + approvals mati", () => {
  async function toPaused(rt: NonNullable<ReturnType<typeof getRuntime>>) {
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    pending[0].respond(writeTool());
    await pA;
    expect(rt.activeTask!.state).toBe("paused");
    return rt.approvals.keys().next().value as string;
  }

  test("M5/M11: modify paused → A' AKTIF pada TICK yang sama (assert tanpa tick); B tak sempat nyelonong", async () => {
    const rt = fresh();
    await toPaused(rt);
    await assistantAsk("parkedB", makeConfig());
    const r = assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    expect(r.ok).toBe(true);
    expect(r.state).toBe("running");
    // ATOMIK: sesaat setelah return (NO await/tick) slot sudah A' — B masih parked
    expect(rt.activeTask!.taskId).toBe(r.taskId);
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2"]);
    expect(rt.approvals.size).toBe(0);                  // approval lama dimatikan
    await waitLlm(2);                                   // turn A' benar-benar mulai
    expect(countSeen("GANTI")).toBe(1);
    expect(seen[1]).toContain("GANTI");
    pending[1].respond("ganti-done");
    await tick(40);
    expect(rt.activeTask!.taskId).toBe("t_2");          // baru setelah itu B
    await waitLlm(3);
    pending[2].respond("b-done");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });

  test("M6/M7: approve/deny BASI pasca-modify → ditolak; A' dan history tak tersentuh", async () => {
    const rt = fresh();
    const apId = await toPaused(rt);
    const r = assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    await tick();
    const histBefore = rt.history.length;
    const staleA = await assistantResolveApproval(apId, true, makeConfig());
    expect(staleA.ok).toBe(false);
    expect(String(staleA.error)).toContain("tidak ditemukan");
    const staleD = await assistantResolveApproval(apId, false, makeConfig());
    expect(staleD.ok).toBe(false);
    expect(rt.activeTask!.taskId).toBe(r.taskId);
    expect(countSeen("GANTI")).toBe(1);                 // tidak ada eksekusi ganda
    expect(rt.history.length).toBe(histBefore);         // stale resolve tak menulis apa pun
    pending[1].respond("ganti-done");
    await tick(40);
    expect(rt.activeTask).toBeNull();
  });
});

// ═══ VALIDASI / TOLAKAN (M-E) ══════════════════════════════════════════
describe("S4-C validasi — tolak eksplisit, ZERO mutation", () => {
  test("M13: taskId tak dikenal → tolak; state tidak berubah sama sekali", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    const r = assistantModify({ taskId: "t_hantu", text: "X" }, makeConfig());
    expect(r.ok).toBe(false);
    expect(rt.activeTask!.taskId).toBe("t_1");
    expect(rt.parkedTasks.length).toBe(0);
    expect(rt.cancelRequested).toBe(false);
    pending[0].respond("oke");
    await pA;
  });

  test("M17: target task PARKED → ditolak eksplisit (deferred), urutan antrean utuh", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    await assistantAsk("parkedB", makeConfig());
    const r = assistantModify({ taskId: "t_2", text: "X" }, makeConfig());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("AKTIF");
    expect(rt.parkedTasks.map((p) => p.taskId)).toEqual(["t_2"]);
    pending[0].respond("oke");
    await pA;
    await waitLlm(2);
    pending[1].respond("b");
    await tick(40);
  });

  test("M14: teks kosong → tolak; flag/antrean tidak disentuh", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    const r = assistantModify({ taskId: "t_1", text: "   \n " }, makeConfig());
    expect(r.ok).toBe(false);
    expect(rt.cancelRequested).toBe(false);             // A TIDAK dibatalkan diam-diam
    expect(rt.parkedTasks.length).toBe(0);
    pending[0].respond("oke");
    await pA;
  });

  test("M15: runtime mati/destroyed → tolak", async () => {
    const rt = fresh();
    rt.destroyed = true;
    const r = assistantModify({ taskId: "t_1", text: "X" }, makeConfig());
    expect(r.ok).toBe(false);
    setRuntime(null);
    expect(assistantModify({ taskId: "t_1", text: "X" }, makeConfig()).ok).toBe(false);
  });

  test("M18: antrean penuh (20) → modify ditolak TANPA drop senyap, isi utuh", async () => {
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    for (let i = 0; i < 20; i++) await assistantAsk("p" + i, makeConfig());
    const r = assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("penuh");
    expect(rt.parkedTasks.length).toBe(20);
    expect(rt.parkedTasks[0].taskId).toBe("t_2");       // kepala lama utuh
    expect(rt.cancelRequested).toBe(false);
    pending[0].respond("oke");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");          // drain normal B, bukan A'
    rt.parkedTasks.length = 0;
    await waitLlm(2);
    pending[1].respond("p0");
    await tick(40);
  });
});

// ═══ ISOLASI + UI GUARD (M-F) ══════════════════════════════════════════
describe("S4-C isolasi lintas-lane + wiring UI", () => {
  test("M16: modify adalah operasi SERVER murni — tidak butuh window/brain", async () => {
    // test ini berjalan tanpa global window/document sama sekali (bun unit):
    expect((globalThis as any).window).toBeUndefined();
    const rt = fresh();
    const pA = assistantAsk("lama", makeConfig());
    await tick();
    const r = assistantModify({ taskId: "t_1", text: "GANTI" }, makeConfig());
    expect(r.ok).toBe(true);
    pending[0].respond("oke");
    await pA;
    expect(rt.activeTask!.taskId).toBe("t_2");
    await waitLlm(2);
    pending[1].respond("g");
    await tick(40);
    // bus hanya menerima event worker normal (thinking_start A + A')
    const starts = assistantEvents(0).events.filter((e: any) => e.type === "thinking_start");
    expect(starts.slice(-2).map((e: any) => String(e.label)).join("|")).toMatch(/lama.*GANTI|GANTI/s);
  });

  test("M-F guard: modify hanya diekspos utk baris ACTIVE + POST {taskId,text}", () => {
    const viewSrc = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "view.ts"), "utf8");
    expect(viewSrc).toMatch(/if \(row\.kind === "active" && deps\.onTaskModify\)/);
    expect(viewSrc).toMatch(/deps\.onTaskModify\?\.\(row\.taskId\)/);
    const panelSrc = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "panel.ts"), "utf8");
    expect(panelSrc).toMatch(/postJson\(API \+ "\/api\/assistant\/modify", \{ taskId, text: txt \}\)/);
    // prompt dibatalkan user → TIDAK ada request
    expect(panelSrc).toMatch(/if \(text === null\) return;/);
    // tanpa mutasi optimistik: status projection hanya dari refreshStatus
    expect(panelSrc).toMatch(/refreshStatus\(\); \/\/ authoritative projection/);
    // assist server: fungsi modify tidak punya await sama sekali (atomik)
    const asSrc = readFileSync(join(repoRoot, "src", "server", "assistant.ts"), "utf8");
    const body = asSrc.slice(
      asSrc.indexOf("export function assistantModify"),
      asSrc.indexOf("// ── Undo: daftar snapshot"),
    );
    expect(body).not.toMatch(/\bawait\b/);
    expect(body).toMatch(/rt\.parkedTasks\.unshift\(\{ taskId: newId, text: txt \}\)/);
    expect(body).toMatch(/rt\.cancelRequested = true;/);
  });
});
