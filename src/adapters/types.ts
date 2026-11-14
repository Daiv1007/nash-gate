/**
 * NashGate Agent Adapter Interface and Data Structures
 * Bridges external models (LLMs, deterministic scripts, heuristics) with the consensus engine.
 * Grounded in Game Theory and Mechanism Design.
 */

import type { Agent, Challenge, Proposal } from '../core/types.ts';

/**
 * Specification and context of the coding problem presented to agents in a round.
 */
export interface ProblemContext {
  /**
   * Unique identifier for the problem (e.g. 'is-palindrome', 'clamp-number').
   */
  readonly id: string;
  /**
   * Human-readable title of the problem.
   */
  readonly title: string;
  /**
   * Clear specification of the function to implement, expected parameters, and behavior.
   */
  readonly task: string;
  /**
   * Optional extended description, edge cases to consider, or algorithmic constraints.
   */
  readonly description?: string;
  /**
   * Optional designated entrypoint function name expected by the Oracle sandbox.
   */
  readonly entrypoint?: string;
  /**
   * Current round number within the tournament.
   */
  readonly round?: number;
  /**
   * Additional domain-specific metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Parameters supplied to an adapter when requesting a code proposal from a GENERATOR agent.
 */
export interface GenerateProposalParams {
  /**
   * The GENERATOR agent staking capital on this proposal.
   */
  readonly agent: Agent;
  /**
   * The coding problem to solve.
   */
  readonly problem: ProblemContext;
  /**
   * Optional view of all currently active agents in the tournament.
   */
  readonly activeAgents?: readonly Agent[];
}

/**
 * Parameters supplied to an adapter when requesting an audit/challenge from an AUDITOR agent.
 */
export interface GenerateChallengeParams {
  /**
   * The AUDITOR agent evaluating the proposed solution.
   */
  readonly auditor: Agent;
  /**
   * The target GENERATOR agent who submitted the proposal.
   */
  readonly targetGenerator: Agent;
  /**
   * The proposal under audit, containing the solution code and generator's stake.
   */
  readonly proposal: Proposal;
  /**
   * The coding problem specification.
   */
  readonly problem: ProblemContext;
  /**
   * Optional view of all currently active agents in the tournament.
   */
  readonly activeAgents?: readonly Agent[];
}

/**
 * Raw structured output produced by a model generating a proposal before final protocol wrapping.
 */
export interface RawProposalOutput {
  /**
   * Executable JavaScript or TypeScript source code solving the problem.
   */
  readonly solution: string;
  /**
   * Staked reputation capital units backing the proposal.
   */
  readonly stake: number;
  /**
   * Rationale or justification for the code and chosen stake.
   */
  readonly reasoning: string;
}

/**
 * Raw structured output produced by a model auditing a proposal.
 */
export interface RawChallengeOutput {
  /**
   * Whether the auditor decides to lodge a challenge.
   * If false, the proposal is accepted without challenge.
   */
  readonly shouldChallenge: boolean;
  /**
   * Input value or parameter array designed to break the proposal.
   */
  readonly testInput?: unknown;
  /**
   * Strictly correct expected return value for the testInput.
   */
  readonly expectedOutput?: unknown;
  /**
   * Staked reputation capital units backing the challenge.
   */
  readonly stake?: number;
  /**
   * Explanation of the identified flaw or reasoning for passing.
   */
  readonly reasoning?: string;
}

/**
 * Standard interface for all NashGate model adapters (Mock, OpenAI-compatible, Ollama, Gemini).
 */
export interface AgentAdapter {
  /**
   * Human-readable identifier or provider tag for this adapter.
   */
  readonly name: string;

  /**
   * Generates a staked Proposal on behalf of an active GENERATOR agent.
   *
   * @param params - Generation parameters including agent and problem.
   * @returns A validated Proposal ready for oracle evaluation.
   */
  generateProposal(params: GenerateProposalParams): Promise<Proposal>;

  /**
   * Generates an adversarial Challenge (or null if deemed sound) on behalf of an active AUDITOR agent.
   *
   * Game-theoretic rationale:
   * Returning null signifies that the auditor declines to challenge. This protects the auditor from
   * the asymmetric false positive penalty (-1.5x stake) when inspecting sound proposals, while allowing
   * the generator to earn an unchallenged dividend (+0.1x stake).
   *
   * @param params - Audit parameters including auditor, target generator, and proposal.
   * @returns A Challenge targeting the proposal, or null if no flaw is detected.
   */
  generateChallenge(params: GenerateChallengeParams): Promise<Challenge | null>;
}
