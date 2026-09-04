/**
 * server/vtuber.ts — Runtime konektor mode AI VTuber (streaming).
 * Single active runtime: start() menghancurkan runtime lama dulu.
 *
 * Provider:
 *  - mock    : simulator penonton + donasi (tanpa API key, untuk tes)
 *  - twitch  : baca live chat via IRC WebSocket (wss://irc-ws.chat.twitch.tv:443)
 *              tanpa token = anonymous read-only (justinfan); token opsional.
 *  - youtube : poll liveChatMessages.list (API key + videoId live);
 *              superChat → event donasi.
 */
import { WebSocket } from "ws";

export type VtEvent = {
  id: number;
  ts: number;
  type: "chat" | "donation" | "system" | "agent";
  user: string;
  text: string;
  amount?: string;
};

type Runtime = {
  cfg: any;
  events: VtEvent[];
  nextId: number;
  destroy: () => void;
};

let runtime: Runtime | null = null;
let nextId = 1;

function pushEvent(e: Omit<VtEvent, "id" | "ts">): VtEvent {
  if (!runtime) throw new Error("vtuber runtime tidak aktif");
  const ev: VtEvent = { id: nextId++, ts: Date.now(), ...e };
  runtime.events.push(ev);
  if (runtime.events.length > 500) runtime.events.splice(0, runtime.events.length - 500);
  return ev;
}

export function vtuberStatus() {
  return {
    running: !!runtime,
    provider: runtime?.cfg?.provider || null,
    channel: runtime?.cfg?.channel || runtime?.cfg?.videoId || null,
    respond: runtime?.cfg?.respond ?? false,
    eventCount: runtime?.events.length || 0,
  };
}

export function vtuberEvents(since: number): { events: VtEvent[]; cursor: number } {
  if (!runtime) return { events: [], cursor: since };
  const events = runtime.events.filter((e) => e.id > since);
  return { events, cursor: nextId - 1 };
}

export function vtuberInjectEvent(body: { type?: string; user?: string; text?: string; amount?: string }): VtEvent | null {
  if (!runtime) return null;
  const type = body.type === "donation" ? "donation" : "chat";
  return pushEvent({ type, user: String(body.user || "Guest"), text: String(body.text || "").slice(0, 400), amount: body.amount });
}

export function vtuberAgentSay(text: string): VtEvent | null {
  if (!runtime) return null;
  return pushEvent({ type: "agent", user: "AI", text: String(text || "").slice(0, 500) });
}

export function vtuberStop() {
  if (runtime) {
    try { runtime.destroy(); } catch {}
    runtime = null;
  }
  return { ok: true };
}

export function vtuberStart(cfg: any): { ok: boolean; error?: string } {
  vtuberStop();
  const provider = String(cfg?.provider || "mock");
  const rt: Runtime = { cfg, events: [], nextId: nextId, destroy: () => {} };
  const timers: any[] = [];
  let ws: WebSocket | null = null;

  const push = (e: Omit<VtEvent, "id" | "ts">) => {
    if (runtime === rt) pushEvent(e);
  };

  try {
    if (provider === "mock") {
      const names = ["Rian", "Sinta", "Budi", "Ayu", "Kevin", "Nadia", "Fajar", "Tania", "Yoga", "Melati"];
      const chats = [
        "Halo semua!", "Kamu dari mana?", "Suara lucu banget 😆", "Sedih banget lagunya",
        "Main game dong!", "Jam berapa stream selesai?", "Keren sih karakternya",
        "Ada yang tahu cara donasi?", "Request lagu boleh?", "Hari ini ngapain aja?",
      ];
      const donors = ["Rian", "Kevin", "Ayu", "Fajar"];
      let tick = 0;
      const timer = setInterval(() => {
        if (runtime !== rt) return;
        tick++;
        if (tick % 5 === 0) {
          const amount = ["Rp 10.000", "Rp 25.000", "Rp 50.000", "Rp 100.000"][Math.floor(Math.random() * 4)];
          push({ type: "donation", user: donors[Math.floor(Math.random() * donors.length)], text: "Dukung terus streamnya!", amount });
        } else {
          push({ type: "chat", user: names[Math.floor(Math.random() * names.length)], text: chats[Math.floor(Math.random() * chats.length)] });
        }
      }, Math.max(3000, Number(cfg?.mockIntervalMs) || 6000));
      timers.push(timer);
      push({ type: "system", user: "system", text: "Mode mock aktif — penonton simulasi (tanpa API key)." });
    } else if (provider === "twitch") {
      const channel = String(cfg?.channel || "").trim().toLowerCase().replace(/^#/, "");
      if (!channel) return { ok: false, error: "nama channel Twitch wajib diisi" };
      const token = String(cfg?.apiKey || "").trim();
      const nick = token ? String(cfg?.nick || "justinfan12345").toLowerCase() : "justinfan" + Math.floor(10000 + Math.random() * 89999);
      ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
      let closed = false;
      ws.addEventListener("open", () => {
        ws!.send("CAP REQ :twitch.tv/tags");
        if (token) ws!.send("PASS oauth:" + token.replace(/^oauth:/i, ""));
        ws!.send("NICK " + nick);
        ws!.send("JOIN #" + channel);
        push({ type: "system", user: "system", text: "Terhubung ke Twitch #" + channel + (token ? " (auth)" : " (anonim)") });
      });
      ws.addEventListener("message", (ev: any) => {
        const raw = String(ev.data || "");
        for (const line of raw.split("\r\n")) {
          if (!line) continue;
          if (line.startsWith("PING")) { ws!.send("PONG :tmi.twitch.tv"); continue; }
          if (line.includes(" PRIVMSG ")) {
            // @tags :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :pesan
            let user = "";
            let text = "";
            let rest = line;
            if (rest.startsWith("@")) { const sp = rest.indexOf(" "); rest = sp >= 0 ? rest.slice(sp + 1) : rest; }
            const m = /^:([^!\s]+)![^\s]*\sPRIVMSG\s+#[^\s]+\s+:(.*)$/.exec(rest);
            if (m) { user = m[1]; text = m[2]; }
            if (rest.startsWith("@badge")) {
              const dm = /display-name=([^;]*)/.exec(line);
              if (dm && dm[1]) user = dm[1];
            }
            if (user && text) push({ type: "chat", user, text: text.slice(0, 400) });
          } else if (line.includes("Login authentication failed") || line.includes("Improperly formatted auth")) {
            push({ type: "system", user: "system", text: "Auth Twitch gagal — cek token/nick. Coba tanpa token (anonim)." });
          }
        }
      });
      ws.addEventListener("close", () => {
        if (closed || runtime !== rt) return;
        push({ type: "system", user: "system", text: "Koneksi Twitch tertutup. Mencoba ulang 5 dtk…" });
        const t = setTimeout(() => { if (runtime === rt) { const c = cfg; vtuberStart(c); } }, 5000);
        timers.push(t);
      });
      ws.addEventListener("error", () => {
        push({ type: "system", user: "system", text: "Gagal terhubung ke Twitch IRC." });
      });
      rt.destroy = () => { closed = true; try { ws?.close(); } catch {} timers.forEach(clearTimeout); };
    } else if (provider === "youtube") {
      const videoId = String(cfg?.videoId || "").trim();
      const key = String(cfg?.apiKey || "").trim();
      if (!videoId || !key) return { ok: false, error: "videoId live + API key YouTube wajib diisi" };
      let liveChatId = "";
      let pageToken = "";
      let stopped = false;
      const base = "https://www.googleapis.com/youtube/v3";
      (async () => {
        try {
          const r = await fetch(`${base}/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${key}`);
          const j: any = await r.json();
          liveChatId = j?.items?.[0]?.liveStreamingDetails?.activeLiveChatId || "";
          if (!liveChatId) {
            push({ type: "system", user: "system", text: "liveChatId tidak ditemukan — pastikan video sedang live dan chat aktif." });
            return;
          }
          push({ type: "system", user: "system", text: "Terhubung ke live chat YouTube." });
        } catch (e: any) {
          push({ type: "system", user: "system", text: "Gagal ambil liveChatId: " + e.message });
          return;
        }
        const poll = async () => {
          while (!stopped && runtime === rt && liveChatId) {
            try {
              const r = await fetch(`${base}/liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}&part=snippet,authorDetails&pageToken=${encodeURIComponent(pageToken)}&key=${key}`);
              const j: any = await r.json();
              if (j.error) { push({ type: "system", user: "system", text: "YouTube API: " + (j.error.message || r.status) }); break; }
              for (const it of j.items || []) {
                const sn = it.snippet || {};
                const user = it.authorDetails?.displayName || sn.authorChannelId || "?";
                if (sn.type === "superChatEvent" && sn.superChatDetails) {
                  const amt = (Number(sn.superChatDetails.amountMicros) / 1e6).toFixed(0);
                  push({ type: "donation", user, text: sn.superChatDetails.userComment || "", amount: amt + " " + (sn.superChatDetails.currency || "") });
                } else if (sn.type === "textMessageEvent" && sn.textMessageDetails?.messageText) {
                  push({ type: "chat", user, text: String(sn.textMessageDetails.messageText).slice(0, 400) });
                } else if (sn.type === "superStickerEvent" && sn.superStickerDetails) {
                  push({ type: "donation", user, text: "[super sticker]", amount: (Number(sn.superStickerDetails.amountMicros) / 1e6).toFixed(0) + " " + (sn.superStickerDetails.currency || "") });
                }
              }
              pageToken = j.nextPageToken || pageToken;
              var wait = Math.max(5000, Number(j.pollingIntervalMillis) || 5000);
            } catch (e: any) {
              push({ type: "system", user: "system", text: "Poll YouTube gagal: " + e.message });
              var wait = 10000;
            }
            await new Promise((res) => setTimeout(res, wait));
          }
        };
        poll();
      })();
      rt.destroy = () => { stopped = true; timers.forEach(clearTimeout); };
    } else {
      return { ok: false, error: "provider tidak dikenal: " + provider };
    }

    runtime = rt;
    return { ok: true };
  } catch (e: any) {
    try { rt.destroy(); } catch {}
    return { ok: false, error: e.message };
  }
}
