/**
 * NashGate Mock Agent Adapter
 * Deterministic, scripted adapter providing realistic solid vs. buggy code proposals
 * and adversarial edge-case challenges with zero API keys required.
 * Grounded in Game Theory and Mechanism Design.
 */

import type { Agent, Challenge, Proposal } from '../core/types.ts';
import { MIN_STAKE } from '../core/types.ts';
import { roundToPrecision } from '../core/bankruptcy.ts';
import {
  clampStake,
  calculateGeneratorStake,
  calculateAuditorStake,
} from '../core/index.ts';
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
      testInput: [50, 100, 0],
      expectedOutput: 50,
      defaultStakePercent: 0.4,
      reasoning: 'Inverted bounds (min=100 > max=0) where value 50 should clamp to 50; buggy naive branch returns min (100).',
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
  'is-valid-parentheses': {
    solid: {
      solution: `function isValidParentheses(s) {
  const stack = [];
  const map = { ')': '(', '}': '{', ']': '[' };
  for (const ch of String(s)) {
    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== map[ch]) return false;
    }
  }
  return stack.length === 0;
}`,
      defaultStakePercent: 0.35,
      reasoning: 'LIFO stack verification ensures proper nesting and closing order for brackets.',
    },
    buggy: {
      solution: `function isValidParentheses(s) {
  // Naive counter heuristic: fails on interleaved brackets like '([)]'
  let round = 0, curly = 0, square = 0;
  for (const ch of String(s)) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    if (round < 0 || curly < 0 || square < 0) return false;
  }
  return round === 0 && curly === 0 && square === 0;
}`,
      defaultStakePercent: 0.45,
      reasoning: 'Independent bracket counters verify overall balance without stack overhead.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: '([)]',
      expectedOutput: false,
      defaultStakePercent: 0.4,
      reasoning: 'Interleaved bracket sequences balance counters but violate proper nesting order.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: '{[()]}',
      expectedOutput: true,
      defaultStakePercent: 0.25,
      reasoning: 'Symmetric well-nested bracket structure; generator will pass cleanly.',
    },
  },
  'two-sum': {
    solid: {
      solution: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const comp = target - nums[i];
    if (seen.has(comp)) return [seen.get(comp), i];
    seen.set(nums[i], i);
  }
  return null;
}`,
      defaultStakePercent: 0.35,
      reasoning: 'Single-pass hash map complement matching with strict distinct index guarantee.',
    },
    buggy: {
      solution: `function twoSum(nums, target) {
  // Buggy: compares elements without checking i !== j, reusing the same element
  for (let i = 0; i < nums.length; i++) {
    for (let j = 0; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) return [i, j];
    }
  }
  return null;
}`,
      defaultStakePercent: 0.5,
      reasoning: 'Nested iteration over pairs to detect matching target sum.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: [[3, 2, 4], 6],
      expectedOutput: [1, 2],
      defaultStakePercent: 0.4,
      reasoning: 'Target 6 with element 3 at index 0 tricks buggy double-loop into returning [0, 0] instead of [1, 2].',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: [[2, 7, 11, 15], 9],
      expectedOutput: [0, 1],
      defaultStakePercent: 0.3,
      reasoning: 'Distinct elements at index 0 and 1; generator passes effortlessly.',
    },
  },
  'flatten-array': {
    solid: {
      solution: `function flattenArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.reduce((acc, item) => {
    return acc.concat(Array.isArray(item) ? flattenArray(item) : item);
  }, []);
}`,
      defaultStakePercent: 0.3,
      reasoning: 'Recursive reduction gracefully flattens arbitrarily nested array trees.',
    },
    buggy: {
      solution: `function flattenArray(arr) {
  // Naive shallow flatten: only unpacks 1 level deep
  if (!Array.isArray(arr)) return [];
  return [].concat(...arr);
}`,
      defaultStakePercent: 0.45,
      reasoning: 'Fast single-level spread concatenation heuristic.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: [1, [2, [3, [4]], 5]],
      expectedOutput: [1, 2, 3, 4, 5],
      defaultStakePercent: 0.4,
      reasoning: 'Deeply nested arrays are not flattened beyond depth 1 by shallow spread.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: [1, [2, 3], 4],
      expectedOutput: [1, 2, 3, 4],
      defaultStakePercent: 0.25,
      reasoning: 'Single-level nested array where shallow flatten happens to work.',
    },
  },
  'fibonacci': {
    solid: {
      solution: `function fibonacci(n) {
  const num = Math.floor(Number(n));
  if (num <= 0) return 0;
  if (num === 1) return 1;
  let prev = 0, curr = 1;
  for (let i = 2; i <= num; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return curr;
}`,
      defaultStakePercent: 0.3,
      reasoning: 'Iterative O(N) linear scan with proper 0-indexed base cases fib(0)=0, fib(1)=1.',
    },
    buggy: {
      solution: `function fibonacci(n) {
  // Buggy 1-indexed off-by-one: returns 1 for n=0
  if (n <= 1) return 1;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`,
      defaultStakePercent: 0.5,
      reasoning: 'Standard textbook recursive Fibonacci definition.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: 0,
      expectedOutput: 0,
      defaultStakePercent: 0.35,
      reasoning: 'fib(0) must equal 0, but buggy recursion returns 1.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: 6,
      expectedOutput: 8,
      defaultStakePercent: 0.3,
      reasoning: 'fib(6) evaluates to 8; generator passes.',
    },
  },
  'anagram-check': {
    solid: {
      solution: `function isAnagram(s1, s2) {
  const clean1 = String(s1).toLowerCase().replace(/[^a-z0-9]/g, '').split('').sort().join('');
  const clean2 = String(s2).toLowerCase().replace(/[^a-z0-9]/g, '').split('').sort().join('');
  return clean1 === clean2;
}`,
      defaultStakePercent: 0.3,
      reasoning: 'Normalization, sorting, and comparison handles spacing, casing, and punctuation.',
    },
    buggy: {
      solution: `function isAnagram(s1, s2) {
  // Buggy: only checks string length and simple character existence without frequency count
  if (s1.length !== s2.length) return false;
  return [...s1].every(ch => s2.includes(ch));
}`,
      defaultStakePercent: 0.4,
      reasoning: 'Fast character presence check assuming equal length implies anagram.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: ['Debit Card', 'Bad Credit'],
      expectedOutput: true,
      defaultStakePercent: 0.35,
      reasoning: 'Mixed-case and spaces evaluate to anagram under normalization, but buggy solution fails.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: ['silent', 'listen'],
      expectedOutput: true,
      defaultStakePercent: 0.25,
      reasoning: 'Valid lowercase single-word anagram; generator passes.',
    },
  },
  'chunk-array': {
    solid: {
      solution: `function chunkArray(arr, size) {
  if (!Array.isArray(arr) || size <= 0) return [];
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}`,
      defaultStakePercent: 0.3,
      reasoning: 'Sequential slicing cleanly handles uneven tail chunks and invalid size values.',
    },
    buggy: {
      solution: `function chunkArray(arr, size) {
  // Buggy: drops the remainder chunk when array length is not evenly divisible by size
  if (!Array.isArray(arr) || size <= 0) return [];
  const fullChunksCount = Math.floor(arr.length / size);
  const result = [];
  for (let i = 0; i < fullChunksCount; i++) {
    result.push(arr.slice(i * size, (i + 1) * size));
  }
  return result;
}`,
      defaultStakePercent: 0.45,
      reasoning: 'Symmetric chunk generation for exact divisor chunks.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: [[1, 2, 3, 4, 5], 2],
      expectedOutput: [[1, 2], [3, 4], [5]],
      defaultStakePercent: 0.35,
      reasoning: 'Odd-length array leaves a trailing chunk [5] that buggy chunker drops.',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: [[1, 2, 3, 4], 2],
      expectedOutput: [[1, 2], [3, 4]],
      defaultStakePercent: 0.25,
      reasoning: 'Evenly divisible array where buggy chunker produces matching output.',
    },
  },
  'find-duplicates': {
    solid: {
      solution: `function findDuplicates(numbers) {
  if (!Array.isArray(numbers)) return [];
  const seen = new Set();
  const duplicates = new Set();
  for (const num of numbers) {
    if (seen.has(num)) duplicates.add(num);
    else seen.add(num);
  }
  return Array.from(duplicates).sort((a, b) => a - b);
}`,
      defaultStakePercent: 0.35,
      reasoning: 'Dual Set filtering guarantees O(N) duplicate detection with sorted, deduplicated output.',
    },
    buggy: {
      solution: `function findDuplicates(numbers) {
  // Buggy: returns duplicates multiple times if repeated >= 3 times, and unsorted
  if (!Array.isArray(numbers)) return [];
  return numbers.filter((val, idx) => numbers.indexOf(val) !== idx);
}`,
      defaultStakePercent: 0.4,
      reasoning: 'Filter with indexOf check to capture repeated items.',
    },
    flawChallenge: {
      shouldChallenge: true,
      testInput: [4, 3, 2, 7, 8, 2, 3, 2],
      expectedOutput: [2, 3],
      defaultStakePercent: 0.35,
      reasoning: 'Repeated items (2 repeated three times) require unique sorted output [2, 3]; buggy returns [2, 3, 2].',
    },
    falsePositiveChallenge: {
      shouldChallenge: true,
      testInput: [1, 2, 3],
      expectedOutput: [],
      defaultStakePercent: 0.25,
      reasoning: 'Array with zero duplicates correctly yields empty array [].',
    },
  },
};

/**
 * Registers custom mock problem definitions into the active mock catalog.
 */
export function registerMockProblem(
  id: string,
  mockDef: {
    solid?: Partial<MockProposalDefinition>;
    buggy?: Partial<MockProposalDefinition>;
    flawChallenge?: Partial<MockChallengeDefinition>;
    falsePositiveChallenge?: Partial<MockChallengeDefinition>;
  }
): void {
  const normalizedId = id.toLowerCase().trim();
  const fallback = DEFAULT_MOCK_CATALOG['is-palindrome'];
  const existing = DEFAULT_MOCK_CATALOG[normalizedId] || fallback;

  DEFAULT_MOCK_CATALOG[normalizedId] = {
    solid: {
      solution: mockDef.solid?.solution ?? existing.solid.solution,
      defaultStakePercent: mockDef.solid?.defaultStakePercent ?? existing.solid.defaultStakePercent,
      reasoning: mockDef.solid?.reasoning ?? existing.solid.reasoning,
    },
    buggy: {
      solution: mockDef.buggy?.solution ?? existing.buggy.solution,
      defaultStakePercent: mockDef.buggy?.defaultStakePercent ?? existing.buggy.defaultStakePercent,
      reasoning: mockDef.buggy?.reasoning ?? existing.buggy.reasoning,
    },
    flawChallenge: {
      shouldChallenge: mockDef.flawChallenge?.shouldChallenge ?? true,
      testInput:
        mockDef.flawChallenge?.testInput !== undefined
          ? mockDef.flawChallenge.testInput
          : existing.flawChallenge.testInput,
      expectedOutput:
        mockDef.flawChallenge?.expectedOutput !== undefined
          ? mockDef.flawChallenge.expectedOutput
          : existing.flawChallenge.expectedOutput,
      defaultStakePercent:
        mockDef.flawChallenge?.defaultStakePercent ?? existing.flawChallenge.defaultStakePercent,
      reasoning: mockDef.flawChallenge?.reasoning ?? existing.flawChallenge.reasoning,
    },
    falsePositiveChallenge: {
      shouldChallenge: mockDef.falsePositiveChallenge?.shouldChallenge ?? true,
      testInput:
        mockDef.falsePositiveChallenge?.testInput !== undefined
          ? mockDef.falsePositiveChallenge.testInput
          : existing.falsePositiveChallenge.testInput,
      expectedOutput:
        mockDef.falsePositiveChallenge?.expectedOutput !== undefined
          ? mockDef.falsePositiveChallenge.expectedOutput
          : existing.falsePositiveChallenge.expectedOutput,
      defaultStakePercent:
        mockDef.falsePositiveChallenge?.defaultStakePercent ??
        existing.falsePositiveChallenge.defaultStakePercent,
      reasoning:
        mockDef.falsePositiveChallenge?.reasoning ?? existing.falsePositiveChallenge.reasoning,
    },
  };
}

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

    // Game-theoretic dynamic staking calculation:
    // If def.defaultStakePercent is defined, calculate baseline from it, clamped via clampStake.
    // Otherwise calculate dynamically using calculateGeneratorStake.
    let calculatedStake: number;
    if (def.defaultStakePercent !== undefined) {
      calculatedStake = roundToPrecision(agent.capital * def.defaultStakePercent, 2);
    } else {
      const decision = calculateGeneratorStake({
        capital: agent.capital,
        confidence: useBuggy ? 0.72 : 0.90,
        riskProfile: useBuggy ? 'aggressive' : 'balanced',
      });
      calculatedStake = decision.stake;
    }
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
      const calculatedStake = def.defaultStakePercent !== undefined
        ? roundToPrecision(auditor.capital * def.defaultStakePercent, 2)
        : calculateAuditorStake({
          capital: auditor.capital,
          targetStake: proposal.stake,
          confidence: 0.90,
          riskProfile: 'balanced',
        }).stake;
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
      const calculatedStake = def.defaultStakePercent !== undefined
        ? roundToPrecision(auditor.capital * def.defaultStakePercent, 2)
        : calculateAuditorStake({
          capital: auditor.capital,
          targetStake: proposal.stake,
          confidence: 0.75,
          riskProfile: 'aggressive',
        }).stake;
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
    return clampStake(rawStake, agentCapital);
  }
}
