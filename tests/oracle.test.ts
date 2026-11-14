/**
 * Unit Tests: Deterministic Oracle Sandbox Runner
 * Verifies code execution safety, timeout enforcement, edge-case failure detection,
 * syntax error handling, and structured consensus verdicts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeInSandbox,
  executeInSandboxSync,
  evaluateChallenge,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  deepEqual,
} from '../src/oracle/index.ts';
import { settlePair } from '../src/core/index.ts';
import type { Agent, Challenge, Proposal } from '../src/core/index.ts';

// ---------------------------------------------------------------------------
// 1. Valid Code Passing
// ---------------------------------------------------------------------------

test('Valid code: Pure function declaration executes and matches expected output', async () => {
  const code = `
    function add(a, b) {
      return a + b;
    }
  `;
  const result = await executeInSandbox(code, [5, 7], 12);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.actualOutput, 12);
  assert.strictEqual(result.expectedOutput, 12);
  assert.strictEqual(result.error, undefined);
  assert.ok(result.executionTimeMs >= 0);
});

test('Valid code: Arrow function expression passes correctly', async () => {
  const code = `(x, y) => x * y`;
  const result = await executeInSandbox(code, [6, 7], 42);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 42);
});

test('Valid code: Constant assignment with single object parameter', async () => {
  const code = `
    const formatUser = (user) => {
      return { id: user.id, fullName: user.firstName + ' ' + user.lastName };
    };
  `;
  const input = { id: 101, firstName: 'Ada', lastName: 'Lovelace' };
  const expected = { id: 101, fullName: 'Ada Lovelace' };

  const result = await executeInSandbox(code, input, expected);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.deepStrictEqual(result.actualOutput, expected);
});

test('Valid code: Deep structural equality for nested objects and arrays', async () => {
  const code = `
    function transform(items) {
      return items.map((x, idx) => ({ index: idx, value: x * 2 }));
    }
  `;
  const input = [10, 20, 30];
  const expected = [
    { index: 0, value: 20 },
    { index: 1, value: 40 },
    { index: 2, value: 60 },
  ];

  const result = await executeInSandbox(code, input, expected);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.deepStrictEqual(result.actualOutput, expected);
});

test('Valid code: TypeScript function with static types and return type', async () => {
  const code = `
    function calculateHypotenuse(a: number, b: number): number {
      return Math.sqrt(a * a + b * b);
    }
  `;
  const result = await executeInSandbox(code, [3, 4], 5);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 5);
});

test('Valid code: TypeScript interface and type annotations stripped cleanly', async () => {
  const code = `
    interface Point {
      x: number;
      y: number;
    }

    type DistanceCalculator = (p1: Point, p2: Point) => number;

    function manhattanDistance(p1: Point, p2: Point): number {
      return Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
    }
  `;
  const input = [{ x: 1, y: 2 }, { x: 4, y: 6 }];
  const expected = 7;

  const result = await executeInSandbox(code, input, expected);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 7);
});

test('Valid code: Export default function syntax supported', async () => {
  const code = `
    export default function isPalindrome(str: string): boolean {
      const clean = str.toLowerCase().replace(/[^a-z0-9]/g, '');
      return clean === clean.split('').reverse().join('');
    }
  `;
  const result = await executeInSandbox(code, 'A man, a plan, a canal: Panama', true);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, true);
});

test('Valid code: CommonJS module.exports syntax supported', async () => {
  const code = `
    module.exports = function countVowels(s) {
      const matches = s.match(/[aeiou]/gi);
      return matches ? matches.length : 0;
    };
  `;
  const result = await executeInSandbox(code, 'deterministic oracle', 8);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 8);
});

test('Valid code: Markdown code fences stripped cleanly', async () => {
  const code = [
    '```typescript',
    'function square(n: number): number {',
    '  return n * n;',
    '}',
    '```',
  ].join('\n');

  const result = await executeInSandbox(code, 9, 81);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 81);
});

test('Valid code: Markdown code fence embedded in conversational text stripped cleanly', async () => {
  const code = [
    'Here is the solution to your problem:',
    '```javascript',
    'function doubleNumber(n) {',
    '  return n * 2;',
    '}',
    '```',
    'Let me know if you need any adjustments!',
  ].join('\n');

  const result = await executeInSandbox(code, 21, 42);
  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.actualOutput, 42);
});

test('Valid code: module.exports object dictionary with named export function', async () => {
  const code = `
    function isEven(n) { return n % 2 === 0; }
    module.exports = { isEven };
  `;
  const result = await executeInSandbox(code, 4, true, { entrypoint: 'isEven' });
  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.actualOutput, true);
});

test('Valid code: Async function resolving promise handled properly', async () => {
  const code = `
    async function asyncAdd(a, b) {
      return a + b;
    }
  `;
  const result = await executeInSandbox(code, [15, 25], 40);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 40);
});

test('Valid code: Synchronous runner executeInSandboxSync executes and passes', () => {
  const code = `function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }`;
  const result = executeInSandboxSync(code, [48, 18], 6);

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);
  assert.strictEqual(result.actualOutput, 6);
});

test('Valid code: Special edge values like NaN, null, and empty array', async () => {
  const code = `function toNaN() { return NaN; }`;
  const result = await executeInSandbox(code, null, NaN);
  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.generatorPassed, true);

  const codeNull = `function returnNull() { return null; }`;
  const resultNull = await executeInSandbox(codeNull, undefined, null);
  assert.strictEqual(resultNull.verdict, 'PASSED');
  assert.strictEqual(resultNull.generatorPassed, true);
});

// ---------------------------------------------------------------------------
// 2. Buggy Code Failing on Edge Cases
// ---------------------------------------------------------------------------

test('Buggy code: Incorrect output value results in FAILED verdict', async () => {
  const code = `
    function add(a, b) {
      return a - b; // Bug: subtraction instead of addition
    }
  `;
  const result = await executeInSandbox(code, [10, 5], 15);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.actualOutput, 5);
  assert.strictEqual(result.expectedOutput, 15);
  assert.match(result.error!, /Output mismatch: expected 15, received 5/);
});

test('Buggy code: Algorithm fails on negative integer edge case', async () => {
  // Buggy isOdd function that fails on negative numbers because (-3) % 2 === -1
  const code = `
    function isOdd(n) {
      return n % 2 === 1;
    }
  `;
  const result = await executeInSandbox(code, -3, true);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.actualOutput, false);
  assert.strictEqual(result.expectedOutput, true);
  assert.match(result.error!, /Output mismatch/);
});

test('Buggy code: Unhandled exception / division by zero throws runtime Error', async () => {
  const code = `
    function safeDivide(a, b) {
      if (b === 0) {
        throw new Error('ZeroDivisionError: denominator cannot be zero');
      }
      return a / b;
    }
  `;
  const result = await executeInSandbox(code, [10, 0], Infinity);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, false);
  assert.match(result.error!, /ZeroDivisionError: denominator cannot be zero/);
});

test('Buggy code: TypeError from reading properties of undefined', async () => {
  const code = `
    function getNestedValue(data) {
      return data.user.profile.age;
    }
  `;
  const result = await executeInSandbox(code, {}, 25);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /TypeError/);
});

test('Buggy code: Deep object structural mismatch', async () => {
  const code = `
    function getStatus() {
      return { status: 'PENDING', code: 200 };
    }
  `;
  const expected = { status: 'SUCCESS', code: 200 };
  const result = await executeInSandbox(code, null, expected);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /Output mismatch/);
});

test('Buggy code: Infinite recursion triggers stack overflow cleanly', async () => {
  const code = `
    function overflow(n) {
      return overflow(n + 1);
    }
  `;
  const result = await executeInSandbox(code, 1, 100);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, false);
  assert.match(result.error!, /Maximum call stack size exceeded/);
});

// ---------------------------------------------------------------------------
// 3. Syntax Errors
// ---------------------------------------------------------------------------

test('Syntax error: Malformed function signature', async () => {
  const code = `function broken(a, b { return a + b; }`;
  const result = await executeInSandbox(code, [1, 2], 3);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, false);
  assert.match(result.error!, /SyntaxError/);
});

test('Syntax error: Unexpected token / invalid variable identifier', async () => {
  const code = `const 123badVariable = 456;`;
  const result = await executeInSandbox(code, null, 456);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /SyntaxError/);
});

test('Syntax error: Unclosed string literal in proposal code', async () => {
  const code = `function greet() { return "hello world; }`;
  const result = await executeInSandbox(code, null, 'hello world');

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /SyntaxError/);
});

test('Syntax error: Empty or whitespace-only code string fails cleanly', async () => {
  const result = await executeInSandbox('   ', null, 0);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /Empty or invalid solution code provided/);
});

test('Syntax error: Code that defines no function fails cleanly', async () => {
  const code = `const x = 42; const y = 10;`;
  const result = await executeInSandbox(code, null, 42);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /No callable function found/);
});

// ---------------------------------------------------------------------------
// 4. Infinite Loops Timing Out Cleanly
// ---------------------------------------------------------------------------

test('Infinite loop: while(true) inside function body times out cleanly (custom 100ms)', async () => {
  const code = `
    function infiniteLoop(x) {
      while (true) {}
      return x;
    }
  `;
  const startTime = Date.now();
  const result = await executeInSandbox(code, 42, 42, { timeoutMs: 100 });
  const duration = Date.now() - startTime;

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, true);
  assert.match(result.error!, /timed out after 100ms/);
  assert.ok(duration >= 90 && duration < 1000, `Duration ${duration}ms was within bounds`);
});

test('Infinite loop: Top-level while(true) in script times out cleanly', async () => {
  const code = `
    while (true) {}
    function solve(x) { return x; }
  `;
  const result = await executeInSandbox(code, 1, 1, { timeoutMs: 100 });

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, true);
  assert.match(result.error!, /timed out/);
});

test('Infinite loop: for(;;) spin-lock times out cleanly in synchronous runner', () => {
  const code = `
    function spinLock() {
      for (;;) {}
    }
  `;
  const result = executeInSandboxSync(code, null, 1, { timeoutMs: 100 });

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, true);
  assert.match(result.error!, /timed out/);
});

test('Infinite loop: Asynchronous unresolving Promise times out cleanly', async () => {
  const code = `
    async function neverResolves() {
      return new Promise(() => {}); // Intentionally unresolving
    }
  `;
  const result = await executeInSandbox(code, null, 10, { timeoutMs: 150 });

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, true);
  assert.match(result.error!, /timed out after 150ms/);
});

test('Infinite loop: Default strict 2000ms timeout halts infinite while loop', async () => {
  const code = `
    function stubbornLoop() {
      while (true) {}
    }
  `;
  assert.strictEqual(DEFAULT_SANDBOX_TIMEOUT_MS, 2000);

  const startTime = Date.now();
  // Exercises default 2000ms timeout
  const result = await executeInSandbox(code, null, 'never');
  const elapsed = Date.now() - startTime;

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.strictEqual(result.timedOut, true);
  assert.match(result.error!, /timed out after 2000ms/);
  assert.ok(elapsed >= 1900, `Execution elapsed ${elapsed}ms should be >= 1900ms`);
});

// ---------------------------------------------------------------------------
// 5. Security & Isolation Verification
// ---------------------------------------------------------------------------

test('Security: Process object is undefined in sandbox context', async () => {
  const code = `
    function checkProcess() {
      return typeof process;
    }
  `;
  const result = await executeInSandbox(code, null, 'undefined');

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.actualOutput, 'undefined');
});

test('Security: Host process termination attempt fails safely', async () => {
  const code = `
    function attemptExit() {
      process.exit(1);
    }
  `;
  const result = await executeInSandbox(code, null, null);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /ReferenceError: process is not defined/);
});

test('Security: Require and import statements are blocked', async () => {
  const code = `
    function accessFS() {
      const fs = require('fs');
      return fs.readdirSync('.');
    }
  `;
  const result = await executeInSandbox(code, null, null);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /ReferenceError: require is not defined/);
});

test('Security: Prototype constructor string execution escape is blocked', async () => {
  const code = `
    function escapeAttempt() {
      const fn = ({}).constructor.constructor;
      return fn("return process")();
    }
  `;
  const result = await executeInSandbox(code, null, null);

  assert.strictEqual(result.verdict, 'FAILED');
  assert.strictEqual(result.generatorPassed, false);
  assert.match(result.error!, /Code generation from strings disallowed/);
});

test('Security: Caller input object is cloned and protected from in-place mutation', async () => {
  const code = `
    function maliciousMutator(obj) {
      obj.secretValue = 'corrupted';
      return obj.secretValue;
    }
  `;
  const originalInput = { secretValue: 'safe' };
  const result = await executeInSandbox(code, originalInput, 'corrupted');

  assert.strictEqual(result.verdict, 'PASSED');
  assert.strictEqual(result.actualOutput, 'corrupted');
  // Caller original input remains pristine
  assert.strictEqual(originalInput.secretValue, 'safe');
});

// ---------------------------------------------------------------------------
// 6. High-Level Core Integration (evaluateChallenge & settlePair)
// ---------------------------------------------------------------------------

test('Integration: evaluateChallenge correctly feeds settlePair when Generator PASSES', async () => {
  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const auditor: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'llama3',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-1',
    solution: `function solution(n) { return n * 2; }`,
    stake: 20,
    reasoning: 'Multiplies input by two',
  };

  // Auditor challenge: false positive (generator passes)
  const challenge: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'gen-1',
    testInput: 10,
    expectedOutput: 20,
    stake: 10,
  };

  const evaluation = await evaluateChallenge(proposal, challenge);

  assert.strictEqual(evaluation.verdict, 'PASSED');
  assert.strictEqual(evaluation.generatorPassed, true);
  assert.strictEqual(evaluation.actualOutput, 20);

  // Settle with game-theoretic payoff matrix
  const settlement = settlePair(generator, proposal, auditor, evaluation);

  // Generator passes: +0.5 * G.stake (+10), Auditor penalized -1.5 * A.stake (-15)
  assert.strictEqual(settlement.generatorPassed, true);
  assert.strictEqual(settlement.generatorDelta, 10);
  assert.strictEqual(settlement.auditorDelta, -15);
});

test('Integration: evaluateChallenge correctly feeds settlePair when Generator FAILS', async () => {
  const generator: Agent = {
    id: 'gen-2',
    role: 'GENERATOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const auditor: Agent = {
    id: 'aud-2',
    role: 'AUDITOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  // Proposal has a bug: fails to handle negative numbers
  const proposal: Proposal = {
    agentId: 'gen-2',
    solution: `function solution(n) { if (n < 0) throw new Error('Negative input'); return n * 2; }`,
    stake: 30,
    reasoning: 'Multiplies input by 2',
  };

  // Auditor challenge breaks the solution
  const challenge: Challenge = {
    auditorId: 'aud-2',
    targetAgentId: 'gen-2',
    testInput: -5,
    expectedOutput: -10,
    stake: 15,
  };

  const evaluation = await evaluateChallenge(proposal, challenge);

  assert.strictEqual(evaluation.verdict, 'FAILED');
  assert.strictEqual(evaluation.generatorPassed, false);
  assert.match(evaluation.error!, /Negative input/);

  // Settle with game-theoretic payoff matrix
  const settlement = settlePair(generator, proposal, auditor, evaluation);

  // Generator fails: forfeits stake (-30), Auditor earns generator stake as bounty (+30)
  assert.strictEqual(settlement.generatorPassed, false);
  assert.strictEqual(settlement.generatorDelta, -30);
  assert.strictEqual(settlement.auditorDelta, 30);
});
