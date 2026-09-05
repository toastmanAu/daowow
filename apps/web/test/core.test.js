const core = require('../core.js');
const V = require('../vectors.js');
const checks = core.selfTest(V);
let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
  if (!c.ok) failed++;
}
console.log(failed === 0 ? `\nALL ${checks.length} VECTOR CHECKS PASS` : `\n${failed} CHECKS FAILED`);
process.exit(failed ? 1 : 0);
