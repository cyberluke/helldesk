import { increment } from '../src/counter.mjs';

const cases = [
  [0, 1],
  [1, 2],
  [41, 42],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = increment(input);
  if (actual !== expected) {
    console.error(`FAIL increment(${input}) = ${actual}, expected ${expected}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}

console.log('PASS: increment(n) === n + 1');
