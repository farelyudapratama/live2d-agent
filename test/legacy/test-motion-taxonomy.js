/**
 * test-motion-taxonomy.js — offline verification for js/motion-taxonomy.js
 * (PORT v2: dari live2d-agent/test/ — path disesuaikan ke layout v2 static/, data/.
 * Sinkronkan bila sumber berubah.)
 *
 * Run: node test/test-motion-taxonomy.js
 *
 * Two kinds of check:
 *  A) SYNTHETIC clips built to look exactly like real rigger output (flat
 *     Segments streams with Linear/Bezier/Stepped types) — asserts the curve
 *     analyser reaches the right verb WITHOUT any help from the filename.
 *     Names are deliberately opaque ("clip_a", "x1") so a passing test proves
 *     curve analysis works, not that the name regex works.
 *  B) The real model files in this repo — asserts we can parse actual
 *     .motion3.json on disk without throwing.
 */
const fs = require('fs');
const path = require('path');
const T = require('../../static/js/motion-taxonomy.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  PASS  ${label}  -> ${got}`); }
  else { fail++; console.log(`  FAIL  ${label}  -> got "${got}", want "${want}"`); }
}

// ── Segment stream builders (mirror the real motion3 wire format) ──
// Linear keyframes: [t0,v0, 0,t1,v1, 0,t2,v2, ...]
function linear(points) {
  const s = [points[0][0], points[0][1]];
  for (let i = 1; i < points.length; i++) s.push(0, points[i][0], points[i][1]);
  return s;
}
// Bezier keyframes (type 1 + 4 control numbers + endpoint) — the common case
// in Cubism exports, and the one a naive parser misreads.
function bezier(points) {
  const s = [points[0][0], points[0][1]];
  for (let i = 1; i < points.length; i++) {
    const [pt, pv] = points[i - 1], [t, v] = points[i];
    const c1t = pt + (t - pt) / 3, c2t = pt + 2 * (t - pt) / 3;
    const c1v = pv + (v - pv) / 3, c2v = pv + 2 * (v - pv) / 3;
    s.push(1, c1t, c1v, c2t, c2v, t, v);
  }
  return s;
}
function clip(curves, duration = 2) {
  return { Meta: { Duration: duration, Fps: 30 }, Curves: curves };
}
function curve(id, segments) { return { Target: 'Parameter', Id: id, Segments: segments }; }

console.log('\nA) Synthetic clips — curve analysis only (opaque names)\n');

// nod: head PITCH oscillates down-up-down and returns home.
check('nod (angleY oscillation, bezier)',
  T.classifyClip(clip([curve('ParamAngleY', bezier([[0,0],[0.3,-18],[0.7,10],[1.1,-8],[1.6,0]]))]), 'clip_a').verb,
  'nod');

// shake: head YAW oscillates. Same shape, different axis — proves the analyser
// distinguishes axes rather than just detecting "movement".
check('shake (angleX oscillation, linear)',
  T.classifyClip(clip([curve('ParamAngleX', linear([[0,0],[0.25,-20],[0.6,18],[0.95,-12],[1.4,0]]))]), 'x1').verb,
  'shake');

// tilt: roll moves once and HOLDS. Distinguished from shake by no reversals
// plus ending far from the start.
check('tilt (angleZ sustained, no reversal)',
  T.classifyClip(clip([curve('ParamAngleZ', bezier([[0,0],[0.5,12],[2.0,12]]))]), 'x2').verb,
  'tilt');

// happy: smile params ride high for the whole clip.
check('happy (eyeSmile + mouthForm high)',
  T.classifyClip(clip([
    curve('ParamEyeLSmile', bezier([[0,0],[0.4,1],[2,1]])),
    curve('ParamMouthForm', bezier([[0,0],[0.4,0.9],[2,0.9]])),
  ]), 'x3').verb,
  'happy');

// sad: brows down AND mouth corners down.
check('sad (browY down + mouthForm down)',
  T.classifyClip(clip([
    curve('ParamBrowLY', bezier([[0,0],[0.5,-0.8],[2,-0.7]])),
    curve('ParamMouthForm', bezier([[0,0],[0.5,-0.6],[2,-0.5]])),
  ]), 'x4').verb,
  'sad');

// angry: brow ANGLE inward + mouth down (different signature from sad).
check('angry (browAngle in + mouth down)',
  T.classifyClip(clip([
    curve('ParamBrowLAngle', bezier([[0,0],[0.3,0.9],[2,0.8]])),
    curve('ParamMouthForm', bezier([[0,0],[0.3,-0.5],[2,-0.4]])),
  ]), 'x5').verb,
  'angry');

// surprised: mouth snaps open EARLY (peak in first third) with eyes wide.
check('surprised (fast mouth-open onset)',
  T.classifyClip(clip([
    curve('ParamMouthOpenY', linear([[0,0],[0.12,1],[0.5,0.8],[2,0.3]])),
    curve('ParamEyeLOpen', linear([[0,1],[0.12,1],[2,1]])),
  ]), 'x6', 2).verb,
  'surprised');

// shy: blush held on.
check('shy (blush sustained)',
  T.classifyClip(clip([curve('ParamBlush', bezier([[0,0],[0.4,1],[2,0.9]]))]), 'x7').verb,
  'shy');

// sleep: eyes closed and STAY closed — must not be read as a blink.
check('sleep (eyes held closed)',
  T.classifyClip(clip([curve('ParamEyeLOpen', bezier([[0,1],[0.5,0],[3,0]]))]), 'x8', 3).verb,
  'sleep');

// lookaway: gaze parked off-centre while the head does NOT turn.
check('lookaway (gaze offset, head still)',
  T.classifyClip(clip([curve('ParamEyeBallX', bezier([[0,0],[0.4,-0.8],[2,-0.75]]))]), 'x9').verb,
  'lookaway');

// A blink must NOT be classified as sleep (returns to open → not sustained).
const blink = T.classifyClip(clip([curve('ParamEyeLOpen', linear([[0,1],[0.08,0],[0.16,1],[1,1]]))]), 'x10', 1);
check('blink is NOT sleep', blink.verb === 'sleep' ? 'sleep' : 'not-sleep', 'not-sleep');

// Empty / unparseable clip degrades to neutral instead of throwing.
check('empty clip -> neutral', T.classifyClip(clip([]), 'x11').verb, 'neutral');
check('null clip -> neutral', T.classifyClip(null, 'x12').verb, 'neutral');

console.log('\nB) Name-hint fallback (no curves available)\n');
check('name hint shakehead', T.classifyClip(null, 'w-cool-shakehead04').verb, 'shake');
check('name hint smile',     T.classifyClip(null, 'face_smile_03').verb, 'happy');
check('name hint cry',       T.classifyClip(null, 'w-sad-cry01').verb, 'sad');
check('name hint wave',      T.classifyClip(null, 'shakehand_hello').verb, 'wave');

console.log('\nC) Curve evidence must OUTRANK a misleading filename\n');
// A file named "...sad..." whose curves are unmistakably a nod. Real datasets
// contain exactly this kind of mislabelling; curve score (0.75) must beat the
// name bonus (0.35).
const conflicted = T.classifyClip(
  clip([curve('ParamAngleY', bezier([[0,0],[0.3,-18],[0.7,10],[1.1,-8],[1.6,0]]))]),
  'w-cool-sad01');
check('curves beat wrong name', conflicted.verb, 'nod');

console.log('\nD) Opaque parameter IDs rescued by .cdi3.json display names\n');
// THE core robustness test. These parameter ids carry ZERO meaning — they are
// taken from the real models in this repo (lumine uses ParamEX10/ParamAnime01,
// 神宫白子 uses Param92). The id regex cannot read any of them. Only the rigger's
// own cdi3 display name can, and the clip names are opaque too, so nothing here
// can be solved by guessing from a filename.
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
check('roleMap resolves all 8 opaque ids', Object.keys(rm.map).length, 8);
check('every one needed the display name', rm.stats.byDisplay, 8);
check('none were readable from the id', rm.stats.byId, 0);

// Same clip, classified WITHOUT then WITH the roleMap. The delta is the proof.
const tearClip = clip([curve('ParamEX10', bezier([[0,0],[0.4,1],[2,1]]))]);
check('tear clip WITHOUT roleMap -> blind', T.classifyClip(tearClip, 'm_014').verb, 'neutral');
check('tear clip WITH roleMap -> sad', T.classifyClip(tearClip, 'm_014', rm.map).verb, 'sad');

const cnAngry = clip([curve('Param92', bezier([[0,0],[0.3,1],[2,1]]))]);
check('Chinese "\u751f\u6c14" flag -> angry', T.classifyClip(cnAngry, 'm_027', rm.map).verb, 'angry');

const jpMouth = clip([curve('zzz1', linear([[0,0],[0.1,1],[0.5,0.8],[2,0.3]]))]);
check('Japanese "\u53e3\u958b\u304d" -> surprised', T.classifyClip(jpMouth, 'm_003', rm.map).verb, 'surprised');

const opaqueTilt = clip([curve('P_7f3a', bezier([[0,0],[0.5,14],[2,14]]))]);
check('opaque id + "angle Z" label -> tilt', T.classifyClip(opaqueTilt, 'm_055', rm.map).verb, 'tilt');

check('cdi3 flag OUTRANKS a lying name',
  T.classifyClip(cnAngry, 'w-cool-happy-smile07', rm.map).verb, 'angry');

// A monotonic RAMP on a flag param is a timeline driver, not an emotion. This
// is lumine's real idle clip shape: tear climbs 0 -> 50 across the whole clip.
// Reading that as "sad" would make her cry during idle.
const tearRamp = clip([curve('ParamEX10', linear([[0,0],[5,25],[10,50]]))]);
check('slow tear RAMP is not sad', T.classifyClip(tearRamp, 'm_099', rm.map).verb, 'neutral');
// ...but a real toggle (snap on early, hold) still reads as sad.
const tearHold = clip([curve('ParamEX10', linear([[0,0],[0.3,50],[10,50]]))]);
check('tear toggled on and HELD is sad', T.classifyClip(tearHold, 'm_098', rm.map).verb, 'sad');

// buildTaxonomy must thread the roleMap through to every clip.
const opaqueSet = [
  { name: 'm_001', motion3: tearClip },
  { name: 'm_002', motion3: cnAngry },
  { name: 'm_003', motion3: clip([curve('Param91', bezier([[0,0],[0.4,0.9],[2,0.9]]))]) },
];
const blind = T.buildTaxonomy(opaqueSet);
const sighted = T.buildTaxonomy(opaqueSet, rm.map);
check('opaque set is 100% unreadable without cdi3', blind.stats.curveClassified, 0);
check('opaque set fully classified with cdi3', sighted.stats.curveClassified, 3);
check('  ...and verbs are distinct', Object.keys(sighted.byVerb).sort().join(','), 'angry,sad,shy');

console.log('\nE) Name hints must NOT be model-specific\n');
// A model whose groups are numbered (extremely common) must NOT be silently
// mapped onto real verbs. Honest 'neutral' at low confidence tells the runtime
// to use synthetic gestures instead of contradicting her mood.
['m_001', '\u30e2\u30fc\u30b7\u30e7\u30f31', '\u52a8\u4f5c7', 'a5rn', '02'].forEach(function (n) {
  check('opaque name "' + n + '" -> no false verb', T.classifyClip(null, n).verb, 'neutral');
});
check('opaque name confidence stays low',
  T.classifyClip(null, 'm_001').confidence <= 0.2 ? 'low' : 'overconfident', 'low');
// But genuine emotion words in the 4 languages Cubism is authored in still work.
check('JP \u7b11\u9854 -> happy', T.classifyClip(null, 'face_\u7b11\u9854_02').verb, 'happy');
check('CN \u96be\u8fc7 -> sad', T.classifyClip(null, '\u96be\u8fc7_01').verb, 'sad');
check('KR \ub044\ub355 (nod) -> nod', T.classifyClip(null, '\ub044\ub355\uc774\uae30').verb, 'nod');
check('KR \uae30\uc6b8 (tilt) -> tilt', T.classifyClip(null, '\uace0\uac1c_\uae30\uc6b8\uc774\uae30').verb, 'tilt');

console.log('\nF) Emotion gating\n');
const byVerb = { happy: ['h1','h2'], sad: ['s1'], nod: ['n1'], neutral: ['z1'] };
// Deterministic RNG so this assertion is stable, not flaky.
let seq = 0; const rnd = () => [0.0, 0.0][seq++ % 2] ?? 0;
const pickHappy = T.pickClipForEmotion(byVerb, 'senang', () => 0.01);
check('senang picks a positive verb', pickHappy && pickHappy.verb, 'happy');
check('sad clip blocked for senang', T.isCompatible('sad', 'senang') ? 'allowed' : 'blocked', 'blocked');
check('sad clip allowed for sedih', T.isCompatible('sad', 'sedih') ? 'allowed' : 'blocked', 'allowed');
check('no compatible clips -> null',
  T.pickClipForEmotion({ sad: ['s1'] }, 'senang') === null ? 'null' : 'something', 'null');

console.log('\nG) Real files on disk\n');
const modelDir = path.join(__dirname, '..', '..', 'data', 'model');
// Find each model folder's cdi3 so real clips get the same rescue the server does.
function findFile(dir, re) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(full, re); if (r) return r; }
    else if (re.test(e.name)) return full;
  }
  return null;
}
const found = [];
(function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.motion3\.json$/i.test(e.name)) found.push(full);
  }
})(modelDir);
if (!found.length) {
  console.log('  (no .motion3.json in model/ — skipping, not a failure)');
} else {
  // Build one roleMap per top-level model folder, keyed by folder path prefix.
  const roleMaps = {};
  for (const folder of fs.readdirSync(modelDir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(modelDir, folder.name);
    const cdi = findFile(dir, /\.cdi3\.json$/i);
    if (!cdi) continue;
    const built = T.buildRoleMap(JSON.parse(fs.readFileSync(cdi, 'utf8')));
    roleMaps[dir] = built.map;
    console.log(`  ${folder.name}: ${built.stats.byId} roles by id + ` +
      `${built.stats.byDisplay} by display name (of ${built.stats.total} params)`);
  }
  const mapFor = (f) => {
    for (const dir in roleMaps) if (f.startsWith(dir)) return roleMaps[dir];
    return null;
  };
  let rescued = 0;
  for (const f of found) {
    const m3 = JSON.parse(fs.readFileSync(f, 'utf8'));
    const nm = path.basename(f).replace(/\.motion3\.json$/i, '');
    const before = T.classifyClip(m3, nm);
    const after = T.classifyClip(m3, nm, mapFor(f));
    const tag = after.evidence !== before.evidence ? '  [cdi3 changed the verdict]' : '';
    if (tag) rescued++;
    console.log(`    ${nm}: without cdi3 -> ${before.verb} (${before.evidence})`);
    console.log(`    ${nm}: with cdi3    -> ${after.verb} (${after.evidence})${tag}`);
  }
  const input = found.map(f => ({
    name: path.basename(f).replace(/\.motion3\.json$/i, ''),
    motion3: JSON.parse(fs.readFileSync(f, 'utf8')),
    _map: mapFor(f),
  }));
  const built = T.buildTaxonomy(input, input[0]._map);
  check('real files parsed without throwing', built.stats.total === found.length ? 'ok' : 'mismatch', 'ok');
  console.log(`  ${rescued}/${found.length} real clips only became readable via cdi3`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
