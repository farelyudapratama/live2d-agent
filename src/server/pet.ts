/**
 * server/pet.ts — Peluncur jendela overlay Desktop Pet.
 * Web tidak bisa menembus batas browser, jadi pet berjalan di jendela
 * aplikasi terpisah yang selalu di atas (always-on-top) dan transparan.
 * Urutan peluncur:
 *   1. Neutralino (jika diinstall) — overlay transparan klik-tembus penuh
 *   2. Chrome/Edge --app --kiosk window (jendela chromeless always-on-top
 *      via PowerShell untuk Windows) — fallback nol-dependency
 * Referensi: flag Chrome app/kiosk adalah API resmi command-line Chromium.
 */
import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const STATIC = join(import.meta.dir, "../../static");

let petProc: any = null;
let petPid: number | null = null;
let petHelper: any = null;

export function petStatus() { return { running: !!petProc || !!petPid }; }

export function petClose() {
  try { petProc?.kill(); } catch {}
  try { if (petHelper) execSync(`taskkill /PID ${petHelper} /T /F`, { stdio: "ignore" }); } catch {}
  try { if (petPid) execSync(`taskkill /PID ${petPid} /T /F`, { stdio: "ignore" }); } catch {}
  petProc = null; petPid = null; petHelper = null;
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

export function petLaunch(): { ok: boolean; error?: string; how?: string } {
  petClose();
  const url = "http://127.0.0.1:8310/pet.html";
  const exe = findChromeEdge();
  if (!exe) return { ok: false, error: "Chrome/Edge tidak ditemukan — install salah satu untuk pet mode" };
  try {
    // --app: jendela tanpa toolbar; --window-size pas ukuran pet.
    petProc = spawn(exe, [
      "--app=" + url,
      "--window-size=420,640",
      "--window-position=40,40",
      "--autoplay-policy=no-user-gesture-required",
    ], { detached: false, stdio: "ignore" });
    petPid = petProc.pid ?? null;
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
