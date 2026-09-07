/**
 * server/browser/policy.ts — Kebijakan URL browser agent.
 * Browser nyata membuka internet sebagai proses user, tetapi AGENT tidak boleh
 * diarahkan diam-diam ke file lokal, metadata cloud, loopback, atau LAN.
 * Origin privat hanya boleh setelah persetujuan eksplisit per sesi.
 */
import { lookup } from "dns/promises";
import { isIP } from "net";

export type BrowserUrlDecision = {
  ok: boolean;
  url?: string;
  origin?: string;
  privateNetwork?: boolean;
  error?: string;
};

const DENIED_SCHEMES = /^(file|javascript|data|blob|chrome|devtools|edge|about):/i;

/** Klasifikasi alamat literal IPv4/IPv6 yang tidak boleh diakses agent. */
export function isPrivateAddress(input: string): boolean {
  const ip = String(input || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!isIP(ip)) return false;
  if (ip === "::" || ip === "::1" || ip === "0.0.0.0" || ip.startsWith("fe80:")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  // IPv4-mapped IPv6.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

export function normalizeBrowserUrl(raw: string): BrowserUrlDecision {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "URL kosong" };
  if (DENIED_SCHEMES.test(text)) return { ok: false, error: "scheme URL tidak diizinkan" };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(text) ? text : "https://" + text);
  } catch {
    return { ok: false, error: "URL tidak valid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "hanya URL http/https yang diizinkan" };
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  const privateNetwork = u.hostname === "localhost" || isPrivateAddress(u.hostname);
  return { ok: true, url: u.href, origin: u.origin, privateNetwork };
}

/** Resolve DNS dan cek SEMUA alamat hasilnya (mencegah hostname → LAN). */
export async function inspectBrowserUrl(raw: string): Promise<BrowserUrlDecision> {
  const base = normalizeBrowserUrl(raw);
  if (!base.ok || !base.url) return base;
  const u = new URL(base.url);
  if (base.privateNetwork) return base;
  try {
    const answers = await lookup(u.hostname, { all: true, verbatim: true });
    if (answers.some((a) => isPrivateAddress(a.address))) {
      return { ...base, privateNetwork: true };
    }
  } catch {
    return { ok: false, error: "hostname tidak dapat di-resolve" };
  }
  return base;
}

/** Grant privat disimpan in-memory per proses/sesi browser. */
export class BrowserOriginGrants {
  private origins = new Set<string>();
  grant(origin: string): void { this.origins.add(origin); }
  revokeAll(): void { this.origins.clear(); }
  has(origin: string): boolean { return this.origins.has(origin); }
  async authorize(raw: string): Promise<BrowserUrlDecision> {
    const d = await inspectBrowserUrl(raw);
    if (!d.ok) return d;
    if (d.privateNetwork && d.origin && !this.has(d.origin)) {
      return { ...d, ok: false, error: "origin privat memerlukan persetujuan user" };
    }
    return d;
  }
}
