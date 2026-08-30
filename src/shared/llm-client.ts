/**
 * shared/llm-client.ts — Multi-provider LLM client.
 * Supports: openai-compatible, gemini, groq, openai, anthropic, mock.
 */
import type { ChatMessage, Connection, LLMProvider } from "./types";

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface ErrorRule { text?: string; status?: number; cooldownMs?: number; backoff?: boolean; }

const ERROR_RULES: ErrorRule[] = [
  { text: "no credentials", cooldownMs: 120_000 },
  { text: "request not allowed", cooldownMs: 5000 },
  { text: "improperly formed request", cooldownMs: 120_000 },
  { text: "rate limit", backoff: true },
  { text: "too many requests", backoff: true },
  { text: "quota exceeded", backoff: true },
  { text: "capacity", backoff: true },
  { text: "overloaded", backoff: true },
  { status: 401, cooldownMs: 120_000 },
  { status: 402, cooldownMs: 120_000 },
  { status: 403, cooldownMs: 120_000 },
  { status: 404, cooldownMs: 120_000 },
  { status: 429, backoff: true },
];

function classifyError(status: number, text: string): { shouldFallback: boolean; cooldownMs: number } {
  const lower = (text || "").toLowerCase();
  for (const rule of ERROR_RULES) {
    if (rule.text && lower.includes(rule.text)) return { shouldFallback: true, cooldownMs: rule.cooldownMs ?? 30_000 };
    if (rule.status && rule.status === status) return { shouldFallback: true, cooldownMs: rule.cooldownMs ?? 30_000 };
  }
  return { shouldFallback: true, cooldownMs: 30_000 };
}

const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
};

function cleanKey(key: string): string {
  return String(key ?? "").replace(/[\u0000-\u001F\u007F\u00A0\u200B\u200C\u200D\uFEFF]+/g, "").trim();
}

function buildChatMessages(messages: ChatMessage[], system: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") continue;
    out.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
  }
  return out;
}

function toGeminiContents(messages: ChatMessage[]) {
  return messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] }));
}

// Bun-native fetch with timeout + size cap
async function postJson(urlStr: string, body: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(new Error(`timeout: LLM tidak merespon dalam ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  try {
    const resp = await fetch(urlStr, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    // Cap 2 MB dihitung dalam BYTE (bukan karakter) — balasan CJK bisa 3x lebih
    // besar dalam byte daripada panjang stringnya.
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("respon LLM terlalu besar");
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error("respon bukan JSON: " + text.slice(0, 200)); }
    if (!resp.ok) {
      const e: any = new Error(`HTTP ${resp.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
      e.statusCode = resp.status;
      throw e;
    }
    return json;
  } finally { clearTimeout(to); }
}

export async function callLLM(conn: Connection, messages: ChatMessage[], clientSystem: string = ""): Promise<string> {
  const provider = (conn.provider ?? "openai-compatible").toLowerCase() as LLMProvider;
  const apiKey = cleanKey(conn.apiKey);
  const model = conn.model || DEFAULT_MODELS[provider] || "";
  const temp = conn.temperature ?? 0.8;
  const maxT = conn.maxTokens ?? 2048;
  const sys = [conn.systemPrompt, clientSystem].filter(Boolean).join("\n\n");

  if (provider === "openai-compatible" || provider === "groq" || provider === "openai") {
    let base: string;
    if (provider === "openai-compatible") {
      base = (conn.baseUrl ?? "").replace(/\/+$/, "");
      if (!base) throw new Error("baseUrl belum diisi untuk openai-compatible");
    } else if (provider === "groq") base = "https://api.groq.com/openai/v1";
    else base = "https://api.openai.com/v1";
    const body = JSON.stringify({ model, messages: buildChatMessages(messages, sys), temperature: temp, max_tokens: maxT });
    const r = await postJson(base + "/chat/completions", body, { Authorization: "Bearer " + apiKey });
    const text = r?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(provider + " kosong: " + JSON.stringify(r).slice(0, 200));
    return text.trim();
  }
  if (provider === "mock") {
    const last = messages.filter((m) => m.role === "user").pop()?.content ?? "";
    await new Promise((r) => setTimeout(r, 300));
    return `Halo! Kamu bilang: "${last}". (Mode mock — isi apiKey di config.json untuk LLM sungguhan.)`;
  }
  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = JSON.stringify({ systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, contents: toGeminiContents(messages), generationConfig: { temperature: temp, maxOutputTokens: maxT, candidateCount: 1 } });
    const r = await postJson(url, body);
    const text = r?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
    if (!text) throw new Error("Gemini kosong: " + JSON.stringify(r).slice(0,200));
    return text.trim();
  }
  if (provider === "anthropic") {
    const body = JSON.stringify({ model, system: sys || undefined, messages: messages.filter((m) => m.role !== "system"), max_tokens: Math.min(maxT, 4096), temperature: temp });
    const r = await postJson("https://api.anthropic.com/v1/messages", body, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
    const text = (r?.content ?? []).map((p: any) => p.text ?? "").join("");
    if (!text) throw new Error("Anthropic kosong: " + JSON.stringify(r).slice(0,200));
    return text.trim();
  }
  throw new Error("provider tidak dikenal: " + provider);
}

export interface LLMResult { reply: string; used: string; }

// ── Multi-LLM role routing ─────────────────────────────────────
// Satu LLM "serba bisa" menerima seluruh konteks (termasuk dulu: tabel
// parameter) di prompt-nya, dan itu menurunkan mutu balasan teks. Dengan tag
// role, prompt berat pindah ke connection yang memang bertugas memetakan
// gerak, dan user bisa memakai "yang murah untuk gerak, yang pintar untuk
// teks". Role kanonik SENGAJA kecil — tambah role baru berarti menambah
// entri di sini + satu checkbox di UI, bukan sistem baru.
export const LLM_ROLES = ["chat", "motion", "sheet"];

/** Bersihkan field `roles`: buang non-string, trim/lowercase, dedupe,
 *  drop role tak dikenal (dengan warning — jangan gagalkan boot). */
export function normalizeRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const k = r.trim().toLowerCase();
    if (!k) continue;
    if (!LLM_ROLES.includes(k)) {
      console.warn("[roles] role tidak dikenal diabaikan:", k);
      continue;
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** true kalau connection ini boleh dipakai untuk `role`.
 *  Absen/invalid/kosong = wildcard (semua role) — kompatibel mundur mutlak. */
export function connHasRole(conn: Connection | null | undefined, role: string): boolean {
  const roles = normalizeRoles(conn && conn.roles);
  if (!roles.length) return true;
  return roles.includes(role);
}

/**
 * Urutan kandidat untuk sebuah role: connection yang MENANDAI role ini
 * secara eksplisit diutamakan di atas wildcard, supaya menandai satu
 * connection sebagai 'motion' benar-benar mengarahkan trafik motion ke sana.
 * Kosong berarti "pakai urutan default llmWithFallback" (aktif dulu).
 */
export function orderForRole(role: string, conns: Connection[]): Connection[] {
  const matching = conns.filter((c) => connHasRole(c, role));
  if (!matching.length) {
    console.warn("[roles] tidak ada connection untuk role \"" + role + "\" — pakai semua connection");
    return [];
  }
  const explicit = conns.filter((c) => normalizeRoles(c.roles).includes(role));
  return explicit.concat(matching.filter((c) => !explicit.includes(c)));
}

/**
 * Panggil LLM untuk sebuah PERAN. Bukan pengganti llmWithFallback(): kebijakan
 * retry/cooldown/persist tetap di sana (satu tempat). Yang ditambahkan di sini
 * hanya penyaringan kandidat + preferensi urutan, lalu pekerjaan diserahkan.
 * Aturan keras: kalau tidak ada connection yang menandai role ini, JANGAN
 * gagal — jatuh ke urutan default (semua connection). Endpoint tidak boleh
 * mati hanya karena user belum menandai role apa pun.
 */
export function llmForRole(
  role: string,
  getConnections: () => Connection[],
  getActive: () => Connection | null,
  persist: (conns: Connection[]) => void,
  messages: ChatMessage[],
  clientSystem: string = ""
): Promise<LLMResult> {
  const order = orderForRole(role, getConnections());
  if (order.length) {
    console.log("[roles] role=" + role + " -> " + order.map((c) => c.name || c.id).join(" > "));
  }
  return llmWithFallback(getConnections, getActive, persist, messages, clientSystem, order);
}

export function llmWithFallback(
  getConnections: () => Connection[],
  getActive: () => Connection | null,
  persist: (conns: Connection[]) => void,
  messages: ChatMessage[],
  clientSystem: string = "",
  order?: Connection[]
): Promise<LLMResult> {
  return new Promise((resolve, reject) => {
    const conns = getConnections();
    if (!conns.length) { const e: any = new Error("Belum ada connection. Buka panel ⚙️ AI Connections."); e.httpStatus = 400; e.kind = "no-connections"; return reject(e); }
    const active = getActive();
    // `order` opsional: daftar connection yang SUDAH diurutkan (dipakai
    // llmForRole). Bila tidak diberikan, perilaku lama dipertahankan persis:
    // active dulu, lalu sisanya urut config.
    const order2 = (Array.isArray(order) && order.length)
      ? order.filter(Boolean)
      : [active, ...conns.filter((c) => c !== active)].filter(Boolean) as Connection[];
    let idx = 0;
    (function tryNext() {
      if (idx >= order2.length) { const e: any = new Error("Semua connection gagal (cek panel ⚙️ AI Connections)."); e.httpStatus = 502; e.kind = "all-failed"; return reject(e); }
      const conn = order2[idx++];
      if (conn.rateLimitedUntil && new Date(conn.rateLimitedUntil).getTime() > Date.now()) return tryNext();
      callLLM(conn, messages, clientSystem).then((reply) => {
        conn.testStatus = "success"; (conn as any).lastError = ""; conn.rateLimitedUntil = null as any;
        persist(conns);
        resolve({ reply, used: conn.id });
      }).catch((err) => {
        const status = err.statusCode ?? 0;
        const cls = classifyError(status, err.message);
        conn.testStatus = "error"; (conn as any).lastError = err.message;
        if (cls.shouldFallback) conn.rateLimitedUntil = new Date(Date.now() + (cls.cooldownMs || 30000)).toISOString() as any;
        persist(conns);
        if (cls.shouldFallback && idx < order2.length) tryNext();
        else { const e: any = new Error("LLM error [" + (conn.name || conn.id) + "]: " + err.message); e.httpStatus = 502; e.kind = "llm-error"; e.conn = conn; reject(e); }
      });
    })();
  });
}

export { classifyError };
