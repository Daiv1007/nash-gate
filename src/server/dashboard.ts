/**
 * NashGate Real-Time Web Visualizer Server
 * Zero-framework HTTP server utilizing Node.js native http module and Server-Sent Events (SSE).
 * Streams game loop hooks, proposals, challenges, oracle verdicts, and Nash settlements live.
 * Grounded in Game Theory and Mechanism Design.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, validateAgentRoster, type Agent } from '../core/index.ts';
import {
  MockAdapter,
  OpenAICompatibleAdapter,
  createAgentAdapter,
  resolveDefaultModel,
  normalizeModelName,
  isLiveMode,
  registerMockProblem,
  type AgentAdapter,
  type ProblemContext,
} from '../adapters/index.ts';
import {
  runTournament,
  type TournamentResult,
  type RoundResult,
} from '../engine/index.ts';

// ---------------------------------------------------------------------------
// Path & Configuration
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HTML_FILE_PATH = path.join(PUBLIC_DIR, 'index.html');

export const DEFAULT_PORT = Number(process.env.PORT) || 3000;
export const DEFAULT_HOST = process.env.HOST || 'localhost';
export const DEFAULT_PACE_DELAY_MS = 600;

// ---------------------------------------------------------------------------
// Tournament Problems Catalog
// ---------------------------------------------------------------------------

export const tournamentProblems: ProblemContext[] = [
  {
    id: 'is-palindrome',
    round: 1,
    title: 'Palindrome Normalization',
    task: 'Implement isPalindrome(s: string): boolean that checks if a string reads identically forwards and backwards.',
    description: 'Evaluates palindrome symmetry ignoring letter case, whitespace, and punctuation.',
    entrypoint: 'isPalindrome',
  },
  {
    id: 'clamp-number',
    round: 2,
    title: 'Boundary Value Clamping',
    task: 'Implement clamp(val: number, min: number, max: number): number that constrains val within boundary parameters min and max.',
    description: 'Returns val clamped to the interval bounded by min and max.',
    entrypoint: 'clamp',
  },
  {
    id: 'sum-array',
    round: 3,
    title: 'Cumulative Array Summation',
    task: 'Implement sumArray(numbers: number[]): number that calculates the sum of all elements in the array.',
    description: 'Computes cumulative sum of elements, returning 0 for empty array.',
    entrypoint: 'sumArray',
  },
  {
    id: 'is-valid-parentheses',
    round: 4,
    title: 'Balanced Bracket Sequences',
    task: 'Implement isValidParentheses(s: string): boolean that validates correctly matching (), {}, and [].',
    description: 'Validates symmetric nesting and bracket closures.',
    entrypoint: 'isValidParentheses',
  },
  {
    id: 'two-sum',
    round: 5,
    title: 'Target Two-Sum Indices',
    task: 'Implement twoSum(nums: number[], target: number): [number, number] | null returning 0-based indices adding up to target.',
    description: 'Must return two distinct indices, without reusing the same element twice.',
    entrypoint: 'twoSum',
  },
  {
    id: 'flatten-array',
    round: 6,
    title: 'Deep Array Flattening',
    task: 'Implement flattenArray(arr: any[]): any[] that deeply flattens nested array structures into a 1D array.',
    description: 'Returns a 1-dimensional array containing all elements regardless of nesting depth.',
    entrypoint: 'flattenArray',
  },
  {
    id: 'fibonacci',
    round: 7,
    title: '0-Indexed Fibonacci Sequence',
    task: 'Implement fibonacci(n: number): number that calculates the nth Fibonacci number with fib(0) = 0 and fib(1) = 1.',
    description: 'Standard 0-indexed Fibonacci sequence starting with 0 and 1.',
    entrypoint: 'fibonacci',
  },
  {
    id: 'anagram-check',
    round: 8,
    title: 'Normalized Anagram Verification',
    task: 'Implement isAnagram(s1: string, s2: string): boolean that checks if s1 and s2 are anagrams.',
    description: 'Returns true if both strings contain identical character frequencies (ignoring case and whitespace).',
    entrypoint: 'isAnagram',
  },
  {
    id: 'chunk-array',
    round: 9,
    title: 'Array Chunking Slicer',
    task: 'Implement chunkArray(arr: any[], size: number): any[][] that splits an array into chunks of the given size.',
    description: 'Preserves remainder elements if length is not evenly divisible.',
    entrypoint: 'chunkArray',
  },
  {
    id: 'find-duplicates',
    round: 10,
    title: 'Unique Duplicate Detector',
    task: 'Implement findDuplicates(numbers: number[]): number[] returning sorted unique duplicate values from an array.',
    description: 'Returns each duplicate value at most once in ascending sorted order.',
    entrypoint: 'findDuplicates',
  },
];

/**
 * Validates problem definition payload.
 */
export function validateProblemPayload(payload: any): {
  valid: boolean;
  errors: string[];
  data?: ProblemContext;
} {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Problem payload must be a non-null object.'] };
  }

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id || !/^[a-z0-9_-]{2,64}$/i.test(id)) {
    errors.push('Problem "id" is required and must be alphanumeric with hyphens/underscores (2-64 chars).');
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!title) {
    errors.push('Problem "title" is required and must be a non-empty string.');
  }

  const task = typeof payload.task === 'string' ? payload.task.trim() : '';
  if (!task) {
    errors.push('Problem "task" is required and must be a non-empty string.');
  }

  let entrypoint = typeof payload.entrypoint === 'string' ? payload.entrypoint.trim() : '';
  if (!entrypoint) {
    // Derive entrypoint from id (e.g. is-valid-parentheses -> isValidParentheses)
    entrypoint = id.replace(/-([a-z0-9])/g, (_: string, g: string) => g.toUpperCase());
  } else if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(entrypoint)) {
    errors.push('Problem "entrypoint" must be a valid JavaScript identifier.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      id,
      title,
      task,
      description: typeof payload.description === 'string' ? payload.description.trim() : undefined,
      entrypoint,
      round: typeof payload.round === 'number' && payload.round > 0 ? payload.round : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined,
    },
  };
}

/**
 * Generates structured JSON arbitration report from TournamentResult.
 */
export function generateReportJson(result: TournamentResult): object {
  const roiTable = result.leaderboard.map((agent, index) => {
    const initial = result.initialAgents.find((a) => a.id === agent.id)?.capital ?? 100;
    const finalCap = agent.capital;
    const profit = finalCap - initial;
    const roi = initial > 0 ? (profit / initial) * 100 : 0;
    return {
      rank: index + 1,
      agentId: agent.id,
      role: agent.role,
      model: agent.model,
      status: agent.status,
      initialCapital: initial,
      finalCapital: finalCap,
      netProfit: Number(profit.toFixed(2)),
      roiPercent: Number(roi.toFixed(2)),
    };
  });

  const roundsSummary = result.rounds.map((round) => {
    return {
      roundNumber: round.roundNumber,
      problem: {
        id: round.problem.id,
        title: round.problem.title,
        task: round.problem.task,
        entrypoint: round.problem.entrypoint,
      },
      proposals: round.proposals.map((p) => ({
        agentId: p.agentId,
        stake: p.stake,
        solutionSnippet: p.solution ? p.solution.slice(0, 100) + '...' : '',
        reasoning: p.reasoning,
      })),
      challenges: round.challenges.map((c) => ({
        auditorId: c.auditorId,
        targetAgentId: c.targetAgentId,
        testInput: c.testInput,
        expectedOutput: c.expectedOutput,
        stake: c.stake,
      })),
      oracleEvaluations: round.evaluations.map((e) => ({
        auditorId: e.challenge?.auditorId || (e as any).auditorId || 'Unknown',
        targetGeneratorId: e.challenge?.targetAgentId || (e as any).targetProposal?.agentId || 'Unknown',
        verdict: e.verdict,
        generatorPassed: e.generatorPassed,
        executionTimeMs: e.executionTimeMs,
        actualOutput: e.actualOutput,
        error: e.error,
      })),
      settlements: {
        pairSettlements: round.settlement.pairSettlements,
        unchallengedSettlements: round.settlement.unchallengedSettlements,
        balanceUpdates: round.settlement.balanceUpdates,
      },
    };
  });

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      engine: 'NashGate Autonomous Consensus Engine',
      completed: result.completed,
      terminationReason: result.terminationReason,
      totalRoundsPlayed: result.totalRoundsPlayed,
    },
    leaderboard: roiTable,
    bankruptAgents: result.bankruptAgents.map((a) => a.id),
    rounds: roundsSummary,
  };
}

/**
 * Generates formatted Markdown arbitration report from TournamentResult.
 */
export function generateReportMarkdown(result: TournamentResult): string {
  const timestamp = new Date().toISOString();
  let md = `# NashGate Arbitration & Consensus Report\n\n`;
  md += `**Generated:** ${timestamp}\n`;
  md += `**Status:** ${result.completed ? 'Completed' : 'Terminated'} (${result.terminationReason})\n`;
  md += `**Total Rounds Played:** ${result.totalRoundsPlayed}\n\n`;

  md += `## 1. Final Leaderboard & ROI Analysis\n\n`;
  md += `| Rank | Agent ID | Role | Model | Status | Initial ($) | Final ($) | Net Profit ($) | ROI (%) |\n`;
  md += `|:----:|:---------|:----:|:------|:------:|:-----------:|:---------:|:--------------:|:-------:|\n`;

  result.leaderboard.forEach((agent, idx) => {
    const initial = result.initialAgents.find((a) => a.id === agent.id)?.capital ?? 100;
    const finalCap = agent.capital;
    const profit = finalCap - initial;
    const roi = initial > 0 ? (profit / initial) * 100 : 0;
    const profitSign = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
    const roiSign = roi >= 0 ? `+${roi.toFixed(1)}%` : `${roi.toFixed(1)}%`;
    md += `| ${idx + 1} | ${agent.id} | ${agent.role} | ${agent.model} | ${agent.status} | $${initial.toFixed(2)} | $${finalCap.toFixed(2)} | ${profitSign} | ${roiSign} |\n`;
  });

  if (result.bankruptAgents.length > 0) {
    md += `\n**Insolvent Agents:** ${result.bankruptAgents.map((a) => a.id).join(', ')}\n`;
  }

  md += `\n## 2. Round-by-Round Arbitration Audit\n\n`;
  result.rounds.forEach((round) => {
    md += `### Round ${round.roundNumber}: ${round.problem.title} (\`${round.problem.id}\`)\n\n`;
    md += `**Task:** ${round.problem.task}\n\n`;

    md += `#### Oracle Verifications & Auditor Challenges\n\n`;
    if (round.evaluations.length === 0) {
      md += `*No challenges submitted in this round.*\n\n`;
    } else {
      md += `| Auditor | Target | Verdict | Generator Passed | Exec Time | Details |\n`;
      md += `|:--------|:-------|:-------:|:----------------:|:---------:|:--------|\n`;
      round.evaluations.forEach((evalItem) => {
        const passText = evalItem.generatorPassed ? '✅ YES' : '❌ NO';
        const errText = evalItem.error
          ? `Error: ${evalItem.error}`
          : `Output: ${JSON.stringify(evalItem.actualOutput)}`;
        const audId = evalItem.challenge?.auditorId || (evalItem as any).auditorId || 'Unknown';
        const genId = evalItem.challenge?.targetAgentId || (evalItem as any).targetProposal?.agentId || 'Unknown';
        md += `| ${audId} | ${genId} | \`${evalItem.verdict}\` | ${passText} | ${evalItem.executionTimeMs?.toFixed(1) ?? 'N/A'}ms | ${errText} |\n`;
      });
      md += `\n`;
    }

    md += `#### Settlement & Balance Transfers\n\n`;
    if (round.settlement.pairSettlements.length > 0) {
      md += `**Pairwise Stake Allocations:**\n`;
      round.settlement.pairSettlements.forEach((ps) => {
        const gSign =
          ps.generatorDelta >= 0
            ? `+$${ps.generatorDelta.toFixed(2)}`
            : `-$${Math.abs(ps.generatorDelta).toFixed(2)}`;
        const aSign =
          ps.auditorDelta >= 0
            ? `+$${ps.auditorDelta.toFixed(2)}`
            : `-$${Math.abs(ps.auditorDelta).toFixed(2)}`;
        md += `- **${ps.generatorId}** (${gSign}) vs **${ps.auditorId}** (${aSign}): ${ps.rationale}\n`;
      });
      md += `\n`;
    }

    if (round.settlement.unchallengedSettlements.length > 0) {
      md += `**Unchallenged Protocol Dividends:**\n`;
      round.settlement.unchallengedSettlements.forEach((us) => {
        md += `- **${us.agentId}**: +$${us.delta.toFixed(2)} (${us.rationale})\n`;
      });
      md += `\n`;
    }
  });

  md += `---\n*Report compiled by NashGate Consensus Protocol Engine.*\n`;
  return md;
}

/**
 * Creates fresh initial roster of 4 agents with 100 capital each.
 * When isLive is true, dynamically applies custom model or resolves the model name across all agents.
 */
export function createInitialAgents(
  isLive: boolean = isLiveMode(),
  defaultModel?: string,
  agentModels?: Record<string, string>
): Agent[] {
  const fallbackModel = isLive ? normalizeModelName(defaultModel || resolveDefaultModel()) : null;
  return [
    createAgent({
      id: 'AlphaGen',
      role: 'GENERATOR',
      model: agentModels?.['AlphaGen'] ? normalizeModelName(agentModels['AlphaGen']) : (fallbackModel || 'deterministic-solid'),
      capital: 100,
    }),
    createAgent({
      id: 'BuggyGen',
      role: 'GENERATOR',
      model: agentModels?.['BuggyGen'] ? normalizeModelName(agentModels['BuggyGen']) : (fallbackModel || 'heuristic-naive'),
      capital: 100,
    }),
    createAgent({
      id: 'SharpAuditor',
      role: 'AUDITOR',
      model: agentModels?.['SharpAuditor'] ? normalizeModelName(agentModels['SharpAuditor']) : (fallbackModel || 'adversarial-verifier'),
      capital: 100,
    }),
    createAgent({
      id: 'RecklessAuditor',
      role: 'AUDITOR',
      model: agentModels?.['RecklessAuditor'] ? normalizeModelName(agentModels['RecklessAuditor']) : (fallbackModel || 'speculative-challenger'),
      capital: 100,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) Manager & Tournament Orchestration State
// ---------------------------------------------------------------------------

export interface DashboardServerOptions {
  readonly paceMs?: number;
}

export interface StartTournamentOptions {
  readonly model?: string;
  readonly agentModels?: Record<string, string>;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly providerKeys?: {
    readonly gemini?: string;
    readonly openai?: string;
    readonly [provider: string]: string | undefined;
  };
  readonly agentApiKeys?: Record<string, string>;
  readonly agentBaseUrls?: Record<string, string>;
  readonly agents?: readonly (Agent | {
    id: string;
    role: 'GENERATOR' | 'AUDITOR';
    model: string;
    capital?: number;
    apiKey?: string;
    baseUrl?: string;
  })[];
  readonly rounds?: number;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private isTournamentRunning = false;
  private currentAgents: Agent[] = createInitialAgents(isLiveMode());
  private problems: ProblemContext[] = [...tournamentProblems];
  private lastTournamentResult: TournamentResult | null = null;
  private currentRoundNumber = 0;
  private readonly paceMs: number;
  private eventHistory: Array<{ event: string; data: unknown }> = [];
  private currentAbortController: AbortController | null = null;

  constructor(options?: DashboardServerOptions) {
    this.paceMs = options?.paceMs ?? DEFAULT_PACE_DELAY_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns current agents with sensitive API keys masked for client security.
   */
  public getSanitizedAgents(): (Agent & { hasDedicatedKey?: boolean })[] {
    return this.currentAgents.map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      capital: a.capital,
      status: a.status,
      hasDedicatedKey: Boolean(a.apiKey && a.apiKey.trim().length > 0),
      ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
      ...(a.apiKey ? { apiKey: '••••••••' } : {}),
    }));
  }

  /**
   * Adds or updates an agent in the configured roster.
   */
  public upsertAgent(params: {
    id: string;
    role: 'GENERATOR' | 'AUDITOR';
    model: string;
    capital?: number;
    apiKey?: string;
    baseUrl?: string;
  }): { ok: boolean; agent?: Agent; error?: string } {
    if (this.isTournamentRunning) {
      return { ok: false, error: 'Cannot modify agents while tournament is running.' };
    }
    try {
      const newAgent = createAgent({
        id: params.id,
        role: params.role,
        model: params.model,
        capital: params.capital ?? 100,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });

      const existingIndex = this.currentAgents.findIndex((a) => a.id === newAgent.id);
      let updatedList: Agent[];
      if (existingIndex >= 0) {
        updatedList = [...this.currentAgents];
        updatedList[existingIndex] = newAgent;
      } else {
        updatedList = [...this.currentAgents, newAgent];
      }

      const rosterValidation = validateAgentRoster(updatedList);
      if (!rosterValidation.valid) {
        return { ok: false, error: rosterValidation.errors.join('; ') };
      }

      this.currentAgents = updatedList;
      this.broadcast('agents:updated', { agents: this.getSanitizedAgents() });
      return { ok: true, agent: newAgent };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Deletes an agent from the roster by ID.
   */
  public deleteAgent(agentId: string): { ok: boolean; error?: string } {
    if (this.isTournamentRunning) {
      return { ok: false, error: 'Cannot delete agents while tournament is running.' };
    }
    const filtered = this.currentAgents.filter((a) => a.id !== agentId);
    if (filtered.length === this.currentAgents.length) {
      return { ok: false, error: `Agent '${agentId}' not found.` };
    }
    const rosterValidation = validateAgentRoster(filtered);
    if (!rosterValidation.valid) {
      return { ok: false, error: rosterValidation.errors.join('; ') };
    }
    this.currentAgents = filtered;
    this.broadcast('agents:updated', { agents: this.getSanitizedAgents() });
    return { ok: true };
  }

  /**
   * Resets agents back to standard initial 4-agent roster.
   */
  public resetAgents(defaultModel?: string): Agent[] {
    if (this.isTournamentRunning) {
      this.abortTournament();
    }
    this.currentAgents = createInitialAgents(isLiveMode(), defaultModel);
    this.broadcast('agents:updated', { agents: this.getSanitizedAgents() });
    return this.currentAgents;
  }

  /**
   * Broadcasts an SSE message to all connected browsers and buffers it for reconnections.
   */
  public broadcast(event: string, data: unknown): void {
    this.eventHistory.push({ event, data });
    if (this.eventHistory.length > 200) {
      this.eventHistory.shift();
    }

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  /**
   * Aborts an active tournament immediately and resets dashboard state to STANDBY.
   */
  public abortTournament(): { stopped: boolean } {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.isTournamentRunning = false;
    this.currentRoundNumber = 0;
    this.eventHistory = [];
    this.currentAgents = createInitialAgents(isLiveMode());
    this.lastTournamentResult = null;
    this.broadcast('tournament:reset', {
      message: 'Tournament was reset by user request.',
      agents: this.getSanitizedAgents(),
    });
    this.broadcast('tournament:state', { isRunning: false });
    return { stopped: true };
  }

  /**
   * Returns copy of active problems catalog.
   */
  public getProblems(): ProblemContext[] {
    return [...this.problems];
  }

  /**
   * Adds a custom problem to the active tournament catalog.
   */
  public addProblem(
    payload: any,
    mockDef?: any
  ): { ok: boolean; problem?: ProblemContext; error?: string } {
    if (this.isTournamentRunning) {
      return { ok: false, error: 'Cannot add problems while tournament is running.' };
    }
    const validation = validateProblemPayload(payload);
    if (!validation.valid || !validation.data) {
      return { ok: false, error: validation.errors.join('; ') };
    }
    const newProblem: ProblemContext = {
      ...validation.data,
      round: validation.data.round ?? this.problems.length + 1,
    };
    if (this.problems.some((p) => p.id.toLowerCase() === newProblem.id.toLowerCase())) {
      return { ok: false, error: `Problem with id '${newProblem.id}' already exists.` };
    }
    this.problems.push(newProblem);
    if (mockDef) {
      registerMockProblem(newProblem.id, mockDef);
    }
    this.broadcast('problem:added', {
      problem: newProblem,
      totalProblems: this.problems.length,
    });
    return { ok: true, problem: newProblem };
  }

  /**
   * Returns snapshot of current state for new connections.
   */
  public getStateSnapshot() {
    const isLive = isLiveMode();
    return {
      isRunning: this.isTournamentRunning,
      agents: this.getSanitizedAgents(),
      currentRound: this.currentRoundNumber,
      totalProblems: this.problems.length,
      problems: this.problems,
      adapterMode: isLive ? 'live-llm' : 'offline-mock',
      resolvedModel: isLive ? resolveDefaultModel() : undefined,
      lastResult: this.lastTournamentResult,
      connectedClients: this.sseClients.size,
    };
  }

  /**
   * Triggers and executes a full multi-round tournament, streaming every hook step.
   * Supports custom agent rosters, per-agent API keys, per-agent base URLs, and custom models.
   */
  public async startTournament(options?: StartTournamentOptions): Promise<{ started: boolean; reason?: string }> {
    if (this.isTournamentRunning) {
      return { started: false, reason: 'Tournament is already in progress' };
    }

    this.isTournamentRunning = true;
    this.currentRoundNumber = 0;
    this.eventHistory = [];
    this.currentAbortController = new AbortController();

    const selectedProblems = options?.rounds && options.rounds > 0
      ? this.problems.slice(0, Math.min(options.rounds, this.problems.length))
      : this.problems;

    // Resolve models, keys, and base URLs
    const uiApiKey = options?.apiKey?.trim() || undefined;
    const uiBaseUrl = options?.baseUrl?.trim() || (options?.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : undefined);
    const liveModel = options?.model?.trim() ? normalizeModelName(options.model) : resolveDefaultModel();
    const isOllamaModel = Boolean(
      liveModel && (
        liveModel.includes(':') ||
        liveModel.toLowerCase().includes('qwen') ||
        liveModel.toLowerCase().includes('llama') ||
        liveModel.toLowerCase().includes('mistral') ||
        liveModel.toLowerCase().includes('phi') ||
        liveModel.toLowerCase().includes('deepseek')
      )
    );
    const globalBaseUrl = uiBaseUrl || (isOllamaModel ? 'http://127.0.0.1:11434/v1' : undefined);
    const isLive = isLiveMode() || Boolean(uiApiKey) || Boolean(globalBaseUrl) || isOllamaModel;
    const sanitizedAgentModels: Record<string, string> | undefined = options?.agentModels
      ? Object.fromEntries(
        Object.entries(options.agentModels).map(([k, v]) => [k, normalizeModelName(v)])
      )
      : undefined;

    // Use custom roster if provided, otherwise initialize standard roster
    if (options?.agents && options.agents.length > 0) {
      try {
        const configured = options.agents.map((a) => {
          const m = a.model ? normalizeModelName(a.model) : (sanitizedAgentModels?.[a.id] || liveModel);
          const lower = (m || '').toLowerCase();
          const isCloud = lower.includes('gemini') || lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3');
          const rawUrl = a.baseUrl || options?.agentBaseUrls?.[a.id] || globalBaseUrl;
          const url = (isCloud && rawUrl && rawUrl.includes('11434')) ? undefined : rawUrl;

          return createAgent({
            id: a.id,
            role: a.role,
            model: m,
            capital: a.capital ?? 100,
            apiKey: a.apiKey || options?.agentApiKeys?.[a.id],
            baseUrl: url,
          });
        });
        const rosterValidation = validateAgentRoster(configured);
        if (!rosterValidation.valid) {
          this.isTournamentRunning = false;
          return { started: false, reason: rosterValidation.errors.join('; ') };
        }
        this.currentAgents = configured;
      } catch (err: any) {
        this.isTournamentRunning = false;
        return { started: false, reason: `Invalid agent configuration: ${err?.message || String(err)}` };
      }
    } else {
      this.currentAgents = createInitialAgents(isLive, liveModel, sanitizedAgentModels);
    }

    // Dynamic per-agent adapter resolver supporting independent API keys, base URLs, and models
    const adapterResolver = (agent: Agent): AgentAdapter => {
      const model = agent.model || sanitizedAgentModels?.[agent.id] || liveModel;
      const lower = (model || '').toLowerCase();
      const isCloud = lower.includes('gemini') || lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3');

      const rawUrl = agent.baseUrl || options?.agentBaseUrls?.[agent.id] || globalBaseUrl;
      const url = (isCloud && rawUrl && rawUrl.includes('11434')) ? undefined : rawUrl;
      const key = agent.apiKey || options?.agentApiKeys?.[agent.id] || uiApiKey;

      return createAgentAdapter(
        { ...agent, apiKey: key, baseUrl: url, model },
        {
          globalApiKey: uiApiKey,
          globalBaseUrl: isCloud ? undefined : globalBaseUrl,
          globalModel: liveModel,
          providerKeys: options?.providerKeys,
          onRetry: (info) => {
            this.broadcast('agent:retry', info);
          },
        }
      );
    };

    // Broadcast tournament kickoff
    this.broadcast('tournament:start', {
      initialAgents: this.getSanitizedAgents(),
      totalRounds: selectedProblems.length,
      adapterMode: isLive ? 'live-llm' : 'offline-mock',
      resolvedModel: isLive ? liveModel : undefined,
    });

    // Execute asynchronously with pacing delay so human viewers can follow live
    (async () => {
      try {
        await this.sleep(this.paceMs);

        const result = await runTournament({
          agents: this.currentAgents,
          problems: selectedProblems,
          adapter: adapterResolver,
          abortSignal: this.currentAbortController?.signal,
          hooks: {
            onRoundStart: async (round, problem, activeAgents) => {
              this.currentRoundNumber = round;
              this.broadcast('round:start', {
                roundNumber: round,
                problem,
                activeAgents,
              });
              await this.sleep(this.paceMs);
            },

            onAgentActionStart: async (agent, phase, targetGenerator) => {
              this.broadcast('agent:action:start', {
                agent,
                phase,
                targetGenerator,
                roundNumber: this.currentRoundNumber,
              });
            },

            onProposalSubmitted: async (proposal, agent) => {
              this.broadcast('proposal:submitted', { proposal, agent });
              await this.sleep(this.paceMs);
            },

            onProposalRejected: async (agent, errors) => {
              this.broadcast('proposal:rejected', { agent, errors });
              await this.sleep(this.paceMs);
            },

            onChallengeSubmitted: async (challenge, auditor, targetGenerator) => {
              this.broadcast('challenge:submitted', {
                challenge,
                auditor,
                targetGenerator,
              });
              await this.sleep(this.paceMs);
            },

            onChallengeDeclined: async (auditor, targetGenerator) => {
              this.broadcast('challenge:declined', {
                auditor,
                targetGenerator,
              });
              await this.sleep(this.paceMs);
            },

            onChallengeRejected: async (auditor, errors) => {
              this.broadcast('challenge:rejected', { auditor, errors });
              await this.sleep(this.paceMs);
            },

            onEvaluationCompleted: async (evaluation) => {
              this.broadcast('evaluation:completed', { evaluation });
              await this.sleep(this.paceMs);
            },

            onSettlementCompleted: async (roundNumber, settlement) => {
              // Update local state registry
              this.currentAgents = [...settlement.updatedAgents];
              const settlementPayload = {
                roundNumber,
                settlement,
                updatedAgents: this.getSanitizedAgents(),
              };
              this.broadcast('settlement:completed', settlementPayload);
              this.broadcast('round:settlement', settlementPayload);
              await this.sleep(this.paceMs);
            },

            onBankruptcy: async (agent, roundNumber) => {
              this.broadcast('agent:bankruptcy', { agent, roundNumber });
              await this.sleep(this.paceMs);
            },

            onRoundEnd: async (roundResult: RoundResult) => {
              this.broadcast('round:end', { roundResult });
              await this.sleep(this.paceMs);
            },

            onTournamentEnd: async (tournamentResult: TournamentResult) => {
              this.lastTournamentResult = tournamentResult;
              this.currentAgents = [...tournamentResult.finalAgents];
              this.broadcast('tournament:end', { tournamentResult });
              await this.sleep(this.paceMs);
            },

            onError: async (error, context) => {
              this.broadcast('engine:error', {
                error: error.message || String(error),
                phase: context.phase,
                agent: context.agent,
                targetGenerator: context.targetGenerator,
                roundNumber: context.roundNumber,
              });
              await this.sleep(this.paceMs);
            },
          },
        });

        this.lastTournamentResult = result;
      } catch (err: any) {
        this.broadcast('tournament:error', {
          message: err?.message || 'Tournament execution error',
        });
      } finally {
        this.currentAbortController = null;
        this.isTournamentRunning = false;
        this.broadcast('tournament:state', { isRunning: false });
      }
    })();

    return { started: true };
  }

  /**
   * Request handler for native Node.js HTTP server.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? '/';

    // Security: Reject any path traversal attempts across all server routes
    if (rawUrl.includes('..') || rawUrl.includes('%2e%2e') || rawUrl.includes('%2E%2E')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied: Path traversal detected' }));
      return;
    }

    const parsedUrl = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase() ?? 'GET';

    // CORS Headers for flexible access
    if (typeof res.setHeader === 'function') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Single Page Dashboard App (HTML)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      fs.readFile(HTML_FILE_PATH, 'utf-8', (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`[NashGate Error] Failed to load dashboard: ${err.message}`);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      });
      return;
    }

    // 1b. Static Assets (e.g. /assets/logo_nash-gate.png, /assets/nash-gate-demo.gif)
    if (method === 'GET' && pathname.startsWith('/assets/')) {
      const assetsDir = path.resolve(__dirname, '../../assets');
      const assetRelative = pathname.replace(/^\/assets\//, '');
      const assetPath = path.resolve(assetsDir, assetRelative);

      // Security: Path traversal defense - ensure requested path stays inside assetsDir
      if (!assetPath.startsWith(assetsDir + path.sep) && assetPath !== assetsDir) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied: Path traversal detected' }));
        return;
      }

      const ext = path.extname(assetPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      fs.readFile(assetPath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Asset not found', asset: assetRelative }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(data);
      });
      return;
    }

    // 2. Real-time Server-Sent Events (SSE) Stream
    if (method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.write(': keepalive\n\n');

      // Send initial snapshot on connection
      res.write(`event: state:init\ndata: ${JSON.stringify(this.getStateSnapshot())}\n\n`);

      // Replay all buffered events from current tournament so newly connected or refreshed tabs get full feed
      for (const item of this.eventHistory) {
        res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
      }

      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      res.on('error', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 3. API: Agents Roster CRUD
    if (method === 'GET' && pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: this.getSanitizedAgents() }));
      return;
    }

    // 3b. API: Model Discovery Proxy (bypasses browser CORS restrictions for Ollama/OpenAI/Gemini)
    if (method === 'POST' && pathname === '/api/models/discover') {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyText || '{}');
          const targetUrl = payload.url;
          if (!targetUrl || typeof targetUrl !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing target url parameter' }));
            return;
          }

          // Security: Validate protocol and enforce permitted hosts whitelist (SSRF prevention)
          let parsedTarget: URL;
          try {
            parsedTarget = new URL(targetUrl);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Malformed target URL' }));
            return;
          }

          if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid URL protocol: must be http or https' }));
            return;
          }

          const host = parsedTarget.hostname.toLowerCase();
          const isLocalOllama = host === 'localhost' || host === '127.0.0.1' || host === '::1';
          const isAllowedCloud =
            host.endsWith('googleapis.com') ||
            host.endsWith('openai.com') ||
            host.endsWith('groq.com') ||
            host.endsWith('anthropic.com');

          if (!isLocalOllama && !isAllowedCloud) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Host '${host}' is not permitted by model discovery proxy` }));
            return;
          }

          const fetchHeaders: Record<string, string> = payload.headers || {};
          let response: Response;
          try {
            response = await fetch(targetUrl, {
              method: 'GET',
              headers: fetchHeaders,
            });
          } catch (initialErr: any) {
            // Windows IPv6 vs IPv4 fallback for Ollama/localhost
            let altUrl: string | null = null;
            if (targetUrl.includes('localhost:11434')) {
              altUrl = targetUrl.replace('localhost:11434', '127.0.0.1:11434');
            } else if (targetUrl.includes('127.0.0.1:11434')) {
              altUrl = targetUrl.replace('127.0.0.1:11434', 'localhost:11434');
            }
            if (altUrl) {
              response = await fetch(altUrl, {
                method: 'GET',
                headers: fetchHeaders,
              });
            } else {
              throw initialErr;
            }
          }
          const data = await response.json();
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (err: any) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err?.message || 'Model discovery proxy failed' }));
        }
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/agents') {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(bodyText);
          const result = this.upsertAgent(payload);
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.error }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agent: result.agent, agents: this.getSanitizedAgents() }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Malformed JSON payload' }));
        }
      });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/agents/')) {
      const agentId = decodeURIComponent(pathname.substring('/api/agents/'.length));
      const result = this.deleteAgent(agentId);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: result.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: this.getSanitizedAgents() }));
      return;
    }

    if (method === 'POST' && pathname === '/api/agents/reset') {
      this.resetAgents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Agents reset to default roster', agents: this.getSanitizedAgents() }));
      return;
    }

    // 4. API: Reset / Abort Active Tournament
    if (method === 'POST' && (pathname === '/api/reset' || pathname === '/api/stop' || pathname === '/api/tournament/reset')) {
      this.abortTournament();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: 'Tournament aborted and reset to standby',
        agents: this.getSanitizedAgents(),
      }));
      return;
    }

    // 5. API: Start Tournament (accepts optional JSON payload with custom agents, models, keys)
    if (method === 'POST' && (pathname === '/api/start' || pathname === '/api/tournament/start')) {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', () => {
        let payload: StartTournamentOptions = {};
        if (bodyText.trim()) {
          try {
            payload = JSON.parse(bodyText);
          } catch { }
        }
        this.startTournament(payload).then((result) => {
          if (!result.started) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.reason }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Tournament started successfully', model: payload.model }));
        });
      });
      return;
    }

    // 4. API: Status Snapshot
    if (method === 'GET' && pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStateSnapshot()));
      return;
    }

    // 5. API: Problems Catalog (GET & POST)
    if (method === 'GET' && pathname === '/api/problems') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, problems: this.problems, total: this.problems.length }));
      return;
    }

    if (method === 'POST' && pathname === '/api/problems') {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(bodyText);
          const result = this.addProblem(payload, payload.mock);
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.error }));
            return;
          }
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              problem: result.problem,
              totalProblems: this.problems.length,
            })
          );
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Malformed JSON payload' }));
        }
      });
      return;
    }

    // 6. API: Arbitration Report Export (JSON & Markdown)
    if (
      method === 'GET' &&
      (pathname === '/api/report' ||
        pathname === '/api/report/json' ||
        pathname === '/api/report/markdown')
    ) {
      if (!this.lastTournamentResult) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'No completed tournament report available. Run a tournament first.',
          })
        );
        return;
      }

      const formatQuery = (parsedUrl.searchParams.get('format') || '').toLowerCase();
      const isMarkdown =
        formatQuery === 'markdown' ||
        formatQuery === 'md' ||
        pathname === '/api/report/markdown';

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      if (isMarkdown) {
        const md = generateReportMarkdown(this.lastTournamentResult);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="nashgate-arbitration-report-${timestamp}.md"`,
        });
        res.end(md);
        return;
      } else {
        const jsonReport = generateReportJson(this.lastTournamentResult);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="nashgate-arbitration-report-${timestamp}.json"`,
        });
        res.end(JSON.stringify(jsonReport, null, 2));
        return;
      }
    }

    // 7. 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint Not Found', pathname }));
  }

  /**
   * Starts listening on the specified port and host.
   */
  public listen(port: number = DEFAULT_PORT, host: string = DEFAULT_HOST): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(port, host, () => {
        const address = this.server?.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        resolve(actualPort);
      });
    });
  }

  /**
   * Gracefully shuts down the HTTP server and disconnects active SSE clients.
   */
  public close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.sseClients) {
        try {
          client.end();
        } catch { }
      }
      this.sseClients.clear();

      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Direct Execution Entrypoint
// ---------------------------------------------------------------------------

async function runDirect() {
  const server = new DashboardServer();
  const port = DEFAULT_PORT;
  const host = DEFAULT_HOST;

  const isLive = isLiveMode();
  const engineDesc = isLive
    ? `\x1b[32mLive OpenAI-Compatible API (${resolveDefaultModel()})\x1b[0m`
    : '\x1b[33mDeterministic Mock Catalog\x1b[0m';

  try {
    const actualPort = await server.listen(port, host);
    const url = `http://${host}:${actualPort}`;

    console.log(`
\x1b[36m╔═══════════════════════════════════════════════════════════════════════════════╗
║                               \x1b[1mNASHGATE UI\x1b[0m\x1b[36m                                     ║
║            \x1b[33mReal-Time Game-Theoretic Multi-Agent Visualizer\x1b[0m\x1b[36m                    ║
╚═══════════════════════════════════════════════════════════════════════════════╝\x1b[0m

  \x1b[32m⚡ Visualizer Dashboard:\x1b[0m \x1b[1m\x1b[4m${url}\x1b[0m
  \x1b[35m📡 SSE Event Stream:\x1b[0m     ${url}/events
  \x1b[34m🤖 Engine Mode:\x1b[0m          ${engineDesc}
  \x1b[90m⏱️  Pacing Step Delay:\x1b[0m    ${DEFAULT_PACE_DELAY_MS}ms per step

  \x1b[90mPress Ctrl+C to stop the dashboard server.\x1b[0m
`);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31m[Error] Port ${port} is already in use. Please specify another port via PORT=<number>.\x1b[0m`);
    } else {
      console.error(`\x1b[31m[Fatal Error] Failed to start NashGate dashboard server:\x1b[0m`, err);
    }
    process.exit(1);
  }
}

// Auto-run if executed as main file
if (process.argv[1] && (process.argv[1].endsWith('dashboard.ts') || process.argv[1].endsWith('dashboard.js'))) {
  runDirect();
}
