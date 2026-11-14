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
 * Returns sibling model candidates for a given model family.
 * Provided as a utility for external consumers; the core retry loop
 * does NOT substitute models — it always retries the exact model chosen by the user.
 */
export function getModelFallbacks(modelName: string): string[] {
  const clean = normalizeModelName(modelName).toLowerCase();
  if (clean.includes('3.8') || clean.includes('2.5')) {
    return ['gemini-1.5-flash', 'gemini-2.0-flash'];
  }
  if (clean.includes('2.0')) {
    return ['gemini-1.5-flash'];
  }
  if (clean === 'gpt-4o') {
    return ['gpt-4o-mini'];
  }
  return [];
}

/**
 * Normalizes model names, stripping extraneous 'models/' prefixes for OpenAI compatibility endpoints.
 * Automatically aliases retired models (e.g. gemini-2.5-flash-lite -> gemini-3.5-flash-lite).
 */
export function normalizeModelName(rawModel: string): string {
  if (!rawModel) return 'gemini-3.5-flash-lite';
  let trimmed = rawModel.trim();
  if (trimmed.startsWith('models/')) {
    trimmed = trimmed.substring('models/'.length);
  }
  if (trimmed.startsWith('gemini-2.5')) {
    return 'gemini-3.5-flash-lite';
  }
  return trimmed;
}

/**
 * Resolves the default LLM model name dynamically based on environment variables:
 * 1. If process.env.LLM_MODEL is set, use that exact model name.
 * 2. Else if process.env.LLM_API_KEY starts with 'AIza' or 'AQ.', default to 'gemini-3.5-flash-lite'.
 * 3. Else if process.env.GEMINI_API_KEY is present, default to 'gemini-3.5-flash-lite'.
 * 4. Else if process.env.LLM_BASE_URL includes '11434' (Ollama), default to 'llama3.2'.
 * 5. Otherwise fallback to 'gpt-4o-mini'.
 */
export function resolveDefaultModel(): string {
  if (process.env.LLM_MODEL && process.env.LLM_MODEL.trim()) {
    return normalizeModelName(process.env.LLM_MODEL);
  }
  const apiKey = process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY;
  if (apiKey && (apiKey.startsWith('AIza') || apiKey.startsWith('AQ.'))) {
    return 'gemini-3.5-flash-lite';
  }
  if (process.env.GEMINI_API_KEY) {
    return 'gemini-3.5-flash-lite';
  }
  const baseUrl = process.env.LLM_BASE_URL;
  if (baseUrl && baseUrl.includes('11434')) {
    return 'llama3.2';
  }
  return 'gpt-4o-mini';
}

/**
 * Detects whether a live LLM endpoint is configured via environment variables.
 */
export function isLiveMode(): boolean {
  return Boolean(
    process.env.LLM_API_KEY ||
    process.env.LLM_BASE_URL ||
    process.env.LLM_MODEL ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY
  );
}

/**
 * Robustly parses and extracts a JSON object from raw model output.
 * Handles bare JSON, markdown-fenced JSON, and JSON embedded in surrounding text.
 *
 * @param rawText - Raw text response from the model.
 * @returns Parsed JSON value.
 */
export function extractJsonFromText(rawText: string): unknown {
  const text = rawText.trim();

  // Helper to remove illegal trailing commas: { "a": 1, } -> { "a": 1 }
  const stripTrailingCommas = (s: string) => s.replace(/,\s*([}\]])/g, '$1');

  // 1. Direct JSON parse
  try {
    return JSON.parse(text);
  } catch {}
  try {
    return JSON.parse(stripTrailingCommas(text));
  } catch {}

  // 2. Strip Markdown code fences: ```json ... ``` or ``` ... ```
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fencedMatch) {
    const fencedContent = fencedMatch[1].trim();
    try {
      return JSON.parse(fencedContent);
    } catch {}
    try {
      return JSON.parse(stripTrailingCommas(fencedContent));
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
    try {
      return JSON.parse(stripTrailingCommas(candidate));
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
   * Network request timeout in milliseconds (default 45,000ms).
   */
  readonly timeoutMs?: number;
  /**
   * Maximum retry attempts for transient capacity errors (HTTP 503, 429, timeouts).
   * Default: 3 retries on the exact chosen model with exponential backoff.
   */
  readonly maxRetries?: number;
  /**
   * Base backoff delay between retry attempts in milliseconds. Default: 2,000ms.
   */
  readonly retryDelayMs?: number;
  /**
   * Injectable fetch implementation (primarily for deterministic unit testing).
   */
  readonly fetchFn?: typeof fetch;
  /**
   * Optional callback triggered when a transient error causes a retry.
   */
  readonly onRetry?: (info: {
    model: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: string;
  }) => void;
}

/**
 * Adapter communicating with any OpenAI-compatible API using native fetch.
 */
export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly name: string;
  private readonly apiKey?: string;
  private readonly customBaseUrl?: string;
  private readonly defaultModel: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly onRetry?: (info: {
    model: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: string;
  }) => void;

  constructor(config?: OpenAICompatibleAdapterConfig) {
    this.name = config?.name ?? 'OpenAICompatibleAdapter';
    this.apiKey =
      config?.apiKey ??
      process.env.LLM_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.GEMINI_API_KEY;

    if (config?.baseUrl) {
      this.customBaseUrl = config.baseUrl.replace(/\/+$/, '');
    } else if (process.env.LLM_BASE_URL) {
      this.customBaseUrl = process.env.LLM_BASE_URL.replace(/\/+$/, '');
    }

    this.defaultModel = config?.model ? normalizeModelName(config.model) : resolveDefaultModel();
    this.temperature = config?.temperature ?? 0.2;
    this.timeoutMs = config?.timeoutMs ?? 60_000;
    this.maxRetries = config?.maxRetries ?? 2;
    this.retryDelayMs = config?.retryDelayMs ?? 1_500;
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
    this.onRetry = config?.onRetry;
  }

  /**
   * Resolves the appropriate base URL for a given model identifier.
   */
  public resolveBaseUrlForModel(model?: string): string {
    if (this.customBaseUrl) {
      return this.customBaseUrl;
    }
    const targetModel = normalizeModelName(model || this.defaultModel).toLowerCase();
    if (
      targetModel.includes('gemini') ||
      (this.apiKey && (this.apiKey.startsWith('AIza') || this.apiKey.startsWith('AQ.'))) ||
      process.env.GEMINI_API_KEY
    ) {
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    }
    if (
      targetModel.includes('llama') ||
      targetModel.includes('ollama') ||
      targetModel.includes('deepseek') ||
      targetModel.includes('qwen') ||
      targetModel.includes('mistral') ||
      targetModel.includes('phi') ||
      targetModel.includes(':')
    ) {
      return 'http://localhost:11434/v1';
    }
    if (this.apiKey) {
      return 'https://api.openai.com/v1';
    }
    return 'http://localhost:11434/v1';
  }

  /**
   * Base URL accessor for backwards compatibility.
   */
  get baseUrl(): string {
    return this.resolveBaseUrlForModel(this.defaultModel);
  }

  /**
   * Executes a single chat completion attempt with strict timeout and response_format fallback.
   */
  private async executeSingleChatCompletion(
    messages: readonly { role: string; content: string }[],
    model: string
  ): Promise<string> {
    const baseUrl = this.resolveBaseUrlForModel(model);
    const endpoint = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      // Google Generative Language endpoint supports and often prefers x-goog-api-key header
      if (this.apiKey.startsWith('AIza') || this.apiKey.startsWith('AQ.')) {
        headers['x-goog-api-key'] = this.apiKey;
      }
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: this.temperature,
    };

    // For reasoning models (e.g. Gemini 3 series like gemini-3.8-flash, o1, o3):
    // Configure reasoning_effort: "low" so the model delivers code generation directly without
    // prolonged internal thinking delays or high-demand capacity exhaustion.
    const lowerModel = model.toLowerCase();
    if (lowerModel.includes('gemini-3') || lowerModel.includes('o1') || lowerModel.includes('o3')) {
      payload['reasoning_effort'] = 'low';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // Handle providers that reject response_format or reasoning_effort with HTTP 400
      if (!response.ok && response.status === 400) {
        const errorBody = await response.text();
        if (/response_format|reasoning_effort|extra_fields/i.test(errorBody)) {
          // Retry with baseline payload without optional fields
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
          const err = new Error(
            `[OpenAICompatibleAdapter] HTTP ${response.status} Error: ${errorBody}`
          );
          (err as any).status = response.status;
          throw err;
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(
          `[OpenAICompatibleAdapter] HTTP ${response.status} ${response.statusText}: ${errText}`
        );
        (err as any).status = response.status;
        throw err;
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
        const timeoutErr = new Error(
          `[OpenAICompatibleAdapter] Request timed out after ${this.timeoutMs}ms.`
        );
        (timeoutErr as any).isTimeout = true;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Dispatches a chat completion call with automatic transient retry (HTTP 503/429/timeouts)
   * strictly adhering to the exact model chosen by the user.
   */
  private async callChatCompletion(
    messages: readonly { role: string; content: string }[],
    modelOverride?: string
  ): Promise<string> {
    const rawModel = modelOverride || this.defaultModel;
    let model = normalizeModelName(rawModel);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter on the exact model the user chose
        const delay = Math.round(this.retryDelayMs * Math.pow(1.8, attempt - 1) + Math.random() * 400);
        this.onRetry?.({
          model,
          attempt,
          maxRetries: this.maxRetries,
          delayMs: delay,
          error: lastError?.message || 'Transient network or capacity error',
        });
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        return await this.executeSingleChatCompletion(messages, model);
      } catch (err: any) {
        lastError = err;
        const status = err.status || 0;

        // Auto-heal retired Google models: if Google returns 404 telling to use gemini-3.5-flash-lite
        if (status === 404 && /no longer available|gemini-3\.5-flash-lite|NOT_FOUND/i.test(err.message)) {
          if (model !== 'gemini-3.5-flash-lite') {
            model = 'gemini-3.5-flash-lite';
            continue;
          }
        }

        const isTimeout = Boolean(err.isTimeout);

        // Daily quota exhaustion (e.g. 20 requests/day free tier limit on gemini-3.8-flash):
        // Retrying within seconds is futile and wastes time; abort immediately with actionable advice.
        const isDailyQuotaExhausted = /per day limit exceeded|GenerateRequestsPerDay|retry in \d+h/i.test(err.message);
        if (isDailyQuotaExhausted) {
          throw new Error(
            `[OpenAICompatibleAdapter] Free Tier Daily Quota Exceeded for ${model}: ${err.message}. Switch model to gemini-3.5-flash-lite or gemini-1.5-flash or clear API key for Offline Mock mode.`
          );
        }

        const isTransient =
          isTimeout ||
          status === 503 ||
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 504 ||
          /high demand|spikes in demand|rate limit|quota|temporarily unavailable|server error/i.test(err.message);

        if (!isTransient) {
          // Fatal error like 401 Unauthorized or 400 Bad Request: fail immediately without wasteful retries
          throw err;
        }
      }
    }

    throw lastError || new Error(`[OpenAICompatibleAdapter] All retry attempts failed for ${model}`);
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
