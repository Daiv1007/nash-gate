/**
 * NashGate OpenAI-Compatible Agent Adapter
 * Connects to any OpenAI-compatible API endpoint (local Ollama, Gemini OpenAI endpoint, OpenAI)
 * using Node's native fetch with zero external SDK dependencies.
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
 * Robustly parses and extracts a JSON object from raw model output.
 * Handles bare JSON, markdown-fenced JSON, and JSON embedded in surrounding text.
 *
 * @param rawText - Raw text response from the model.
 * @returns Parsed JSON value.
 */
export function extractJsonFromText(rawText: string): unknown {
  const text = rawText.trim();

  // 1. Direct JSON parse
  try {
    return JSON.parse(text);
  } catch {}

  // 2. Strip Markdown code fences: ```json ... ``` or ``` ... ```
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {}
  }

  // 3. Locate outermost curly brackets: { ... }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error(
    `[OpenAICompatibleAdapter] Failed to parse strict JSON from model response: "${text.slice(0, 150)}..."`
  );
}

/**
 * Configuration options for OpenAICompatibleAdapter.
 */
export interface OpenAICompatibleAdapterConfig {
  /**
   * Adapter name tag.
   */
  readonly name?: string;
  /**
   * API Key for authorization.
   * Defaults to process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY.
   */
  readonly apiKey?: string;
  /**
   * Base URL of the OpenAI-compatible service.
   * Defaults to process.env.LLM_BASE_URL.
   * If unset, intelligently defaults to Gemini endpoint if apiKey starts with 'AIza',
   * OpenAI endpoint if apiKey is present, or local Ollama (http://localhost:11434/v1).
   */
  readonly baseUrl?: string;
  /**
   * Model identifier to request. Defaults to 'gpt-4o-mini' or agent's configured model.
   */
  readonly model?: string;
  /**
   * Sampling temperature (default 0.2 for deterministic code generation).
   */
  readonly temperature?: number;
  /**
   * Network request timeout in milliseconds (default 30,000ms).
   */
  readonly timeoutMs?: number;
  /**
   * Injectable fetch implementation (primarily for deterministic unit testing).
   */
  readonly fetchFn?: typeof fetch;
}

/**
 * Adapter communicating with any OpenAI-compatible API using native fetch.
 */
export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly name: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config?: OpenAICompatibleAdapterConfig) {
    this.name = config?.name ?? 'OpenAICompatibleAdapter';
    this.apiKey =
      config?.apiKey ??
      process.env.LLM_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.GEMINI_API_KEY;

    // Resolve base URL
    if (config?.baseUrl) {
      this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    } else if (process.env.LLM_BASE_URL) {
      this.baseUrl = process.env.LLM_BASE_URL.replace(/\/+$/, '');
    } else if (this.apiKey && this.apiKey.startsWith('AIza')) {
      // Gemini's OpenAI-compatible endpoint
      this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
    } else if (this.apiKey) {
      this.baseUrl = 'https://api.openai.com/v1';
    } else {
      // Local Ollama default
      this.baseUrl = 'http://localhost:11434/v1';
    }

    this.defaultModel = config?.model ?? process.env.LLM_MODEL ?? 'gpt-4o-mini';
    this.temperature = config?.temperature ?? 0.2;
    this.timeoutMs = config?.timeoutMs ?? 30_000;
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  /**
   * Dispatches a chat completion call enforcing strict JSON response format.
   */
  private async callChatCompletion(
    messages: readonly { role: string; content: string }[],
    modelOverride?: string
  ): Promise<string> {
    const endpoint = `${this.baseUrl}/chat/completions`;
    const model = modelOverride || this.defaultModel;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const payload = {
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: this.temperature,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // Handle providers that reject response_format: { type: "json_object" }
      if (!response.ok && response.status === 400) {
        const errorBody = await response.text();
        if (/response_format/i.test(errorBody)) {
          // Retry without response_format
          const fallbackPayload = {
            model,
            messages,
            temperature: this.temperature,
          };
          response = await this.fetchFn(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(fallbackPayload),
            signal: controller.signal,
          });
        } else {
          throw new Error(
            `[OpenAICompatibleAdapter] HTTP ${response.status} Error: ${errorBody}`
          );
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(
          `[OpenAICompatibleAdapter] HTTP ${response.status} ${response.statusText}: ${errText}`
        );
      }

      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(
          `[OpenAICompatibleAdapter] Invalid API response structure: missing message content.`
        );
      }

      return content;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(
          `[OpenAICompatibleAdapter] Request timed out after ${this.timeoutMs}ms.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generates a Proposal for a GENERATOR agent.
   */
  async generateProposal(params: GenerateProposalParams): Promise<Proposal> {
    const { agent, problem } = params;

    const systemPrompt = `You are an expert software engineer participating as a GENERATOR agent in the NashGate consensus protocol.
Your task is to write a pure, deterministic JavaScript function that solves the given problem.
You must stake reputation capital on your solution.
Game-theoretic rule: If your solution fails an auditor's test case, you forfeit your ENTIRE stake. If unchallenged, you earn a 10% dividend. If it survives an auditor challenge, you earn a 50% resilience dividend.

Output strictly valid JSON with this exact schema:
{
  "solution": "executable JavaScript function string",
  "stake": <number between ${MIN_STAKE} and ${agent.capital}>,
  "reasoning": "brief explanation of correctness and chosen stake"
}`;

    const userPrompt = `Problem: ${problem.title}
Task: ${problem.task}
${problem.description ? `Details: ${problem.description}\n` : ''}${
      problem.entrypoint ? `Expected function name: ${problem.entrypoint}\n` : ''
    }
Agent ID: ${agent.id}
Available Capital: ${agent.capital}
Minimum Stake: ${MIN_STAKE}
Maximum Stake: ${agent.capital}

Respond with strictly valid JSON only:`;

    const rawContent = await this.callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      agent.model
    );

    const parsed = extractJsonFromText(rawContent) as Partial<RawProposalOutput>;

    if (!parsed || typeof parsed.solution !== 'string' || !parsed.solution.trim()) {
      throw new Error(
        `[OpenAICompatibleAdapter] Generator response missing valid 'solution' string.`
      );
    }

    const defaultStake = Math.max(MIN_STAKE, roundToPrecision(agent.capital * 0.25, 2));
    const rawStake = typeof parsed.stake === 'number' ? parsed.stake : defaultStake;
    const clampedStake = this.normalizeStake(rawStake, agent.capital);

    return {
      agentId: agent.id,
      solution: parsed.solution.trim(),
      stake: clampedStake,
      reasoning:
        typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
          ? parsed.reasoning.trim()
          : 'OpenAI-compatible generated proposal',
    };
  }

  /**
   * Generates a Challenge (or null) for an AUDITOR agent evaluating a target proposal.
   */
  async generateChallenge(params: GenerateChallengeParams): Promise<Challenge | null> {
    const { auditor, targetGenerator, proposal, problem } = params;

    const systemPrompt = `You are an adversarial test engineer participating as an AUDITOR agent in the NashGate consensus protocol.
Your role is to inspect proposed code for subtle edge-case failures, hallucinations, or bugs.
Game-theoretic rule: If your challenge successfully breaks the generator's solution, you win the generator's staked capital (+${proposal.stake}) as a bounty.
HOWEVER, if your challenge is a FALSE POSITIVE (the generator passes), you suffer an asymmetric anti-spam penalty of -1.5x your stake (-1.5 * stake).
Therefore, if the solution is robust and correct, DECLINE to challenge (shouldChallenge: false) to protect your capital.

Output strictly valid JSON with this exact schema:
{
  "shouldChallenge": boolean,
  "testInput": <the parameter value or array of parameters to pass to the function>,
  "expectedOutput": <the strictly correct expected return value>,
  "stake": <number between ${MIN_STAKE} and ${auditor.capital}>,
  "reasoning": "explanation of flaw found, or why the code is deemed sound"
}`;

    const userPrompt = `Problem: ${problem.title}
Task: ${problem.task}
${problem.description ? `Details: ${problem.description}\n` : ''}
Target Generator: ${targetGenerator.id}
Target Staked Capital: ${proposal.stake}

Proposed Solution Code:
\`\`\`javascript
${proposal.solution}
\`\`\`

Auditor ID: ${auditor.id}
Auditor Available Capital: ${auditor.capital}

Carefully verify if there is an edge case that breaks this solution.
Respond with strictly valid JSON only:`;

    const rawContent = await this.callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      auditor.model
    );

    const parsed = extractJsonFromText(rawContent) as Partial<RawChallengeOutput>;

    if (!parsed || !parsed.shouldChallenge) {
      // Auditor declines challenge -> protects against -1.5x false positive penalty
      return null;
    }

    if (parsed.testInput === undefined) {
      // Cannot challenge without input
      return null;
    }

    const defaultStake = Math.max(MIN_STAKE, roundToPrecision(auditor.capital * 0.25, 2));
    const rawStake = typeof parsed.stake === 'number' ? parsed.stake : defaultStake;
    const clampedStake = this.normalizeStake(rawStake, auditor.capital);

    return {
      auditorId: auditor.id,
      targetAgentId: targetGenerator.id,
      testInput: parsed.testInput,
      expectedOutput: parsed.expectedOutput,
      stake: clampedStake,
    };
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
