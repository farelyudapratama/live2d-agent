/**
 * direct-write-guard.test.ts — Phase 13 STAGE 0: guard static anti-bypass.
 *
 * Mencegah writer BARU menulis core Cubism diam-diam. Semua tulisan parameter
 * baru wajib lewat Parameter Arbiter → ParameterApi (single commit point).
 *
 * Baseline app.js dibekukan: daftar baris tulis-langsung yang ADA hari ini
 * (writer legacy yang belum dimigrasi — Phase 13 Stage 1+) + jumlah total.
 * Menambah baris tulis baru, mengedit baris legacy, atau menghapus tanpa
 * mencatat = test merah → wajib update sadar di file ini.
 *
 * Modul arbiter sendiri dilarang memuat token setter core apa pun.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const WRITE_RE = /setParameterValueById|setParameterValueByIndex|setPartOpacityById/g;

// Baseline tulis-langsung LEGACY di app.js (audit final Phase 13 Stage 4 —
// setiap baris dikategorikan; DILARANG menambah pola baru — writer baru
// wajib lewat arbiter → ParameterApi):
//   [F-guard]   254/255, 311/312, 335 — fallback legacy guard tanpa arbiter
//               (harness vm test-override-guard + bundle lama; jalur runtime
//               ber-arbiter tidak pernah menyentuhnya)
//   [F-legacy]  213 — pokeParam wrapper: fallback tanpa link untuk
//               pokeActual (restore/reset); runtime selalu link-first
//   [F-legacy]  6961, 6983, 7005 — fallback tanpa link di keluarga rawDrive
//               (applyRawDrive/restore — semantik restore Stage 1)
//   [PART]      6725, 6854, 7103 — setPartOpacityById: DOMAIN PART (bukan
//               parameter) — di luar domain ParameterApi/Arbiter, tulis
//               core sah untuk part opacity
const APP_BASELINE_LINES = [
  "cm.setParameterValueById(id, o.value, o.weight);",
  "cm.setParameterValueById(id, v, 1);",
  "cm.setParameterValueById(id, value, weight === undefined ? 1 : weight);",
  "cm.setPartOpacityById(id, Math.max(0, Math.min(1, v)));",
  "cm.setPartOpacityById(id, clamped);",
  "cm.setPartOpacityById(id, v);",
  "else cm.setParameterValueById(id, o, 1);",
  "else if (cm) cm.setParameterValueById(id, prev[id], 1);",
  "if (cm) cm.setParameterValueById(id, state.rawDrivePrev[id], 1);",
];
const APP_BASELINE_COUNT = 12;

function writeLines(path: string): { total: number; distinct: string[] } {
  const src = readFileSync(join(repoRoot, path), "utf8");
  const lines = [...src.matchAll(WRITE_RE)].map((m) => {
    const start = src.lastIndexOf("\n", m.index!) + 1;
    const end = src.indexOf("\n", m.index!);
    return src.slice(start, end === -1 ? undefined : end).trim();
  });
  return { total: lines.length, distinct: [...new Set(lines)].sort() };
}

describe("guard direct parameter write (anti-bypass arbiter)", () => {
  test("app.js: jumlah tulis-langsung tidak bertambah dari baseline legacy", () => {
    const { total } = writeLines("static/js/app.js");
    expect(total).toBe(APP_BASELINE_COUNT);
  });

  test("app.js: setiap baris tulis-langsung ada di baseline tercatat", () => {
    const { distinct } = writeLines("static/js/app.js");
    const unknown = distinct.filter((l) => !APP_BASELINE_LINES.includes(l));
    expect(unknown).toEqual([]);
  });

  test("parameter-arbiter.ts bebas setter core — komit hanya lewat backing", () => {
    const src = readFileSync(join(repoRoot, "src/client/engine/parameter-arbiter.ts"), "utf8");
    expect(src.match(WRITE_RE)).toBeNull();
  });

  test("role-parameter-bridge.ts: tulis inti hanya di backing toleran (jalur kanonik)", () => {
    const src = readFileSync(join(repoRoot, "src/client/engine/role-parameter-bridge.ts"), "utf8");
    const lines = [...src.matchAll(WRITE_RE)].map((m) => {
      const start = src.lastIndexOf("\n", m.index!) + 1;
      const end = src.indexOf("\n", m.index!);
      return src.slice(start, end === -1 ? undefined : end).trim();
    });
    // baris kode tulis inti hanya dua bentuk ini (framework 5.3 via indeks;
    // setParameterValueById hanya fallback legacy string-id di backing sama).
    // Baris guard `if (typeof ...)` bukan tulisan — hanya baris yang berakhir
    // panggilan statement yang dihitung.
    const codeWrites = lines.filter(
      (l) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("setParameterValueBy") && l.endsWith(");"),
    );
    expect(codeWrites.sort()).toEqual([
      "cm.setParameterValueById(id, value, 1);",
      "src.setParameterValueByIndex(i, value, 1);",
    ]);
  });
});
