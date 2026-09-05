#!/usr/bin/env node
/* run-guards.js — runner untuk suite guard legacy di test/legacy/*.
 *
 * Suite di test/legacy adalah skrip mandiri (konvensi: tiap suite mencetak
 * ringkasan "N passed, M failed" sendiri).
 * Runner ini menjalankan tiap file dengan interpreter saat ini (bun — bisa
 * node juga untuk .js), mengambil ringkasan TERAKHIR (beberapa suite mencetak
 * catatan setelah ringkasan), dan exit non-zero bila ada kegagalan.
 *
 * Jalankan: bun run test/run-guards.js   (atau: npm run test:guards)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const legacyDir = path.join(__dirname, 'legacy');

const files = fs.readdirSync(legacyDir)
  .filter(f => /^test-.*\.(js|ts)$/.test(f))
  .sort();

let totalPass = 0, totalFail = 0, suitesRun = 0, suitesSkipped = 0;
let firstFailure = null;

for (const f of files) {
  const full = path.join(legacyDir, f);
  const res = spawnSync(process.execPath, [full], { cwd: ROOT, encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  process.stdout.write('\n=== ' + f + ' ===\n');
  process.stdout.write(out);

  const lines = out.split('\n').filter(l => /\d+\s+passed,\s*\d+\s+failed/.test(l));
  const summary = lines.length ? lines[lines.length - 1] : null;

  if (summary) {
    const m = summary.match(/(\d+)\s+passed,\s*(\d+)\s+failed/);
    const p = m ? Number(m[1]) : 0;
    const fl = m ? Number(m[2]) : 0;
    totalPass += p; totalFail += fl; suitesRun++;
    if (fl > 0 && !firstFailure) firstFailure = f;
  } else {
    if (res.status === 0) {
      suitesSkipped++;
      process.stdout.write('[skipped: no summary line — asset/condition not met]\n');
    } else {
      suitesSkipped++;
      totalFail++;
      if (!firstFailure) firstFailure = f;
      process.stdout.write('[FAIL: suite crashed (exit ' + res.status + ') — check output above]\n');
    }
  }
}

process.stdout.write('\n==================================================\n');
process.stdout.write('Suites run: ' + suitesRun + ', skipped: ' + suitesSkipped + '\n');
process.stdout.write('GUARDS TOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed\n');
process.stdout.write('==================================================\n');

process.exit(totalFail > 0 ? 1 : 0);
