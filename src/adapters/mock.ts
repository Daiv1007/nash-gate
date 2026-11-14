/**
 * NashGate Mock Agent Adapter
 * Deterministic, scripted adapter providing realistic solid vs. buggy code proposals
 * and adversarial edge-case challenges with zero API keys required.
 * Grounded in Game Theory and Mechanism Design.
 */

import type { Agent, Challenge, Proposal } from '../core/types.ts';
import { MIN_STAKE } from '../core/types.ts';
import { roundToPrecision } from '../core/bankruptcy.ts';
import type {
  AgentAdapter,
  GenerateChallengeParams,
  GenerateProposalParams,
  ProblemContext,
  RawChallengeOutput,
  RawProposalOutput,
} from './types.ts';

/**
 * Scripted proposal definition for a given problem variant.
 */
export interface MockProposalDefinition {
  readonly solution: string;
  readonly defaultStakePercent: number;
  readonly reasoning: string;
}

/**
 * Scripted challenge definition targeting a specific problem.
 */
export interface MockChallengeDefinition {
  readonly shouldChallenge: boolean;
  readonly testInput?: unknown;
  readonly expectedOutput?: unknown;
  readonly defaultStakePercent?: number;
  readonly reasoning?: string;
}

/**
 * Predefined realistic problem catalog with solid implementations, buggy variations,
 * and corresponding edge-case challenges.
 */
export const DEFAULT_MOCK_CATALOG: Record<
  string,
  {
    solid: MockProposalDefinition;
    buggy: MockProposalDefinition;
    flawChallenge: MockChallengeDefinition;
    falsePositiveChallenge: MockChallengeDefinition;
  }
> = {
  'is-palindrome': {
    solid: {
      solution: `function isPalindrome(s) {
  // Normalize string: strip non-alphanumeric and lowercase
  const clean = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean === clean.split('').reverse().join('');
}`,
      defaultStakePercent: 0.3,
      reasoning: 'Normalized character filtering ensures resilient handling of spaces, casing, and punctuation.',
    },
    buggy: {
      solution: `function isPalindrome(s) {
  // Naive check: fails on punctuation, whitespace, and case sensitivity
  return s === s.split('').reverse().join('');
}`,
      defaultStakePercent: 0.4,
      reasoning: 'Direct string reversal heuristic assuming pre-cleaned input.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: 'A man, a plan, a canal: Panama',
      expectedOutput: true,
      defaultStakePercent: 0.3,
      reasoning: 'Naive reversal fails on multi-word palindrome sentences with punctuation and casing.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: 'radar',
      expectedOutput: true,
      defaultStakePercent: 0.25,
      reasoning: 'Speculative check on simple symmetric word; generator will pass, penalizing auditor for spam.',
    },
  },
  'clamp-number': {
    solid: {
      solution: `function clamp(val, min, max) {
  // Handle inverted boundaries safely
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.min(Math.max(val, lower), upper);
}`,
      defaultStakePercent: 0.35,
      reasoning: 'Defensive boundary sorting protects against inverted ranges and clamps correctly.',
    },
    buggy: {
      solution: `function clamp(val, min, max) {
  // Fails when min > max or when checking negative lower bounds
  if (val < min) return min;
  if (val > max) return max;
  return val;
}`,
      defaultStakePercent: 1.0,
      reasoning: 'High-conviction linear conditional clamping assuming strictly ordered min <= max.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: [-10, 0, 100],
      expectedOutput: 0,
      defaultStakePercent: 0.4,
      reasoning: 'Negative value below zero-bound must clamp to 0; triggers off-by-one or condition branch.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: [50, 0, 100],
      expectedOutput: 50,
      defaultStakePercent: 0.7,
      reasoning: 'Reckless over-leveraged challenge on mid-range value; generator passes effortlessly.',
    },
  },
  'sum-array': {
    solid: {
      solution: `function sumArray(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  return numbers.reduce((acc, curr) => acc + (Number(curr) || 0), 0);
}`,
      defaultStakePercent: 0.3,
      reasoning: 'Defensive reduction gracefully coalescing empty inputs and NaN entries.',
    },
    buggy: {
      solution: `function sumArray(numbers) {
  // Fails on empty array: returns numbers[0] which is undefined
  let total = numbers[0];
  for (let i = 1; i < numbers.length; i++) {
    total += numbers[i];
  }
  return total;
}`,
      defaultStakePercent: 0.5,
      reasoning: 'Standard accumulator loop starting from element 0.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: [],
      expectedOutput: 0,
      defaultStakePercent: 0.35,
      reasoning: 'Empty array input causes buggy accumulator to return undefined instead of 0.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: [1, 2, 3, 4, 5],
      expectedOutput: 15,
      defaultStakePercent: 0.25,
      reasoning: 'Standard positive array; generator passes.',
    },
  },
};

/**
 * Configuration options for customizing MockAdapter behavior.
 */
export interface MockAdapterOptions {
  readonly name?: string;
  /**
   * Global behavior profile:
   * - 'solid': Always propose robust code; audit prudently.
   * - 'buggy': Always propose flawed code; audit recklessly.
   * - 'mixed' (default): Infer behavior from agent ID / model naming conventions.
   */
  readonly profile?: 'solid' | 'buggy' | 'mixed';
  /**
   * Custom programmatic handler for proposals.
   */
  readonly proposalHandler?: (params: GenerateProposalParams) => Promise<RawProposalOutput> | RawProposalOutput;
  /**
   * Custom programmatic handler for challenges.
   */
  readonly challengeHandler?: (params: GenerateChallengeParams) => Promise<RawChallengeOutput | null> | RawChallengeOutput | null;
}

/**
 * Deterministic Mock Agent Adapter.
 */
export class MockAdapter implements AgentAdapter {
  readonly name: string;
  private readonly profile: 'solid' | 'buggy' | 'mixed';
  private readonly proposalHandler?: (params: GenerateProposalParams) => Promise<RawProposalOutput> | RawProposalOutput;
  private readonly challengeHandler?: (params: GenerateChallengeParams) => Promise<RawChallengeOutput | null> | RawChallengeOutput | null;

  constructor(options?: MockAdapterOptions) {
    this.name = options?.name ?? 'MockAdapter';
    this.profile = options?.profile ?? 'mixed';
    this.proposalHandler = options?.proposalHandler;
    this.challengeHandler = options?.challengeHandler;
  }

  /**
   * Determines whether an agent should exhibit buggy behavior based on profile and naming conventions.
   */
  private isBuggyGenerator(agent: Agent): boolean {
    if (this.profile === 'buggy') return true;
    if (this.profile === 'solid') return false;

    const lowerId = agent.id.toLowerCase();
    const lowerModel = agent.model.toLowerCase();
    return (
      lowerId.includes('buggy') ||
      lowerId.includes('naive') ||
      lowerId.includes('flawed') ||
      lowerModel.includes('buggy') ||
      lowerModel.includes('naive') ||
      lowerModel.includes('heuristic')
    );
  }

  /**
   * Determines whether an auditor should exhibit reckless false-positive behavior.
   */
  private isRecklessAuditor(agent: Agent): boolean {
    const lowerId = agent.id.toLowerCase();
    const lowerModel = agent.model.toLowerCase();
    return (
      lowerId.includes('reckless') ||
      lowerId.includes('spam') ||
      lowerId.includes('false') ||
      lowerModel.includes('reckless') ||
      lowerModel.includes('speculative')
    );
  }

  /**
   * Determines whether an auditor should decline to challenge (passive / prudent on solid code).
   */
  private isPassiveAuditor(agent: Agent): boolean {
    const lowerId = agent.id.toLowerCase();
    const lowerModel = agent.model.toLowerCase();
    return (
      lowerId.includes('passive') ||
      lowerId.includes('prudent') ||
      lowerModel.includes('passive')
    );
  }

  /**
   * Resolves the problem catalog entry corresponding to problem id or title.
   */
  private resolveCatalogEntry(problem: ProblemContext) {
    const id = problem.id.toLowerCase();
    if (DEFAULT_MOCK_CATALOG[id]) {
      return DEFAULT_MOCK_CATALOG[id];
    }
    for (const [key, entry] of Object.entries(DEFAULT_MOCK_CATALOG)) {
      if (id.includes(key) || problem.title.toLowerCase().includes(key)) {
        return entry;
      }
    }
    // Fallback to is-palindrome as default
    return DEFAULT_MOCK_CATALOG['is-palindrome'];
  }

  /**
   * Generates a Proposal for a GENERATOR agent.
   */
  async generateProposal(params: GenerateProposalParams): Promise<Proposal> {
    const { agent, problem } = params;

    // Check custom handler first
    if (this.proposalHandler) {
      const raw = await this.proposalHandler(params);
      const stake = this.normalizeStake(raw.stake, agent.capital);
      return {
        agentId: agent.id,
        solution: raw.solution,
        stake,
        reasoning: raw.reasoning,
      };
    }

    const catalog = this.resolveCatalogEntry(problem);
    const useBuggy = this.isBuggyGenerator(agent);
    const def = useBuggy ? catalog.buggy : catalog.solid;

    // Calculate stake as percentage of current capital
    const calculatedStake = roundToPrecision(agent.capital * def.defaultStakePercent, 2);
    const stake = this.normalizeStake(calculatedStake, agent.capital);

    return {
      agentId: agent.id,
      solution: def.solution,
      stake,
      reasoning: `${def.reasoning} [Staking ${stake} / ${agent.capital} capital]`,
    };
  }

  /**
   * Generates a Challenge (or null) for an AUDITOR agent evaluating a target proposal.
   */
  async generateChallenge(params: GenerateChallengeParams): Promise<Challenge | null> {
    const { auditor, targetGenerator, proposal, problem } = params;

    // Check custom handler first
    if (this.challengeHandler) {
      const raw = await this.challengeHandler(params);
      if (!raw || !raw.shouldChallenge) {
        return null;
      }
      const stake = this.normalizeStake(raw.stake ?? auditor.capital * 0.25, auditor.capital);
      return {
        auditorId: auditor.id,
        targetAgentId: targetGenerator.id,
        testInput: raw.testInput,
        expectedOutput: raw.expectedOutput,
        stake,
      };
    }

    const catalog = this.resolveCatalogEntry(problem);
    const targetIsBuggy = this.isBuggyGenerator(targetGenerator);
    const auditorIsReckless = this.isRecklessAuditor(auditor);
    const auditorIsPassive = this.isPassiveAuditor(auditor);

    // Case 1: Target is buggy and auditor is not passive -> Sharp audit catches flaw
    if (targetIsBuggy && !auditorIsPassive) {
      const def = catalog.flawChallenge;
      const calculatedStake = roundToPrecision(
        auditor.capital * (def.defaultStakePercent ?? 0.3),
        2
      );
      const stake = this.normalizeStake(calculatedStake, auditor.capital);
      return {
        auditorId: auditor.id,
        targetAgentId: targetGenerator.id,
        testInput: def.testInput,
        expectedOutput: def.expectedOutput,
        stake,
      };
    }

    // Case 2: Target is solid, but auditor is reckless -> lodges false positive challenge
    if (!targetIsBuggy && auditorIsReckless) {
      const def = catalog.falsePositiveChallenge;
      const calculatedStake = roundToPrecision(
        auditor.capital * (def.defaultStakePercent ?? 0.25),
        2
      );
      const stake = this.normalizeStake(calculatedStake, auditor.capital);
      return {
        auditorId: auditor.id,
        targetAgentId: targetGenerator.id,
        testInput: def.testInput,
        expectedOutput: def.expectedOutput,
        stake,
      };
    }

    // Case 3: Target is solid and auditor is prudent -> declines challenge (returns null)
    // Game-theoretic rationale: Avoiding false positive penalty (-1.5x) preserves capital.
    return null;
  }

  /**
   * Normalizes numeric stake within allowable bounds [MIN_STAKE, agentCapital].
   */
  private normalizeStake(rawStake: number, agentCapital: number): number {
    if (agentCapital < MIN_STAKE) {
      return MIN_STAKE;
    }
    const clamped = Math.max(MIN_STAKE, Math.min(rawStake, agentCapital));
    return roundToPrecision(clamped, 2);
  }
}
