/**
 * test/agent-undo.test.ts — Snapshot & revert mutasi file agent (undo).
 * Diuji lewat jalur EKSEKUSI sungguhan: makeRuntime dengan workDir folder
 * temp → agentRunApproved (jalur yang sama dengan approval panel/CLI) →
 * isi file di disk dicek → revertUndo → isi kembali seperti semula.
 * Tidak ada jaringan, tidak menyentuh data/ user (workDir = mkdtemp).
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeRuntime, getRuntime, setRuntime } from "../src/server/agent/state";
import { agentRunApproved } from "../src/server/agent/loop";
import { revertUndo, undoList } from "../src/server/agent/undo";

const workDir = mkdtempSync(join(tmpdir(), "agent-undo-"));
const rt = makeRuntime({}, workDir, []);
setRuntime(rt);

afterAll(() => {
  setRuntime(null);
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

describe("undo/revert mutasi file agent", () => {
  it("edit_file pada file lama → snapshot berisi isi asli; revert memulihkan", async () => {
    const rel = "src/a.txt";
    const abs = join(workDir, "src", "a.txt");
    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(abs, "kondisi asli\n", "utf8");

    const res = await agentRunApproved(rt, "edit_file", { path: rel, old: "asli", new: "diubah agent" });
    expect(res).not.toMatch(/^ERROR/);
    expect(readFileSync(abs, "utf8")).toContain("diubah agent");

    const list = undoList(rt);
    expect(list.length).toBe(1);
    expect(list[0].path).toBe("src/a.txt");
    expect(list[0].kind).toBe("modified");

    const msg = revertUndo(rt, list[0].id);
    expect(msg).toContain("Dikembalikan");
    expect(readFileSync(abs, "utf8")).toBe("kondisi asli\n");
  });

  it("write_file pada file BARU → revert menghapus file", async () => {
    const rel = "new/b.txt";
    const abs = join(workDir, "new", "b.txt");

    const res = await agentRunApproved(rt, "write_file", { path: rel, content: "baru" });
    expect(res).not.toMatch(/^ERROR/);
    expect(existsSync(abs)).toBe(true);

    const list = undoList(rt);
    const rec = list.find((u) => u.path === rel)!;
    expect(rec.kind).toBe("created");

    revertUndo(rt, rec.id);
    expect(existsSync(abs)).toBe(false);
  });

  it("delete_file pada file lama → revert mengembalikan isinya", async () => {
    const rel = "c.txt";
    const abs = join(workDir, "c.txt");
    writeFileSync(abs, "jangan hilang", "utf8");

    const res = await agentRunApproved(rt, "delete_file", { path: rel });
    expect(res).not.toMatch(/^ERROR/);
    expect(existsSync(abs)).toBe(false);

    const rec = undoList(rt).find((u) => u.path === rel)!;
    expect(rec.kind).toBe("modified");
    revertUndo(rt, rec.id);
    expect(readFileSync(abs, "utf8")).toBe("jangan hilang");
  });

  it("revert ganda ditolak; id asing 404-ish; path di luar workDir tak tercatat", async () => {
    const rel = "d.txt";
    writeFileSync(join(workDir, rel), "x", "utf8");
    await agentRunApproved(rt, "write_file", { path: rel, content: "y" });
    const rec = undoList(rt).find((u) => u.path === rel)!;

    revertUndo(rt, rec.id);
    expect(() => revertUndo(rt, rec.id)).toThrow(/sudah pernah/);
    expect(() => revertUndo(rt, "un_tidak_ada")).toThrow(/tidak dikenal/);

    // path traversal — tool menolak, snapshot tidak dibuat
    const res = await agentRunApproved(rt, "write_file", { path: "../outside.txt", content: "no" });
    expect(res).toMatch(/^ERROR/);
    expect(undoList(rt).some((u) => u.path.includes("outside.txt"))).toBe(false);
  });

  it("dua mutasi beruntun pada path sama → SATU rekaman (kondisi asli)", async () => {
    const rel = "e.txt";
    writeFileSync(join(workDir, rel), "asli-e", "utf8");
    await agentRunApproved(rt, "write_file", { path: rel, content: "v1" });
    await agentRunApproved(rt, "write_file", { path: rel, content: "v2" });

    const recs = undoList(rt).filter((u) => u.path === rel);
    expect(recs.length).toBe(1);

    revertUndo(rt, recs[0].id);
    expect(readFileSync(join(workDir, rel), "utf8")).toBe("asli-e");
  });

  it("cap MAX_UNDO: rekaman terlama dibuang (FIFO)", async () => {
    const rt2 = makeRuntime({}, workDir, []);
    for (let i = 0; i < 25; i++) {
      await agentRunApproved(rt2, "write_file", { path: "cap/f" + i + ".txt", content: "x" + i });
    }
    expect(rt2.undo.length).toBe(20);
    expect(rt2.undo[0].relPath).toBe("cap/f5.txt"); // f0..f4 terbuang
    setRuntime(null);
  });
});
