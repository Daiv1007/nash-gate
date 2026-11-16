/**
 * NashGate Core Module
 * Pure game-theoretic logic, validation, bankruptcy handling, and settlement.
 */

export type {
  AgentRole,
  AgentStatus,
  Agent,
  Proposal,
  Challenge,
  ChallengeEvaluation,
  PairSettlementResult,
  UnchallengedSettlementResult,
  AgentBalanceUpdate,
  RoundSettlementResult,
  CreateAgentParams,
} from './types.ts';

export {
  DEFAULT_INITIAL_CAPITAL,
  MIN_STAKE,
  UNCHALLENGED_REWARD_MULTIPLIER,
  GENERATOR_PASS_REWARD_MULTIPLIER,
  AUDITOR_FAIL_PENALTY_MULTIPLIER,
} from './types.ts';

export * from './bankruptcy.ts';
export * from './validation.ts';
export * from './settlement.ts';
export * from './staking.ts';
