/**
 * engine/motion-taxonomy.ts — classify Live2D .motion3.json clips into SEMANTIC VERBS.
 * Port of static/js/motion-taxonomy.js (UMD) to TypeScript — single source of truth
 * untuk client (bundle) dan server (import langsung).
 *
 * WHY THIS EXISTS
 * ---------------
 * A model like Ichika ships 300+ motion groups with names like
 * "w-cool-sad01", "face_smile_03", "w-normal-shakehead04". The old code picked
 * one uniformly at random every ~1.5s while the character was talking, so a
 * crying clip could fire mid-happy-sentence. That is the root cause of
 * "animasinya nggak sesuai konteks".
 *
 * The fix: give every clip a semantic label ONCE (at import), then let the
 * runtime pick only from clips whose label is compatible with the emotion the
 * AI is currently expressing.
 *
 * TWO TIERS OF EVIDENCE
 * ---------------------
 *  1. CURVE ANALYSIS (primary, language-independent, works on any naming
 *     convention): decode each parameter curve and measure what the clip
 *     actually DOES — does the head oscillate vertically (nod)? horizontally
 *     (shake)? does the mouth corner go up and stay up (happy)? This is
 *     ground truth, not a guess.
 *  2. NAME HINTS (secondary): most riggers do encode intent in the filename.
 *     Used to break ties, to raise confidence, and as the ONLY source when the
 *     .motion3.json files aren't reachable (e.g. a sheet was generated on a
 *     previous import and the model folder has since moved).
 *
 * Aturan model-agnostic berlaku penuh di sini: tidak ada nama model, id
 * parameter, atau skema penamaan spesifik yang boleh masuk ke pola mana pun
 * (lihat docs/MODEL-AGNOSTIC-RULES.md).
 */

// ── Canonical verb set ──────────────────────────────────────────
// Deliberately small. The LLM only ever picks from THESE, and the runtime
// resolves a verb to a real clip. Keeping the set small means the LLM makes
// fewer bad choices than if it saw 300 raw group names.
export const VERBS = [
  'nod',        // agreement, acknowledgement (head pitch oscillation)
  'shake',      // disagreement, denial (head yaw oscillation)
  'tilt',       // curiosity, listening (sustained head roll)
  'happy',      // smile / delight (mouth corners + eye smile up)
  'sad',        // dejection (brows down, mouth corners down)
  'angry',      // irritation (brows angled in, mouth down)
  'surprised',  // shock (fast eyes-wide + mouth-open onset)
  'shy',        // embarrassment (blush + look away)
  'think',      // pondering (sustained gaze offset + slight tilt)
  'wave',       // greeting (arm/body params, large amplitude)
  'sleep',      // drowsy (eyes closed sustained)
  'lookaway',   // averted gaze (sustained eyeball offset)
  'lean',       // body weight shift toward/away
  'neutral',    // idle-ish, no strong signal
] as const;
export type Verb = (typeof VERBS)[number];

// Emotional valence of each verb. Used to HARD-BLOCK incompatible clips:
// a 'negative' clip must never fire while the character expresses joy.
export const VERB_VALENCE: Record<string, string> = {
  nod: 'neutral', shake: 'neutral', tilt: 'neutral', think: 'neutral',
  lookaway: 'neutral', lean: 'neutral', neutral: 'neutral', sleep: 'neutral',
  happy: 'positive', wave: 'positive',
  sad: 'negative', angry: 'negative', shy: 'soft', surprised: 'alert',
};

// Emotion (the app's Indonesian emotion vocabulary) → verbs allowed to play.
// Ordered by preference: the runtime tries the first verb that has clips.
export const EMOTION_VERBS: Record<string, string[]> = {
  senang:    ['happy', 'nod', 'lean', 'wave', 'tilt'],
  tersenyum: ['happy', 'nod', 'tilt'],
  sedih:     ['sad', 'lookaway', 'think', 'tilt'],
  malu:      ['shy', 'lookaway', 'tilt'],
  kaget:     ['surprised', 'shake', 'lean'],
  kesal:     ['angry', 'shake'],
  bingung:   ['think', 'tilt', 'shake', 'lookaway'],
  normal:    ['neutral', 'nod', 'tilt', 'lookaway', 'think'],
};

// ── Role resolution for curve ids (compact, model-agnostic) ─────
// Mirrors app.js ROLE_KEYWORDS but only for the roles that matter to
// classification. Kept local so this module stays dependency-free.
const ROLE_PATTERNS: Record<string, RegExp[]> = {
  angleX:   [/^param(?:_)?anglex$/i, /anglex/i, /(?:^|_)yaw/i, /頭.*横/, /头.*左右/],
  angleY:   [/^param(?:_)?angley$/i, /angley/i, /(?:^|_)pitch/i, /頭.*縦/, /头.*上下/],
  angleZ:   [/^param(?:_)?anglez$/i, /anglez/i, /(?:^|_)roll/i, /傾/, /倾/],
  eyeBallX: [/eyeballx/i, /瞳.*x/i, /眼球.*x/i],
  eyeBallY: [/eyebally/i, /瞳.*y/i, /眼球.*y/i],
  eyeLOpen: [/eyelopen/i, /eye_l_open/i, /左目.*開/, /左眼.*开/],
  eyeROpen: [/eyeropen/i, /eye_r_open/i, /右目.*開/, /右眼.*开/],
  eyeSmile: [/eye[lr]?smile/i, /目.*笑/, /眼.*笑/],
  mouthForm:  [/mouthform(?!\d)/i, /口角/, /口形/, /嘴形/],
  mouthOpenY: [/mouthopeny/i, /mouthopen(?!x)/i, /口.*開/, /张口/, /张嘴/],
  browY:     [/brow[lr]?y(?!\w)/i, /眉.*上下/, /眉.*y/i],
  browAngle: [/brow[lr]?angle/i, /眉.*角/],
  browForm:  [/brow[lr]?form/i, /眉.*形/],
  bodyX: [/bodyanglex/i, /体.*x/i, /胴.*x/i],
  bodyY: [/bodyangley/i, /体.*y/i, /胴.*y/i],
  bodyZ: [/bodyanglez/i, /体.*z/i, /胴.*z/i],
  blush: [/blush/i, /cheek(?!puff)/i, /頬/, /脸红/],
  arm:   [/arm/i, /hand/i, /腕/, /手/],
};

export function roleOf(id: string): string | null {
  for (const role in ROLE_PATTERNS) {
    for (const re of ROLE_PATTERNS[role]) if (re.test(id)) return role;
  }
  return null;
}

// ── Role resolution from .cdi3.json DISPLAY NAMES ───────────────
// Parameter IDs are frequently opaque: this repo's own models drive
// 'ParamAnime01', 'ParamEX10', 'Param92' — none of which any id regex can
// read. But the rigger ALSO ships a cdi3 file naming those same params
// 'guruguru', 'tear', '生气'. That is authored semantics straight from the
// model's creator, so it beats anything we could guess from a filename.
//
// These patterns describe what a rigger would plausibly TYPE as a label, in
// the languages Cubism is actually used in — not the naming scheme of any one
// model we happened to test against.
const DISPLAY_PATTERNS: Record<string, RegExp[]> = {
  angleX:     [/\bangle\s*x\b/i, /\byaw\b/i, /head.*(?:left|right|horiz)/i, /頭.*横/, /头.*左右/],
  angleY:     [/\bangle\s*y\b/i, /\bpitch\b/i, /head.*(?:up|down|vert)/i, /頭.*縦/, /头.*上下/],
  angleZ:     [/\bangle\s*z\b/i, /\broll\b/i, /\btilt\b/i, /傾/, /倾/, /歪/],
  eyeBallX:   [/eye\s*ball\s*x/i, /\bgaze\s*x/i, /瞳.*[xX横]/, /眼球.*[xX]/],
  eyeBallY:   [/eye\s*ball\s*y/i, /\bgaze\s*y/i, /瞳.*[yY縦]/, /眼球.*[yY]/],
  eyeSmile:   [/eye.*smile/i, /smile.*eye/i, /目.*笑/, /眼.*笑/],
  eyeLOpen:   [/eye.*open/i, /open.*eye/i, /\bblink\b/i, /目.*開/, /眼.*开/],
  mouthForm:  [/mouth\s*form/i, /mouth.*(?:corner|shape|smile)/i, /口角/, /嘴形/, /口形/],
  mouthOpenY: [/mouth\s*open/i, /口.*開/, /张[口嘴]/],
  browY:      [/brow.*(?:up|down|y\b|height)/i, /眉.*上下/],
  browAngle:  [/brow.*angle/i, /眉.*角/],
  browForm:   [/brow.*form/i, /眉.*形/],
  bodyX:      [/body.*angle\s*x/i, /体.*[xX]/, /胴.*[xX]/],
  bodyY:      [/body.*angle\s*y/i, /体.*[yY]/, /胴.*[yY]/],
  bodyZ:      [/body.*angle\s*z/i, /body.*swing/i, /体.*[zZ]/, /胴.*[zZ]/],
  arm:        [/\barm\b/i, /\bhand\b/i, /腕/, /\b手\b/],
  // Direct emotion FLAGS. Riggers commonly expose a single toggle that turns
  // an entire expression on ('angry eye', 'tear', 'blush', '生气'). When a
  // clip drives one of these, that IS the intent — no inference needed.
  blush:      [/\bblush\b/i, /cheek(?!\s*puff\s*out)/i, /頬/, /脸红/, /照れ/, /羞/],
  tear:       [/\btear\b/i, /\bcry\b/i, /涙/, /泪/, /哭/],
  angryFlag:  [/\bangry\b/i, /\banger\b/i, /\bmad\b/i, /怒/, /生气/, /愤/],
  sadFlag:    [/\bsad\b/i, /\bdepress/i, /悲/, /难过/, /落ち込/],
  smileFlag:  [/\bsmile\b/i, /\bgrin\b/i, /\bjoy\b/i, /笑顔/, /开心/, /喜/],
  surpriseFlag: [/\bsurprise/i, /\bshock/i, /驚/, /惊/],
  dizzy:      [/guruguru/i, /\bdizzy\b/i, /目回/, /晕/],
  sleepFlag:  [/\bsleep/i, /\bdrowsy\b/i, /眠/, /睡/],
};

export function roleFromDisplayName(displayName: unknown): string | null {
  const n = String(displayName || '');
  if (!n) return null;
  for (const role in DISPLAY_PATTERNS) {
    for (const re of DISPLAY_PATTERNS[role]) if (re.test(n)) return role;
  }
  return null;
}

export interface RoleMapStats { total: number; byId: number; byDisplay: number; }
export interface RoleMapResult { map: Record<string, string>; stats: RoleMapStats; }

/**
 * Build a paramId -> role map for one model.
 *
 * Resolution order per parameter:
 *   1. the parameter ID itself (works for standard 'ParamAngleX' rigs)
 *   2. the cdi3 DISPLAY NAME (rescues opaque ids like ParamEX10 / Param92)
 *
 * Pass the result to classifyClip() so curve analysis works on models whose
 * parameter ids carry no meaning at all.
 */
export function buildRoleMap(cdi3: any): RoleMapResult {
  const map: Record<string, string> = {};
  const stats: RoleMapStats = { total: 0, byId: 0, byDisplay: 0 };
  const params = (cdi3 && cdi3.Parameters) || [];
  for (const p of params) {
    const id = p && p.Id;
    if (!id) continue;
    stats.total++;
    const byId = roleOf(id);
    if (byId) { map[id] = byId; stats.byId++; continue; }
    const byName = roleFromDisplayName(p.Name);
    if (byName) { map[id] = byName; stats.byDisplay++; }
  }
  return { map, stats };
}

// ── motion3.json segment decoding ───────────────────────────────
// The Segments array is a FLAT number stream, not objects. Layout:
//   [ t0, v0, <type>, ...payload, <type>, ...payload, ... ]
// type 0 = Linear         payload: t, v                (2)
// type 1 = Bezier         payload: c1t,c1v,c2t,c2v,t,v (6)
// type 2 = Stepped        payload: t, v                (2)
// type 3 = InverseStepped payload: t, v                (2)
// We only need the KEYFRAME values (control points don't change the
// envelope enough to matter for classification), so Bezier collapses to its
// endpoint.
export interface CurvePoint { t: number; v: number; }

export function decodeCurve(segments: unknown): CurvePoint[] {
  const pts: CurvePoint[] = [];
  if (!Array.isArray(segments) || (segments as unknown[]).length < 2) return pts;
  const s = segments as number[];
  pts.push({ t: s[0], v: s[1] });
  let i = 2;
  let guard = 0;
  while (i < s.length && guard++ < 100000) {
    const type = s[i]; i++;
    if (type === 1) {
      if (i + 5 >= s.length) break;
      pts.push({ t: s[i + 4], v: s[i + 5] });
      i += 6;
    } else if (type === 0 || type === 2 || type === 3) {
      if (i + 1 >= s.length) break;
      pts.push({ t: s[i], v: s[i + 1] });
      i += 2;
    } else {
      break;  // unknown segment type — stop rather than misread the stream
    }
  }
  return pts;
}

export interface CurveFeatures {
  min: number; max: number; amp: number; mean: number; tmean: number;
  first: number; last: number; dur: number; reversals: number; peakT: number; sustained: boolean;
}

// Measure what a curve DOES: amplitude, how many times it reverses
// direction (oscillation), whether it holds an offset, and when it peaks.
export function curveFeatures(pts: CurvePoint[]): CurveFeatures | null {
  if (!pts.length) return null;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const p of pts) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; sum += p.v; }
  const amp = max - min;
  const mean = sum / pts.length;
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const dur = pts[pts.length - 1].t - pts[0].t;

  // TIME-WEIGHTED mean (trapezoidal integral / duration). This is what you
  // want for every "does the clip HOLD this value?" question: a keyframe
  // count mean over-weights dense keyframe regions, so a clip that snaps the
  // eyes shut in 0.5s then holds shut for 2.5s would read as mean≈0.33
  // ("eyes mostly open") instead of the correct ≈0.08.
  let tmean = mean;
  if (dur > 0) {
    let area = 0;
    for (let i = 1; i < pts.length; i++) {
      area += (pts[i].v + pts[i - 1].v) / 2 * (pts[i].t - pts[i - 1].t);
    }
    tmean = area / dur;
  }

  // Direction reversals, ignoring noise below 15% of amplitude. A "nod" is
  // 2+ reversals (down-up-down); a one-way move is 0-1.
  const noise = Math.max(amp * 0.15, 1e-4);
  let reversals = 0, lastDir = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].v - pts[i - 1].v;
    if (Math.abs(d) < noise) continue;
    const dir = d > 0 ? 1 : -1;
    if (lastDir !== 0 && dir !== lastDir) reversals++;
    lastDir = dir;
  }

  // Where the extreme happens, normalized 0..1 over the clip. A fast onset
  // (peak in the first third) reads as a startle; a late peak reads as a
  // gradual build.
  let peakT = 0, peakDev = 0;
  for (const p of pts) {
    const dev = Math.abs(p.v - first);
    if (dev > peakDev) { peakDev = dev; peakT = dur > 0 ? (p.t - pts[0].t) / dur : 0; }
  }

  // "Sustained" = ends far from where it started (holds a pose) rather than
  // returning home. Distinguishes a tilt-and-hold from a shake.
  const sustained = Math.abs(last - first) > amp * 0.45 && amp > 1e-3;

  return { min, max, amp, mean, tmean, first, last, dur, reversals, peakT, sustained };
}

// ── Name hints (WEAK, tie-breaker only) ─────────────────────────
// These exist for ONE reason: when a model ships no reachable .motion3.json
// files, a name is the only signal left. They are deliberately limited to
// common emotion vocabulary in the languages Cubism is actually authored in
// (EN / JP / CN / KR) — NOT to any single model's naming scheme.
//
// Do NOT add patterns here just because one model you tested uses them. If a
// name is unreadable the honest answer is 'neutral' with low confidence, which
// tells the runtime to fall back to synthetic gestures. A wrong verb is worse
// than no verb, because it makes her contradict her own mood.
//
// Longest-match-wins ordering matters: 'shakehead' must beat 'shake'.
const NAME_HINTS: [RegExp, string][] = [
  [/shakehead|shake head|首振|摇头|고개.*젓/i, 'shake'],
  [/shakehand|wave|greeting|hello|\bhi\b|挥手|손.*흔/i, 'wave'],
  [/nod ?tilt|tilt ?head ?nod|nod ?shake/i, 'nod'],
  [/\bnod|うなず|点头|頷|끄덕/i, 'nod'],
  [/tilt|首傾|歪头|기울/i, 'tilt'],
  [/smile|happy|joy|laugh|grin|wink|嬉|笑|开心|기쁨|웃/i, 'happy'],
  [/\bsad\b|\bcry|tear|sorrow|regret|sigh|lonely|悲|泣|难过|슬픔|울/i, 'sad'],
  [/angry|anger|\bmad\b|rage|hate|disgust|怒|愤|화[남나]/i, 'angry'],
  [/surprise|shock|scream|startle|驚|惊|놀[람라]/i, 'surprised'],
  [/blush|\bshy\b|embarrass|恥|照れ|羞|脸红|부끄/i, 'shy'],
  [/think|ponder|wonder|trouble|worry|考|悩|思|생각/i, 'think'],
  [/sleep|drowsy|doze|close ?eye|eye ?close|眠|睡|目閉|闭眼|잠/i, 'sleep'],
  [/look ?away|look ?down|avert|逸ら|看向|시선/i, 'lookaway'],
  [/lean|approach|寄|靠/i, 'lean'],
  [/idle|default|normal|pose|breath|relief/i, 'neutral'],
];

export function nameHint(name: unknown): string | null {
  const raw = String(name || '');
  // Separators are not word boundaries to a regex: in 'face_sad_01' the \b in
  // /\bsad\b/ never fires because '_' is a word character. Riggers separate
  // tokens with _, -, ., camelCase and digits interchangeably, so normalize
  // all of those to spaces and test both forms.
  const norm = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\/]+/g, ' ')
    .replace(/(\d)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, verb] of NAME_HINTS) if (re.test(raw) || re.test(norm)) return verb;
  return null;
}

export interface ClassifyResult {
  verb: string; valence: string; confidence: number; evidence: string; duration: number;
}

/**
 * Classify ONE clip from its decoded curves.
 * @param motion3  parsed .motion3.json (may be null → name-only)
 * @param name     group/file name, used only as a weak tie-breaker
 * @param roleMap  paramId -> role, from buildRoleMap(cdi3). Supply this for
 *        models whose parameter IDs are opaque (ParamEX10, Param92); without
 *        it those curves are invisible to the analyser.
 */
export function classifyClip(motion3: any, name: unknown, roleMap?: Record<string, string> | null): ClassifyResult {
  const hint = nameHint(name);
  const duration = (motion3 && motion3.Meta && motion3.Meta.Duration) || 0;

  // No file → name hint is all we have.
  if (!motion3 || !Array.isArray(motion3.Curves) || !motion3.Curves.length) {
    const verb = hint || 'neutral';
    return {
      verb, valence: VERB_VALENCE[verb] || 'neutral',
      confidence: hint ? 0.5 : 0.15,
      evidence: hint ? 'name-only' : 'no-signal',
      duration,
    };
  }

  // Bucket curves by semantic role, keeping the strongest-amplitude curve
  // per role (a clip may drive ParamBrowLY and ParamBrowRY; either is fine
  // as the representative).
  const byRole: Record<string, CurveFeatures> = {};
  for (const c of motion3.Curves) {
    if (c.Target !== 'Parameter') continue;
    // The cdi3-derived map wins: it is the rigger's own labelling, whereas
    // roleOf() is our guess at their id convention.
    const role = (roleMap && roleMap[c.Id]) || roleOf(c.Id || '');
    if (!role) continue;
    const f = curveFeatures(decodeCurve(c.Segments));
    if (!f) continue;
    if (!byRole[role] || f.amp > byRole[role].amp) byRole[role] = f;
  }

  const F = (r: string) => byRole[r] || null;
  const amp = (r: string) => (byRole[r] ? byRole[r].amp : 0);
  // For every "does the clip HOLD this expression?" test we use the
  // TIME-weighted mean, not the keyframe mean — see curveFeatures().
  const mean = (r: string) => (byRole[r] ? byRole[r].tmean : 0);
  const rev = (r: string) => (byRole[r] ? byRole[r].reversals : 0);

  // Scored candidates: curve evidence produces a score, the name hint adds a
  // bonus. Highest score wins. Scores are heuristic weights tuned so that a
  // clear curve signal (score >= 0.6) outranks a name hint alone (0.35).
  const scores: Record<string, { s: number; why: string[] }> = {};
  const bump = (verb: string, s: number, why: string) => {
    if (!scores[verb]) scores[verb] = { s: 0, why: [] };
    scores[verb].s += s;
    scores[verb].why.push(why);
  };

  // Head oscillation → nod / shake. Angle params are in degrees, so a
  // meaningful movement is several degrees, not fractions.
  if (amp('angleY') > 4 && rev('angleY') >= 2) bump('nod', 0.75, `angleY amp=${amp('angleY').toFixed(1)} rev=${rev('angleY')}`);
  if (amp('angleX') > 4 && rev('angleX') >= 2) bump('shake', 0.75, `angleX amp=${amp('angleX').toFixed(1)} rev=${rev('angleX')}`);
  // Sustained roll with little oscillation → a held tilt.
  if (F('angleZ') && amp('angleZ') > 3 && rev('angleZ') < 2 && F('angleZ').sustained) {
    bump('tilt', 0.7, `angleZ sustained mean=${mean('angleZ').toFixed(1)}`);
  }

  // Facial valence. mouthForm/eyeSmile are normalized -1..1.
  if (mean('eyeSmile') > 0.25 || mean('mouthForm') > 0.3) {
    bump('happy', 0.7, `smile eyeSmile=${mean('eyeSmile').toFixed(2)} mouthForm=${mean('mouthForm').toFixed(2)}`);
  }
  if (mean('browY') < -0.2 && mean('mouthForm') < -0.15) {
    bump('sad', 0.7, `brows down + mouth down`);
  }
  if (mean('browAngle') > 0.3 && mean('mouthForm') < 0) {
    bump('angry', 0.65, `brows angled in + mouth down`);
  }
  // Startle: mouth flies open AND eyes go wide, EARLY in the clip.
  if (F('mouthOpenY') && F('mouthOpenY').max > 0.55 && F('mouthOpenY').peakT < 0.35) {
    const eyesWide = F('eyeLOpen') ? F('eyeLOpen').max >= 0.85 : true;
    if (eyesWide) bump('surprised', 0.7, `fast mouth-open peakT=${F('mouthOpenY').peakT.toFixed(2)}`);
  }
  if (mean('blush') > 0.3) bump('shy', 0.65, `blush mean=${mean('blush').toFixed(2)}`);

  // ── Rigger-authored emotion FLAGS ──
  // Params the creator explicitly labelled 'tear' / 'angry eye' / '生气' /
  // 'guruguru'. When a clip switches one of these ON, that is a statement of
  // intent, not something to infer. They only exist when a roleMap resolved
  // them from cdi3 display names.
  //
  // Two traps this has to survive, both found in real files:
  //
  // 1. Params are NOT normalized to 0..1. lumine's tear params run 0..60 and
  //    its 'guruguru' runs 0..2520, so an absolute threshold would either
  //    never fire or always fire. We compare against the curve's OWN range.
  //
  // 2. A monotonic RAMP is not a flag. lumine's idle drives tear 0 -> 50
  //    linearly across 10s: that is a phase/timeline driver for a falling
  //    droplet sprite, not "she is crying this whole clip". A ramp sits at
  //    exactly 50% of its range with its peak at the very END; a genuine
  //    toggle reaches full early and HOLDS, landing near 90%. Requiring both
  //    a high held-fraction and an early peak separates the two cleanly.
  const flagOn = (r: string) => {
    const f = byRole[r];
    if (!f || !(f.max > 0)) return 0;
    const held = f.tmean / f.max;      // 1.0 = on for the entire clip
    if (held < 0.6) return 0;          // ramps and late onsets sit at ~0.5
    if (f.peakT > 0.75) return 0;      // still climbing at the end = a ramp
    return held;
  };
  const flag = (r: string, verb: string, w: number, label: string) => {
    const on = flagOn(r);
    if (on) bump(verb, w, `${label} flag held ${(on * 100).toFixed(0)}% of clip`);
  };
  flag('tear', 'sad', 0.7, 'tear');
  flag('angryFlag', 'angry', 0.75, 'angry');
  flag('sadFlag', 'sad', 0.75, 'sad');
  flag('smileFlag', 'happy', 0.75, 'smile');
  flag('surpriseFlag', 'surprised', 0.75, 'surprise');
  flag('sleepFlag', 'sleep', 0.75, 'sleep');
  // 'guruguru' / dizzy spirals read as being lost in thought, not an emotion.
  flag('dizzy', 'think', 0.6, 'dizzy');

  // Eyes closed and HELD (not a blink) → drowsy. Uses the time-weighted mean
  // so a fast close followed by a long hold reads correctly.
  if (F('eyeLOpen') && F('eyeLOpen').tmean < 0.3 && F('eyeLOpen').sustained) {
    bump('sleep', 0.6, `eyes held closed tmean=${F('eyeLOpen').tmean.toFixed(2)}`);
  }
  // Gaze parked off-center without the head following → averted look.
  if (F('eyeBallX') && Math.abs(mean('eyeBallX')) > 0.35 && F('eyeBallX').sustained && amp('angleX') < 6) {
    bump('lookaway', 0.55, `gaze parked at ${mean('eyeBallX').toFixed(2)}`);
  }
  if (amp('arm') > 0.4) bump('wave', 0.6, `arm amp=${amp('arm').toFixed(2)}`);
  if (F('bodyY') && Math.abs(mean('bodyY')) > 3 && F('bodyY').sustained) {
    bump('lean', 0.5, `body shift mean=${mean('bodyY').toFixed(1)}`);
  }
  if (F('bodyZ') && amp('bodyZ') > 3 && rev('bodyZ') < 2 && F('bodyZ').sustained && !scores.tilt) {
    bump('tilt', 0.45, `body roll sustained`);
  }

  if (hint) bump(hint, 0.35, `name hint "${hint}"`);

  // Pick the winner.
  let best: string | null = null;
  for (const v in scores) if (!best || scores[v].s > scores[best].s) best = v;

  // Nothing fired: it's a low-energy clip. Check whether ANY tracked role
  // moved at all — if not it really is idle filler.
  if (!best) {
    const totalAmp = Object.keys(byRole).reduce((a, r) => a + amp(r), 0);
    return {
      verb: 'neutral',
      valence: 'neutral',
      confidence: 0.2,
      evidence: `no distinctive signal (total amp=${totalAmp.toFixed(2)})`,
      duration,
    };
  }

  return {
    verb: best,
    valence: VERB_VALENCE[best] || 'neutral',
    confidence: Math.min(1, scores[best].s),
    evidence: scores[best].why.join('; '),
    duration,
  };
}

export interface TaxonomyEntry {
  name: string; verb: string; valence: string; confidence: number; duration: number; evidence: string;
}
export interface Taxonomy {
  byVerb: Record<string, string[]>;
  clips: TaxonomyEntry[];
  stats: { total: number; curveClassified: number; nameOnly: number; unclassified: number };
}

/**
 * Build a taxonomy from a list of clips.
 * @param clips    [{name, motion3?}]
 * @param roleMap  paramId -> role from buildRoleMap(cdi3), applied to every
 *        clip. Strongly recommended: without it, models with opaque
 *        parameter IDs fall back to name guessing.
 */
export function buildTaxonomy(clips: { name: string; motion3?: any }[] | null, roleMap?: Record<string, string> | null): Taxonomy {
  const byVerb: Record<string, string[]> = {};
  const out: TaxonomyEntry[] = [];
  const stats = { total: 0, curveClassified: 0, nameOnly: 0, unclassified: 0 };
  for (const c of clips || []) {
    const r = classifyClip(c.motion3, c.name, roleMap);
    stats.total++;
    if (r.evidence === 'name-only') stats.nameOnly++;
    else if (r.evidence === 'no-signal' || r.confidence < 0.3) stats.unclassified++;
    else stats.curveClassified++;
    const entry: TaxonomyEntry = { name: c.name, verb: r.verb, valence: r.valence, confidence: +r.confidence.toFixed(2), duration: r.duration, evidence: r.evidence };
    out.push(entry);
    (byVerb[r.verb] = byVerb[r.verb] || []).push(c.name);
  }
  return { byVerb, clips: out, stats };
}

export interface ClipPick { verb: string; name: string; }

/**
 * Pick a clip name appropriate for an emotion. Returns null when the model
 * has no compatible clip — the caller should then fall back to the synthetic
 * GESTURE_LIBRARY rather than playing something contradictory.
 *
 * @param byVerb   verb -> [clip names]
 * @param emotion  app emotion key ('senang', 'sedih', ...)
 * @param rnd      optional RNG for deterministic tests
 */
export function pickClipForEmotion(byVerb: Record<string, string[]> | null, emotion: string, rnd?: () => number): ClipPick | null {
  if (!byVerb) return null;
  const random = rnd || Math.random;
  const prefer = EMOTION_VERBS[emotion] || EMOTION_VERBS.normal;
  // Weight earlier (more on-emotion) verbs higher, but still allow the
  // neutral movers so she doesn't repeat the same smile clip every time.
  const pool: string[] = [];
  prefer.forEach((verb, i) => {
    const clips = byVerb[verb];
    if (!clips || !clips.length) return;
    const weight = prefer.length - i;   // first verb gets the largest share
    for (let w = 0; w < weight; w++) pool.push(verb);
  });
  if (!pool.length) return null;
  const verb = pool[Math.floor(random() * pool.length)];
  const clips = byVerb[verb];
  return { verb, name: clips[Math.floor(random() * clips.length)] };
}

/** True when a clip's verb is emotionally safe to play for this emotion. */
export function isCompatible(verb: string, emotion: string): boolean {
  const allowed = EMOTION_VERBS[emotion] || EMOTION_VERBS.normal;
  return allowed.indexOf(verb) !== -1;
}
