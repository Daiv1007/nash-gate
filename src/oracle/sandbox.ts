/**
 * NashGate Deterministic Sandbox Runner
 * Secure, isolated code execution engine using Node's native vm module.
 * Grounded in Game Theory and Mechanism Design.
 */

import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import type { Challenge, ChallengeEvaluation, Proposal } from '../core/types.ts';
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  type OracleExecutionResult,
  type OracleVerdict,
  type SandboxOptions,
} from './types.ts';

/**
 * Normalizes values for human-readable error reporting.
 */
function formatValue(val: unknown): string {
  if (val === undefined) return 'undefined';
  if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
  if (typeof val === 'symbol') return val.toString();
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/**
 * Deterministic deep equality check between actual and expected outputs.
 * Handles cross-realm prototype differences via structured cloning, NaN values,
 * and standard deep structural assertions.
 *
 * @param actual - Value returned by the generator solution.
 * @param expected - Expected value declared by the auditor challenge.
 * @returns true if actual deeply equals expected, false otherwise.
 */
export function deepEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) {
    return true;
  }

  // Handle NaN comparison (in standard JS NaN !== NaN)
  if (
    typeof actual === 'number' &&
    typeof expected === 'number' &&
    Number.isNaN(actual) &&
    Number.isNaN(expected)
  ) {
    return true;
  }

  try {
    // structuredClone normalizes cross-realm prototypes between VM context and host context
    const clonedActual = actual !== undefined ? structuredClone(actual) : undefined;
    const clonedExpected = expected !== undefined ? structuredClone(expected) : undefined;
    assert.deepStrictEqual(clonedActual, clonedExpected);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cleans and transforms JavaScript/TypeScript source code for execution in a classic VM script.
 * - Strips Markdown code blocks (e.g. ```typescript ... ```).
 * - Strips TypeScript type annotations and interfaces using native Node utilities.
 * - Rewrites ES module export statements to CommonJS / global assignments.
 * - Rewrites top-level const and let declarations to var for context introspection.
 *
 * @param rawCode - Input code string submitted by a generator.
 * @returns Transformed, VM-runnable JavaScript source code.
 */
export function preprocessCode(rawCode: string): string {
  if (typeof rawCode !== 'string') {
    throw new TypeError('Code must be a string');
  }

  let code = rawCode.trim();

  // 1. Strip Markdown code fences if present
  const fenceMatch = code.match(/^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    code = fenceMatch[1].trim();
  }

  // 2. Strip TypeScript types natively
  if (typeof stripTypeScriptTypes === 'function') {
    code = stripTypeScriptTypes(code);
  }

  // 3. Normalize export statements for classic VM script execution
  code = code
    .replace(/^export\s+default\s+function\s+/gm, 'function ')
    .replace(/^export\s+default\s+/gm, 'module.exports = ')
    .replace(/^export\s+(async\s+function|function)\s+/gm, '$1 ')
    .replace(/^export\s+(const|let|var)\s+/gm, 'var ')
    .replace(/^(const|let)\s+/gm, 'var ');

  // 4. Wrap anonymous function statements: function (x) { ... } -> (function (x) { ... })
  if (/^\s*function\s*\(/.test(code)) {
    code = `(${code})`;
  }

  return code;
}

/**
 * Creates an isolated and hardened VM execution context with minimal safe standard library globals.
 * Strictly excludes ambient process, filesystem, networking, and dynamic code generation capabilities.
 */
function createSandboxContext(): vm.Context {
  const moduleObj = { exports: {} as Record<string, unknown> };

  const sandbox: Record<string, unknown> = {
    // Pure math and primitives
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Date,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    BigInt,
    JSON,
    // Standard error types
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError,
    // Pure utility functions
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    // CommonJS environment shims
    module: moduleObj,
    exports: moduleObj.exports,
    // Isolated console mock
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  };

  // Enforce { codeGeneration: { strings: false, wasm: false } } to prevent prototype escape via eval/Function
  return vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
}

/**
 * Resolves the target callable function from evaluated context or expression result.
 */
function findCallableFunction(
  context: vm.Context,
  evalResult: unknown,
  entrypoint?: string
): { fn?: Function; error?: string } {
  // 1. Explicit entrypoint requested
  if (entrypoint) {
    const named = (context as any)[entrypoint];
    if (typeof named === 'function') {
      return { fn: named };
    }
    return { error: `Entrypoint function '${entrypoint}' not found in proposal solution` };
  }

  // 2. Evaluated expression directly produced a callable function (e.g., arrow function expression)
  if (typeof evalResult === 'function') {
    return { fn: evalResult };
  }

  // 3. CommonJS module.exports assignment
  const modExports = (context as any).module?.exports;
  if (typeof modExports === 'function') {
    return { fn: modExports };
  }
  if (modExports && typeof modExports.default === 'function') {
    return { fn: modExports.default };
  }

  // 4. Conventional function names for algorithm solutions
  const conventionalNames = ['solution', 'solve', 'solutionFn', 'main', 'handler', 'default'];
  for (const name of conventionalNames) {
    if (typeof (context as any)[name] === 'function') {
      return { fn: (context as any)[name] };
    }
  }

  // 5. Scan context for user-defined functions
  const initialKeys = new Set([
    'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'RegExp',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'JSON',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
    'encodeURIComponent', 'decodeURIComponent', 'module', 'exports', 'console',
  ]);

  const userFunctions: Function[] = [];
  for (const key of Object.keys(context)) {
    if (!initialKeys.has(key) && typeof (context as any)[key] === 'function') {
      userFunctions.push((context as any)[key]);
    }
  }

  if (userFunctions.length > 0) {
    // Select the last declared function in script order
    return { fn: userFunctions[userFunctions.length - 1] };
  }

  return { error: 'No callable function found in proposal solution' };
}

/**
 * Formats a failure verdict result.
 */
function createFailureResult(
  error: string,
  expectedOutput: unknown,
  executionTimeMs: number,
  timedOut: boolean = false,
  actualOutput?: unknown
): OracleExecutionResult {
  return {
    verdict: 'FAILED',
    generatorPassed: false,
    passed: false,
    timedOut,
    actualOutput,
    expectedOutput,
    error,
    executionTimeMs,
  };
}

/**
 * Formats a pass verdict result.
 */
function createPassResult(
  actualOutput: unknown,
  expectedOutput: unknown,
  executionTimeMs: number
): OracleExecutionResult {
  return {
    verdict: 'PASSED',
    generatorPassed: true,
    passed: true,
    timedOut: false,
    actualOutput,
    expectedOutput,
    executionTimeMs,
  };
}

/**
 * Synchronously executes code inside the sandbox.
 * Enforces a strict timeout (default 2000ms) for synchronous execution.
 *
 * @param code - Generator's function string (JavaScript or TypeScript).
 * @param testInput - Auditor's challenge input.
 * @param expectedOutput - Auditor's expected challenge output.
 * @param options - Execution configuration including timeoutMs.
 * @returns Structured consensus execution verdict.
 */
export function executeInSandboxSync(
  code: string,
  testInput: unknown,
  expectedOutput: unknown,
  options?: SandboxOptions
): OracleExecutionResult {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  const startTime = performance.now();

  if (!code || typeof code !== 'string' || !code.trim()) {
    return createFailureResult(
      'Empty or invalid solution code provided',
      expectedOutput,
      0,
      false
    );
  }

  // Step 1: Preprocess code (strip Markdown fences, strip TS types, normalize exports)
  let processedCode: string;
  try {
    processedCode = preprocessCode(code);
  } catch (err: any) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    return createFailureResult(
      `SyntaxError: ${err?.message || String(err)}`,
      expectedOutput,
      elapsed,
      false
    );
  }

  // Step 2: Create hardened context
  const context = createSandboxContext();

  // Step 3: Evaluate script in context under strict timeout
  let evalResult: unknown;
  try {
    evalResult = vm.runInContext(processedCode, context, {
      timeout: timeoutMs,
      displayErrors: true,
    });
  } catch (err: any) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    const isTimeout =
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      /timed out/i.test(err?.message || '');
    return createFailureResult(
      isTimeout
        ? `Script execution timed out after ${timeoutMs}ms`
        : `${err?.name || 'Error'}: ${err?.message || String(err)}`,
      expectedOutput,
      elapsed,
      isTimeout
    );
  }

  // Step 4: Locate callable function
  const { fn: targetFn, error: lookupError } = findCallableFunction(
    context,
    evalResult,
    options?.entrypoint
  );

  if (!targetFn || lookupError) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    return createFailureResult(
      lookupError || 'No callable function found in proposal solution',
      expectedOutput,
      elapsed,
      false
    );
  }

  // Step 5: Invoke the function strictly within vm.runInContext under timeout
  (context as any).__targetFn__ = targetFn;
  try {
    (context as any).__input__ =
      testInput !== undefined ? structuredClone(testInput) : undefined;
  } catch {
    (context as any).__input__ = testInput;
  }

  const shouldSpread =
    options?.spreadArrayInput !== undefined
      ? options.spreadArrayInput
      : Array.isArray(testInput) && targetFn.length > 1;

  (context as any).__shouldSpread__ = shouldSpread;

  let rawOutput: unknown;
  try {
    rawOutput = vm.runInContext(
      `__targetFn__(...(__input__ === undefined ? [] : (__shouldSpread__ ? __input__ : [__input__])))`,
      context,
      { timeout: timeoutMs, displayErrors: true }
    );
  } catch (err: any) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    const isTimeout =
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      /timed out/i.test(err?.message || '');
    return createFailureResult(
      isTimeout
        ? `Script execution timed out after ${timeoutMs}ms`
        : `${err?.name || 'Error'}: ${err?.message || String(err)}`,
      expectedOutput,
      elapsed,
      isTimeout
    );
  }

  // Step 6: Verify not a pending promise in sync mode
  if (
    rawOutput !== null &&
    typeof rawOutput === 'object' &&
    typeof (rawOutput as any).then === 'function'
  ) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    return createFailureResult(
      'Async functions or Promises are not supported in synchronous execution; use executeInSandbox instead',
      expectedOutput,
      elapsed,
      false
    );
  }

  // Step 7: Clone and evaluate output
  let actualOutput: unknown;
  try {
    actualOutput = rawOutput !== undefined ? structuredClone(rawOutput) : undefined;
  } catch {
    actualOutput = rawOutput;
  }

  const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
  const passed = deepEqual(actualOutput, expectedOutput);

  if (passed) {
    return createPassResult(actualOutput, expectedOutput, elapsed);
  } else {
    return createFailureResult(
      `Output mismatch: expected ${formatValue(expectedOutput)}, received ${formatValue(actualOutput)}`,
      expectedOutput,
      elapsed,
      false,
      actualOutput
    );
  }
}

/**
 * Asynchronously executes code inside the sandbox.
 * Enforces a strict timeout (default 2000ms) for both synchronous execution and asynchronous Promise resolution.
 *
 * @param code - Generator's function string (JavaScript or TypeScript).
 * @param testInput - Auditor's challenge input.
 * @param expectedOutput - Auditor's expected challenge output.
 * @param options - Execution configuration including timeoutMs.
 * @returns Structured consensus execution verdict.
 */
export async function executeInSandbox(
  code: string,
  testInput: unknown,
  expectedOutput: unknown,
  options?: SandboxOptions
): Promise<OracleExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  const startTime = performance.now();

  if (!code || typeof code !== 'string' || !code.trim()) {
    return createFailureResult(
      'Empty or invalid solution code provided',
      expectedOutput,
      0,
      false
    );
  }

  // Step 1: Preprocess code
  let processedCode: string;
  try {
    processedCode = preprocessCode(code);
  } catch (err: any) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    return createFailureResult(
      `SyntaxError: ${err?.message || String(err)}`,
      expectedOutput,
      elapsed,
      false
    );
  }

  // Step 2: Create sandbox context
  const context = createSandboxContext();

  // Step 3: Evaluate code in context under strict timeout
  let evalResult: unknown;
  try {
    evalResult = vm.runInContext(processedCode, context, {
      timeout: timeoutMs,
      displayErrors: true,
    });
  } catch (err: any) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    const isTimeout =
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      /timed out/i.test(err?.message || '');
    return createFailureResult(
      isTimeout
        ? `Script execution timed out after ${timeoutMs}ms`
        : `${err?.name || 'Error'}: ${err?.message || String(err)}`,
      expectedOutput,
      elapsed,
      isTimeout
    );
  }

  // Step 4: Locate callable function
  const { fn: targetFn, error: lookupError } = findCallableFunction(
    context,
    evalResult,
    options?.entrypoint
  );

  if (!targetFn || lookupError) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    return createFailureResult(
      lookupError || 'No callable function found in proposal solution',
      expectedOutput,
      elapsed,
      false
    );
  }

  // Step 5: Invoke function inside vm.runInContext
  (context as any).__targetFn__ = targetFn;
  try {
    (context as any).__input__ =
      testInput !== undefined ? structuredClone(testInput) : undefined;
  } catch {
    (context as any).__input__ = testInput;
  }

  const shouldSpread =
    options?.spreadArrayInput !== undefined
      ? options.spreadArrayInput
      : Array.isArray(testInput) && targetFn.length > 1;

  (context as any).__shouldSpread__ = shouldSpread;

  let rawOutput: unknown;
  try {
    rawOutput = vm.runInContext(
      `__targetFn__(...(__input__ === undefined ? [] : (__shouldSpread__ ? __input__ : [__input__])))`,
      context,
      { timeout: timeoutMs, displayErrors: true }
    );
  } catch (err: any) {
    const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
    const isTimeout =
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      /timed out/i.test(err?.message || '');
    return createFailureResult(
      isTimeout
        ? `Script execution timed out after ${timeoutMs}ms`
        : `${err?.name || 'Error'}: ${err?.message || String(err)}`,
      expectedOutput,
      elapsed,
      isTimeout
    );
  }

  // Step 6: Handle Promise resolution with remaining timeout race
  if (
    rawOutput !== null &&
    typeof rawOutput === 'object' &&
    typeof (rawOutput as any).then === 'function'
  ) {
    const elapsed = performance.now() - startTime;
    const remainingTimeout = Math.max(0, timeoutMs - elapsed);

    let timer: NodeJS.Timeout | undefined;
    try {
      rawOutput = await Promise.race([
        rawOutput,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const timeoutErr = new Error(`Script execution timed out after ${timeoutMs}ms`);
            (timeoutErr as any).code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
            reject(timeoutErr);
          }, remainingTimeout);
        }),
      ]);
    } catch (err: any) {
      const totalElapsed = Math.round((performance.now() - startTime) * 100) / 100;
      const isTimeout =
        err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
        /timed out/i.test(err?.message || '');
      return createFailureResult(
        isTimeout
          ? `Script execution timed out after ${timeoutMs}ms`
          : `${err?.name || 'Error'}: ${err?.message || String(err)}`,
        expectedOutput,
        totalElapsed,
        isTimeout
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Step 7: Clone and evaluate output
  let actualOutput: unknown;
  try {
    actualOutput = rawOutput !== undefined ? structuredClone(rawOutput) : undefined;
  } catch {
    actualOutput = rawOutput;
  }

  const elapsed = Math.round((performance.now() - startTime) * 100) / 100;
  const passed = deepEqual(actualOutput, expectedOutput);

  if (passed) {
    return createPassResult(actualOutput, expectedOutput, elapsed);
  } else {
    return createFailureResult(
      `Output mismatch: expected ${formatValue(expectedOutput)}, received ${formatValue(actualOutput)}`,
      expectedOutput,
      elapsed,
      false,
      actualOutput
    );
  }
}

/**
 * High-level Consensus Evaluator: Executes an Auditor's Challenge against a Generator's Proposal.
 * Returns a complete ChallengeEvaluation object ready for settlement by the core payoff engine.
 *
 * @param proposal - The Generator's proposal containing the solution code string.
 * @param challenge - The Auditor's challenge containing testInput and expectedOutput.
 * @param options - Sandbox options including timeout override.
 * @returns ChallengeEvaluation merged with detailed OracleExecutionResult.
 */
export async function evaluateChallenge(
  proposal: Proposal,
  challenge: Challenge,
  options?: SandboxOptions
): Promise<ChallengeEvaluation & OracleExecutionResult> {
  const result = await executeInSandbox(
    proposal.solution,
    challenge.testInput,
    challenge.expectedOutput,
    options
  );

  return {
    ...result,
    challenge,
    generatorPassed: result.generatorPassed,
    details: {
      actualOutput: result.actualOutput,
      error: result.error,
      executionTimeMs: result.executionTimeMs,
    },
  };
}

/**
 * Synchronous variant of evaluateChallenge.
 */
export function evaluateChallengeSync(
  proposal: Proposal,
  challenge: Challenge,
  options?: SandboxOptions
): ChallengeEvaluation & OracleExecutionResult {
  const result = executeInSandboxSync(
    proposal.solution,
    challenge.testInput,
    challenge.expectedOutput,
    options
  );

  return {
    ...result,
    challenge,
    generatorPassed: result.generatorPassed,
    details: {
      actualOutput: result.actualOutput,
      error: result.error,
      executionTimeMs: result.executionTimeMs,
    },
  };
}
