/**
 * agent/directive-parser.ts — Parse LLM response into text segments + actions.
 * Handles directives like [EMOTION:senang][GESTURE:nod] etc.
 */

import type { ParsedActions, ParsedSegment, DirectiveType } from "../../shared/types";

const DIRECTIVE_TYPES = "ACTION|EMOTION|HEAD|EYES|MOUTH|ACC|EXPR|BODY|PROP|PROPERTY|GESTURE|MOTION|INTENSITY";
const DIRECTIVE_RE = new RegExp(`\\[(?:${DIRECTIVE_TYPES}):[^\\]]+\\]`, "gi");

export function stripDirectives(text: string): string {
  return String(text || "").replace(DIRECTIVE_RE, "").trim();
}

export function hasDirectives(text: string): boolean {
  return new RegExp(`\\[(?:${DIRECTIVE_TYPES}):`, "i").test(String(text || ""));
}

/**
 * Parse an LLM response into segments.
 * Each segment has text + actions to apply.
 */
export function parseSegments(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const blockRe = new RegExp(`^\\[(${DIRECTIVE_TYPES}):([^\\]]+)\\]\\s*$`, "i");
  const parts = text.split(new RegExp(`(\\[(?:${DIRECTIVE_TYPES}):[^\\]]+\\]\\s*)`, "gi"));

  let currentActions: ParsedActions = {};
  let currentText = "";

  for (const part of parts) {
    const blockMatch = part.match(blockRe);
    if (blockMatch) {
      // Flush current segment if it has text
      const clean = currentText.trim();
      if (clean) {
        segments.push({ text: clean, actions: { ...currentActions } });
        currentText = "";
      }

      const type = blockMatch[1].toUpperCase();
      const val = blockMatch[2].trim();

      switch (type) {
        case "EMOTION":
        case "EXPR":
          currentActions.emotion = val;
          break;
        case "HEAD": {
          const p = val.split(",").map(Number);
          if (p.length >= 2) currentActions.head = { x: p[0], y: p[1] };
          break;
        }
        case "EYES": {
          const p = val.split(",").map(Number);
          if (p.length >= 2) currentActions.eyes = { x: p[0], y: p[1] };
          break;
        }
        case "MOUTH": {
          const p = val.split(",").map(Number);
          if (p.length >= 2) currentActions.mouth = { form: p[0], open: p[1] };
          break;
        }
        case "BODY": {
          const p = val.split(",").map(Number);
          // `|| 0` (bukan `?? 0`): NaN dari mis. "[BODY:a,b]" harus jatuh ke 0,
          // bukan menyebar jadi NaN di pose.
          if (p.length >= 2) currentActions.body = { x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 };
          break;
        }
        case "ACC": {
          const p = val.split(":");
          if (p.length >= 2) {
            if (!currentActions.accessories) currentActions.accessories = {};
            currentActions.accessories[p[0]] = Number(p[1]) || 0;
          }
          break;
        }
        case "PROP":
        case "PROPERTY":
          currentActions.property = val;
          break;
        case "GESTURE":
          currentActions.gesture = val;
          break;
        case "MOTION":
          currentActions.motion = val;
          break;
        case "INTENSITY": {
          const n = Number(val);
          if (Number.isFinite(n)) currentActions.intensity = Math.max(0.1, Math.min(1, n));
          break;
        }
      }
    } else {
      currentText += part;
    }
  }

  // Flush remaining
  const clean = currentText.trim();
  if (clean || Object.keys(currentActions).length) {
    segments.push({ text: clean, actions: { ...currentActions } });
  }

  // Fallback: plain text with no directives
  if (!segments.length && text.trim()) {
    segments.push({ text: text.trim(), actions: {} });
  }

  return segments;
}

// Matching gesture for the fallback path (no directives at all from the LLM)
// — so even the "worst case" still plays a real, recognizable motion instead
// of just a static pose + idle mouth-flap. Dipakai applyActions() dan
// segmentTextFallback().
export const EMOTION_GESTURE_FALLBACK: Record<string, string> = {
  senang: "lean_excited",
  sedih: "look_away_shy",
  malu: "look_away_shy",
  kaget: "recoil_surprised",
  normal: "nod",
};

/**
 * Guess emotion from text content (fallback when no directives).
 */
export function guessEmotion(text: string): string {
  const t = String(text || "").toLowerCase();
  if (/(senang|gembira|hehe|haha|lucu|mantap|yes|hore|terima kasih|makasih|love|sayang|seru|asik|keren)/.test(t)) return "senang";
  if (/(senyum|senang|suka|ramah|halo|hai)/.test(t)) return "tersenyum";
  if (/(sedih|kecewa|sepi|rindu|galau|huhu|nangis|kasihan)/.test(t)) return "sedih";
  if (/(malu|grogi|cantik|ganteng|pacar|cium|peluk|dekat|mesra|blush)/.test(t)) return "malu";
  if (/(wah|kaget|serius|gila|astaga|beneran|loo|wow|hah|apa)/.test(t)) return "kaget";
  if (/(kesal|marah|bete|sebel|benci|gamau|ngambek)/.test(t)) return "kesal";
  if (/(bingung|gimana|kenapa|maksudnya|ragu|entah|mikir)/.test(t)) return "bingung";
  return "normal";
}

/**
 * Smart text segmentation fallback (when LLM returns plain text without directives).
 */
export function segmentTextFallback(text: string): ParsedSegment[] {
  const clauses = text.split(/(?<=[.!?~…\n]+)\s+|(?<=,\s+)(?=[A-Z0-9\u4e00-\u9fff])/g).filter((c) => c.trim().length > 0);
  if (!clauses.length) clauses.push(text);

  return clauses.map((clause, idx) => {
    const emo = guessEmotion(clause);
    const gest = EMOTION_GESTURE_FALLBACK[emo] || (idx === 0 ? "wave_hi" : "nod");
    return {
      text: clause.trim(),
      actions: {
        emotion: emo,
        gesture: gest,
        intensity: emo === "normal" ? 0.5 : 0.85,
      },
    };
  });
}
