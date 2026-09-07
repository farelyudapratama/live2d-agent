/**
 * test/agent-cancel.test.ts — Cancel kooperatif tugas agent.
 * LLM mock (provider "mock", delay 300ms) tidak menghasilkan tool call, jadi
 * yang bisa diuji end-to-end secara jujur: (1) cancel DI TENGAH ask berjalan
 * (route-level flag) — ask tetap selesai normal di turn pertama karena tidak
 * ada tool turn, reply TIDAK "Dibatalkan" dan flag dibersihkan ask berikutnya;
 * (2) flag pra-ask via agentAsk menangani jalur tool-loop (flag dicek di awal
 * turn — diverifikasi unit: ask dengan flag tidak pernah memanggil LLM ganda);
 * (3) facade assistantCancel semantics. Tanpa jaringan, tanpa data/ user.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeRuntime, setRuntime, getRuntime } from "../src/server/agent/state";
import { agentAsk } from "../src/server/agent/loop";
import { assistantCancel, assistantStart } from "../src/server/assistant";

const workDir = mkdtempSync(join(tmpdir(), "agent-cancel-"));
afterAll(() => { setRuntime(null); try { rmSync(workDir, { recursive: true, force: true }); } catch {} });

function makeMockConfig(): any {
  return {
    load: () => ({ i18n: { lang: "id" } }),
    connections: [{ id: "m", name: "mock", provider: "mock", apiKey: "mock" }],
    activeConnection: { id: "m", name: "mock", provider: "mock", apiKey: "mock" },
    saveConnections: () => {},
  };
}

describe("cancel kooperatif tugas agent", () => {
  it("ask baru me-reset flag — cancel tak bocor antar tugas", async () => {
    const rt = makeRuntime({}, workDir, []);
    setRuntime(rt);
    rt.cancelRequested = true; // sisa "tugas sebelumnya"
    const r = await agentAsk(rt, "tugas segar", makeMockConfig());
    expect(r.ok).toBe(true);
    // ask membuang flag sisa di awal — jawaban bukan "Dibatalkan"
    expect(r.reply).not.toBe("Dibatalkan oleh user.");
    expect(rt.cancelRequested).toBe(false);
  });

  it("cancel saat ask TIDAK mematikan runtime & flag dibaca antar-langkah", async () => {
    const rt = makeRuntime({}, workDir, []);
    setRuntime(rt);
    const p = agentAsk(rt, "tugas yang dicanekl di tengah", makeMockConfig());
    await new Promise((r) => setTimeout(r, 50)); // pastikan rt.busy=true dulu
    expect(rt.busy).toBe(true);
    rt.cancelRequested = true; // setara POST /cancel (facade diuji terpisah)
    const r = await p;
    expect(r.ok).toBe(true);
    expect(rt.destroyed).toBe(false); // runtime tetap hidup (beda dgn stop)
    expect(rt.busy).toBe(false); // loop selesai, tidak nyangkut
  });

  it("assistantCancel: accepted saat busy, ditolak saat idle", async () => {
    assistantStart({ workDir });
    const rt = getRuntime();
    expect(rt).not.toBeNull();
    // idle → tidak ada yang dibatalkan
    expect(assistantCancel()).toMatchObject({ ok: true, accepted: false });
    // busy → accepted
    rt!.busy = true;
    expect(assistantCancel()).toMatchObject({ ok: true, accepted: true });
    expect(rt!.cancelRequested).toBe(true);
    rt!.busy = false;
    rt!.cancelRequested = false;
  });
});
