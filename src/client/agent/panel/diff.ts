/**
 * client/agent/panel/diff.ts — Kalkulasi diff file di sisi client (murni,
 * tanpa DOM/jaringan — diuji langsung dengan bun test).
 *
 * Sumber data: argumen tool mutasi file yang SUDAH lewat SSE
 * (`write_file{path,content}`, `edit_file{path,old,new}`,
 * `delete_file{path}`) — jadi panel bisa menampilkan diff ala coding-agent
 * ("3 files changed +42 −6") tanpa perubahan server sama sekali.
 *
 * Algoritma: trim prefix/suffix baris yang sama → LCS DP di sisaannya
 * (cap 1000 baris per sisi; di luar cap → stat saja tanpa hunks, `clipped`).
 */

export type DiffRow = { t: "add" | "del" | "ctx"; text: string };

export type DiffHunk = {
  /** Baris 1-based di teks lama tempat hunk mulai (konteks dihitung). */
  aStart: number;
  /** Baris 1-based di teks baru tempat hunk mulai. */
  bStart: number;
  rows: DiffRow[];
};

export type FileChange = {
  path: string;
  kind: "write" | "edit" | "delete";
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** true = hunks tidak lengkap (file terlalu besar / info tak tersedia). */
  clipped: boolean;
};

/** Cap LCS: di atas ini diff hanya stat (mencegah DP raksasa di UI thread). */
const CAP_LINES = 1000;
/** Baris konteks di sekitar perubahan per hunk. */
const CTX = 2;
/** Gap baris konteks antar dua gugus perubahan agar tetap satu hunk. */
const MERGE_CTX = 4;
/** Cap baris yang dirender per diff (diterapkan pemanggil, dihitung di sini). */
export const MAX_RENDER_ROWS = 400;

type Op = { t: "add" | "del" | "ctx"; text: string };

/** Edit script berurutan (ctx/add/del) dari dua deret baris sisa. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const below = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j]
        ? dp[below + j + 1] + 1
        : Math.max(dp[below + j], dp[row + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "ctx", text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: "del", text: a[i] }); i++; }
    else { ops.push({ t: "add", text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: "del", text: a[i++] }); }
  while (j < m) { ops.push({ t: "add", text: b[j++] }); }
  return ops;
}

/** Kelompokkan ops jadi hunks berkonteks + hitung stat. */
function hunksFromOps(ops: Op[], firstLine: number): { added: number; removed: number; hunks: DiffHunk[] } {
  // Nomor baris sumber sebelum tiap op (untuk header @@).
  const aNum: number[] = [];
  const bNum: number[] = [];
  let aLine = firstLine + 1;
  let bLine = firstLine + 1;
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    aNum[k] = aLine;
    bNum[k] = bLine;
    if (ops[k].t === "del") { changeIdx.push(k); aLine++; }
    else if (ops[k].t === "add") { changeIdx.push(k); bLine++; }
    else { aLine++; bLine++; }
  }
  const added = ops.filter((o) => o.t === "add").length;
  const removed = ops.filter((o) => o.t === "del").length;
  const hunks: DiffHunk[] = [];
  let g = 0;
  while (g < changeIdx.length) {
    let e = g;
    while (e + 1 < changeIdx.length && changeIdx[e + 1] - changeIdx[e] <= MERGE_CTX + 1) e++;
    const from = Math.max(0, changeIdx[g] - CTX);
    const to = Math.min(ops.length - 1, changeIdx[e] + CTX);
    const rows: DiffRow[] = [];
    for (let k = from; k <= to; k++) rows.push({ t: ops[k].t, text: ops[k].text });
    hunks.push({ aStart: aNum[from], bStart: bNum[from], rows });
    g = e + 1;
  }
  return { added, removed, hunks };
}

/** Diff baris dua teks. Hasil `clipped=true` berarti hanya stat yang sah. */
export function diffLines(
  oldText: string,
  newText: string,
): { added: number; removed: number; hunks: DiffHunk[]; clipped: boolean } {
  // Teks kosong = nol baris (bukan satu baris kosong) — penting untuk
  // write_file dari "" agar tidak dihitung menghapus satu baris hantu.
  const a = oldText ? String(oldText).split("\n") : [];
  const b = newText ? String(newText).split("\n") : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (!midA.length && !midB.length) {
    return { added: 0, removed: 0, hunks: [], clipped: false };
  }
  if (midA.length > CAP_LINES || midB.length > CAP_LINES) {
    return { added: midB.length, removed: midA.length, hunks: [], clipped: true };
  }
  const ops = lcsOps(midA, midB);
  return { ...hunksFromOps(ops, pre), clipped: false };
}

/**
 * FileChange dari satu panggilan tool mutasi file, atau null bila tool
 * bukan mutasi file / argumen tak lengkap.
 */
export function changeFromTool(name: string, args: any): FileChange | null {
  if (!args || typeof args !== "object") return null;
  const path = typeof (args as any).path === "string" ? (args as any).path : "";
  if (!path) return null;
  if (name === "write_file") {
    const content = typeof (args as any).content === "string" ? (args as any).content : "";
    // Isi lama tak diketahui client — tampilkan sebagai tambahan penuh.
    return { path, kind: "write", ...diffLines("", content) };
  }
  if (name === "edit_file") {
    const oldS = typeof (args as any).old === "string" ? (args as any).old : "";
    const newS = typeof (args as any).new === "string" ? (args as any).new : "";
    if (!oldS && !newS) return null;
    return { path, kind: "edit", ...diffLines(oldS, newS) };
  }
  if (name === "delete_file") {
    return { path, kind: "delete", added: 0, removed: 0, hunks: [], clipped: true };
  }
  return null;
}
