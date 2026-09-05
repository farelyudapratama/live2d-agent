/**
 * dist.ts — Rakit folder release PORTABLE Live2D Agent.
 *
 * Hasil: dist/Live2D-Agent/ yang bisa di-zip dan dibagikan — user cukup
 * dobel-klik live2d-shell.exe (atau live2d-agent.exe), TANPA Bun, tanpa
 * build, tanpa Rust. Isi folder:
 *
 *   live2d-agent.exe    server Bun hasil `bun build --compile` (runtime
 *                       Bun ter-embed; dependensi npm ikut di-bundle)
 *   live2d-shell.exe    cangkang Tauri (WebView2) — sidecar: menyalakan
 *                       server sendiri bila belum jalan
 *   static/             frontend (index.html, app.js, bundle.js, dll.)
 *   data/               DIBUAT saat first-run — sengaja tidak disertakan
 *                       agar konfigurasi/API key user tidak ikut paket
 *
 * Bila Inno Setup 6 (ISCC) terpasang, langkah terakhir juga membungkus folder
 * ini menjadi SATU file: dist/Live2D-Agent-Setup.exe — installer per-user
 * tanpa admin (lihat installer.iss).
 *
 * Pemakaian:
 *   bun run src/dist.ts                 # target = OS host (Windows ini)
 *   bun run src/dist.ts -- bun-linux-x64  # cross-compile target lain (server saja)
 *
 * Catatan lintas-OS: server bisa di-cross-compile dari mana saja, tapi exe
 * shell Tauri per-OS harus dibangun di OS-nya masing-masing (macOS/Windows
 * toolchain tidak saling bisa) — biasanya lewat CI runner.
 */
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, ".."); // src/ → repo root
const OUT_DIR_NAME = "Live2D-Agent";
const OUT = join(REPO, "dist", OUT_DIR_NAME);
const SHELL_EXE = join(REPO, "agent-shell", "target", "release", "live2d-shell.exe");

const BUN = process.execPath; // bun.exe saat dev — dipakai lagi sebagai driver build

function fail(msg: string): never {
  console.error(`  [!] ${msg}`);
  process.exit(1);
}

// Argumen: -- <bun-target> (mis. bun-linux-x64, bun-darwin-arm64)
const sepIdx = process.argv.indexOf("--");
const bunTarget = sepIdx !== -1 ? process.argv[sepIdx + 1] : null;
const isWindowsTarget = bunTarget
  ? bunTarget.includes("windows")
  : process.platform === "win32";
const serverExeName = isWindowsTarget ? "live2d-agent.exe" : "live2d-agent";

console.log(`╔══════════════════════════════════════════════╗`);
console.log(`║  Live2D Agent — rakit release portable       ║`);
console.log(`╚══════════════════════════════════════════════╝`);
console.log(`  Target : ${bunTarget ?? "host (" + process.platform + ")"}`);
console.log(`  Output : dist/${OUT_DIR_NAME}/`);
console.log("");

// 1) Client bundle (bundle.js wajib ada — server menampilkan halaman mati tanpanya)
console.log("  [1/5] Bundle client → static/js/bundle.js");
const build = spawnSync(BUN, ["run", join(REPO, "src", "build.ts")], {
  cwd: REPO,
  stdio: "inherit",
});
if (build.status !== 0) fail("build client gagal");

// 2) Compile server → exe mandiri
console.log("  [2/5] Compile server → live2d-agent(.exe)");
const compileArgs = [
  "build", "--compile", "src/server/index.ts",
  "--outfile", join("dist", OUT_DIR_NAME, serverExeName),
  ...(bunTarget ? ["--target", bunTarget] : []),
];
const compile = spawnSync(BUN, compileArgs, { cwd: REPO, stdio: "inherit" });
if (compile.status !== 0) fail("compile server gagal");

// 3) Frontend statik — exe hasil langkah 2 diselamatkan dulu (folder dibersihkan)
console.log("  [3/5] Salin static/");
const tmpExe = join(OUT, serverExeName);
const keptExe = join(REPO, "dist", `.${serverExeName}.keep`);
if (existsSync(tmpExe)) renameSync(tmpExe, keptExe);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(REPO, "static"), join(OUT, "static"), { recursive: true });
if (existsSync(keptExe)) renameSync(keptExe, tmpExe);

// 4) Shell Tauri bila sudah dibangun (bun run build:pet)
console.log("  [4/5] Shell Tauri");
if (existsSync(SHELL_EXE)) {
  const dst = join(OUT, "live2d-shell.exe");
  cpSync(SHELL_EXE, dst);
  const mb = (statSync(dst).size / 1024 / 1024).toFixed(1);
  console.log(`        [OK] live2d-shell.exe (${mb} MB)`);
} else {
  console.log("        [i] live2d-shell.exe belum dibangun (bun run build:pet) —");
  console.log("            folder release tanpa jendela app; server tetap bisa dites manual.");
}

writeFileSync(
  join(OUT, "BACA-SAYA.txt"),
  [
    "Live2D Agent — versi portable",
    "=============================",
    "",
    "Cara pakai:",
    "  1. Dobel-klik live2d-shell.exe  (server menyala otomatis, jendela app terbuka)",
    "     - atau jalankan live2d-agent.exe lalu buka http://127.0.0.1:8310 di browser",
    "  2. Impor model Live2D (folder .model3.json atau .zip) lewat tombol impor di app.",
    "  3. Isi API key LLM (pengaturan koneksi) & TTS lewat UI — tersimpan di data/config.json.",
    "",
    "Catatan:",
    "  - Taruh folder ini di lokasi yang boleh ditulis (mis. Desktop/D:/),",
    "    BUKAN di bawah C:\\Program Files — data/config.json ditulis di samping exe.",
    "  - Windows: WebView2 sudah bawaan Windows 10/11.",
    "  - Semua data user hidup di folder data/ — pindahkan folder ini = pindah semua.",
    "",
  ].join("\r\n"),
  "utf8",
);

// Ringkasan ukuran
function dirSize(p: string): number {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}
const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MB";

// 5) Installer Windows (Inno Setup) — folder di atas dibungkus jadi SATU file:
//    dist/Live2D-Agent-Setup.exe — install per-user ke %LOCALAPPDATA%\Programs
//    (tanpa admin) sehingga kontrak "data/ di samping exe" tetap berlaku.
//    ISCC dicari di lokasi bawaan winget & installer resmi; env ISCC bisa
//    memaksa path lain. Tanpa ISCC, zip folder seperti biasa.
console.log("  [5/5] Installer Windows (Inno Setup)");
const SETUP_EXE = join(REPO, "dist", "Live2D-Agent-Setup.exe");
if (process.platform !== "win32") {
  console.log("        [i] Bukan Windows — installer hanya dibangun di Windows.");
} else {
  const iscc = [
    process.env.ISCC,
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].find((p) => p && existsSync(p));
  if (!iscc) {
    console.log("        [i] ISCC (Inno Setup 6) tidak ditemukan — zip folder release seperti biasa,");
    console.log("            atau pasang dulu: winget install JRSoftware.InnoSetup");
  } else {
    const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
    const iss = spawnSync(iscc, [`/DAPP_VERSION=${version}`, "installer.iss"], { cwd: REPO, stdio: "inherit" });
    if (iss.status !== 0) fail("build installer gagal");
    console.log(`        [OK] Live2D-Agent-Setup.exe (${mb(statSync(SETUP_EXE).size)}) — satu file siap dibagikan`);
  }
}

console.log("");
console.log(`  [OK] Release siap: dist/${OUT_DIR_NAME}/  (${mb(dirSize(OUT))})`);
console.log("       Zip foldernya untuk dibagikan — atau bagikan Live2D-Agent-Setup.exe.");
