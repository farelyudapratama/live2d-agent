/**
 * client/agent/panel/view.ts — Renderer DOM transcript agent.
 * Rekonsiliasi keyed: setiap blok punya id+rev; elemen dibangun ulang hanya
 * bila rev berubah — teks yang sedang streaming tidak memicu rebuild panel.
 * Anggaran render dijaga: warna solid + hairline, tanpa blur/gradient.
 */

import type { Block } from "./transcript";
import { changeFromTool, MAX_RENDER_ROWS } from "./diff";
import type { FileChange } from "./diff";

export type PlanItem = { id?: string; task: string; status: string; note?: string };

export type PanelViewDeps = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  onApprove: (apId: string, approve: boolean) => void;
};

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function createPanelView(root: HTMLElement, deps: PanelViewDeps) {
  const t = deps.t;
  // ── Skeleton panel ──────────────────────────────────────────────
  const statusbar = el("div", "as-statusbar");
  const pill = el("span", "as-pill");
  const pillDot = el("span", "as-pill-dot");
  const pillLabel = el("span", "as-pill-label");
  pill.appendChild(pillDot);
  pill.appendChild(pillLabel);
  statusbar.appendChild(pill);

  const tl = el("div", "as-tl");
  tl.setAttribute("aria-live", "polite");

  const planBox = el("div", "as-plan hidden");
  const memBox = el("div", "as-plan as-membox hidden");

  root.appendChild(statusbar);
  root.appendChild(planBox);
  root.appendChild(memBox);
  root.appendChild(tl);

  // ── Rekonsiliasi transcript ─────────────────────────────────────
  const rendered = new Map<number, { el: HTMLElement; rev: number }>();
  const openTools = new Set<number>(); // state expand kartu tool per blok id
  const openDiffs = new Set<string>(); // state expand diff (key: `${id}:${path}`)

  // ── Diff & ringkasan perubahan file ─────────────────────────────
  /** Kartu diff satu file: header stat, body berisi hunk (collapsible). */
  function buildDiff(ch: FileChange, key: string, openByDefault = false): HTMLElement {
    const w = el("div", "as-diff");
    w.dataset.kind = ch.kind;
    const hd = el("button", "as-diff-hd") as HTMLButtonElement;
    hd.type = "button";
    hd.appendChild(el("span", "as-diff-kind", ch.kind));
    hd.appendChild(el("span", "as-diff-path", ch.path));
    const stat = el("span", "as-diff-stat");
    stat.appendChild(el("span", "add", "+" + ch.added));
    stat.appendChild(el("span", "del", "−" + ch.removed));
    hd.appendChild(stat);
    hd.appendChild(el("span", "as-chev", "▾"));
    const bd = el("div", "as-diff-bd");
    if (!ch.hunks.length) {
      bd.appendChild(el("div", "as-clipped", t(ch.clipped ? "as.diff.tooBig" : "as.diff.empty")));
    } else {
      let shown = 0;
      let truncated = false;
      for (const h of ch.hunks) {
        if (shown >= MAX_RENDER_ROWS) { truncated = true; break; }
        bd.appendChild(el("div", "as-diff-h",
          "@@ -" + h.aStart + " +" + h.bStart + " @@"));
        for (const r of h.rows) {
          if (shown >= MAX_RENDER_ROWS) { truncated = true; break; }
          const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : " ";
          bd.appendChild(el("div", "as-diff-ln " + r.t, sign + r.text));
          shown++;
        }
      }
      if (truncated || ch.clipped) {
        bd.appendChild(el("span", "as-clipped", t("as.diff.clipped")));
      }
    }
    if (openByDefault || openDiffs.has(key)) w.classList.add("open");
    hd.addEventListener("click", () => {
      w.classList.toggle("open");
      if (w.classList.contains("open")) openDiffs.add(key);
      else openDiffs.delete(key);
    });
    w.appendChild(hd);
    w.appendChild(bd);
    return w;
  }

  /** Kartu ringkasan giliran: "N file berubah +a −r" + baris per file. */
  function buildChanges(b: Extract<Block, { kind: "changes" }>): HTMLElement {
    const w = el("div", "as-blk as-chg");
    const hd = el("div", "as-chg-hd");
    hd.appendChild(el("span", "as-chg-ttl", t("as.chg.files", { n: b.files.length })));
    const stat = el("span", "as-diff-stat");
    stat.appendChild(el("span", "add", "+" + b.added));
    stat.appendChild(el("span", "del", "−" + b.removed));
    hd.appendChild(stat);
    w.appendChild(hd);
    for (const f of b.files) {
      const rowWrap = el("div", "as-chg-item");
      const row = el("button", "as-chg-row") as HTMLButtonElement;
      row.type = "button";
      row.appendChild(el("span", "as-chg-kind", f.kind));
      row.appendChild(el("span", "as-chg-path", f.path));
      const st = el("span", "as-diff-stat");
      st.appendChild(el("span", "add", "+" + f.added));
      st.appendChild(el("span", "del", "−" + f.removed));
      row.appendChild(st);
      const key = b.id + ":" + f.path;
      const body = buildDiff(f, key);
      row.addEventListener("click", () => {
        body.classList.toggle("open");
        if (body.classList.contains("open")) openDiffs.add(key);
        else openDiffs.delete(key);
      });
      rowWrap.appendChild(row);
      rowWrap.appendChild(body);
      w.appendChild(rowWrap);
    }
    return w;
  }

  function nearBottom(): boolean {
    return tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
  }
  function scrollToBottom(): void {
    tl.scrollTop = tl.scrollHeight;
  }

  function buildBlock(b: Block): HTMLElement {
    switch (b.kind) {
      case "user": {
        const w = el("div", "as-blk as-user");
        w.appendChild(el("span", "as-who", t("as.you")));
        w.appendChild(el("div", "as-txt", b.text));
        return w;
      }
      case "agent": {
        const w = el("div", "as-blk as-agent");
        const txt = el("div", "as-txt", b.text);
        if (b.streaming) txt.appendChild(el("span", "as-caret"));
        w.appendChild(txt);
        return w;
      }
      case "final": {
        const w = el("div", "as-blk as-agent as-final");
        w.appendChild(el("span", "as-who", t("as.agentName")));
        w.appendChild(el("div", "as-txt", b.text));
        return w;
      }
      case "speak": {
        const w = el("div", "as-blk as-speak");
        w.appendChild(el("span", "as-who", t("as.speakTag")));
        w.appendChild(el("div", "as-txt", b.text));
        return w;
      }
      case "status": {
        const w = el("div", "as-blk as-status" + (b.variant ? " " + b.variant : ""));
        w.textContent = b.text;
        return w;
      }
      case "tool": {
        const w = el("div", "as-blk as-tool");
        w.dataset.status = b.status;
        const hd = el("button", "as-tool-hd") as HTMLButtonElement;
        hd.type = "button";
        hd.appendChild(el("span", "as-dot"));
        hd.appendChild(el("span", "as-tool-name", b.name));
        if (b.summary) hd.appendChild(el("span", "as-tool-sum", b.summary));
        hd.appendChild(el("span", "as-chev", "▾"));
        const bd = el("div", "as-tool-bd");
        if (b.change) {
          // Mutasi file: diff lebih bermakna daripada JSON argumen mentah.
          bd.appendChild(buildDiff(b.change, String(b.id) + ":" + b.change.path));
        } else if (b.argsText != null) {
          bd.appendChild(el("div", "as-lbl", t("as.tool.args")));
          bd.appendChild(el("pre", "as-tool-args", b.argsText));
        }
        if (b.result != null) {
          bd.appendChild(el("div", "as-lbl", t("as.tool.result")));
          const pre = el("pre", "as-tool-res", b.result);
          if (b.status === "done") {
            pre.appendChild(el("span", "as-clipped", t("as.tool.clipped")));
          }
          bd.appendChild(pre);
        }
        if (openTools.has(b.id)) w.classList.add("open");
        hd.addEventListener("click", () => {
          w.classList.toggle("open");
          if (w.classList.contains("open")) openTools.add(b.id);
          else openTools.delete(b.id);
        });
        w.appendChild(hd);
        w.appendChild(bd);
        return w;
      }
      case "approval": {
        const w = el("div", "as-blk as-appr");
        const hd = el("div", "as-appr-hd");
        hd.appendChild(el("span", "as-appr-ttl", t("as.approve.title")));
        hd.appendChild(el("span", "as-tool-name", b.tool));
        w.appendChild(hd);
        const argsText = (() => {
          try {
            return b.args == null ? "" : JSON.stringify(b.args, null, 2);
          } catch {
            return String(b.args);
          }
        })();
        // Mutasi file → pratinjau diff (terbuka) agar keputusan Allow/Deny
        // berbasis isi, bukan JSON mentah.
        const preview = changeFromTool(b.tool, b.args);
        if (preview && preview.hunks.length) {
          w.appendChild(buildDiff(preview, "appr:" + b.apId, true));
        } else if (argsText) {
          w.appendChild(el("pre", "as-tool-args", argsText));
        }
        const row = el("div", "as-appr-row");
        const ok = el("button", "mini-btn as-appr-ok", t("as.allow")) as HTMLButtonElement;
        ok.type = "button";
        const no = el("button", "mini-btn as-appr-no", t("as.deny")) as HTMLButtonElement;
        no.type = "button";
        ok.addEventListener("click", () => {
          ok.disabled = true;
          no.disabled = true;
          deps.onApprove(b.apId, true);
        });
        no.addEventListener("click", () => {
          ok.disabled = true;
          no.disabled = true;
          deps.onApprove(b.apId, false);
        });
        row.appendChild(ok);
        row.appendChild(no);
        w.appendChild(row);
        return w;
      }
      case "subagent": {
        const w = el("div", "as-blk as-sub");
        w.dataset.state = b.state;
        w.appendChild(el("span", "as-sub-name", b.name));
        w.appendChild(el("span", "as-sub-text", b.text));
        return w;
      }
      case "changes": {
        return buildChanges(b);
      }
    }
  }

  function render(blocks: Block[]): void {
    const stick = nearBottom();
    const seen = new Set<number>();
    let prev: HTMLElement | null = null;
    for (const b of blocks) {
      seen.add(b.id);
      const cur = rendered.get(b.id);
      if (cur && cur.rev === b.rev) {
        prev = cur.el;
        continue;
      }
      const node = buildBlock(b);
      if (cur) {
        cur.el.replaceWith(node);
        cur.el = node;
        cur.rev = b.rev;
      } else {
        if (prev) prev.after(node);
        else tl.insertBefore(node, tl.firstChild);
        rendered.set(b.id, { el: node, rev: b.rev });
      }
      prev = node;
    }
    for (const [id, cur] of rendered) {
      if (!seen.has(id)) {
        cur.el.remove();
        rendered.delete(id);
        openTools.delete(id);
        const pref = id + ":";
        for (const k of [...openDiffs]) if (k.startsWith(pref)) openDiffs.delete(k);
      }
    }
    if (stick) scrollToBottom();
  }

  // ── Widget plan ─────────────────────────────────────────────────
  function renderPlan(plan: PlanItem[]): void {
    planBox.textContent = "";
    if (!plan || !plan.length) {
      planBox.classList.add("hidden");
      return;
    }
    planBox.classList.remove("hidden");
    const head = el("div", "as-plan-head");
    head.appendChild(el("span", "as-plan-ttl", t("as.planTitle")));
    const done = plan.filter((p) => p.status === "done").length;
    head.appendChild(el("span", "as-plan-prog", t("as.plan.progress", { done, total: plan.length })));
    planBox.appendChild(head);
    for (const p of plan) {
      const row = el("div", "as-plan-item");
      row.appendChild(el("span", "st " + p.status, p.status));
      row.appendChild(el("span", "", p.task + (p.note ? " — " : "")));
      if (p.note) row.appendChild(el("span", "note", p.note));
      planBox.appendChild(row);
    }
  }

  // ── Widget memory ───────────────────────────────────────────────
  function renderMemory(entries: Array<{ key: string; value: string }>, onForget: (key: string) => void): void {
    memBox.textContent = "";
    memBox.classList.remove("hidden");
    memBox.appendChild(el("div", "as-plan-ttl", t("as.memTitle")));
    if (!entries.length) {
      memBox.appendChild(el("div", "", t("as.memEmpty")));
      return;
    }
    for (const m of entries) {
      const row = el("div", "as-mem-row");
      row.appendChild(el("span", "k", "[" + m.key + "]"));
      row.appendChild(el("span", "", m.value));
      const forget = el("button", "mini-btn", t("as.memForget")) as HTMLButtonElement;
      forget.type = "button";
      forget.addEventListener("click", () => onForget(m.key));
      row.appendChild(forget);
      memBox.appendChild(row);
    }
  }

  function hideMemory(): void {
    memBox.classList.add("hidden");
    memBox.textContent = "";
  }

  // ── Status pill ─────────────────────────────────────────────────
  type PillState = "off" | "idle" | "busy" | "busyOther" | "thinking";
  function setPill(state: PillState): void {
    pill.dataset.state = state;
    pillLabel.textContent = t(
      state === "off" ? "as.status.off"
        : state === "busy" ? "as.status.busy"
        : state === "busyOther" ? "as.status.busyOther"
        : state === "thinking" ? "as.status.thinking"
        : "as.status.idle",
    );
  }

  function clearTranscript(): void {
    rendered.clear();
    openTools.clear();
    openDiffs.clear();
    tl.textContent = "";
  }

  return { render, renderPlan, renderMemory, hideMemory, setPill, clearTranscript };
}

export type PanelView = ReturnType<typeof createPanelView>;
