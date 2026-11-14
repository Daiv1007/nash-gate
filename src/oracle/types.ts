/**
 * NashGate Oracle Types and Constants
 * Sandboxed execution runner data structures for deterministic verification.
 */

import type { Challenge, Proposal, ChallengeEvaluation } from '../core/types.ts';

/**
 * Structured verdict indicating the outcome of a sandboxed challenge execution.
 * - PASSED: The proposed solution executed successfully and matched the expected output (false positive challenge).
 * - FAILED: The proposed solution threw a syntax error, runtime exception, timed out, or output mismatched.
 */
export type OracleVerdict = 'PASSED' | 'FAILED';

/**
 * Detailed result of executing a proposal against an auditor challenge in the sandbox.
 */
export interface OracleExecutionResult {
  /**
   * Structured consensus verdict ('PASSED' | 'FAILED').
   */
  readonly verdict: OracleVerdict;
  /**
   * Convenience boolean flag: true if proposal passed (verdict === 'PASSED'), false otherwise.
   */
  readonly generatorPassed: boolean;
  /**
   * Alias for generatorPassed for general-purpose runner consumption.
   */
  readonly passed: boolean;
  /**
   * True if execution was halted due to exceeding the timeout threshold.
   */
  readonly timedOut: boolean;
  /**
   * Actual return value produced by the generator's solution if execution completed without error.
   */
  readonly actualOutput?: unknown;
  /**
   * Expected output specified in the auditor's challenge.
   */
  readonly expectedOutput?: unknown;
  /**
   * Human-readable error message in case of syntax error, runtime exception, timeout, or output mismatch.
   */
  readonly error?: string;
  /**
   * Measured execution duration in milliseconds.
   */
  readonly executionTimeMs: number;
}

/**
 * Configuration options for the deterministic sandbox runner.
 */
export interface SandboxOptions {
  /**
   * Maximum allowed execution time in milliseconds before halting execution.
   * Defaults to DEFAULT_SANDBOX_TIMEOUT_MS (2000ms).
   */
  readonly timeoutMs?: number;
  /**
   * Explicit name of the function to invoke within the proposal code.
   * If omitted, the runner automatically discovers the exported, declared, or returned function.
   */
  readonly entrypoint?: string;
  /**
   * Explicit override controlling whether an array testInput should be spread across function parameters.
   * If omitted, defaults to spreading only when testInput is an Array and target function arity > 1.
   */
  readonly spreadArrayInput?: boolean;
}

/**
 * Strict default execution timeout in milliseconds as mandated by the NashGate specification.
 * Game-theoretic rationale: Precludes denial-of-service through infinite loops or non-terminating algorithms,
 * ensuring bounded settlement latency per round.
 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 2000;
