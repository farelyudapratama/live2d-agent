/**
 * server/agent/parse.ts — Parsing/pembersihan output model.
 * Directive tool adalah MEKANISME, bukan ucapan: jangan pernah tampil ke
 * panel user atau tersimpan sebagai jawaban.
 */

/**
 * Buang semua varian directive tool dari teks yang ditujukan ke user:
 * "TOOL: ...", "**Tool:** ...", "<tool_call>", dan baris JSON argumen
 * {"name": "list_dir", ...}.
 */
export function stripToolDirective(t: string, toolNames: string[]): string {
  const lines = String(t || "")
    .split("\n")
    .filter((ln) => {
      const s = ln.trim();
      if (!s) return true;
      // Tag tool-call gaya <tool_call> / </tool_call>
      if (/^<\/?tool_call>?$/i.test(s)) return false;
      // "Tool: ...", "**Tool:** ...", "TOOL: nama {...}", "alat: ..."
      if (/^[\s\*#>-]*(?:tool|alat)\s*:/i.test(s)) return false;
      // Baris JSON argumen: {"name": "list_dir", ...}
      if (/^\{.*\}$/.test(s)) {
        try {
          const j = JSON.parse(s);
          if (toolNames.includes(String(j.name || ""))) return false;
        } catch {
          /* bukan JSON valid — biarkan */
        }
      }
      return true;
    });
  return lines.join("\n").replace(/\n{2,}/g, "\n").trim();
}
