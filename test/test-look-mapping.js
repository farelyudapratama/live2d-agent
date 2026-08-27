// Offline proof that the mouse look mapping lets her reach FULL travel in every
// direction, on any framing, and with the correct sign.
//
// Mocks just enough PIXI (getLocalBounds / toGlobal) — no WebGL — because
// headless Chrome often returns only the "Memuat model..." screen for this heavy
// async Cubism model, so a screenshot cannot prove a gaze angle.
//
// The bug this locks down: normalizing the cursor offset by the model's LOCAL
// height made the reachable range wildly asymmetric. In upper-body framing the
// eye line sits near the TOP of the canvas, so there were only ~130px of room
// above it versus ~495px below — the cursor could reach barely a third of the
// upward range while downward saturated past 100%. She physically could not
// look up. Normalizing per-side against the available canvas room fixes it.
//
// Sign convention, verified against the real rig via coreModel reads:
//   ParamAngleY / ParamEyeBallY are POSITIVE when looking UP.
//
// Run: node test/test-look-mapping.js

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  -> ' + extra : '')); }
  else      { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}

const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

// REF_HALF and gains mirror js/app.js. Keep them in sync.
const REF_HALF = 30;
const BODY_RATIO = 0.25;
const EYE_FRACTION = 0.22;

function makeModel(localW, localH, scale, posX, posY) {
  const lb = { x: 0, y: 0, width: localW, height: localH };
  return {
    getLocalBounds: () => lb,
    toGlobal: (p) => ({ x: p.x * scale + posX, y: p.y * scale + posY }),
  };
}

// THE mapping now in js/app.js.
const MARGIN = 0.15;
function computeLook(m, screenW, screenH, clientX, clientY) {
  const lb = m.getLocalBounds();
  const eye = m.toGlobal({ x: lb.x + lb.width / 2, y: lb.y + lb.height * EYE_FRACTION });

  // Reference point is kept inside the canvas with a margin on every side, so
  // an extreme zoom can never push it off-screen and starve one direction.
  const refX = clamp(eye.x, screenW * MARGIN, screenW * (1 - MARGIN));
  const refY = clamp(eye.y, screenH * MARGIN, screenH * (1 - MARGIN));

  const upRoom    = Math.max(1, refY);
  const downRoom  = Math.max(1, screenH - refY);
  const leftRoom  = Math.max(1, refX);
  const rightRoom = Math.max(1, screenW - refX);

  const rawY = clientY - refY;
  const rawX = clientX - refX;
  const ny = clamp(-rawY / (rawY < 0 ? upRoom : downRoom), -1, 1);
  const nx = clamp(rawX / (rawX < 0 ? leftRoom : rightRoom), -1, 1);

  return {
    tax: nx * REF_HALF, tay: ny * REF_HALF,
    tex: nx,            tey: ny,
    tbx: nx * REF_HALF * BODY_RATIO, tby: ny * REF_HALF * BODY_RATIO,
    eyeX: refX, eyeY: refY, ny, nx,
  };
}

const SW = 882, SH = 624, LW = 5000, LH = 8000;
// Real numbers measured from the running app: upper-body framing puts the eye
// line at y≈129 of a 624px canvas — the asymmetric case that caused the bug.
const framings = {
  'UPPER-BODY': makeModel(LW, LH, 0.0819, SW / 2 - (LW / 2) * 0.0819, -16),
  'FULL-BODY':  makeModel(LW, LH, 0.064,  SW / 2 - (LW / 2) * 0.064,  40),
  'ZOOMED-IN':  makeModel(LW, LH, 0.20,   SW / 2 - (LW / 2) * 0.20,   -700),
};

console.log('\nA) Neutral + direction + FULL REACH, per framing');
for (const [name, m] of Object.entries(framings)) {
  const p = computeLook(m, SW, SH, 0, 0);
  const at     = computeLook(m, SW, SH, p.eyeX, p.eyeY);
  const topEdge = computeLook(m, SW, SH, p.eyeX, 0);
  const botEdge = computeLook(m, SW, SH, p.eyeX, SH);

  console.log('\n  [' + name + '] eyeLine y=' + p.eyeY.toFixed(0) + ' of ' + SH +
              '  (roomUp=' + p.eyeY.toFixed(0) + ' roomDown=' + (SH - p.eyeY).toFixed(0) + ')');

  ok(Math.abs(at.tay) < 1e-9, '[' + name + '] cursor ON eye line -> neutral', 'tay=' + at.tay.toFixed(6));
  ok(topEdge.tay > 0, '[' + name + '] cursor at TOP edge -> looks UP', 'tay=' + topEdge.tay.toFixed(2));
  ok(botEdge.tay < 0, '[' + name + '] cursor at BOTTOM edge -> looks DOWN', 'tay=' + botEdge.tay.toFixed(2));

  // THE regression guard: full travel must be reachable in BOTH directions.
  ok(Math.abs(topEdge.tay - REF_HALF) < 1e-6,
     '[' + name + '] TOP edge reaches FULL up range', 'tay=' + topEdge.tay.toFixed(3) + ' / ' + REF_HALF);
  ok(Math.abs(botEdge.tay + REF_HALF) < 1e-6,
     '[' + name + '] BOTTOM edge reaches FULL down range', 'tay=' + botEdge.tay.toFixed(3) + ' / -' + REF_HALF);
  ok(Math.abs(Math.abs(topEdge.tay) - Math.abs(botEdge.tay)) < 1e-6,
     '[' + name + '] up and down reach are SYMMETRIC (container does not clip gaze)',
     '|up|=' + Math.abs(topEdge.tay).toFixed(2) + ' |down|=' + Math.abs(botEdge.tay).toFixed(2));

  // Head, eyeballs and body must agree or they cancel out visually.
  ok(Math.sign(topEdge.tay) === Math.sign(topEdge.tey) &&
     Math.sign(topEdge.tay) === Math.sign(topEdge.tby),
     '[' + name + '] head + eyes + body all agree looking up',
     'tay=' + topEdge.tay.toFixed(1) + ' tey=' + topEdge.tey.toFixed(2) + ' tby=' + topEdge.tby.toFixed(1));
  ok(Math.abs(topEdge.tey) <= 1 + 1e-9 && Math.abs(botEdge.tey) <= 1 + 1e-9,
     '[' + name + '] eyeball stays within normalized ±1 (no clamp overshoot)',
     'tey=' + topEdge.tey.toFixed(2));
}

console.log('\nB) Horizontal reach and sign');
for (const [name, m] of Object.entries(framings)) {
  const p = computeLook(m, SW, SH, 0, 0);
  const right = computeLook(m, SW, SH, SW, p.eyeY);
  const left  = computeLook(m, SW, SH, 0,  p.eyeY);
  ok(right.tax > 0 && left.tax < 0, '[' + name + '] head turns toward cursor',
     'right=' + right.tax.toFixed(1) + ' left=' + left.tax.toFixed(1));
  ok(Math.abs(right.tax - REF_HALF) < 1e-6 && Math.abs(left.tax + REF_HALF) < 1e-6,
     '[' + name + '] both horizontal edges reach FULL range',
     'right=' + right.tax.toFixed(2) + ' left=' + left.tax.toFixed(2));
  ok(Math.sign(right.tax) === Math.sign(right.tex), '[' + name + '] eyeballs track horizontally',
     'tex=' + right.tex.toFixed(2));
}

console.log('\nC) No saturation beyond the reference range (old gains clamped)');
for (const [name, m] of Object.entries(framings)) {
  const p = computeLook(m, SW, SH, 0, 0);
  for (const y of [0, SH * 0.25, p.eyeY, SH * 0.75, SH]) {
    const r = computeLook(m, SW, SH, p.eyeX, y);
    ok(Math.abs(r.tay) <= REF_HALF + 1e-9, '[' + name + '] tay within ±' + REF_HALF + ' at y=' + Math.round(y),
       'tay=' + r.tay.toFixed(2));
  }
}

console.log('\nD) Source guard: js/app.js must normalize per-side, not by local bounds');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  ok(/upRoom/.test(code) && /downRoom/.test(code),
     'per-side room normalization is present (upRoom / downRoom)');
  ok(!/state\.look\.tay\s*=\s*dy\s*\*/.test(code),
     'tay no longer divides by the model local height (dy)');
  // The old overshooting gains must not come back.
  ok(!/state\.look\.tay\s*=\s*[^;]*\b55\b/.test(code),
     'tay does not use the old overshooting gain of 55');
  ok(/state\.look\.tay\s*=\s*ny\s*\*/.test(code),
     'tay is driven by the per-side normalized ny');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
