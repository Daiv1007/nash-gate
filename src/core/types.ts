/**
 * NashGate Core Data Structures and Constants
 * Grounded in Game Theory and Mechanism Design.
 */

/**
 * Agent roles within the NashGate consensus mechanism.
 * - GENERATOR: Proposes solutions to tasks and stakes reputation capital on their correctness.
 * - AUDITOR: Analyzes proposed solutions, generates adversarial edge cases, and stakes capital on breaking them.
 */
export type AgentRole = 'GENERATOR' | 'AUDITOR';

/**
 * Operational status of an agent.
 * - ACTIVE: Solvent agent eligible to participate in proposal generation, challenging, and settlement.
 * - BANKRUPT: Insolvent agent (capital <= 0) permanently barred from further rounds in the session.
 */
export type AgentStatus = 'ACTIVE' | 'BANKRUPT';

/**
 * Core Agent entity representing reputation capital and participation role.
 */
export interface Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly model: string;
  readonly capital: number;
  readonly status: AgentStatus;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * Proposal submitted by a GENERATOR agent.
 * Represents a solution staked with reputation capital.
 */
export interface Proposal {
  readonly agentId: string;
  readonly solution: string;
  readonly stake: number;
  readonly reasoning: string;
}

/**
 * Challenge submitted by an AUDITOR agent against a target GENERATOR's proposal.
 * Represents an adversarial test input designed to prove a hallucination or logic failure.
 */
export interface Challenge {
  readonly auditorId: string;
  readonly targetAgentId: string;
  readonly testInput: unknown;
  readonly expectedOutput: unknown;
  readonly stake: number;
}

/**
 * Outcome of executing a challenge against a generator's proposal via the deterministic Oracle.
 */
export interface ChallengeEvaluation {
  readonly challenge: Challenge;
  /**
   * true if the generator PASSES the challenge (auditor's challenge was a false positive).
   * false if the generator FAILS the challenge (auditor's edge case broke the solution).
   */
  readonly generatorPassed: boolean;
  readonly details?: {
    readonly actualOutput?: unknown;
    readonly error?: string;
    readonly executionTimeMs?: number;
  };
}

/**
 * Result of settling a single (Generator, Auditor) evaluated challenge pair.
 */
export interface PairSettlementResult {
  readonly generatorId: string;
  readonly auditorId: string;
  readonly generatorPassed: boolean;
  readonly generatorStake: number;
  readonly auditorStake: number;
  readonly generatorDelta: number;
  readonly auditorDelta: number;
  readonly rationale: string;
}

/**
 * Result of settling an unchallenged proposal.
 */
export interface UnchallengedSettlementResult {
  readonly agentId: string;
  readonly stake: number;
  readonly delta: number;
  readonly rationale: string;
}

/**
 * Record of an individual agent's balance and status update during round settlement.
 */
export interface AgentBalanceUpdate {
  readonly agentId: string;
  readonly initialCapital: number;
  readonly netDelta: number;
  readonly finalCapital: number;
  readonly previousStatus: AgentStatus;
  readonly currentStatus: AgentStatus;
  readonly isBankrupt: boolean;
}

/**
 * Complete immutable outcome of a settled round.
 */
export interface RoundSettlementResult {
  readonly updatedAgents: Agent[];
  readonly pairSettlements: PairSettlementResult[];
  readonly unchallengedSettlements: UnchallengedSettlementResult[];
  readonly balanceUpdates: AgentBalanceUpdate[];
  readonly bankruptAgentIds: string[];
}

/**
 * Parameters for instantiating a new agent.
 */
export interface CreateAgentParams {
  readonly id: string;
  readonly role: AgentRole;
  readonly model: string;
  readonly capital?: number;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * Default initial capital allocated to newly instantiated agents.
 */
export const DEFAULT_INITIAL_CAPITAL = 100;

/**
 * Minimum allowable stake in reputation capital units.
 * Game-theoretic rationale: Enforces non-zero skin-in-the-game, preventing costless spamming or sybil participation.
 */
export const MIN_STAKE = 1;

/**
 * Multiplier applied to generator stake when a proposal remains unchallenged in a round (+10% dividend).
 * Game-theoretic rationale: Provides a positive expected value (EV > 0) for honest, uncontested proposals,
 * compensating the generator for providing a valid solution without exhausting verification resources.
 */
export const UNCHALLENGED_REWARD_MULTIPLIER = 0.1;

/**
 * Multiplier applied to generator stake when surviving an auditor's challenge (+50% resilience reward).
 * Game-theoretic rationale: Compensates the generator for surviving adversarial scrutiny, reinforcing
 * high-confidence proposals and rewarding robust implementations.
 */
export const GENERATOR_PASS_REWARD_MULTIPLIER = 0.5;

/**
 * Multiplier applied to auditor stake as a penalty when their challenge fails / is a false positive (-150% penalty).
 * Game-theoretic rationale: Asymmetric penalty (> 1.0) imposes a high expected loss on frivolous, speculative,
 * or brute-force challenges, creating a deterrent against denial-of-service or probabilistic spam.
 */
export const AUDITOR_FAIL_PENALTY_MULTIPLIER = 1.5;
