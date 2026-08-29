/**
 * test/motion-taxonomy.test.ts — guard untuk src/client/engine/motion-taxonomy.ts.
 *
 * Konversi 1:1 dari test/legacy/test-motion-taxonomy.js (port v1), dengan satu
 * perbedaan penting: suite ini mengimpor modul TS yang BENAR-BENAR dipakai
 * bundle browser dan server — bukan salinan logika. Semua skenario v1 dipertahankan:
 * analisa kurva (opaque names), fallback name-hint, dominasi kurva atas nama,
 * rescue cdi3 untuk id opak, flag vs ramp, gating emosi, dan file asli di disk.
 */
import { describe, it, expect } from "bun:test";
import * as T from "../src/client/engine/motion-taxonomy";
import * as fs from "fs";
import * as path from "path";

// ── Segment stream builders (mirror the real motion3 wire format) ──
function linear(points: [number, number][]): number[] {
  const s: number[] = [points[0][0], points[0][1]];
  for (let i = 1; i < points.length; i++) s.push(0, points[i][0], points[i][1]);
  return s;
}
function bezier(points: [number, number][]): number[] {
  const s: number[] = [points[0][0], points[0][1]];
  for (let i = 1; i < points.length; i++) {
    const [pt, pv] = points[i - 1], [t, v] = points[i];
    const c1t = pt + (t - pt) / 3, c2t = pt + 2 * (t - pt) / 3;
    const c1v = pv + (v - pv) / 3, c2v = pv + 2 * (v - pv) / 3;
    s.push(1, c1t, c1v, c2t, c2v, t, v);
  }
  return s;
}
function clip(curves: any[], duration = 2) {
  return { Meta: { Duration: duration, Fps: 30 }, Curves: curves };
}
function curve(id: string, segments: number[]) {
  return { Target: 'Parameter', Id: id, Segments: segments };
}

describe("taxonomy A) synthetic clips — curve analysis only (opaque names)", () => {
  it("nod (angleY oscillation, bezier)", () => {
    expect(T.classifyClip(clip([curve('ParamAngleY', bezier([[0,0],[0.3,-18],[0.7,10],[1.1,-8],[1.6,0]]))]), 'clip_a').verb).toBe('nod');
  });
  it("shake (angleX oscillation, linear)", () => {
    expect(T.classifyClip(clip([curve('ParamAngleX', linear([[0,0],[0.25,-20],[0.6,18],[0.95,-12],[1.4,0]]))]), 'x1').verb).toBe('shake');
  });
  it("tilt (angleZ sustained, no reversal)", () => {
    expect(T.classifyClip(clip([curve('ParamAngleZ', bezier([[0,0],[0.5,12],[2.0,12]]))]), 'x2').verb).toBe('tilt');
  });
  it("happy (eyeSmile + mouthForm high)", () => {
    expect(T.classifyClip(clip([
      curve('ParamEyeLSmile', bezier([[0,0],[0.4,1],[2,1]])),
      curve('ParamMouthForm', bezier([[0,0],[0.4,0.9],[2,0.9]])),
    ]), 'x3').verb).toBe('happy');
  });
  it("sad (browY down + mouthForm down)", () => {
    expect(T.classifyClip(clip([
      curve('ParamBrowLY', bezier([[0,0],[0.5,-0.8],[2,-0.7]])),
      curve('ParamMouthForm', bezier([[0,0],[0.5,-0.6],[2,-0.5]])),
    ]), 'x4').verb).toBe('sad');
  });
  it("angry (browAngle in + mouth down)", () => {
    expect(T.classifyClip(clip([
      curve('ParamBrowLAngle', bezier([[0,0],[0.3,0.9],[2,0.8]])),
      curve('ParamMouthForm', bezier([[0,0],[0.3,-0.5],[2,-0.4]])),
    ]), 'x5').verb).toBe('angry');
  });
  it("surprised (fast mouth-open onset)", () => {
    expect(T.classifyClip(clip([
      curve('ParamMouthOpenY', linear([[0,0],[0.12,1],[0.5,0.8],[2,0.3]])),
      curve('ParamEyeLOpen', linear([[0,1],[0.12,1],[2,1]])),
    ]), 'x6', 2).verb).toBe('surprised');
  });
  it("shy (blush sustained)", () => {
    expect(T.classifyClip(clip([curve('ParamBlush', bezier([[0,0],[0.4,1],[2,0.9]]))]), 'x7').verb).toBe('shy');
  });
  it("sleep (eyes held closed)", () => {
    expect(T.classifyClip(clip([curve('ParamEyeLOpen', bezier([[0,1],[0.5,0],[3,0]]))]), 'x8', 3).verb).toBe('sleep');
  });
  it("lookaway (gaze offset, head still)", () => {
    expect(T.classifyClip(clip([curve('ParamEyeBallX', bezier([[0,0],[0.4,-0.8],[2,-0.75]]))]), 'x9').verb).toBe('lookaway');
  });
  it("blink is NOT sleep (returns to open → not sustained)", () => {
    const blink = T.classifyClip(clip([curve('ParamEyeLOpen', linear([[0,1],[0.08,0],[0.16,1],[1,1]]))]), 'x10', 1);
    expect(blink.verb).not.toBe('sleep');
  });
  it("empty clip -> neutral", () => {
    expect(T.classifyClip(clip([]), 'x11').verb).toBe('neutral');
  });
  it("null clip -> neutral", () => {
    expect(T.classifyClip(null, 'x12').verb).toBe('neutral');
  });
});

describe("taxonomy B) name-hint fallback (no curves available)", () => {
  it("name hint shakehead", () => {
    expect(T.classifyClip(null, 'w-cool-shakehead04').verb).toBe('shake');
  });
  it("name hint smile", () => {
    expect(T.classifyClip(null, 'face_smile_03').verb).toBe('happy');
  });
  it("name hint cry", () => {
    expect(T.classifyClip(null, 'w-sad-cry01').verb).toBe('sad');
  });
  it("name hint wave", () => {
    expect(T.classifyClip(null, 'shakehand_hello').verb).toBe('wave');
  });
});

describe("taxonomy C) curve evidence must OUTRANK a misleading filename", () => {
  // A file named "...sad..." whose curves are unmistakably a nod. Curve score
  // (0.75) must beat the name bonus (0.35).
  it("curves beat wrong name", () => {
    const conflicted = T.classifyClip(
      clip([curve('ParamAngleY', bezier([[0,0],[0.3,-18],[0.7,10],[1.1,-8],[1.6,0]]))]),
      'w-cool-sad01');
    expect(conflicted.verb).toBe('nod');
  });
});

describe("taxonomy D) opaque parameter IDs rescued by .cdi3.json display names", () => {
  // THE core robustness test. Parameter ids carry ZERO meaning (dari model asli:
  // ParamEX10/ParamAnime01/Param92). Hanya display name cdi3 yang bisa membaca.
  const fakeCdi3 = {
    Parameters: [
      { Id: 'ParamEX10', Name: 'tear' },
      { Id: 'ParamEX06', Name: 'angry eye' },
      { Id: 'ParamEX11', Name: 'blush' },
      { Id: 'ParamAnime01', Name: 'guruguru' },
      { Id: 'Param92', Name: '\u751f\u6c14' },          // Chinese: "angry"
      { Id: 'Param91', Name: '\u8138\u7ea2' },          // Chinese: "blush"
      { Id: 'P_7f3a', Name: 'angle Z' },            // opaque id, readable label
      { Id: 'zzz1', Name: '\u53e3\u958b\u304d' },       // Japanese: "mouth open"
    ],
  };
  const rm = T.buildRoleMap(fakeCdi3);

  it("roleMap resolves all 8 opaque ids", () => {
    expect(Object.keys(rm.map).length).toBe(8);
  });
  it("every one needed the display name", () => {
    expect(rm.stats.byDisplay).toBe(8);
  });
  it("none were readable from the id", () => {
    expect(rm.stats.byId).toBe(0);
  });

  const tearClip = clip([curve('ParamEX10', bezier([[0,0],[0.4,1],[2,1]]))]);
  it("tear clip WITHOUT roleMap -> blind", () => {
    expect(T.classifyClip(tearClip, 'm_014').verb).toBe('neutral');
  });
  it("tear clip WITH roleMap -> sad", () => {
    expect(T.classifyClip(tearClip, 'm_014', rm.map).verb).toBe('sad');
  });
  it('Chinese "生气" flag -> angry', () => {
    const cnAngry = clip([curve('Param92', bezier([[0,0],[0.3,1],[2,1]]))]);
    expect(T.classifyClip(cnAngry, 'm_027', rm.map).verb).toBe('angry');
  });
  it('Japanese "口開き" -> surprised', () => {
    const jpMouth = clip([curve('zzz1', linear([[0,0],[0.1,1],[0.5,0.8],[2,0.3]]))]);
    expect(T.classifyClip(jpMouth, 'm_003', rm.map).verb).toBe('surprised');
  });
  it('opaque id + "angle Z" label -> tilt', () => {
    const opaqueTilt = clip([curve('P_7f3a', bezier([[0,0],[0.5,14],[2,14]]))]);
    expect(T.classifyClip(opaqueTilt, 'm_055', rm.map).verb).toBe('tilt');
  });
  it("cdi3 flag OUTRANKS a lying name", () => {
    const cnAngry = clip([curve('Param92', bezier([[0,0],[0.3,1],[2,1]]))]);
    expect(T.classifyClip(cnAngry, 'w-cool-happy-smile07', rm.map).verb).toBe('angry');
  });
  it("slow tear RAMP is not sad (timeline driver, lumine's real idle shape)", () => {
    const tearRamp = clip([curve('ParamEX10', linear([[0,0],[5,25],[10,50]]))]);
    expect(T.classifyClip(tearRamp, 'm_099', rm.map).verb).toBe('neutral');
  });
  it("tear toggled on and HELD is sad", () => {
    const tearHold = clip([curve('ParamEX10', linear([[0,0],[0.3,50],[10,50]]))]);
    expect(T.classifyClip(tearHold, 'm_098', rm.map).verb).toBe('sad');
  });
  it("buildTaxonomy threads the roleMap through to every clip", () => {
    const opaqueSet = [
      { name: 'm_001', motion3: tearClip },
      { name: 'm_002', motion3: clip([curve('Param92', bezier([[0,0],[0.3,1],[2,1]]))]) },
      { name: 'm_003', motion3: clip([curve('Param91', bezier([[0,0],[0.4,0.9],[2,0.9]]))]) },
    ];
    const blind = T.buildTaxonomy(opaqueSet);
    const sighted = T.buildTaxonomy(opaqueSet, rm.map);
    expect(blind.stats.curveClassified).toBe(0);
    expect(sighted.stats.curveClassified).toBe(3);
    expect(Object.keys(sighted.byVerb).sort().join(',')).toBe('angry,sad,shy');
  });
});

describe("taxonomy E) name hints must NOT be model-specific", () => {
  // Model dengan group bernomor (sangat umum) TIDAK boleh dipetakan diam-diam
  // ke verb nyata — 'neutral' jujur memberi tahu runtime memakai gesture.
  for (const n of ['m_001', '\u30e2\u30fc\u30b7\u30e7\u30f31', '\u52a8\u4f5c7', 'a5rn', '02']) {
    it(`opaque name "${n}" -> no false verb`, () => {
      expect(T.classifyClip(null, n).verb).toBe('neutral');
    });
  }
  it("opaque name confidence stays low", () => {
    expect(T.classifyClip(null, 'm_001').confidence).toBeLessThanOrEqual(0.2);
  });
  it('JP 笑顔 -> happy', () => {
    expect(T.classifyClip(null, 'face_\u7b11\u9854_02').verb).toBe('happy');
  });
  it('CN 难过 -> sad', () => {
    expect(T.classifyClip(null, '\u96be\u8fc7_01').verb).toBe('sad');
  });
  it('KR 끄덕 (nod) -> nod', () => {
    expect(T.classifyClip(null, '\ub044\ub355\uc774\uae30').verb).toBe('nod');
  });
  it('KR 기울 (tilt) -> tilt', () => {
    expect(T.classifyClip(null, '\uace0\uac1c_\uae30\uc6b8\uc774\uae30').verb).toBe('tilt');
  });
});

describe("taxonomy F) emotion gating", () => {
  const byVerb: Record<string, string[]> = { happy: ['h1','h2'], sad: ['s1'], nod: ['n1'], neutral: ['z1'] };
  it("senang picks a positive verb (deterministic RNG)", () => {
    const pickHappy = T.pickClipForEmotion(byVerb, 'senang', () => 0.01);
    expect(pickHappy && pickHappy.verb).toBe('happy');
  });
  it("sad clip blocked for senang", () => {
    expect(T.isCompatible('sad', 'senang')).toBe(false);
  });
  it("sad clip allowed for sedih", () => {
    expect(T.isCompatible('sad', 'sedih')).toBe(true);
  });
  it("no compatible clips -> null", () => {
    expect(T.pickClipForEmotion({ sad: ['s1'] }, 'senang')).toBeNull();
  });
});

describe("taxonomy G) real files on disk (data/model)", () => {
  // Verifikasi file .motion3.json asli di repo bisa diparse tanpa throw, dan
  // cdi3 rescue bekerja pada model sungguhan (lumine / 神宫白子). Bila repo
  // tidak punya model, test dilewati (bukan kegagalan) — sama seperti v1.
  const modelDir = path.join(__dirname, "..", "data", "model");

  function findFile(dir: string, re: RegExp): string | null {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findFile(full, re); if (r) return r; }
      else if (re.test(e.name)) return full;
    }
    return null;
  }

  it("every real .motion3.json parses and classifies without throwing", () => {
    const found: string[] = [];
    (function walk(d: string) {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.motion3\.json$/i.test(e.name)) found.push(full);
      }
    })(modelDir);
    if (!found.length) {
      console.log("  (no .motion3.json in data/model — skipping, not a failure)");
      expect(true).toBe(true);
      return;
    }
    // Satu roleMap per folder model teratas (rescue cdi3, sama seperti server).
    const roleMaps: Record<string, Record<string, string>> = {};
    for (const folder of fs.readdirSync(modelDir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const dir = path.join(modelDir, folder.name);
      const cdi = findFile(dir, /\.cdi3\.json$/i);
      if (!cdi) continue;
      const built = T.buildRoleMap(JSON.parse(fs.readFileSync(cdi, "utf8")));
      roleMaps[dir] = built.map;
    }
    const mapFor = (f: string): Record<string, string> | null => {
      for (const dir in roleMaps) if (f.startsWith(dir)) return roleMaps[dir];
      return null;
    };
    for (const f of found) {
      const m3 = JSON.parse(fs.readFileSync(f, "utf8"));
      const nm = path.basename(f).replace(/\.motion3\.json$/i, "");
      const withMap = T.classifyClip(m3, nm, mapFor(f));
      expect(withMap.verb.length).toBeGreaterThan(0);
      expect(T.VERBS as readonly string[]).toContain(withMap.verb);
    }
    const input = found.map(f => ({
      name: path.basename(f).replace(/\.motion3\.json$/i, ""),
      motion3: JSON.parse(fs.readFileSync(f, "utf8")),
      _map: mapFor(f),
    }));
    const built = T.buildTaxonomy(input, input[0]._map);
    expect(built.stats.total).toBe(found.length);
  });
});
