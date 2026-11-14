/**
 * NashGate Oracle Module
 * Deterministic, sandboxed verification engine for multi-agent game-theoretic consensus.
 */

export type {
  OracleVerdict,
  OracleExecutionResult,
  SandboxOptions,
} from './types.ts';

export {
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from './types.ts';

export {
  deepEqual,
  preprocessCode,
  executeInSandbox,
  executeInSandboxSync,
  evaluateChallenge,
  evaluateChallengeSync,
} from './sandbox.ts';
