/**
 * NashGate Stake and Entity Validation
 * Deterministic pure functions for validating agent creation, stakes, proposals, and challenges.
 */

import type {
  Agent,
  Challenge,
  CreateAgentParams,
  Proposal,
} from './types.ts';
import {
  DEFAULT_INITIAL_CAPITAL,
  MIN_STAKE,
} from './types.ts';
import { isBankrupt } from './bankruptcy.ts';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Creates a successful validation result.
 */
function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

/**
 * Creates a failed validation result with one or more error messages.
 */
function fail(...errors: string[]): ValidationResult {
  return { valid: false, errors };
}

/**
 * Instantiates an Agent with validated parameters.
 * Capital defaults to DEFAULT_INITIAL_CAPITAL (100).
 *
 * @param params - Configuration parameters for the agent.
 * @returns Fully initialized Agent.
 */
export function createAgent(params: CreateAgentParams): Agent {
  if (!params.id || typeof params.id !== 'string' || params.id.trim().length === 0) {
    throw new Error('[ValidationError] Agent id must be a non-empty string.');
  }

  if (params.role !== 'GENERATOR' && params.role !== 'AUDITOR') {
    throw new Error(`[ValidationError] Invalid agent role '${params.role}'. Must be 'GENERATOR' or 'AUDITOR'.`);
  }

  if (!params.model || typeof params.model !== 'string' || params.model.trim().length === 0) {
    throw new Error('[ValidationError] Agent model must be a non-empty string.');
  }

  const initialCapital = params.capital !== undefined ? params.capital : DEFAULT_INITIAL_CAPITAL;

  if (typeof initialCapital !== 'number' || Number.isNaN(initialCapital) || !Number.isFinite(initialCapital)) {
    throw new Error('[ValidationError] Agent capital must be a valid finite number.');
  }

  if (initialCapital < 0) {
    throw new Error('[ValidationError] Initial capital cannot be negative.');
  }

  return {
    id: params.id.trim(),
    role: params.role,
    model: params.model.trim(),
    capital: initialCapital,
    status: initialCapital <= 0 ? 'BANKRUPT' : 'ACTIVE',
    ...(params.apiKey && typeof params.apiKey === 'string' && params.apiKey.trim()
      ? { apiKey: params.apiKey.trim() }
      : {}),
    ...(params.baseUrl && typeof params.baseUrl === 'string' && params.baseUrl.trim()
      ? { baseUrl: params.baseUrl.trim() }
      : {}),
  };
}

/**
 * Validates whether a stake meets mechanism boundaries (1 <= stake <= capital).
 *
 * Game-theoretic rationale:
 * 1. stake >= MIN_STAKE (1): Enforces non-zero exposure, preventing risk-free cheap talk.
 * 2. stake <= capital: Enforces full collateralization, preventing unbacked leverage.
 *
 * @param stake - The numeric stake amount to validate.
 * @param agentCapital - The current capital of the staking agent.
 * @returns ValidationResult indicating validity and any violations.
 */
export function validateStake(stake: number, agentCapital: number): ValidationResult {
  const errors: string[] = [];

  if (typeof stake !== 'number' || Number.isNaN(stake) || !Number.isFinite(stake)) {
    return fail(`Stake must be a valid finite number. Received: ${stake}`);
  }

  if (typeof agentCapital !== 'number' || Number.isNaN(agentCapital) || !Number.isFinite(agentCapital)) {
    return fail(`Agent capital must be a valid finite number. Received: ${agentCapital}`);
  }

  if (agentCapital < MIN_STAKE) {
    errors.push(
      `Agent has insufficient capital (${agentCapital}) to meet minimum stake requirement (${MIN_STAKE}).`
    );
  }

  if (stake < MIN_STAKE) {
    errors.push(`Stake (${stake}) must be at least MIN_STAKE (${MIN_STAKE}).`);
  }

  // Defend against sub-cent floating-point precision artifacts (e.g. 177.16 vs 177.156)
  const roundedStake = Math.round((stake + Number.EPSILON) * 100) / 100;
  const roundedCapital = Math.round((agentCapital + Number.EPSILON) * 100) / 100;
  if (stake > agentCapital && roundedStake > roundedCapital) {
    errors.push(`Stake (${stake}) cannot exceed available agent capital (${agentCapital}).`);
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

/**
 * Validates a proposal submitted by an agent.
 *
 * @param proposal - The proposal to inspect.
 * @param agent - The agent submitting the proposal.
 * @returns ValidationResult with details on any compliance failures.
 */
export function validateProposal(proposal: Proposal, agent: Agent): ValidationResult {
  const errors: string[] = [];

  if (isBankrupt(agent)) {
    errors.push(`Agent '${agent.id}' is BANKRUPT and cannot submit proposals.`);
  }

  if (agent.role !== 'GENERATOR') {
    errors.push(`Agent '${agent.id}' has role '${agent.role}'. Only 'GENERATOR' agents can submit proposals.`);
  }

  if (!proposal.agentId || proposal.agentId !== agent.id) {
    errors.push(`Proposal agentId '${proposal.agentId}' does not match agent id '${agent.id}'.`);
  }

  if (typeof proposal.solution !== 'string' || proposal.solution.trim().length === 0) {
    errors.push('Proposal solution must be a non-empty string.');
  }

  const stakeResult = validateStake(proposal.stake, agent.capital);
  if (!stakeResult.valid) {
    errors.push(...stakeResult.errors);
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

/**
 * Validates an adversarial challenge submitted by an auditor against a target generator.
 *
 * @param challenge - The challenge to inspect.
 * @param auditor - The auditor submitting the challenge.
 * @param targetGenerator - The target generator being challenged.
 * @param proposal - Optional matching proposal from the target generator.
 * @returns ValidationResult with details on any compliance failures.
 */
export function validateChallenge(
  challenge: Challenge,
  auditor: Agent,
  targetGenerator: Agent,
  proposal?: Proposal
): ValidationResult {
  const errors: string[] = [];

  if (isBankrupt(auditor)) {
    errors.push(`Auditor '${auditor.id}' is BANKRUPT and cannot submit challenges.`);
  }

  if (auditor.role !== 'AUDITOR') {
    errors.push(`Agent '${auditor.id}' has role '${auditor.role}'. Only 'AUDITOR' agents can submit challenges.`);
  }

  if (!challenge.auditorId || challenge.auditorId !== auditor.id) {
    errors.push(`Challenge auditorId '${challenge.auditorId}' does not match auditor id '${auditor.id}'.`);
  }

  if (isBankrupt(targetGenerator)) {
    errors.push(`Target generator '${targetGenerator.id}' is BANKRUPT and cannot be challenged.`);
  }

  if (targetGenerator.role !== 'GENERATOR') {
    errors.push(
      `Target agent '${targetGenerator.id}' has role '${targetGenerator.role}'. Only 'GENERATOR' agents can be challenged.`
    );
  }

  if (!challenge.targetAgentId || challenge.targetAgentId !== targetGenerator.id) {
    errors.push(
      `Challenge targetAgentId '${challenge.targetAgentId}' does not match target generator id '${targetGenerator.id}'.`
    );
  }

  if (challenge.auditorId === challenge.targetAgentId) {
    errors.push('Auditor cannot challenge itself.');
  }

  if (challenge.testInput === undefined) {
    errors.push('Challenge must provide a defined testInput.');
  }

  const stakeResult = validateStake(challenge.stake, auditor.capital);
  if (!stakeResult.valid) {
    errors.push(...stakeResult.errors);
  }

  if (proposal) {
    if (proposal.agentId !== targetGenerator.id) {
      errors.push(
        `Target generator '${targetGenerator.id}' does not match proposal author '${proposal.agentId}'.`
      );
    }
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

/**
 * Validates round participation constraints across all agents, proposals, and challenges.
 * Enforces total solvency so agents cannot over-commit capital across multiple actions.
 *
 * @param agents - Collection or map of participating agents.
 * @param proposals - Proposals submitted for the round.
 * @param challenges - Challenges submitted for the round.
 * @returns ValidationResult summarizing round readiness.
 */
export function validateRoundParticipation(
  agents: readonly Agent[] | Map<string, Agent>,
  proposals: readonly Proposal[],
  challenges: readonly Challenge[]
): ValidationResult {
  const agentMap =
    agents instanceof Map
      ? agents
      : new Map<string, Agent>(agents.map((a) => [a.id, a]));

  const errors: string[] = [];
  const cumulativeStakes = new Map<string, number>();

  // Validate proposals
  for (const proposal of proposals) {
    const generator = agentMap.get(proposal.agentId);
    if (!generator) {
      errors.push(`Proposal references unknown agentId '${proposal.agentId}'.`);
      continue;
    }
    const propRes = validateProposal(proposal, generator);
    if (!propRes.valid) {
      errors.push(...propRes.errors);
    }
    const current = cumulativeStakes.get(proposal.agentId) ?? 0;
    cumulativeStakes.set(proposal.agentId, current + proposal.stake);
  }

  // Validate challenges
  for (const challenge of challenges) {
    const auditor = agentMap.get(challenge.auditorId);
    const targetGen = agentMap.get(challenge.targetAgentId);

    if (!auditor) {
      errors.push(`Challenge references unknown auditorId '${challenge.auditorId}'.`);
    }
    if (!targetGen) {
      errors.push(`Challenge references unknown targetAgentId '${challenge.targetAgentId}'.`);
    }

    if (auditor && targetGen) {
      const chalRes = validateChallenge(challenge, auditor, targetGen);
      if (!chalRes.valid) {
        errors.push(...chalRes.errors);
      }
    }

    const current = cumulativeStakes.get(challenge.auditorId) ?? 0;
    cumulativeStakes.set(challenge.auditorId, current + challenge.stake);
  }

  // Check cumulative solvency
  for (const [agentId, totalStake] of cumulativeStakes.entries()) {
    const agent = agentMap.get(agentId);
    if (agent && totalStake > agent.capital) {
      errors.push(
        `Agent '${agentId}' has over-committed capital: total stake across round (${totalStake}) exceeds capital (${agent.capital}).`
      );
    }
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

/**
 * Validates a complete roster of agents before tournament initialization.
 * Enforces mechanism requirements:
 * 1. At least 2 active agents total.
 * 2. At least 1 GENERATOR agent (to propose solutions).
 * 3. At least 1 AUDITOR agent (to audit proposals and prevent sybil free-riding).
 * 4. Strictly unique agent IDs.
 * 5. Valid initial capital >= MIN_STAKE for all active agents.
 *
 * @param agents - Array of agents to validate.
 * @returns ValidationResult summarizing roster readiness.
 */
export function validateAgentRoster(agents: readonly Agent[]): ValidationResult {
  const errors: string[] = [];

  if (!agents || agents.length < 2) {
    return fail('Tournament requires at least 2 agents to run consensus arbitration.');
  }

  const seenIds = new Set<string>();
  let generatorCount = 0;
  let auditorCount = 0;

  for (const agent of agents) {
    if (!agent.id || !agent.id.trim()) {
      errors.push('Agent with empty or missing ID detected.');
      continue;
    }

    const cleanId = agent.id.trim();
    if (seenIds.has(cleanId)) {
      errors.push(`Duplicate agent ID '${cleanId}' detected in roster.`);
    }
    seenIds.add(cleanId);

    if (agent.role === 'GENERATOR') {
      if (agent.status === 'ACTIVE') generatorCount++;
    } else if (agent.role === 'AUDITOR') {
      if (agent.status === 'ACTIVE') auditorCount++;
    } else {
      errors.push(`Agent '${cleanId}' has invalid role '${(agent as any).role}'.`);
    }

    if (typeof agent.capital !== 'number' || Number.isNaN(agent.capital) || !Number.isFinite(agent.capital)) {
      errors.push(`Agent '${cleanId}' has invalid capital value '${agent.capital}'.`);
    } else if (agent.status === 'ACTIVE' && agent.capital < MIN_STAKE) {
      errors.push(
        `Active agent '${cleanId}' must have capital >= ${MIN_STAKE} (received: ${agent.capital}).`
      );
    }
  }

  if (generatorCount === 0) {
    errors.push('Roster must contain at least one active GENERATOR agent.');
  }

  if (auditorCount === 0) {
    errors.push('Roster must contain at least one active AUDITOR agent.');
  }

  return errors.length === 0 ? ok() : fail(...errors);
}
