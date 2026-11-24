/* Exact reward-tier boundaries, using the same function the Worker uses. */

import { DEFAULT_TIERS, discountForScore } from '../shared/arcade.ts';

const cases = [
  [0, 0],
  [90, 0],
  [99, 0],
  [100, 2],
  [199, 2],
  [200, 5],
  [299, 5],
  [300, 7],
  [399, 7],
  [400, 10],
  [410, 10],
  [999, 10],
];

let failed = 0;
for (const [score, expected] of cases) {
  const actual = discountForScore(score, DEFAULT_TIERS);
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  score ${score} → ${actual}% (expected ${expected}%)`);
}

console.log(`\n${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
