/**
 * NashGate Round Settlement Engine
 * Pure, deterministic functions executing the game-theoretic payoff matrix and ledger updates.
 */

import type {
  Agent,
  AgentBalanceUpdate,
  ChallengeEvaluation,
  PairSettlementResult,
  Proposal,
  RoundSettlementResult,
  UnchallengedSettlementResult,
} from './types.ts';
import {
  AUDITOR_FAIL_PENALTY_MULTIPLIER,
  GENERATOR_PASS_REWARD_MULTIPLIER,
  UNCHALLENGED_REWARD_MULTIPLIER,
} from './types.ts';
import { applyBankruptcy, isBankrupt, roundToPrecision } from './bankruptcy.ts';

/**
 * Calculates payoff deltas for a single (Generator, Auditor) evaluated challenge pair.
 *
 * Game-theoretic rationale:
 * 1. Generator FAILS (!generatorPassed):
 *    - Generator loses stake (-G.stake) which is transferred to the auditor (+G.stake) as a bounty.
 *    - Encourages auditors to find authentic bugs and holds generators liable for incorrect outputs.
 * 2. Generator PASSES (generatorPassed):
 *    - Auditor suffers an asymmetric anti-spam penalty of 1.5x stake (-1.5 * A.stake).
 *    - Generator receives a 0.5x dividend (+0.5 * G.stake) for withstanding adversarial scrutiny.
 *    - Deters speculative spam while rewarding proven resilience.
 *
 * @param generatorStake - Staked capital of the generator's proposal.
 * @param auditorStake - Staked capital of the auditor's challenge.
 * @param generatorPassed - True if generator passed (challenge failed); false if generator failed.
 * @returns Payoff deltas and mathematical explanation.
 */
export function calculatePairPayoff(
  generatorStake: number,
  auditorStake: number,
  generatorPassed: boolean
): { generatorDelta: number; auditorDelta: number; rationale: string } {
  if (generatorPassed) {
    // Case 2: Generator PASSES (Auditor challenge was a false positive)
    const generatorDelta = roundToPrecision(GENERATOR_PASS_REWARD_MULTIPLIER * generatorStake);
    const auditorDelta = -roundToPrecision(AUDITOR_FAIL_PENALTY_MULTIPLIER * auditorStake);
    return {
      generatorDelta,
      auditorDelta,
      rationale:
        `Generator passed adversarial check: rewarded +${generatorDelta} (0.5 * ${generatorStake} stake); ` +
        `Auditor penalized ${auditorDelta} (-1.5 * ${auditorStake} stake) for false positive spam.`,
    };
  } else {
    // Case 1: Generator FAILS (Auditor's edge case broke the solution)
    const generatorDelta = -roundToPrecision(generatorStake);
    const auditorDelta = roundToPrecision(generatorStake);
    return {
      generatorDelta,
      auditorDelta,
      rationale:
        `Generator failed adversarial check: forfeited -${generatorStake} stake; ` +
        `Auditor awarded +${generatorStake} bounty for proving solution failure.`,
    };
  }
}

/**
 * Calculates payoff delta for an unchallenged proposal.
 *
 * Game-theoretic rationale:
 * Unchallenged proposals award a modest +10% dividend (+0.1 * G.stake) to the generator.
 * This guarantees a positive expected value for valid proposals even when no auditors challenge,
 * preventing protocol stagnation.
 *
 * @param generatorStake - Staked capital of the unchallenged proposal.
 * @returns Payoff delta and explanation.
 */
export function calculateUnchallengedPayoff(
  generatorStake: number
): { generatorDelta: number; rationale: string } {
  const generatorDelta = roundToPrecision(UNCHALLENGED_REWARD_MULTIPLIER * generatorStake);
  return {
    generatorDelta,
    rationale: `Proposal unchallenged: generator awarded +${generatorDelta} dividend (0.1 * ${generatorStake} stake).`,
  };
}

/**
 * Executes a pairwise settlement for a single evaluated challenge.
 *
 * @param generator - Target generator agent.
 * @param proposal - Proposal under challenge.
 * @param auditor - Auditor agent.
 * @param evaluation - Challenge evaluation containing challenge and outcome.
 * @returns PairSettlementResult describing the outcome.
 */
export function settlePair(
  generator: Agent,
  proposal: Proposal,
  auditor: Agent,
  evaluation: ChallengeEvaluation
): PairSettlementResult {
  const { challenge, generatorPassed } = evaluation;

  if (proposal.agentId !== generator.id) {
    throw new Error(
      `[SettlementError] Proposal agentId '${proposal.agentId}' does not match generator '${generator.id}'.`
    );
  }

  if (challenge.auditorId !== auditor.id) {
    throw new Error(
      `[SettlementError] Challenge auditorId '${challenge.auditorId}' does not match auditor '${auditor.id}'.`
    );
  }

  if (challenge.targetAgentId !== generator.id) {
    throw new Error(
      `[SettlementError] Challenge targetAgentId '${challenge.targetAgentId}' does not match generator '${generator.id}'.`
    );
  }

  const { generatorDelta, auditorDelta, rationale } = calculatePairPayoff(
    proposal.stake,
    challenge.stake,
    generatorPassed
  );

  return {
    generatorId: generator.id,
    auditorId: auditor.id,
    generatorPassed,
    generatorStake: proposal.stake,
    auditorStake: challenge.stake,
    generatorDelta,
    auditorDelta,
    rationale,
  };
}

/**
 * Executes an unchallenged settlement for a proposal that faced zero challenges.
 *
 * @param generator - Generator agent who submitted the proposal.
 * @param proposal - Unchallenged proposal.
 * @returns UnchallengedSettlementResult.
 */
export function settleUnchallenged(
  generator: Agent,
  proposal: Proposal
): UnchallengedSettlementResult {
  if (proposal.agentId !== generator.id) {
    throw new Error(
      `[SettlementError] Proposal agentId '${proposal.agentId}' does not match generator '${generator.id}'.`
    );
  }

  const { generatorDelta, rationale } = calculateUnchallengedPayoff(proposal.stake);

  return {
    agentId: generator.id,
    stake: proposal.stake,
    delta: generatorDelta,
    rationale,
  };
}

/**
 * Input configuration for settling a consensus round.
 */
export interface SettleRoundParams {
  readonly agents: readonly Agent[] | Map<string, Agent>;
  readonly proposals: readonly Proposal[];
  readonly evaluations: readonly ChallengeEvaluation[];
}

/**
 * Executes full round settlement over a set of agents, proposals, and challenge evaluations.
 *
 * Guarantees:
 * - Deterministic, pure execution (zero I/O, zero side-effects).
 * - Rejects participation from bankrupt agents.
 * - Applies pairwise payoffs and unchallenged dividends.
 * - Enforces bankruptcy conditions (capital <= 0 -> capital = 0, status = 'BANKRUPT').
 * - Preserves immutable audit history.
 *
 * @param params - Round inputs.
 * @returns RoundSettlementResult with updated agents, ledgers, and bankruptcy records.
 */
export function settleRound(params: SettleRoundParams): RoundSettlementResult {
  const { proposals, evaluations } = params;

  // Build mutable lookup map for agents
  const agentMap = new Map<string, Agent>(
    params.agents instanceof Map
      ? params.agents
      : params.agents.map((a) => [a.id, a])
  );

  // Map proposals by generator id
  const proposalMap = new Map<string, Proposal>();
  for (const proposal of proposals) {
    const agent = agentMap.get(proposal.agentId);
    if (!agent) {
      throw new Error(`[SettlementError] Unknown agent '${proposal.agentId}' in proposals.`);
    }
    if (isBankrupt(agent)) {
      throw new Error(
        `[SettlementError] Bankrupt agent '${agent.id}' cannot submit proposals or participate in settlement.`
      );
    }
    if (proposalMap.has(proposal.agentId)) {
      throw new Error(
        `[SettlementError] Duplicate proposal detected for agent '${proposal.agentId}' in the same round.`
      );
    }
    proposalMap.set(proposal.agentId, proposal);
  }

  // Track net capital adjustments per agent
  const deltas = new Map<string, number>();
  for (const [id] of agentMap.entries()) {
    deltas.set(id, 0);
  }

  const pairSettlements: PairSettlementResult[] = [];
  const challengedGeneratorIds = new Set<string>();

  // Process all evaluated challenges
  for (const evalResult of evaluations) {
    const { challenge } = evalResult;
    const auditor = agentMap.get(challenge.auditorId);
    const generator = agentMap.get(challenge.targetAgentId);

    if (!auditor) {
      throw new Error(`[SettlementError] Unknown auditor '${challenge.auditorId}' in challenge evaluation.`);
    }
    if (isBankrupt(auditor)) {
      throw new Error(
        `[SettlementError] Bankrupt auditor '${auditor.id}' cannot challenge or participate in settlement.`
      );
    }

    if (!generator) {
      throw new Error(`[SettlementError] Unknown target generator '${challenge.targetAgentId}' in challenge.`);
    }

    const proposal = proposalMap.get(generator.id);
    if (!proposal) {
      throw new Error(
        `[SettlementError] Target generator '${generator.id}' has no active proposal in this round.`
      );
    }

    challengedGeneratorIds.add(generator.id);

    const pairResult = settlePair(generator, proposal, auditor, evalResult);
    pairSettlements.push(pairResult);

    deltas.set(generator.id, (deltas.get(generator.id) ?? 0) + pairResult.generatorDelta);
    deltas.set(auditor.id, (deltas.get(auditor.id) ?? 0) + pairResult.auditorDelta);
  }

  // Process unchallenged proposals
  const unchallengedSettlements: UnchallengedSettlementResult[] = [];
  for (const [generatorId, proposal] of proposalMap.entries()) {
    if (!challengedGeneratorIds.has(generatorId)) {
      const generator = agentMap.get(generatorId)!;
      const unchResult = settleUnchallenged(generator, proposal);
      unchallengedSettlements.push(unchResult);
      deltas.set(generatorId, (deltas.get(generatorId) ?? 0) + unchResult.delta);
    }
  }

  // Update agents and enforce bankruptcy
  const updatedAgents: Agent[] = [];
  const balanceUpdates: AgentBalanceUpdate[] = [];
  const bankruptAgentIds: string[] = [];

  for (const [id, initialAgent] of agentMap.entries()) {
    const netDelta = roundToPrecision(deltas.get(id) ?? 0);
    const unadjustedNewCapital = initialAgent.capital + netDelta;

    // Apply bankruptcy condition (capital <= 0 -> capital = 0, status = 'BANKRUPT')
    const finalCapital = unadjustedNewCapital <= 0 ? 0 : roundToPrecision(unadjustedNewCapital);
    const finalStatus = finalCapital <= 0 ? 'BANKRUPT' : initialAgent.status;

    const updatedAgent: Agent = {
      ...initialAgent,
      capital: finalCapital,
      status: finalStatus,
    };

    updatedAgents.push(updatedAgent);

    const bankrupt = finalStatus === 'BANKRUPT';
    if (bankrupt) {
      bankruptAgentIds.push(id);
    }

    balanceUpdates.push({
      agentId: id,
      initialCapital: initialAgent.capital,
      netDelta,
      finalCapital,
      previousStatus: initialAgent.status,
      currentStatus: finalStatus,
      isBankrupt: bankrupt,
    });
  }

  return {
    updatedAgents,
    pairSettlements,
    unchallengedSettlements,
    balanceUpdates,
    bankruptAgentIds,
  };
}
