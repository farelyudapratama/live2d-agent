#!/usr/bin/env node
/* test-role-emotions.js — the UNIVERSAL EMOTION vocabulary must stay model-agnostic.
 *
 * WHY THIS EXISTS
 * The emotion path was dead in three stacked places:
 *   1. setEmotionTargets() was `return;` — a no-op, so state.emoTarget never got
 *      a single entry and the eased-emotion loop in the alive engine iterated
 *      zero times forever.
 *   2. Both bundled sheets stored supportedEmotions as `[]`. `typeof [] ===
 *      'object'` slipped through the guard, and hasOwnProperty() is always false
 *      on an array, so every [EMOTION:...] from the LLM failed silently.
 *   3. playEmotionClip() returned null because no taxonomy was present.
 * Net effect: the model could not express anything, and nothing errored.
 *
 * The fix must NOT be "ship a table of parameter ids that works on the two models
 * in model/ today". That is the exact defect class test-role-mapping.js exists to
 * forbid. So emotions are authored in ROLE space (mouthForm, browLY, eyeLSmile…)
 * and resolved per model through mapRoles() + the real declared ranges.
 *
 * This suite runs the REAL extracted bodies of buildRoleEmotions() and
 * setEmotionTargets() from js/app.js against synthetic rigs — including a rig
 * that shares NO naming convention with any bundled model, a percent-range rig,
 * and an opaque rig with no facial roles at all.
 *
 * Run: node test/test-role-emotions.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function section(t) { console.log(`\n${t}`); }

// ── extract the real function bodies (js/app.js is a browser IIFE) ───────────
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const tplMatch = appSrc.match(/const EMOTION_ROLE_TEMPLATES = \{[\s\S]*?\n  \};/);
const normRolesMatch = appSrc.match(/const NORM_TEMPLATE_ROLES = new Set\([^)]*\);/);
const minRolesMatch = appSrc.match(/const EMOTION_MIN_ROLES = \d+;/);
const degreeMatch = appSrc.match(/const DEGREE_ROLES = new Set\([^)]*\);/);
const refHalfMatch = appSrc.match(/const REF_HALF = \d+;/);
const refHalfForMatch = appSrc.match(/const refHalfFor = [^;]*;/);
const roleIdMatch = appSrc.match(/const roleId = [^;]*;/);
const clampMatch = appSrc.match(/const clamp = \(v, lo, hi\) => [^;]*;/);

const buildSrc = extractFn(appSrc, 'buildRoleEmotions');
const refreshSrc = extractFn(appSrc, 'refreshRoleEmotions');
const setTargetsSrc = extractFn(appSrc, 'setEmotionTargets');
const emotionActualSrc = extractFn(appSrc, 'emotionActualFor');
const roleRangeSrc = extractFn(appSrc, 'roleRange');
const toActualSrc = extractFn(appSrc, 'toActual');
const roleClampSrc = extractFn(appSrc, 'roleClampActual');
const projectSrc = extractFn(appSrc, 'projectEmotionPresets');

section('1. Plumbing: the emotion engine exists and is wired');
ok('EMOTION_ROLE_TEMPLATES is declared', !!tplMatch);
ok('NORM_TEMPLATE_ROLES is declared', !!normRolesMatch);
ok('EMOTION_MIN_ROLES is declared', !!minRolesMatch);
ok('buildRoleEmotions() exists', !!buildSrc);
ok('refreshRoleEmotions() exists', !!refreshSrc);
ok('emotionActualFor() exists', !!emotionActualSrc);
ok('setEmotionTargets() exists', !!setTargetsSrc);
ok('setEmotionTargets() is no longer a no-op stub',
  !!setTargetsSrc && !/^function setEmotionTargets\([^)]*\)\s*\{\s*return;\s*\}$/.test(setTargetsSrc.trim()));
ok('setEmotionTargets() actually assigns state.emoTarget',
  !!setTargetsSrc && /state\.emoTarget\s*=/.test(setTargetsSrc));
ok('detectModelCapabilities() calls refreshRoleEmotions()',
  /refreshRoleEmotions\(\);/.test(appSrc));
ok('inspectModel() seeds supportedEmotions from buildRoleEmotions()',
  /const supportedEmotions = buildRoleEmotions\(\);/.test(appSrc));
ok('model swap clears roleEmotions', /state\.roleEmotions = \{\};/.test(appSrc));
ok('model swap clears emoTarget', /state\.emoTarget = \{\};/.test(appSrc));

if (!buildSrc || !setTargetsSrc || !tplMatch || !emotionActualSrc || !clampMatch) {
  console.log(`\n${pass} passed, ${fail} failed  (emotion engine not extractable — aborting behavior tests)`);
  process.exit(1);
}

// ── sandbox harness: run the REAL bodies against a synthetic rig ─────────────
function makeEngine(rig) {
  // rig: { roleIds: {role:id}, paramRange: {id:{min,max,def}} }
  const sandbox = {
    console: { log() {}, warn() {} },
    state: {
      model: {},                        // truthy: setEmotionTargets() guards on it
      caps: { ids: rig.roleIds, params: new Set(Object.keys(rig.paramRange)) },
      paramRange: rig.paramRange,
      roleEmotions: {}, supportedEmotions: {},
      emoTarget: {}, emoCur: {},
    },
    // readParam() touches the live Cubism core; the seed value is irrelevant to
    // the assertions here, so stub it at the model's declared default.
    readParam: (id) => {
      const r = rig.paramRange[id];
      return (r && typeof r.def === 'number') ? r.def : 0;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    clampMatch[0],
    refHalfMatch[0], degreeMatch[0], refHalfForMatch[0], roleIdMatch[0],
    normRolesMatch[0], minRolesMatch[0], tplMatch[0],
    roleRangeSrc, toActualSrc, roleClampSrc, emotionActualSrc,
    buildSrc, refreshSrc, setTargetsSrc,
    projectSrc || '',
  ].join('\n'), sandbox);
  return sandbox;
}

// Rig A: canonical Cubism naming, symmetric ±30 / ±1 — the "easy" case.
const CANON = {
  roleIds: {
    angleY: 'ParamAngleY', angleZ: 'ParamAngleZ',
    eyeBallX: 'ParamEyeBallX', eyeBallY: 'ParamEyeBallY',
    eyeLSmile: 'ParamEyeLSmile', eyeRSmile: 'ParamEyeRSmile',
    mouthForm: 'ParamMouthForm', mouthOpenY: 'ParamMouthOpenY',
    browLForm: 'ParamBrowLForm', browRForm: 'ParamBrowRForm',
    browLY: 'ParamBrowLY', browRY: 'ParamBrowRY',
    browLAngle: 'ParamBrowLAngle', browRAngle: 'ParamBrowRAngle',
  },
  paramRange: {
    ParamAngleY: { min: -30, max: 30, def: 0 }, ParamAngleZ: { min: -30, max: 30, def: 0 },
    ParamEyeBallX: { min: -1, max: 1, def: 0 }, ParamEyeBallY: { min: -1, max: 1, def: 0 },
    ParamEyeLSmile: { min: 0, max: 1, def: 0 }, ParamEyeRSmile: { min: 0, max: 1, def: 0 },
    ParamMouthForm: { min: -1, max: 1, def: 0 }, ParamMouthOpenY: { min: 0, max: 1, def: 0 },
    ParamBrowLForm: { min: -1, max: 1, def: 0 }, ParamBrowRForm: { min: -1, max: 1, def: 0 },
    ParamBrowLY: { min: -1, max: 1, def: 0 }, ParamBrowRY: { min: -1, max: 1, def: 0 },
    ParamBrowLAngle: { min: -1, max: 1, def: 0 }, ParamBrowRAngle: { min: -1, max: 1, def: 0 },
  },
};

// Rig B: a HOSTILE rig — none of these ids appear in any bundled model, ranges
// are percent-based, one is inverted, and defaults are non-zero. Same role names
// though, because roles are resolved by mapRoles() elsewhere (see
// test-role-mapping.js); here we prove the VALUE mapping is range-driven.
const HOSTILE = {
  roleIds: {
    angleY: 'k_tilt_v', angleZ: 'k_tilt_r',
    eyeBallX: 'gaze_h', eyeBallY: 'gaze_v',
    mouthForm: 'lip_shape', mouthOpenY: 'lip_gap',
    browLForm: 'bl_shape', browRForm: 'br_shape',
    browLY: 'bl_h', browRY: 'br_h',
  },
  paramRange: {
    k_tilt_v: { min: -10, max: 40, def: 15 },      // asymmetric, non-zero rest
    k_tilt_r: { min: -8, max: 8, def: 0 },
    gaze_h: { min: 0, max: 100, def: 50 },         // percent
    gaze_v: { min: 0, max: 100, def: 50 },
    lip_shape: { min: -100, max: 100, def: 0 },    // percent, signed
    lip_gap: { min: 0, max: 100, def: 0 },         // percent
    bl_shape: { min: 1, max: -1, def: 0 },         // INVERTED declaration
    br_shape: { min: -1, max: 1, def: 0 },
    bl_h: { min: -2, max: 2, def: 0 },
    br_h: { min: -2, max: 2, def: 0 },
  },
};

// Rig C: opaque model — parameters exist but NO facial roles resolve at all.
const OPAQUE = {
  roleIds: {},
  paramRange: { m_001: { min: 0, max: 1, def: 0 }, m_002: { min: 0, max: 1, def: 0 } },
};

// Rig D: coarse rig — a single shared brow param, and only ONE facial role
// beyond it, to exercise both alias-collapse and the min-roles floor.
const COARSE = {
  roleIds: { browLForm: 'brow', browRForm: 'brow' },
  paramRange: { brow: { min: -1, max: 1, def: 0 } },
};

section('2. Vocabulary is DERIVED per model, not hardcoded');
{
  const canon = makeEngine(CANON);
  const vocab = canon.buildRoleEmotions();
  const names = Object.keys(vocab);
  ok('canonical rig expresses several emotions', names.length >= 5, names.join(','));
  ok('every emotion maps to REAL param ids of this rig',
    names.every(n => Object.keys(vocab[n]).every(id => CANON.paramRange[id])),
    'all ids owned');

  const opaque = makeEngine(OPAQUE);
  const oVocab = opaque.buildRoleEmotions();
  ok('opaque rig (zero facial roles) yields ZERO emotions',
    Object.keys(oVocab).length === 0, JSON.stringify(oVocab));

  const coarse = makeEngine(COARSE);
  const cVocab = coarse.buildRoleEmotions();
  const anyMulti = Object.values(cVocab).some(v => Object.keys(v).length > 1);
  ok('roles collapsing onto one id never produce two writers on it', !anyMulti,
    JSON.stringify(cVocab));
  ok('a single resolved role is below EMOTION_MIN_ROLES and declined',
    Object.keys(cVocab).length === 0, Object.keys(cVocab).join(',') || 'none');

  // The whole point: same template, different rig, different numbers.
  const hostile = makeEngine(HOSTILE);
  const hVocab = hostile.buildRoleEmotions();
  ok('hostile rig also expresses emotions', Object.keys(hVocab).length >= 4,
    Object.keys(hVocab).join(','));
  ok('hostile rig uses ITS OWN ids, none from the canonical rig',
    Object.keys(hVocab).every(n =>
      Object.keys(hVocab[n]).every(id => !/^Param/.test(id))),
    'no Param* leakage');
}

section('3. Values are mapped through each rig\'s declared range');
{
  const hostile = makeEngine(HOSTILE);
  const v = hostile.buildRoleEmotions();

  // mouthOpenY is a NORM role: template 0.8 means "80% open" -> 80 on a 0..100 rig.
  ok('norm role scales into a percent range (0.8 -> 80)',
    v.kaget && approx(v.kaget.lip_gap, 80), String(v.kaget && v.kaget.lip_gap));

  // mouthForm is a reference-scale role (±1): -0.8 -> -80 on a -100..100 rig.
  ok('reference role scales into a percent range (-0.8 -> -80)',
    v.sedih && approx(v.sedih.lip_shape, -80), String(v.sedih && v.sedih.lip_shape));

  // angleY is DEGREES: -6 of ±30 reference = -20% of half-range. On -10..40
  // (mid 15, half 25) that is 15 + (-0.2 * 25) = 10 — NOT -6, and NOT 0.
  ok('degree role respects an asymmetric non-zero-rest range',
    v.sedih && approx(v.sedih.k_tilt_v, 10), String(v.sedih && v.sedih.k_tilt_v));
  ok('degree role never assumes 0 is neutral',
    v.sedih && v.sedih.k_tilt_v !== 0 && v.sedih.k_tilt_v !== -6,
    String(v.sedih && v.sedih.k_tilt_v));

  // Every value must sit inside the declared range, including the inverted one.
  const outOfRange = [];
  for (const emo in v) {
    for (const id in v[emo]) {
      const r = HOSTILE.paramRange[id];
      const lo = Math.min(r.min, r.max), hi = Math.max(r.min, r.max);
      if (!(v[emo][id] >= lo - 1e-9 && v[emo][id] <= hi + 1e-9) || Number.isNaN(v[emo][id])) {
        outOfRange.push(`${emo}.${id}=${v[emo][id]}`);
      }
    }
  }
  ok('no emotion value escapes its declared range (inverted rig included)',
    outOfRange.length === 0, outOfRange.join(',') || 'clean');

  // And a 0..1 rig must NOT receive percent values.
  const canon = makeEngine(CANON).buildRoleEmotions();
  ok('same template yields 0..1 values on a 0..1 rig',
    canon.kaget && approx(canon.kaget.ParamMouthOpenY, 0.8),
    String(canon.kaget && canon.kaget.ParamMouthOpenY));
}

section('4. Eyes stay owned by the blink system');
{
  const canon = makeEngine(CANON).buildRoleEmotions();
  const eyeOpenIds = ['ParamEyeLOpen', 'ParamEyeROpen'];
  const touched = [];
  for (const emo in canon) {
    for (const id in canon[emo]) if (eyeOpenIds.includes(id)) touched.push(`${emo}.${id}`);
  }
  ok('no emotion writes an eye-open param', touched.length === 0,
    touched.join(',') || 'clean');
  ok('templates never mention eyeLOpen/eyeROpen',
    !/eyeLOpen|eyeROpen/.test(tplMatch[0]), 'clean');
}

section('5. setEmotionTargets(): release, intensity, and defaults');
{
  const e = makeEngine(HOSTILE);
  const v = e.buildRoleEmotions();

  e.setEmotionTargets(v.sedih, 1);
  const heldSad = Object.keys(e.state.emoTarget).slice();
  ok('targets are populated (the old stub set nothing)', heldSad.length > 0,
    `${heldSad.length} param(s)`);
  ok('emoCur is seeded so the morph starts from the live face',
    heldSad.every(id => typeof e.state.emoCur[id] === 'number'), 'seeded');

  // Switching emotion must RELEASE params the new one does not mention, easing
  // them to the model's own default — not to 0.
  e.setEmotionTargets(v.kaget, 1);
  const released = heldSad.filter(id => !(v.kaget && v.kaget[id] !== undefined));
  const wrongRelease = released.filter(id => {
    const d = HOSTILE.paramRange[id].def;
    return !approx(e.state.emoTarget[id], d);
  });
  ok('params dropped by the new emotion ease back to the MODEL default',
    wrongRelease.length === 0, wrongRelease.join(',') || `${released.length} released`);
  ok('release target is the declared default, not literal 0',
    released.some(id => HOSTILE.paramRange[id].def !== 0)
      ? released.filter(id => HOSTILE.paramRange[id].def !== 0)
          .every(id => e.state.emoTarget[id] !== 0)
      : true,
    'non-zero rest honoured');

  // Intensity scales away from the default, not from zero.
  const full = makeEngine(HOSTILE);
  full.setEmotionTargets(v.sedih, 1);
  const half = makeEngine(HOSTILE);
  half.setEmotionTargets(v.sedih, 0.5);
  const id = 'k_tilt_v';                        // def 15, full target 10
  const d = HOSTILE.paramRange[id].def;
  ok('intensity 0.5 lands halfway between default and full target',
    approx(half.state.emoTarget[id], d + (full.state.emoTarget[id] - d) * 0.5),
    `${d} -> ${half.state.emoTarget[id]} -> ${full.state.emoTarget[id]}`);
  ok('intensity 0 rests at the model default (not 0)',
    (() => { const z = makeEngine(HOSTILE); z.setEmotionTargets(v.sedih, 0);
             return approx(z.state.emoTarget[id], d); })(),
    `def=${d}`);

  // A param the model does not own must never become a target.
  const bogus = makeEngine(HOSTILE);
  bogus.setEmotionTargets({ not_a_param: 1, lip_gap: 50 }, 1);
  ok('unknown param ids are refused', bogus.state.emoTarget.not_a_param === undefined,
    Object.keys(bogus.state.emoTarget).join(','));
  ok('known param in the same call still applies',
    approx(bogus.state.emoTarget.lip_gap, 50), String(bogus.state.emoTarget.lip_gap));

  // Non-finite input must not poison the target map.
  const nan = makeEngine(HOSTILE);
  nan.setEmotionTargets({ lip_gap: 'abc', lip_shape: NaN, bl_h: 1 }, 1);
  ok('non-numeric values are dropped',
    nan.state.emoTarget.lip_gap === undefined && nan.state.emoTarget.lip_shape === undefined,
    JSON.stringify(nan.state.emoTarget));

  // Out-of-range input is clamped to the rig, not written raw.
  const over = makeEngine(HOSTILE);
  over.setEmotionTargets({ lip_gap: 9999 }, 1);
  ok('over-range values are clamped to the declared max',
    approx(over.state.emoTarget.lip_gap, 100), String(over.state.emoTarget.lip_gap));

  // resetEmotion() path: empty preset releases everything to defaults.
  const rst = makeEngine(HOSTILE);
  rst.setEmotionTargets(v.sedih, 1);
  rst.setEmotionTargets({});
  const notDefault = Object.keys(rst.state.emoTarget)
    .filter(k => !approx(rst.state.emoTarget[k], HOSTILE.paramRange[k].def));
  ok('empty preset eases every held param back to its default',
    notDefault.length === 0, notDefault.join(',') || 'all released');
}

section('6. Sheet projection: user presets win, stale builtins are dropped');
{
  if (!projectSrc) {
    ok('projectEmotionPresets() extractable', false, 'not found');
  } else {
    const e = makeEngine(CANON);
    e.refreshRoleEmotions();
    const builtinNames = Object.keys(e.state.roleEmotions);

    // An array here is the ORIGINAL bug: typeof [] === 'object' passes a naive
    // guard, then hasOwnProperty() is false forever.
    const sheet = { supportedEmotions: [], presets: { user: [] } };
    e.projectEmotionPresets(sheet);
    ok('array-shaped supportedEmotions is replaced by a real map',
      !Array.isArray(sheet.supportedEmotions) && typeof sheet.supportedEmotions === 'object',
      Array.isArray(sheet.supportedEmotions) ? 'still an array' : 'map');
    ok('builtin emotions reach the sheet',
      builtinNames.every(n => Object.prototype.hasOwnProperty.call(sheet.supportedEmotions, n)),
      Object.keys(sheet.supportedEmotions).join(','));
    ok('the LLM gate hasOwnProperty() now succeeds',
      builtinNames.length > 0 &&
      Object.prototype.hasOwnProperty.call(sheet.supportedEmotions, builtinNames[0]),
      builtinNames[0]);

    // A user preset with a builtin name must override, not be overridden.
    const e2 = makeEngine(CANON);
    e2.refreshRoleEmotions();
    const custom = { ParamMouthForm: 0.123 };
    const sheet2 = { supportedEmotions: {},
      presets: { user: [{ name: 'senang', category: 'emosi', values: custom }] } };
    e2.projectEmotionPresets(sheet2);
    ok('user emosi preset overrides the builtin of the same name',
      approx(sheet2.supportedEmotions.senang.ParamMouthForm, 0.123),
      JSON.stringify(sheet2.supportedEmotions.senang));

    // A sheet saved under a DIFFERENT model carries foreign ids; builtin entries
    // must be rebuilt from the current rig, never trusted from disk.
    const e3 = makeEngine(CANON);
    e3.refreshRoleEmotions();
    const stale = { supportedEmotions: { senang: { foreign_id_from_other_rig: 1 },
                                         ghost_emotion: { another_foreign: 1 } },
                    presets: { user: [] } };
    e3.projectEmotionPresets(stale);
    ok('foreign ids from another rig are purged from builtin entries',
      !Object.prototype.hasOwnProperty.call(stale.supportedEmotions.senang || {},
        'foreign_id_from_other_rig'),
      JSON.stringify(stale.supportedEmotions.senang));
    ok('builtin entries are rebuilt against the CURRENT model',
      Object.keys(stale.supportedEmotions.senang || {}).every(id => CANON.paramRange[id]),
      Object.keys(stale.supportedEmotions.senang || {}).join(','));

    // An opaque model must advertise nothing — silence beats a wrong face.
    const e4 = makeEngine(OPAQUE);
    e4.refreshRoleEmotions();
    const sheet4 = { supportedEmotions: { senang: { m_001: 1 } }, presets: { user: [] } };
    e4.projectEmotionPresets(sheet4);
    ok('opaque model advertises no builtin emotions',
      Object.keys(sheet4.supportedEmotions).length === 0,
      Object.keys(sheet4.supportedEmotions).join(',') || 'none');
  }
}

section('7. SOURCE GUARD: no character-specific data in the emotion tables');
{
  const lines = tplMatch[0].split('\n').map(l => l.replace(/\/\/.*$/, ''));
  const code = lines.join('\n');

  // Numbered ids are one rigger's slot numbering — the Param91 defect class.
  const numbered = code.match(/Param\d+/g) || [];
  ok('templates contain no numbered parameter ids', numbered.length === 0,
    numbered.join(',') || 'clean');

  // Any Cubism id at all means the table stopped being role-space.
  const rawIds = code.match(/\bParam[A-Za-z]+\b/g) || [];
  ok('templates contain no raw Cubism parameter ids', rawIds.length === 0,
    rawIds.join(',') || 'clean');

  // Character names must not appear anywhere in the emotion engine.
  const region = appSrc.slice(appSrc.indexOf('const NORM_TEMPLATE_ROLES'),
                             appSrc.indexOf('function detectModelCapabilities'));
  ok('emotion engine names no specific character',
    !/lumine|genshin|神宫白子|面饼|ichika/i.test(region.replace(/\/\/.*$/gm, '')),
    'clean');

  // Every template key must be a role the keyword table can actually resolve.
  const kwBlock = appSrc.slice(appSrc.indexOf('const ROLE_KEYWORDS'),
                               appSrc.indexOf('const GROUP_PATTERNS'));
  const knownRoles = new Set((kwBlock.match(/^\s{4}(\w+):/gm) || [])
    .map(s => s.trim().replace(':', '')));
  const usedRoles = new Set();
  for (const m of code.matchAll(/(\w+)\s*:\s*-?[\d.]+/g)) usedRoles.add(m[1]);
  const unknown = [...usedRoles].filter(r => !knownRoles.has(r));
  ok('every template role exists in ROLE_KEYWORDS', unknown.length === 0,
    unknown.join(',') || `${usedRoles.size} roles`);

  // NORM_TEMPLATE_ROLES must also be real roles, or the 0..1 mapping is dead.
  const normRoles = (normRolesMatch[0].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
  const unknownNorm = normRoles.filter(r => !knownRoles.has(r));
  ok('every NORM_TEMPLATE_ROLES entry exists in ROLE_KEYWORDS',
    unknownNorm.length === 0, unknownNorm.join(',') || normRoles.join(','));

  // The array-shaped-map trap must stay closed everywhere it was found.
  const naiveGuards = (appSrc.match(/typeof sheet\.supportedEmotions !== 'object'\)/g) || []);
  ok('no naive typeof-only guard remains on supportedEmotions',
    naiveGuards.length === 0, `${naiveGuards.length} left`);
  ok('migrateSheet() rejects array-shaped maps via asMap()',
    /const asMap = \(v\) =>[\s\S]*?Array\.isArray\(v\)/.test(appSrc));
}

section('8. Real sheets on disk survive the current engine');
{
  const dir = path.join(ROOT, 'sheets');
  let checked = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!d.roleIds || !Object.keys(d.roleIds).length) continue;
      checked++;
      const byId = {};
      (d.params || []).forEach(p => { byId[p.id] = p; });
      const paramRange = {};
      for (const id of Object.keys(byId)) {
        const p = (d.paramRange || {})[id] || byId[id];
        if (p && typeof p.min === 'number' && typeof p.max === 'number') {
          paramRange[id] = { min: p.min, max: p.max,
            def: typeof p.def === 'number' ? p.def : 0 };
        }
      }
      const e = makeEngine({ roleIds: d.roleIds, paramRange });
      const v = e.buildRoleEmotions();
      const label = d.modelName || f;
      ok(`[${label}] derives a non-empty emotion vocabulary`,
        Object.keys(v).length > 0, Object.keys(v).join(',') || 'NONE');
      const bad = [];
      for (const emo in v) {
        for (const id in v[emo]) {
          const r = paramRange[id];
          if (!r) { bad.push(`${emo}.${id}:unowned`); continue; }
          const lo = Math.min(r.min, r.max), hi = Math.max(r.min, r.max);
          if (!(v[emo][id] >= lo - 1e-9 && v[emo][id] <= hi + 1e-9)) {
            bad.push(`${emo}.${id}=${v[emo][id]}`);
          }
        }
      }
      ok(`[${label}] all emotion values land inside declared ranges`,
        bad.length === 0, bad.join(',') || 'clean');
      // Emotions must be DISTINGUISHABLE, or the face reads as one expression.
      const sigs = Object.keys(v).map(k => JSON.stringify(v[k]));
      ok(`[${label}] emotions are distinguishable from each other`,
        new Set(sigs).size === sigs.length, `${new Set(sigs).size}/${sigs.length} unique`);
    }
  }
  ok('at least one real sheet exercised', checked > 0, `${checked} sheet(s)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
