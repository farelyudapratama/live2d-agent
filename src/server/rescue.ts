/**
 * rescue.ts — Auto-Rescue (Mode Rakit Otomatis) ──────────────────────────
 *
 * Beberapa model fan-made dibagikan TANPA .model3.json: hanya .moc3,
 * tekstur .png, physics/cdi, dan file .motion3/.exp3 yang yatim (kadang
 * petunjuknya tersimpan di lumine.vtube.json milik VTube Studio — mis.
 * "IdleAnimation"). Tanpa manifest, folder itu tidak pernah muncul di
 * daftar model dan tidak bisa dimuat runtime.
 *
 * Modul ini menyapu folder seperti itu dan MERAKITKAN blueprint
 * .model3.json DI MEMORI (tidak menulis ke folder model — read path
 * read-only sesuai konvensi repo), lalu disuapkan ke sistem lewat jalur
 * virtual `model/<folder>/__rescue__.model3.json`.
 *
 * Model-agnostic: tersapu dari struktur folder (moc3/tekstur/motion/exp),
 * urutan tekstur dari penomoran natural, dan kelompok motion Idle dari
 * petunjuk vtube.json ATAU pola nama /idle/i — bukan dari id tertentu.
 *
 * Idempoten: kalau folder sudah punya manifest sungguhan, fungsi kembali
 * null — manifest user tidak pernah disentuh.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, relative, dirname } from "path";

export const RESCUE_FILENAME = "__rescue__.model3.json";

export interface RescueBlueprint {
  manifest: any;
  summary: {
    textures: number;
    motions: number;
    expressions: number;
    hasPhysics: boolean;
    hasCdi3: boolean;
    idleMotion: string | null;
  };
}

/** Jalankan callback pada tiap file di dalam dir (rekursif, maks depth 6). */
function walkFiles(dir: string, visit: (full: string) => void, depth = 0): void {
  if (depth > 6) return;
  let entries: any[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, visit, depth + 1);
    else visit(full);
  }
}

/** findManifest lokal: .model3.json pertama (rekursif) — null bila tidak ada. */
function findManifest(dir: string, depth = 0): string | null {
  if (depth > 6) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { const r = findManifest(full, depth + 1); if (r) return r; }
      else if (e.name.toLowerCase().endsWith(".model3.json")) return full;
    }
  } catch {}
  return null;
}

/** Urutan natural: angka di nama dibandingkan sebagai angka (texture_02 < texture_10). */
function naturalCompare(a: string, b: string): number {
  const ra = a.toLowerCase().split(/(\d+)/);
  const rb = b.toLowerCase().split(/(\d+)/);
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const xa = ra[i], xb = rb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa) ? Number(xa) : null;
    const nb = /^\d+$/.test(xb) ? Number(xb) : null;
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}

function firstBy(dir: string, suffix: string): string | null {
  const hits: string[] = [];
  walkFiles(dir, (full) => { if (full.toLowerCase().endsWith(suffix)) hits.push(full); });
  hits.sort(naturalCompare);
  return hits[0] || null;
}

/** Petunjuk vtube.json VTube Studio: kembalikan path relatif file motion Idle. */
function vtubeIdleMotion(dir: string): string | null {
  const hits: string[] = [];
  walkFiles(dir, (full) => { if (full.toLowerCase().endsWith(".vtube.json")) hits.push(full); });
  hits.sort(naturalCompare);
  for (const vt of hits) {
    try {
      const j = JSON.parse(readFileSync(vt, "utf8"));
      const idle = j && j.FileReferences && j.FileReferences.IdleAnimation;
      if (typeof idle === "string" && idle.trim()) {
        // Path di vtube.json relatif terhadap FOLDER PEMILIK file itu. Rigger
        // kadang menulis tanpa subfolder walau motion ada di subfolder —
        // cocokkan longgar: cari file motion ber-basename sama di seluruh
        // folder model; gagal itu, coba jalur literal dari pemilik vtube.json.
        const wanted = idle.trim().replace(/\\/g, "/").split("/").pop()!.toLowerCase();
        const candidates: string[] = [];
        walkFiles(dir, (full) => {
          if (full.toLowerCase().endsWith(".motion3.json") &&
              full.replace(/\\/g, "/").split("/").pop()!.toLowerCase() === wanted) {
            candidates.push(full);
          }
        });
        candidates.sort(naturalCompare);
        if (candidates.length) return candidates[0];
        return join(dirname(vt), idle.trim());
      }
    } catch {}
  }
  return null;
}

export interface RescueScan {
  moc3: string;
  textures: string[];
  physics: string | null;
  cdi3: string | null;
  pose: string | null;
  motions: { name: string; file: string }[];
  expressions: { name: string; file: string }[];
  idleHint: string | null;
}

/** Sapu folder: kumpulkan file inti + yatim. Null bila folder bukan kandidat. */
export function scanRescueFolder(dir: string): RescueScan | null {
  if (!existsSync(dir)) return null;
  // moc3 wajib — tanpa itu tidak ada yang bisa dirakit
  let moc3: string | null = null;
  const pngs: string[] = [];
  const motions: { name: string; file: string }[] = [];
  const expressions: { name: string; file: string }[] = [];
  walkFiles(dir, (full) => {
    const low = full.toLowerCase();
    if (low.endsWith(".moc3")) {
      if (!moc3) moc3 = full;
      return;
    }
    if (low.endsWith(".png")) { pngs.push(full); return; }
    if (low.endsWith(".motion3.json")) {
      motions.push({ name: basenameNoExt(full, ".motion3.json"), file: full });
      return;
    }
    if (low.endsWith(".exp3.json")) {
      expressions.push({ name: basenameNoExt(full, ".exp3.json"), file: full });
      return;
    }
  });
  if (!moc3) return null;
  // urutan tekstur: file berpola texture ATAU di folder atlas berangka dipilih
  // duluan (konvensi ekspor Cubism), lalu urut natural. Ikon (nama mengandung
  // "icon") sengaja dikeluarkan — bukan tekstur model.
  const atlasLike = pngs.filter((p) => /texture|\.8192|\.4096|\.2048/i.test(p) && !/icon/i.test(p));
  const tex = (atlasLike.length ? atlasLike : pngs.filter((p) => !/icon/i.test(p)))
    .sort((x, y) => naturalCompare(x, y));
  motions.sort((x, y) => naturalCompare(x.file, y.file));
  expressions.sort((x, y) => naturalCompare(x.file, y.file));
  const idleHint = vtubeIdleMotion(dir);
  return {
    moc3,
    textures: tex,
    physics: firstBy(dir, ".physics3.json"),
    cdi3: firstBy(dir, ".cdi3.json"),
    pose: firstBy(dir, ".pose3.json"),
    motions,
    expressions,
    idleHint,
  };
}

function basenameNoExt(full: string, ext: string): string {
  const base = full.replace(/\\/g, "/").split("/").pop() || full;
  return base.slice(0, base.length - ext.length);
}

/**
 * Rakit blueprint .model3.json di memori untuk folder yang TIDAK punya
 * manifest. Null bila: folder tak ada, tak ada .moc3, atau manifest sudah
 * ada (idempoten — manifest user tidak pernah ditimpa).
 */
export function buildRescueBlueprint(modelDir: string): RescueBlueprint | null {
  if (!existsSync(modelDir)) return null;
  if (findManifest(modelDir)) return null;          // manifest user utuh — bukan tugas kita
  const scan = scanRescueFolder(modelDir);
  if (!scan) return null;

  const rel = (full: string) => relative(modelDir, full).split("\\").join("/");
  const FileReferences: any = {
    Moc: rel(scan.moc3),
    Textures: scan.textures.map(rel),
  };
  if (scan.physics) FileReferences.Physics = rel(scan.physics);
  if (scan.cdi3) FileReferences.DisplayInfo = rel(scan.cdi3);
  if (scan.pose) FileReferences.Pose = rel(scan.pose);

  // Kelompok motion: Idle dari petunjuk vtube.json ATAU pola nama /idle/i
  // (pixi-live2d memutar grup "Idle" otomatis — sama seperti maksud
  // IdleAnimation di vtube.json). Sisanya masuk grup "Motion".
  const idleFiles = new Set<string>();
  if (scan.idleHint) idleFiles.add(scan.idleHint);
  const Motions: Record<string, { File: string }[]> = {};
  for (const m of scan.motions) {
    const isIdle = idleFiles.has(m.file) || /idle/i.test(m.name);
    if (isIdle) idleFiles.add(m.file);
    const group = isIdle ? "Idle" : "Motion";
    (Motions[group] = Motions[group] || []).push({ File: rel(m.file) });
  }
  if (Object.keys(Motions).length) FileReferences.Motions = Motions;

  // Ekspresi yatim: nama unik (duplikat membuat satu entri tak terjangkau
  // via getExpressionIndex yang mencocokkan Name).
  const seen = new Set<string>();
  const Expressions: { Name: string; File: string }[] = [];
  for (const e of scan.expressions) {
    let name = e.name;
    if (seen.has(name)) { let k = 2; while (seen.has(name + " " + k)) k++; name = name + " " + k; }
    seen.add(name);
    Expressions.push({ Name: name, File: rel(e.file) });
  }
  if (Expressions.length) FileReferences.Expressions = Expressions;

  const manifest = {
    Version: 3,
    FileReferences,
    // Penanda rakitan (dibaca manusia; loader mengabaikan field asing).
    AutoRescued: {
      by: "live2d-agent auto-rescue",
      at: new Date().toISOString(),
      textures: scan.textures.length,
      motions: scan.motions.length,
      expressions: scan.expressions.length,
    },
  };
  return {
    manifest,
    summary: {
      textures: scan.textures.length,
      motions: scan.motions.length,
      expressions: scan.expressions.length,
      hasPhysics: !!scan.physics,
      hasCdi3: !!scan.cdi3,
      idleMotion: scan.idleHint ? rel(scan.idleHint) : null,
    },
  };
}

// ── helper kecil (hindari import path/dirname duplikat) ────────────

