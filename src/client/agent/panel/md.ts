/**
 * client/agent/panel/md.ts — Parser markdown mini untuk jawaban agent
 * (murni, tanpa DOM/jaringan — diuji langsung dengan bun test).
 *
 * Tanpa dependency (bundle zero-dep) dan XSS-safe by design: parser HANYA
 * menghasilkan token data; view.ts merender via createElement/textContent —
 * tidak pernah innerHTML konten model.
 *
 * Cakupan (cukup untuk jawaban coding-agent):
 *   heading #..######, paragraf, fenced code ```lang, blockquote >,
 *   list ul (- * +) / ol (1. / 1)), inline: `code`, **bold**, *italic*,
 *   _italic_ (dengan guard word-boundary agar snake_case aman),
 *   link [teks](http(s)://...) — href non-http dirender teks biasa.
 */

export type MdInline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "bold"; text: string }
  | { t: "italic"; text: string }
  | { t: "link"; text: string; href: string };

export type MdToken =
  | { t: "h"; level: number; inlines: MdInline[] }
  | { t: "p"; inlines: MdInline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; inlines: MdInline[] }
  | { t: "ul"; items: MdInline[][] }
  | { t: "ol"; items: MdInline[][] };

const INLINE_RE =
  /(`+)([^`]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w\\])\*(?!\s)([^*\n]+?)\*(?![\w])|(?<![\w\\])_(?!_)([^_\n]+?)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/;

/** Parse satu potong teks jadi deret inline (rekursif pada sisa teks). */
export function parseInlines(s: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = String(s ?? "");
  for (;;) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) out.push({ t: "text", text: rest.slice(0, m.index) });
    if (m[2] !== undefined) out.push({ t: "code", text: m[2] });
    else if (m[3] !== undefined) out.push({ t: "bold", text: m[3] });
    else if (m[4] !== undefined) out.push({ t: "bold", text: m[4] });
    else if (m[5] !== undefined) out.push({ t: "italic", text: m[5] });
    else if (m[6] !== undefined) out.push({ t: "italic", text: m[6] });
    else if (m[7] !== undefined && m[8] !== undefined) {
      out.push({ t: "link", text: m[7], href: m[8] });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ t: "text", text: rest });
  return out;
}

const RE_FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RE_HEAD = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_QUOTE = /^\s*>\s?/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*\d+[.)]\s+(.*)$/;

/** Parse teks markdown jadi pohon token blok. */
export function parseMarkdown(src: string): MdToken[] {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const tokens: MdToken[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code — ambil apa adanya, tanpa inline parsing.
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const lang = fence[2] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp("^\\s*" + mark.charAt(0) + "{" + mark.length + "}\\s*$").test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // baris penutup (atau habis)
      tokens.push({ t: "code", lang, text: body.join("\n") });
      continue;
    }

    const head = RE_HEAD.exec(line);
    if (head) {
      tokens.push({ t: "h", level: head[1].length, inlines: parseInlines(head[2]) });
      i++;
      continue;
    }

    // Blockquote — gabung baris berurutan (">" opsional di baris kosong).
    if (RE_QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        body.push(lines[i].replace(RE_QUOTE, ""));
        i++;
      }
      tokens.push({ t: "quote", inlines: parseInlines(body.join("\n").trim()) });
      continue;
    }

    // List — kelompokkan item berurutan (ul & ol tidak dicampur satu grup).
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = RE_OL.test(line) && !RE_UL.test(line);
      const re = ordered ? RE_OL : RE_UL;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) { items.push(parseInlines(m[1])); i++; continue; }
        // lanjutan item (indentasi) menempel ke item terakhir
        if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].push({ t: "text", text: " " + lines[i].trim() });
          i++;
          continue;
        }
        break;
      }
      tokens.push(ordered ? { t: "ol", items } : { t: "ul", items });
      continue;
    }

    // Paragraf — baris non-kosong berurutan digabung dengan newline.
    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() &&
      !RE_FENCE.test(lines[i]) && !RE_HEAD.test(lines[i]) &&
      !RE_QUOTE.test(lines[i]) && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) tokens.push({ t: "p", inlines: parseInlines(para.join("\n")) });
  }
  return tokens;
}
