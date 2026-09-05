/**
 * server/pet.ts — Peluncur jendela overlay Desktop Pet.
 * Web tidak bisa menembus batas browser, jadi pet berjalan di jendela
 * aplikasi terpisah yang selalu di atas (always-on-top) dan transparan.
 * Urutan peluncur:
 *   1. Shell Tauri (agent-shell/target/release/live2d-shell.exe pada dev,
 *      live2d-shell.exe di samping server pada folder release portable) —
 *      jendela WebView2 transparan, selalu di atas, dan bisa klik-tembus;
 *      paling ringan (±40-90MB) karena memakai WebView2 bawaan Windows.
 *   2. Chrome/Edge --app (jendela opaque always-on-top via PowerShell)
 *      — fallback nol-build kalau exe Tauri belum dibangun.
 * Referensi: flag Chrome app/kiosk adalah API resmi command-line Chromium.
 */
import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { appRoot } from "../shared/paths";

const ROOT = appRoot();
const STATIC = join(ROOT, "static");
// Urutan kandidat shell: (1) exe di samping server — folder release portable;
// (2) hasil build dev di agent-shell/target.
const SHELL_CANDIDATES = [
  join(ROOT, "live2d-shell.exe"),
  join(ROOT, "agent-shell", "target", "release", "live2d-shell.exe"),
];
function findShellExe(): string | null {
  for (const c of SHELL_CANDIDATES) { try { if (existsSync(c)) return c; } catch {} }
  return null;
}

let petProc: any = null;
let petPid: number | null = null;
let petHelper: any = null;
let clickThrough = false;
let activeShell: "tauri" | "browser" | null = null;

export function petStatus() {
  // Proses bisa mati sendiri (user menutup via tombol pet); sinkronkan state.
  if (petProc && petProc.exitCode !== null) {
    petProc = null;
    petPid = null;
    petHelper = null;
    clickThrough = false;
    activeShell = null;
  }
  return { running: !!petProc || !!petPid, clickThrough, shell: activeShell };
}

export function petSetClickThrough(on: boolean) {
  clickThrough = !!on;
  return { ok: true, clickThrough };
}

export function petClose() {
  try { petProc?.kill(); } catch {}
  try { if (petHelper) execSync(`taskkill /PID ${petHelper} /T /F`, { stdio: "ignore" }); } catch {}
  try { if (petPid) execSync(`taskkill /PID ${petPid} /T /F`, { stdio: "ignore" }); } catch {}
  petProc = null; petPid = null; petHelper = null;
  clickThrough = false; activeShell = null;
  return { ok: true };
}

function findChromeEdge(): string | null {
  const candidates = [
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) { try { if (c && existsSync(c)) return c; } catch {} }
  return null;
}

export function petLaunch(port: number): { ok: boolean; error?: string; how?: string } {
  petClose();
  // Port lewat parameter supaya tidak ada sumber kebenaran kedua (dulu
  // hardcode 8310 di sini — bikin pet salah sasaran saat PORT dioverride).
  const url = `http://127.0.0.1:${port}/pet.html`;

  // Shell 1: Tauri — transparan, topmost native, bisa klik-tembus.
  const shellExe = findShellExe();
  if (shellExe) {
    try {
      petProc = spawn(shellExe, ["pet", url], { detached: false, stdio: "ignore" });
      petPid = petProc.pid ?? null;
      activeShell = "tauri";
      return { ok: true, how: "tauri-shell (transparan + klik-tembus)" };
    } catch (e: any) {
      // jatuh ke fallback browser
      console.warn("[pet] shell Tauri gagal dijalankan:", e.message);
    }
  }

  // Shell 2: Chrome/Edge --app — fallback nol-build.
  const exe = findChromeEdge();
  if (!exe) {
    return {
      ok: false,
      error:
        "Shell belum dibangun (bun run build:pet) dan Chrome/Edge tidak ditemukan",
    };
  }
  try {
    // --app: jendela tanpa toolbar; --window-size pas ukuran pet.
    petProc = spawn(exe, [
      "--app=" + url,
      "--window-size=420,640",
      "--window-position=40,40",
      "--autoplay-policy=no-user-gesture-required",
    ], { detached: false, stdio: "ignore" });
    petPid = petProc.pid ?? null;
    activeShell = "browser";
    // Windows: paksa jendela Chrome paling atas (always-on-top) via PowerShell.
    // (Flag CLI Chromium tidak punya always-on-top; SetWindowPos API resmi Win32.)
    if (process.platform === "win32" && petPid) {
      setTimeout(() => {
        try {
          const ps = `Add-Type -Name W -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);';` +
            `$p=Get-Process -Id ${petPid} -ErrorAction Stop;` +
            `$h=$p.MainWindowHandle;` +
            `if($h -ne 0){[P.W]::SetWindowPos($h,-1,0,0,0,0,0x0041);[P.W]::SetForegroundWindow($h)}`;
          const c = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
          petHelper = c.pid ?? null;
        } catch {}
      }, 2500);
    }
    return { ok: true, how: "app-window (Chrome/Edge --app + always-on-top)" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
