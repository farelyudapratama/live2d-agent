#!/usr/bin/env node
/* test-role-mapping.js — MODEL-AGNOSTIC guarantees for role resolution.
 *
 * WHY THIS EXISTS
 * The system must work with ANY Live2D Cubism model a user imports, not just the
 * ones that happen to sit in model/ today. Historically it did not:
 *   1. ROLE_KEYWORDS listed 'Param91' (one model's blush slot) at highest
 *      priority, so any OTHER model owning Param91 got a random body part
 *      animated whenever the character blushed.
 *   2. PARAM_META hardcoded 9 numbered accessory ids from one model.
 *   3. mapRoles() read meaning out of ARRAY ORDER (lipSyncIds[0],
 *      eyeBlinkIds[0]/[1]). model3.json Groups order is arbitrary, so on a real
 *      model mouthOpenY aliased onto mouthForm and the mouth never opened.
 *
 * These are one class of defect: a FEATURE depending on a name, number, or
 * ordering the rigger was free to choose. This suite falsifies that dependence.
 *
 * Run: node test/test-role-mapping.js
 */
'use strict';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────────
// Port of the shipped logic from js/app.js (browser IIFE, not importable).
// Keep in sync with js/app.js: ROLE_KEYWORDS / GROUP_PATTERNS / mapRoles.
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_KEYWORDS = {
  angleX:     ['ParamAngleX','AngleX','angle_x','yaw','turnx','rotx','頭','头','横向','左右'],
  angleY:     ['ParamAngleY','AngleY','angle_y','pitch','turny','roty','縦','纵向','上下'],
  angleZ:     ['ParamAngleZ','AngleZ','angle_z','roll','tilt','傾','倾','歪'],
  eyeBallX:   ['ParamEyeBallX','EyeBallX','eyeball_x','lookx','瞳','眼球','目玉'],
  eyeBallY:   ['ParamEyeBallY','EyeBallY','eyeball_y','looky','瞳','眼球','目玉'],
  eyeLOpen:   ['ParamEyeLOpen','EyeLOpen','eye_l_open','左目','左眼'],
  eyeROpen:   ['ParamEyeROpen','EyeROpen','eye_r_open','右目','右眼'],
  mouthOpenY: ['ParamMouthOpenY','MouthOpenY','mouth_open','口開','张口','张嘴'],
  mouthForm:  ['ParamMouthForm','MouthForm','mouth_form','口角','口形','嘴形','口型'],
  bodyAngleX: ['ParamBodyAngleX','BodyAngleX','body_angle_x','bodyx','体','胴','躯'],
  blush:      ['ParamBlush','Blush','blush','ParamCheekRed','CheekRed',
               '頬紅','ほお染め','照れ','脸红','腮红','害羞'],
};

const GROUP_PATTERNS = {
  mouthOpenY: [/openy$/i, /mouthopen/i, /open/i, /口開|開口|口を開/, /张口|张嘴|开口/],
  eyeLOpen:   [/eyelopen/i, /^parameyel.*open/i, /_l_?open/i, /left.*open/i, /左目|左眼/],
  eyeROpen:   [/eyeropen/i, /^parameyer.*open/i, /_r_?open/i, /right.*open/i, /右目|右眼/],
};

function pickFromGroup(list, patterns) {
  if (!Array.isArray(list) || !list.length) return null;
  for (const re of patterns) {
    const hit = list.find(id => typeof id === 'string' && re.test(id));
    if (hit) return hit;
  }
  return null;
}

function mapRoles(paramSet, official) {
  const ids = {};
  if (!paramSet || !paramSet.size) return ids;
  const list = Array.from(paramSet).map(id => id.toLowerCase());
  const lowerToReal = {};
  Array.from(paramSet).forEach((id, i) => { lowerToReal[list[i]] = id; });
  for (const role in ROLE_KEYWORDS) {
    if (official && GROUP_PATTERNS[role]) {
      const pool = (role === 'mouthOpenY') ? official.lipSyncIds : official.eyeBlinkIds;
      const owned = (pool || []).filter(id => paramSet.has(id));
      const picked = pickFromGroup(owned, GROUP_PATTERNS[role]);
      if (picked) { ids[role] = picked; continue; }
      if (owned.length === 1) { ids[role] = owned[0]; continue; }
    }
    const canonical = 'Param' + role.charAt(0).toUpperCase() + role.slice(1);
    if (paramSet.has(canonical)) { ids[role] = canonical; continue; }
    let foundLower = null;
    for (const kw of ROLE_KEYWORDS[role]) {
      const lk = kw.toLowerCase();
      const hit = list.find(x => x.includes(lk));
      if (hit) { foundLower = hit; break; }
    }
    if (foundLower) ids[role] = lowerToReal[foundLower];
  }
  if (ids.mouthOpenY && ids.mouthOpenY === ids.mouthForm) {
    const alt = Array.from(paramSet).find(id =>
      /open/i.test(id) && /mouth|口|嘴/i.test(id) && id !== ids.mouthForm);
    if (alt) ids.mouthOpenY = alt; else delete ids.mouthOpenY;
  }
  return ids;
}

// Accessory detection (ported from inspectModel step 4)
function detectAccessories(params, roleIds) {
  const ROLE_ID_SET = new Set(Object.values(roleIds).filter(Boolean));
  return params.filter(p =>
    p.min >= 0 && p.max <= 1 && p.def === 0 &&
    !ROLE_ID_SET.has(p.id) && !/physics/i.test(p.id) &&
    /^Param\d+$/.test(p.id)
  ).map(p => p.id);
}

// ─────────────────────────────────────────────────────────────────────────────
section('A) REGRESSION: lipSync group order must not alias mouthOpenY');
// Real observed case: LipSync group lists ParamMouthForm FIRST.
{
  const params = new Set(['ParamMouthForm','ParamMouthOpenY','ParamAngleX']);
  const official = { lipSyncIds: ['ParamMouthForm','ParamMouthOpenY'], eyeBlinkIds: [] };
  const r = mapRoles(params, official);
  ok('mouthOpenY picks the OPEN param, not index 0',
    r.mouthOpenY === 'ParamMouthOpenY', r.mouthOpenY);
  ok('mouthOpenY !== mouthForm (no aliasing)',
    r.mouthOpenY !== r.mouthForm, `${r.mouthOpenY} vs ${r.mouthForm}`);
}
// Reversed order must give the SAME answer — proves order-independence.
{
  const params = new Set(['ParamMouthForm','ParamMouthOpenY']);
  const a = mapRoles(params, { lipSyncIds: ['ParamMouthForm','ParamMouthOpenY'], eyeBlinkIds: [] });
  const b = mapRoles(params, { lipSyncIds: ['ParamMouthOpenY','ParamMouthForm'], eyeBlinkIds: [] });
  ok('result identical under reversed group order',
    a.mouthOpenY === b.mouthOpenY, `${a.mouthOpenY} == ${b.mouthOpenY}`);
}

section('B) REGRESSION: eyeBlink group order must not swap L/R');
{
  const params = new Set(['ParamEyeLOpen','ParamEyeROpen']);
  // Rigger wrote RIGHT first — index-based code would swap the eyes.
  const r = mapRoles(params, { eyeBlinkIds: ['ParamEyeROpen','ParamEyeLOpen'], lipSyncIds: [] });
  ok('eyeLOpen resolves to the LEFT param', r.eyeLOpen === 'ParamEyeLOpen', r.eyeLOpen);
  ok('eyeROpen resolves to the RIGHT param', r.eyeROpen === 'ParamEyeROpen', r.eyeROpen);
}

section('C) REGRESSION: numbered ids must never carry meaning');
{
  // A THIRD-PARTY model that uses Param91 for something unrelated (a tail).
  // The old table listed 'Param91' as the top blush keyword.
  const params = new Set(['Param91','ParamAngleX','ParamMouthForm']);
  const r = mapRoles(params, null);
  ok('Param91 is NOT claimed as blush', r.blush !== 'Param91', String(r.blush));
  ok('no blush role at all when model has no blush param',
    r.blush === undefined, String(r.blush));
}
{
  // cheek PUFF is a different action from blushing; must not be mistaken for it.
  const params = new Set(['ParamCheekPuffR','ParamCheekPuffL']);
  const r = mapRoles(params, null);
  ok('ParamCheekPuff is NOT treated as blush', r.blush === undefined, String(r.blush));
}
{
  const params = new Set(['ParamBlush','Param91']);
  const r = mapRoles(params, null);
  ok('a real blush param IS found', r.blush === 'ParamBlush', r.blush);
}

section('D) RENAME-INVARIANCE: canonical model under 4 naming schemes');
// The SAME rig described with different vocabularies must resolve the same ROLES.
// This is the core model-agnostic guarantee.
const schemes = {
  english:  { angleX:'ParamAngleX', mouthOpen:'ParamMouthOpenY', mouthForm:'ParamMouthForm',
              eyeL:'ParamEyeLOpen', eyeR:'ParamEyeROpen' },
  japanese: { angleX:'頭の左右',     mouthOpen:'口開き',          mouthForm:'口形',
              eyeL:'左目の開閉',     eyeR:'右目の開閉' },
  chinese:  { angleX:'头部左右',     mouthOpen:'张嘴',            mouthForm:'嘴形',
              eyeL:'左眼开闭',       eyeR:'右眼开闭' },
};
for (const [name, s] of Object.entries(schemes)) {
  const params = new Set(Object.values(s));
  const official = { lipSyncIds: [s.mouthForm, s.mouthOpen], eyeBlinkIds: [s.eyeR, s.eyeL] };
  const r = mapRoles(params, official);
  ok(`[${name}] mouthOpenY resolved & distinct from mouthForm`,
    !!r.mouthOpenY && r.mouthOpenY !== r.mouthForm, `${r.mouthOpenY} vs ${r.mouthForm}`);
  ok(`[${name}] head yaw resolved`, r.angleX === s.angleX, String(r.angleX));
  ok(`[${name}] left/right eyes not swapped`,
    r.eyeLOpen === s.eyeL && r.eyeROpen === s.eyeR, `${r.eyeLOpen} / ${r.eyeROpen}`);
}

section('E) OPAQUE model: fully meaningless ids must degrade SAFELY');
// Worst case: a rigger names everything m_001..m_050. We cannot invent meaning —
// the requirement is that we resolve NOTHING rather than resolve WRONGLY, and
// that a single-member group is still usable (unambiguous by construction).
{
  const params = new Set(Array.from({ length: 20 }, (_, i) => `m_${String(i).padStart(3, '0')}`));
  const r = mapRoles(params, null);
  const resolved = Object.keys(r);
  ok('opaque ids resolve to NO roles (no false positives)',
    resolved.length === 0, `resolved: [${resolved.join(',')}]`);
}
{
  // Groups metadata rescues an opaque model: LipSync has exactly one member.
  const params = new Set(['m_001','m_002','m_003']);
  const r = mapRoles(params, { lipSyncIds: ['m_002'], eyeBlinkIds: [] });
  ok('single-member LipSync group is used even with opaque id',
    r.mouthOpenY === 'm_002', String(r.mouthOpenY));
}
{
  // Ambiguous opaque group: 2 members, no name signal -> must NOT guess.
  const params = new Set(['m_001','m_002']);
  const r = mapRoles(params, { lipSyncIds: ['m_001','m_002'], eyeBlinkIds: [] });
  ok('ambiguous opaque group does not silently pick index 0',
    r.mouthOpenY === undefined, String(r.mouthOpenY));
}

section('F) Groups metadata must not inject params the model lacks');
{
  const params = new Set(['ParamMouthForm']);
  // Stale Groups referencing a removed param.
  const r = mapRoles(params, { lipSyncIds: ['ParamMouthOpenY'], eyeBlinkIds: [] });
  ok('nonexistent id from Groups is rejected',
    r.mouthOpenY !== 'ParamMouthOpenY', String(r.mouthOpenY));
}

section('G) Accessory detection is measured, not hardcoded');
{
  // Model WITH numbered accessory toggles (the shape the old list encoded).
  const withAcc = [
    { id:'Param91', min:0, max:1, def:0 }, { id:'Param92', min:0, max:1, def:0 },
    { id:'Param52', min:0, max:1, def:0 }, { id:'ParamAngleX', min:-30, max:30, def:0 },
  ];
  const acc = detectAccessories(withAcc, mapRoles(new Set(withAcc.map(p=>p.id)), null));
  ok('toggle-shaped numbered params detected as accessories',
    acc.length === 3, `[${acc.join(',')}]`);

  // A DIFFERENT rigger's numbering — must work identically.
  const other = [
    { id:'Param7', min:0, max:1, def:0 }, { id:'Param300', min:0, max:1, def:0 },
  ];
  const acc2 = detectAccessories(other, mapRoles(new Set(other.map(p=>p.id)), null));
  ok('works on unrelated numbering (7/300, not 91/92)',
    acc2.length === 2, `[${acc2.join(',')}]`);

  // Model with NO accessories must yield none (no phantom entries from a list).
  const noAcc = [
    { id:'ParamMouthForm', min:-1, max:1, def:0 },
    { id:'ParamMouthOpenY', min:0, max:1, def:0 },
  ];
  const acc3 = detectAccessories(noAcc, mapRoles(new Set(noAcc.map(p=>p.id)), null));
  ok('model without accessories yields zero', acc3.length === 0, `[${acc3.join(',')}]`);

  // A semantic role that happens to be toggle-shaped must not be exposed.
  const roleShaped = [{ id:'Param91', min:0, max:1, def:0 }];
  const acc4 = detectAccessories(roleShaped, { blush: 'Param91' });
  ok('param claimed as a role is excluded from accessories',
    acc4.length === 0, `[${acc4.join(',')}]`);
}

section('H) Real sheets on disk must satisfy the mouth invariant');
{
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'sheets');
  let checked = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const ids = d.roleIds || {};
      if (!ids.mouthOpenY && !ids.mouthForm) continue;
      checked++;
      const owned = new Set((d.params || []).map(p => p.id));
      // Re-resolve with the FIXED logic; the sheet on disk may predate the fix.
      const re = mapRoles(owned, null);
      ok(`[${d.modelName || f}] re-resolved mouthOpenY !== mouthForm`,
        !re.mouthOpenY || re.mouthOpenY !== re.mouthForm,
        `${re.mouthOpenY} vs ${re.mouthForm}`);
      if (ids.mouthOpenY === ids.mouthForm) {
        console.log(`        note: sheet on disk is STALE (aliased as ` +
          `${ids.mouthOpenY}); re-scan the model to regenerate it.`);
      }
    }
  }
  ok('at least one real sheet exercised', checked > 0, `${checked} sheet(s)`);
}

section('I) Guard: no numbered id may appear in ROLE_KEYWORDS');
{
  const offenders = [];
  for (const role in ROLE_KEYWORDS) {
    for (const kw of ROLE_KEYWORDS[role]) {
      if (/^Param\d+$/i.test(kw)) offenders.push(`${role}:${kw}`);
    }
  }
  ok('keyword table free of model-specific numbered ids',
    offenders.length === 0, offenders.length ? offenders.join(',') : 'clean');
}
{
  // Same guard against the SHIPPED source, so app.js can't regress silently.
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const kwBlock = src.slice(src.indexOf('const ROLE_KEYWORDS'),
                            src.indexOf('const GROUP_PATTERNS'));
  // Strip // comments first: the block deliberately DISCUSSES Param91 in prose
  // explaining why numbered ids are banned, and that must not trip the guard.
  const kwCode = kwBlock.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const badKw = kwCode.match(/'Param\d+'/g) || [];
  ok('js/app.js ROLE_KEYWORDS has no numbered ids',
    badKw.length === 0, badKw.join(',') || 'clean');
  const metaStart = src.indexOf('const PARAM_META');
  const metaBlock = src.slice(metaStart, src.indexOf('function findParamMeta'));
  const badMeta = metaBlock.match(/^\s+Param\d+:/gm) || [];
  ok('js/app.js PARAM_META has no numbered accessory entries',
    badMeta.length === 0, badMeta.map(s => s.trim()).join(' ') || 'clean');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
