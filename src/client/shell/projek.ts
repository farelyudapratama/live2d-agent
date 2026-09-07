/**
 * client/shell/projek.ts — Rail projek shell (activity bar → rail kiri).
 * Isi #projek-rail dibangun di sini (TS, di-bundle sebagai
 * window.__shellProjek) — BUKAN legacy JS (aturan AGENTS.md).
 *
 * Isi: indikator project (nama = basename workdir, klik = salin path) +
 * riwayat sesi assistant (list/new/switch/delete via /api/assistant/
 * sessions*). Setelah switch sukses, dispatch event DOM
 * `agent:session-changed` — panel agent yang menangkap (hydrate transcript).
 */

const API = location.origin;
const LS_KEY = "live2d.projekRail.open";

type SessionItem = { id: string; name: string; workDir: string; ts: number; count: number };
type SessionsResp = { active: string; sessions: SessionItem[] };

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function getT() {
  const i = (window as any).__i18n;
  return (k: string, v?: Record<string, string | number>) => (i ? i.t(k, v) : k);
}

async function fetchJSON(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || "HTTP " + r.status);
  return d;
}

export function startProjekRail(): () => void {
  const t = getT();
  const railEl = document.getElementById("projek-rail");
  const btnEl = document.getElementById("btn-projek-rail");
  if (!railEl || !btnEl) return () => {};
  const rail: HTMLElement = railEl;
  const btn = btnEl as HTMLButtonElement;

  let destroyed = false;
  let open = false;
  try { open = localStorage.getItem(LS_KEY) === "1"; } catch {}

  function setOpen(v: boolean): void {
    open = v;
    rail.classList.toggle("hidden", !open);
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
    try { localStorage.setItem(LS_KEY, open ? "1" : "0"); } catch {}
    if (open) void draw();
  }

  /** Gambar seluruh isi rail: kartu project + daftar sesi. */
  async function draw(): Promise<void> {
    if (destroyed || !open) return;
    rail.textContent = "";
    rail.appendChild(el("div", "prj-title", t("shell.projek.title")));

    // ── Kartu project (workdir aktif dari /status) ──
    let workDir = "";
    try {
      const st = await fetchJSON(API + "/api/assistant/status");
      workDir = String(st.workDir || "");
    } catch {}
    const card = el("button", "prj-card") as HTMLButtonElement;
    card.type = "button";
    if (workDir) {
      const nm = workDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workDir;
      card.appendChild(el("span", "name", nm));
      card.appendChild(el("span", "path", workDir));
      card.setAttribute("title", t("shell.projek.copyTip"));
      card.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(workDir);
          const old = card.querySelector(".path")?.textContent;
          const p = card.querySelector(".path");
          if (p) p.textContent = t("shell.projek.copied");
          setTimeout(() => { if (p) p.textContent = old || workDir; }, 1200);
        } catch {}
      });
    } else {
      card.appendChild(el("span", "name", t("shell.projek.noProject")));
    }
    rail.appendChild(card);

    // ── Daftar sesi assistant ──
    rail.appendChild(el("div", "prj-title", t("as.sess.title")));
    const head = el("div", "note-row");
    const newBtn = el("button", "mini-btn", t("as.sess.new")) as HTMLButtonElement;
    newBtn.type = "button";
    newBtn.addEventListener("click", () => { void newSession(); });
    head.appendChild(newBtn);
    rail.appendChild(head);

    const listBox = el("div", "prj-sess");
    rail.appendChild(listBox);
    let data: SessionsResp;
    try {
      data = await fetchJSON(API + "/api/assistant/sessions");
    } catch (e: any) {
      listBox.appendChild(el("div", "prj-empty", "✗ " + (e?.message || e)));
      return;
    }
    if (!data.sessions?.length) {
      listBox.appendChild(el("div", "prj-empty", t("as.sess.empty")));
      return;
    }
    for (const s of data.sessions) {
      listBox.appendChild(sessionRow(s, data.active === s.id));
    }
  }

  function sessionRow(s: SessionItem, active: boolean): HTMLElement {
    const t2 = getT();
    const row = el("button", "prj-sess-item" + (active ? " active" : "")) as HTMLButtonElement;
    row.type = "button";
    row.appendChild(el("span", "nm", s.name));
    row.appendChild(el("span", "meta", t2("as.sess.count", { n: s.count })));
    const del = el("span", "del", "✕");
    del.setAttribute("title", t2("as.sess.delete"));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(t2("as.sess.deleteTip", { name: s.name }))) void removeSession(s.id);
    });
    row.appendChild(del);
    row.addEventListener("click", () => { void switchSession(s.id); });
    return row;
  }

  function notifySessionChanged(): void {
    window.dispatchEvent(new CustomEvent("agent:session-changed"));
  }

  async function newSession(): Promise<void> {
    try {
      await fetchJSON(API + "/api/assistant/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      notifySessionChanged();
      await draw();
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  async function switchSession(id: string): Promise<void> {
    try {
      await fetchJSON(API + "/api/assistant/sessions/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      notifySessionChanged();
      await draw();
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  async function removeSession(id: string): Promise<void> {
    try {
      await fetchJSON(API + "/api/assistant/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      notifySessionChanged();
      await draw();
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  const onBtn = () => setOpen(!open);
  btn.addEventListener("click", onBtn);

  // Sesi bisa berubah dari luar (CLI menulis store) → segarkan saat rail
  // terbuka tiap 8 dtk (murah: satu GET ringan).
  const iv = setInterval(() => { if (open) void draw(); }, 8000);

  setOpen(open);

  return function destroyProjekRail() {
    destroyed = true;
    clearInterval(iv);
    btn.removeEventListener("click", onBtn);
    rail.textContent = "";
  };
}
