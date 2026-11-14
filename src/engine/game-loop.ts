/**
 * NashGate Multi-Round Game Loop and Consensus Orchestrator
 * Connects model adapters (/src/adapters/), deterministic sandbox oracle (/src/oracle/),
 * and pure game-theoretic settlement (/src/core/).
 * Grounded in Game Theory and Mechanism Design.
 */

import type {
  Agent,
  Challenge,
  ChallengeEvaluation,
  Proposal,
  RoundSettlementResult,
} from '../core/types.ts';
import {
  filterActiveAgents,
  isBankrupt,
  roundToPrecision,
} from '../core/bankruptcy.ts';
import {
  validateChallenge,
  validateProposal,
  validateRoundParticipation,
} from '../core/validation.ts';
import { settleRound } from '../core/settlement.ts';
import {
  evaluateChallenge,
  type OracleExecutionResult,
  type SandboxOptions,
} from '../oracle/index.ts';
import type { AgentAdapter, ProblemContext } from '../adapters/types.ts';

/**
 * Result summary of a single executed tournament round.
 */
export interface RoundResult {
  readonly roundNumber: number;
  readonly problem: ProblemContext;
  readonly activeAgents: readonly Agent[];
  readonly proposals: readonly Proposal[];
  readonly challenges: readonly Challenge[];
  readonly evaluations: readonly (ChallengeEvaluation & OracleExecutionResult)[];
  readonly settlement: RoundSettlementResult;
  readonly updatedAgents: readonly Agent[];
  readonly bankruptAgentIds: readonly string[];
}

/**
 * Lifecycle hook callbacks enabling rich terminal logging, telemetry, or custom UI streaming.
 */
export interface GameLoopHooks {
  onTournamentStart?: (agents: readonly Agent[]) => void | Promise<void>;
  onRoundStart?: (
    round: number,
    problem: ProblemContext,
    activeAgents: readonly Agent[]
  ) => void | Promise<void>;
  onProposalSubmitted?: (proposal: Proposal, agent: Agent) => void | Promise<void>;
  onProposalRejected?: (agent: Agent, errors: readonly string[]) => void | Promise<void>;
  onChallengeSubmitted?: (
    challenge: Challenge,
    auditor: Agent,
    targetGenerator: Agent
  ) => void | Promise<void>;
  onChallengeDeclined?: (auditor: Agent, targetGenerator: Agent) => void | Promise<void>;
  onChallengeRejected?: (auditor: Agent, errors: readonly string[]) => void | Promise<void>;
  onEvaluationCompleted?: (
    evaluation: ChallengeEvaluation & OracleExecutionResult
  ) => void | Promise<void>;
  onSettlementCompleted?: (
    roundNumber: number,
    settlement: RoundSettlementResult
  ) => void | Promise<void>;
  onBankruptcy?: (agent: Agent, roundNumber: number) => void | Promise<void>;
  onRoundEnd?: (result: RoundResult) => void | Promise<void>;
  onTournamentEnd?: (result: TournamentResult) => void | Promise<void>;
}

/**
 * Options for single-round execution.
 */
export interface RunRoundParams {
  readonly roundNumber: number;
  readonly problem: ProblemContext;
  readonly agents: Map<string, Agent>;
  readonly getAdapter: (agent: Agent) => AgentAdapter;
  readonly sandboxOptions?: SandboxOptions;
  readonly hooks?: GameLoopHooks;
}

/**
 * Options for multi-round tournament execution.
 */
export interface RunTournamentParams {
  readonly agents: readonly Agent[];
  readonly problems: readonly ProblemContext[];
  readonly adapter: AgentAdapter | Map<string, AgentAdapter> | ((agent: Agent) => AgentAdapter);
  readonly maxRounds?: number;
  readonly sandboxOptions?: SandboxOptions;
  readonly hooks?: GameLoopHooks;
}

/**
 * Complete outcome of a multi-round tournament.
 */
export interface TournamentResult {
  readonly rounds: readonly RoundResult[];
  readonly initialAgents: readonly Agent[];
  readonly finalAgents: readonly Agent[];
  readonly leaderboard: readonly Agent[];
  readonly bankruptAgents: readonly Agent[];
  readonly totalRoundsPlayed: number;
  readonly completed: boolean;
  readonly terminationReason: string;
}

/**
 * Resolves an AgentAdapter for a given agent.
 */
function resolveAdapter(
  agent: Agent,
  adapterSource: AgentAdapter | Map<string, AgentAdapter> | ((agent: Agent) => AgentAdapter)
): AgentAdapter {
  if (typeof adapterSource === 'function') {
    return adapterSource(agent);
  }
  if (adapterSource instanceof Map) {
    const found = adapterSource.get(agent.id) ?? adapterSource.get('default');
    if (!found) {
      throw new Error(`[GameEngineError] No adapter registered for agent '${agent.id}'.`);
    }
    return found;
  }
  return adapterSource;
}

/**
 * Executes a single consensus round:
 * 1. Filters active solvent agents (bankrupt agents permanently barred).
 * 2. Collects and validates staked Proposals from GENERATOR agents.
 * 3. Collects and validates adversarial Challenges from AUDITOR agents.
 * 4. Executes deterministic sandboxed verification via the Oracle.
 * 5. Settles payoffs, transfers capital bounties, applies penalties, and triggers bankruptcies.
 *
 * @param params - Configuration and context for the round.
 * @returns Immutable RoundResult with complete audit log.
 */
export async function runRound(params: RunRoundParams): Promise<RoundResult> {
  const { roundNumber, problem, agents, getAdapter, sandboxOptions, hooks } = params;

  // Step 1: Filter solvent agents.
  // Game-theoretic rationale: Insolvent agents possess zero collateral to back their stakes.
  // Permanent exclusion eliminates moral hazard and preserves consensus integrity.
  const allAgentsList = Array.from(agents.values());
  const activeAgents = filterActiveAgents(allAgentsList);

  await hooks?.onRoundStart?.(roundNumber, problem, activeAgents);

  const activeGenerators = activeAgents.filter((a) => a.role === 'GENERATOR');
  const activeAuditors = activeAgents.filter((a) => a.role === 'AUDITOR');

  // Step 2: Proposal Generation Phase
  const validProposals: Proposal[] = [];
  const generatorMap = new Map<string, Agent>();

  for (const generator of activeGenerators) {
    generatorMap.set(generator.id, generator);
    const adapter = getAdapter(generator);

    try {
      const proposal = await adapter.generateProposal({
        agent: generator,
        problem,
        activeAgents,
      });

      const validation = validateProposal(proposal, generator);
      if (validation.valid) {
        validProposals.push(proposal);
        await hooks?.onProposalSubmitted?.(proposal, generator);
      } else {
        await hooks?.onProposalRejected?.(generator, validation.errors);
      }
    } catch (err: any) {
      await hooks?.onProposalRejected?.(generator, [
        `Adapter generation failed: ${err?.message || String(err)}`,
      ]);
    }
  }

  // Step 3: Adversarial Auditing Phase
  // Each active auditor inspects proposals submitted by generators.
  const validChallenges: Challenge[] = [];
  const auditorCumulativeStakes = new Map<string, number>();

  for (const auditor of activeAuditors) {
    const adapter = getAdapter(auditor);
    auditorCumulativeStakes.set(auditor.id, 0);

    for (const proposal of validProposals) {
      const targetGenerator = generatorMap.get(proposal.agentId);
      if (!targetGenerator || targetGenerator.id === auditor.id) {
        continue;
      }

      try {
        const challenge = await adapter.generateChallenge({
          auditor,
          targetGenerator,
          proposal,
          problem,
          activeAgents,
        });

        if (!challenge) {
          // Auditor voluntarily declined to challenge.
          // Game-theoretic rationale: Avoiding speculative false-positive penalty (-1.5x stake)
          // allows the proposal to stand unchallenged and receive a 10% dividend.
          await hooks?.onChallengeDeclined?.(auditor, targetGenerator);
          continue;
        }

        const validation = validateChallenge(challenge, auditor, targetGenerator, proposal);
        const currentTotal = auditorCumulativeStakes.get(auditor.id) ?? 0;
        const newTotal = currentTotal + challenge.stake;

        if (validation.valid && newTotal <= auditor.capital) {
          validChallenges.push(challenge);
          auditorCumulativeStakes.set(auditor.id, newTotal);
          await hooks?.onChallengeSubmitted?.(challenge, auditor, targetGenerator);
        } else {
          const errors = [...validation.errors];
          if (newTotal > auditor.capital) {
            errors.push(
              `Cumulative challenge stake (${newTotal}) exceeds auditor capital (${auditor.capital}).`
            );
          }
          await hooks?.onChallengeRejected?.(auditor, errors);
        }
      } catch (err: any) {
        await hooks?.onChallengeRejected?.(auditor, [
          `Adapter audit failed: ${err?.message || String(err)}`,
        ]);
      }
    }
  }

  // Step 4: Deterministic Sandboxed Verification via the Oracle
  const evaluations: (ChallengeEvaluation & OracleExecutionResult)[] = [];
  const proposalLookup = new Map<string, Proposal>(validProposals.map((p) => [p.agentId, p]));

  for (const challenge of validChallenges) {
    const proposal = proposalLookup.get(challenge.targetAgentId);
    if (!proposal) continue;

    const evaluation = await evaluateChallenge(proposal, challenge, sandboxOptions);
    evaluations.push(evaluation);
    await hooks?.onEvaluationCompleted?.(evaluation);
  }

  // Step 5: Pure Game-Theoretic Settlement
  // Game-theoretic rationale:
  // - Generator FAILS: generator loses stake (-G.stake), awarded to auditor (+G.stake) as a bounty.
  // - Generator PASSES: auditor penalized (-1.5 * A.stake) for false positive spam; generator rewarded (+0.5 * G.stake).
  // - Unchallenged: generator receives +0.1 * G.stake dividend.
  // - Capital <= 0 -> BANKRUPT (capital clamped to 0, permanently excluded).
  const settlement = settleRound({
    agents: activeAgents,
    proposals: validProposals,
    evaluations,
  });

  // Track previously solvent agents that became bankrupt in this round
  const newlyBankruptIds = new Set<string>();
  for (const update of settlement.balanceUpdates) {
    if (update.previousStatus === 'ACTIVE' && update.isBankrupt) {
      newlyBankruptIds.add(update.agentId);
    }
  }

  // Update master agent registry
  for (const updated of settlement.updatedAgents) {
    agents.set(updated.id, updated);
  }

  await hooks?.onSettlementCompleted?.(roundNumber, settlement);

  for (const bankruptId of newlyBankruptIds) {
    const bankruptAgent = agents.get(bankruptId);
    if (bankruptAgent) {
      await hooks?.onBankruptcy?.(bankruptAgent, roundNumber);
    }
  }

  const result: RoundResult = {
    roundNumber,
    problem,
    activeAgents,
    proposals: validProposals,
    challenges: validChallenges,
    evaluations,
    settlement,
    updatedAgents: settlement.updatedAgents,
    bankruptAgentIds: Array.from(newlyBankruptIds),
  };

  await hooks?.onRoundEnd?.(result);
  return result;
}

/**
 * Runs a complete multi-round tournament:
 * Iterates through problems, executing rounds sequentially until all problems
 * are exhausted, all generators are bankrupt, or fewer than 2 active agents remain.
 *
 * @param params - Tournament configuration.
 * @returns TournamentResult summarizing rounds, leaderboard, and statistics.
 */
export async function runTournament(params: RunTournamentParams): Promise<TournamentResult> {
  const { agents: initialAgents, problems, adapter, maxRounds, sandboxOptions, hooks } = params;

  const agentMap = new Map<string, Agent>(initialAgents.map((a) => [a.id, a]));
  const getAdapter = (agent: Agent) => resolveAdapter(agent, adapter);

  await hooks?.onTournamentStart?.(initialAgents);

  const rounds: RoundResult[] = [];
  const limit = Math.min(problems.length, maxRounds ?? problems.length);
  let terminationReason = 'All scheduled rounds completed successfully.';

  for (let i = 0; i < limit; i++) {
    const roundNumber = i + 1;
    const problem = { ...problems[i], round: roundNumber };

    const activeList = filterActiveAgents(Array.from(agentMap.values()));
    const activeGenerators = activeList.filter((a) => a.role === 'GENERATOR');

    if (activeGenerators.length === 0) {
      terminationReason = 'Consensus halted: all GENERATOR agents are BANKRUPT.';
      break;
    }

    if (activeList.length < 2) {
      terminationReason = 'Consensus halted: fewer than 2 solvent agents remain active.';
      break;
    }

    const roundResult = await runRound({
      roundNumber,
      problem,
      agents: agentMap,
      getAdapter,
      sandboxOptions,
      hooks,
    });

    rounds.push(roundResult);
  }

  const finalAgents = Array.from(agentMap.values());
  const leaderboard = [...finalAgents].sort((a, b) => b.capital - a.capital);
  const bankruptAgents = finalAgents.filter((a) => isBankrupt(a));

  const result: TournamentResult = {
    rounds,
    initialAgents,
    finalAgents,
    leaderboard,
    bankruptAgents,
    totalRoundsPlayed: rounds.length,
    completed: rounds.length === limit,
    terminationReason,
  };

  await hooks?.onTournamentEnd?.(result);
  return result;
}
