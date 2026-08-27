#!/usr/bin/env node
/* test-param-scaling.js — the REFERENCE SCALE must never leak model assumptions.
 *
 * WHY THIS EXISTS
 * All motion in js/app.js is authored in a REFERENCE scale that was tuned against
 * one rig (神宫白子: head half-range ~30 degrees). That is only safe because a
 * mapping layer (toActual / roleClampActual / pokeRoleNorm) converts reference
 * values into whatever range THIS model actually declares. The danger is a
 * BYPASS: any code path that writes a literal number straight at a role param
 * re-introduces the hardcoded assumption, and it fails SILENTLY.
 *
 * Measured on this project: BOTH bundled models happen to use eyeOpen 0..1 and
 * angle +-30, so every bypass looked correct. A rig using 0..100, an inverted
 * range, or a non-zero default would break with no error at all:
 *   - blink wrote pokeParam(eyeLOpen, 0/1)      -> never blinks on a 0..100 rig
 *   - breath wrote pokeParam(breath, 0..1)      -> no breathing
 *   - lip-sync wrote Math.min(1, ...)           -> mouth visually shut while talking
 *   - mouth rest wrote state.mouthRest (0)      -> mouth forced shut after each line
 *
 * This suite pins the mapping maths AND greps the shipped source so a future
 * bypass turns the build red instead of quietly flattening the character.
 *
 * Run: node test/test-param-scaling.js
 */
'use strict';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function section(t) { console.log(`\n${t}`); }

// ── Port of the shipped mapping layer (js/app.js is a browser IIFE) ──────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const REF_HALF = 30;
const DEGREE_ROLES = new Set(['angleX','angleY','angleZ','bodyAngleX','bodyAngleY','bodyAngleZ']);
const refHalfFor = (role) => DEGREE_ROLES.has(role) ? REF_HALF : 1;

function makeRig(ranges) {
  const roleRange = (role) => ranges[role] || null;
  const toActual = (role, vRef) => {
    const RH = refHalfFor(role);
    const r = roleRange(role);
    if (!r) return clamp(vRef, -RH, RH);
    const mid = (r.max + r.min) / 2, half = (r.max - r.min) / 2;
    return mid + (vRef / RH) * (half || RH);
  };
  const roleClampActual = (role, v) => {
    const r = roleRange(role);
    if (!r) return clamp(v, -42, 42);
    return clamp(v, r.min, r.max);
  };
  const pokeRoleNorm = (role, t) => {
    const r = roleRange(role);
    return r ? r.min + clamp(t, 0, 1) * (r.max - r.min) : clamp(t, 0, 1);
  };
  const roleDefault = (role) => {
    const r = roleRange(role);
    return (r && typeof r.def === 'number') ? r.def : 0;
  };
  const write = (role, vRef) => roleClampActual(role, toActual(role, vRef));
  return { toActual, roleClampActual, pokeRoleNorm, roleDefault, write };
}

// Three rigs: the reference one, a degrees-but-smaller one, and a hostile one
// that uses percent ranges, an inverted eye, and non-zero defaults.
const REFERENCE = makeRig({
  angleX: { min: -30, max: 30, def: 0 },
  eyeBallX: { min: -1, max: 1, def: 0 },
  eyeLOpen: { min: 0, max: 1, def: 1 },
  breath: { min: 0, max: 1, def: 0 },
  mouthOpenY: { min: 0, max: 1, def: 0 },
});
const SMALL = makeRig({
  angleX: { min: -10, max: 10, def: 0 },
  eyeBallX: { min: -0.5, max: 0.5, def: 0 },
  eyeLOpen: { min: 0, max: 1, def: 1 },
  breath: { min: 0, max: 1, def: 0 },
  mouthOpenY: { min: 0, max: 1, def: 0 },
});
const HOSTILE = makeRig({
  angleX: { min: -90, max: 90, def: 0 },
  eyeBallX: { min: -10, max: 10, def: 0 },
  eyeLOpen: { min: 0, max: 100, def: 100 },   // percent, rests OPEN
  breath: { min: 0, max: 100, def: 0 },
  mouthOpenY: { min: 0, max: 100, def: 20 },  // rests slightly ajar
});

section('A) Reference scale reproduces itself on the reference rig');
ok('full-left head maps to the rig minimum',
  approx(REFERENCE.write('angleX', -30), -30), String(REFERENCE.write('angleX', -30)));
ok('centre maps to centre', approx(REFERENCE.write('angleX', 0), 0));
ok('gaze uses the NORMALIZED reference (+-1), not +-30',
  approx(REFERENCE.write('eyeBallX', 1), 1), String(REFERENCE.write('eyeBallX', 1)));

section('B) Same authored intent scales PROPORTIONALLY across rigs');
// Identical reference input must reach the same FRACTION of travel everywhere.
for (const [name, rig, expect] of [['reference', REFERENCE, 30], ['small', SMALL, 10], ['hostile', HOSTILE, 90]]) {
  ok(`[${name}] full-right head reaches the rig's own max`,
    approx(rig.write('angleX', 30), expect), String(rig.write('angleX', 30)));
  const half = rig.write('angleX', 15);
  ok(`[${name}] half intent = half travel (${half})`, approx(half, expect / 2));
}
ok('a small rig is NOT driven to the reference +-30 (would over-rotate)',
  Math.abs(SMALL.write('angleX', 30)) === 10, String(SMALL.write('angleX', 30)));
ok('a large rig is NOT capped at the reference 30 (would under-rotate)',
  Math.abs(HOSTILE.write('angleX', 30)) === 90, String(HOSTILE.write('angleX', 30)));

section('C) Gaze must not be squashed by the DEGREE reference');
// Historic bug: normalized roles were divided by 30, so the eyes moved ~3% of
// their range and the gaze looked frozen mid-face.
for (const [name, rig] of [['reference', REFERENCE], ['small', SMALL], ['hostile', HOSTILE]]) {
  const r = { reference: 1, small: 0.5, hostile: 10 }[name];
  ok(`[${name}] full gaze reaches full eye travel`,
    approx(rig.write('eyeBallX', 1), r), String(rig.write('eyeBallX', 1)));
}
ok('gaze on the hostile rig is not stuck near zero',
  Math.abs(HOSTILE.write('eyeBallX', 1)) > 1, String(HOSTILE.write('eyeBallX', 1)));

section('D) Normalized writers (blink / breath / lip-sync) respect real ranges');
ok('blink CLOSED hits the rig minimum on a percent rig',
  HOSTILE.pokeRoleNorm('eyeLOpen', 0) === 0);
ok('blink OPEN hits 100 on a percent rig, not the literal 1',
  HOSTILE.pokeRoleNorm('eyeLOpen', 1) === 100,
  String(HOSTILE.pokeRoleNorm('eyeLOpen', 1)));
ok('the old literal 1 would have been a 1% blink (bug reproduced)',
  HOSTILE.pokeRoleNorm('eyeLOpen', 1) !== 1);
ok('full breath reaches the rig max',
  HOSTILE.pokeRoleNorm('breath', 1) === 100);
// Lip-sync authors an openness FRACTION; peak talking is ~0.75-1.0.
const talkPeak = HOSTILE.pokeRoleNorm('mouthOpenY', 0.75);
ok('talking opens the mouth visibly on a percent rig',
  talkPeak === 75, String(talkPeak));
ok('a raw 0.75 literal would be visually shut (bug reproduced)',
  talkPeak > 1);

section('E) Resting values come from the MODEL default, not a literal 0');
ok('eyes rest OPEN when the rig says so', HOSTILE.roleDefault('eyeLOpen') === 100,
  String(HOSTILE.roleDefault('eyeLOpen')));
ok('mouth rests at the rig default, not forced shut',
  HOSTILE.roleDefault('mouthOpenY') === 20, String(HOSTILE.roleDefault('mouthOpenY')));
ok('absent range degrades to 0 rather than throwing',
  makeRig({}).roleDefault('mouthOpenY') === 0);

section('F) Clamping never escapes the model\'s declared range');
for (const [name, rig, lo, hi] of [['reference', REFERENCE, -30, 30], ['small', SMALL, -10, 10], ['hostile', HOSTILE, -90, 90]]) {
  const over = rig.write('angleX', 999), under = rig.write('angleX', -999);
  ok(`[${name}] overshoot clamps to max`, over === hi, String(over));
  ok(`[${name}] undershoot clamps to min`, under === lo, String(under));
}
ok('normalized writer clamps t>1', HOSTILE.pokeRoleNorm('eyeLOpen', 5) === 100);
ok('normalized writer clamps t<0', HOSTILE.pokeRoleNorm('eyeLOpen', -5) === 0);

section('G) Asymmetric range: mapping must honour the MIDPOINT, not assume 0');
// A rig whose head travels -10..+40 has its neutral at +15. Assuming 0 is centre
// would leave the head permanently cocked to one side.
const ASYM = makeRig({ angleX: { min: -10, max: 40, def: 15 } });
ok('centre intent lands on the true midpoint (15)',
  approx(ASYM.write('angleX', 0), 15), String(ASYM.write('angleX', 0)));
ok('full-right lands on max', approx(ASYM.write('angleX', 30), 40));
ok('full-left lands on min', approx(ASYM.write('angleX', -30), -10));

section('H) Missing range info degrades safely, never wildly');
const BLIND = makeRig({});
ok('unknown degree role stays within the reference half',
  BLIND.write('angleX', 999) === 30, String(BLIND.write('angleX', 999)));
ok('unknown normalized role stays within +-1',
  BLIND.write('eyeBallX', 999) === 1, String(BLIND.write('eyeBallX', 999)));

section('I) SOURCE GUARD: no role param may be written with a bare literal');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const lines = src.split('\n');
  // Strip comments so prose describing the old bugs doesn't trip the guard.
  const code = lines.map(l => l.replace(/\/\/.*$/, ''));

  // 1) pokeParam(<roleId(...) or lo/ro>, <numeric literal>) — the classic bypass.
  const bypass = [];
  code.forEach((l, i) => {
    const m = l.match(/pokeParam\(\s*(?:roleId\([^)]*\)|lo|ro)\s*,\s*(-?[\d.]+)\s*,/);
    if (m) bypass.push(`${i + 1}: ${l.trim()}`);
  });
  ok('no pokeParam(role, <literal>) bypass remains',
    bypass.length === 0, bypass.join(' | ') || 'clean');

  // 2) blink must go through role space.
  const blinkRaw = [];
  code.forEach((l, i) => {
    if (/pokeParam\(\s*(lo|ro)\s*,/.test(l)) blinkRaw.push(`${i + 1}: ${l.trim()}`);
  });
  ok('blink uses pokeRoleNorm, not raw eye ids',
    blinkRaw.length === 0, blinkRaw.join(' | ') || 'clean');

  // 3) lip-sync must not assign a bare 0..1 to the mouth override.
  const lipRaw = [];
  code.forEach((l, i) => {
    if (/state\.overrides\[mId\]\s*=\s*Math\.min\(\s*1\s*,/.test(l)) lipRaw.push(`${i + 1}: ${l.trim()}`);
  });
  ok('lip-sync maps openness into the real mouth range',
    lipRaw.length === 0, lipRaw.join(' | ') || 'clean');

  // 4) the mapping helpers must still exist and be used.
  for (const fn of ['pokeRoleNorm', 'pokeRoleRef', 'roleDefault', 'toActual', 'roleClampActual']) {
    const declared = new RegExp(`function ${fn}\\b|const ${fn}\\s*=`).test(src);
    ok(`helper ${fn}() is present`, declared);
  }
  const usedNorm = (src.match(/pokeRoleNorm\(/g) || []).length;
  ok('pokeRoleNorm is actually used by the animation code',
    usedNorm >= 6, `${usedNorm} call site(s)`);

  // 5) REF_HALF must remain a single documented constant, not sprinkled magic.
  const refHalfLits = (code.join('\n').match(/\/\s*30\b|\*\s*30\b/g) || []);
  ok('no stray /30 or *30 magic outside the constant',
    refHalfLits.length === 0, refHalfLits.join(',') || 'clean');
}

section('J) Real sheets: every role range is usable by the mapping layer');
{
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'sheets');
  let checked = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const byId = {};
      (d.params || []).forEach(p => { byId[p.id] = p; });
      const ranges = {};
      for (const [role, id] of Object.entries(d.roleIds || {})) {
        const p = (d.paramRange || {})[id] || byId[id];
        if (p && typeof p.min === 'number' && typeof p.max === 'number') ranges[role] = p;
      }
      if (!Object.keys(ranges).length) continue;
      checked++;
      const rig = makeRig(ranges);
      const label = d.modelName || f;
      let bad = [];
      for (const role of Object.keys(ranges)) {
        const r = ranges[role];
        for (const vRef of [-refHalfFor(role), 0, refHalfFor(role)]) {
          const out = rig.write(role, vRef);
          if (!(out >= r.min - 1e-9 && out <= r.max + 1e-9) || Number.isNaN(out)) {
            bad.push(`${role}@${vRef}->${out}`);
          }
        }
      }
      ok(`[${label}] all role writes land inside the declared range`,
        bad.length === 0, bad.join(',') || `${Object.keys(ranges).length} roles`);
      // Full-travel intent must actually MOVE the param (no dead roles).
      const dead = Object.keys(ranges).filter(role =>
        ranges[role].max !== ranges[role].min &&
        approx(rig.write(role, refHalfFor(role)), rig.write(role, 0)));
      ok(`[${label}] full intent produces real movement on every role`,
        dead.length === 0, dead.join(',') || 'none dead');
    }
  }
  ok('at least one real sheet exercised', checked > 0, `${checked} sheet(s)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
