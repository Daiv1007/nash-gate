/**
 * NashGate OpenAI-Compatible Agent Adapter
 * Connects to any OpenAI-compatible API endpoint (local Ollama, Gemini OpenAI endpoint, OpenAI)
 * using Node's native fetch with zero external SDK dependencies.
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
 * Returns sibling model candidates for a given model family.
 * Provided as a utility for external consumers; the core retry loop
 * does NOT substitute models — it always retries the exact model chosen by the user.
 */
export function getModelFallbacks(modelName: string): string[] {
  const clean = normalizeModelName(modelName).toLowerCase();
  if (clean.includes('4-carbon') || clean.includes('4-argon')) {
    return ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
  }
  if (clean.includes('4-hydrogen') || clean.includes('3.8')) {
    return ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];
  }
  if (clean.includes('3.5') || clean.includes('3.6')) {
    return ['gemini-3.8-flash', 'gemini-4-hydrogen'];
  }
  if (clean.includes('2.0') || clean.includes('2.5') || clean.includes('1.5')) {
    return ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen'];
  }
  if (clean === 'gpt-4o') {
    return ['gpt-4o-mini'];
  }
  return [];
}

/**
 * Normalizes model names, stripping extraneous 'models/' prefixes for OpenAI compatibility endpoints
 * and automatically upgrading deprecated/shut down models (e.g. gemini-2.0-flash, gemini-2.5-flash -> gemini-3.5-flash-lite).
 */
export function normalizeModelName(rawModel: string): string {
  if (!rawModel) return 'gemini-3.5-flash-lite';
  let trimmed = rawModel.trim();
  if (trimmed.startsWith('models/')) {
    trimmed = trimmed.substring('models/'.length);
  }
  // Upgrades per official Google AI Studio deprecation guidance
  if (
    trimmed === 'gemini-2.0-flash' ||
    trimmed === 'gemini-2.0-flash-lite' ||
    trimmed === 'gemini-2.5-flash'
  ) {
    return 'gemini-3.5-flash-lite';
  }
  if (trimmed === 'gemini-2.5-pro') {
    return 'gemini-3.8-flash';
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
  let text = (rawText || '').trim();

  // 0. Handle thinking tags from reasoning models (e.g. Qwen, DeepSeek, QwQ): <think>...</think>
  if (text.includes('</think>')) {
    const afterThink = text.substring(text.lastIndexOf('</think>') + '</think>'.length).trim();
    if (afterThink.includes('{')) {
      text = afterThink;
    } else {
      text = text.replace(/<\/?think>/g, '').trim();
    }
  } else if (text.includes('<think>')) {
    const firstBrace = text.indexOf('{');
    if (firstBrace !== -1) {
      text = text.slice(firstBrace).trim();
    }
  }

  // Helper to remove illegal trailing commas: { "a": 1, } -> { "a": 1 }
  const stripTrailingCommas = (s: string) => s.replace(/,\s*([}\]])/g, '$1');

  // 1. Direct JSON parse
  try {
    return JSON.parse(text);
  } catch {}
  try {
    return JSON.parse(stripTrailingCommas(text));
  } catch {}

  // 2. Strip Markdown code fences without polynomial regex (indexOf is O(N) and immune to ReDoS)
  const firstFence = text.indexOf('```');
  if (firstFence !== -1) {
    const secondFence = text.indexOf('```', firstFence + 3);
    if (secondFence !== -1) {
      let fencedContent = text.substring(firstFence + 3, secondFence).trim();
      if (fencedContent.startsWith('json')) {
        fencedContent = fencedContent.substring(4).trim();
      }
      try {
        return JSON.parse(fencedContent);
      } catch {}
      try {
        return JSON.parse(stripTrailingCommas(fencedContent));
      } catch {}
    }
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
  private readonly hasExplicitApiKey: boolean;
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

    const trimTrailingSlashes = (url: string) => {
      let u = url.trim();
      while (u.endsWith('/')) {
        u = u.slice(0, -1);
      }
      return u;
    };

    if (config?.baseUrl) {
      this.customBaseUrl = trimTrailingSlashes(config.baseUrl);
    } else if (process.env.LLM_BASE_URL) {
      this.customBaseUrl = trimTrailingSlashes(process.env.LLM_BASE_URL);
    }

    const explicitGeminiKey = Boolean(
      config?.apiKey && (config.apiKey.startsWith('AIza') || config.apiKey.startsWith('AQ.'))
    );
    this.defaultModel = config?.model
      ? normalizeModelName(config.model)
      : explicitGeminiKey
        ? 'gemini-3.5-flash-lite'
        : resolveDefaultModel();
    this.temperature = config?.temperature ?? 0.2;

    const targetModelLower = this.defaultModel.toLowerCase();
    const isCloudModel =
      targetModelLower.includes('gemini') ||
      targetModelLower.startsWith('gpt-') ||
      targetModelLower.startsWith('o1') ||
      targetModelLower.startsWith('o3') ||
      targetModelLower.startsWith('o4');

    const isLocalOllama = !isCloudModel && Boolean(
      this.customBaseUrl?.includes('11434') ||
      (this.defaultModel && (
        this.defaultModel.includes(':') ||
        targetModelLower.includes('qwen') ||
        targetModelLower.includes('llama') ||
        targetModelLower.includes('mistral') ||
        targetModelLower.includes('deepseek') ||
        targetModelLower.includes('phi')
      ))
    );

    // Track whether the apiKey came from the explicit config (agent/user-provided) vs an env variable.
    // Local Ollama endpoints do not inherit cloud env keys (GEMINI_API_KEY, etc.).
    this.hasExplicitApiKey = Boolean(config?.apiKey);
    this.apiKey =
      config?.apiKey ??
      (isLocalOllama
        ? undefined
        : process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY);
    this.timeoutMs = config?.timeoutMs ?? (isLocalOllama ? 90_000 : 60_000);
    this.maxRetries = config?.maxRetries ?? (isLocalOllama ? 1 : 2);
    this.retryDelayMs = config?.retryDelayMs ?? 1_500;
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
    this.onRetry = config?.onRetry;
  }

  /**
   * Resolves the appropriate base URL for a given model identifier.
   */
  public resolveBaseUrlForModel(model?: string): string {
    const targetModel = normalizeModelName(model || this.defaultModel).toLowerCase();
    const isGemini = targetModel.includes('gemini');
    const isOpenAi =
      targetModel.startsWith('gpt-') ||
      targetModel.startsWith('o1') ||
      targetModel.startsWith('o3') ||
      targetModel.startsWith('o4');

    const isLocalOllamaUrl = Boolean(
      this.customBaseUrl && (
        this.customBaseUrl.includes('11434') ||
        this.customBaseUrl.includes('localhost:11434') ||
        this.customBaseUrl.includes('127.0.0.1:11434')
      )
    );

    // If customBaseUrl points to local Ollama (11434), but the target model is a cloud model,
    // NEVER route cloud models to local Ollama!
    if (isGemini) {
      if (this.customBaseUrl && !isLocalOllamaUrl) {
        return this.customBaseUrl;
      }
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    }

    if (isOpenAi) {
      if (this.customBaseUrl && !isLocalOllamaUrl) {
        return this.customBaseUrl;
      }
      return 'https://api.openai.com/v1';
    }

    if (this.customBaseUrl) {
      return this.customBaseUrl;
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
      return this.customBaseUrl || 'http://localhost:11434/v1';
    }

    if (
      (this.apiKey && (this.apiKey.startsWith('AIza') || this.apiKey.startsWith('AQ.'))) ||
      process.env.GEMINI_API_KEY
    ) {
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    }

    if (this.apiKey) {
      return 'https://api.openai.com/v1';
    }

    return this.customBaseUrl || 'http://localhost:11434/v1';
  }

  /**
   * Base URL accessor for backwards compatibility.
   */
  get baseUrl(): string {
    return this.resolveBaseUrlForModel(this.defaultModel);
  }

  /**
   * Calls Ollama's native /api/chat endpoint with think:false to disable chain-of-thought loops.
   * This is the only endpoint where Ollama's think parameter is properly respected.
   */
  private async executeOllamaChat(
    messages: readonly { role: string; content: string }[],
    model: string
  ): Promise<string> {
    // Prefer IPv4 to avoid Windows IPv6 latency on Ollama
    const baseHost = this.customBaseUrl
      ? this.customBaseUrl.replace(/\/v1\/?$/, '')
      : 'http://127.0.0.1:11434';
    const endpoint = `${baseHost.replace('localhost', '127.0.0.1')}/api/chat`;

    const payload = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      think: false,
      stream: false,
      options: {
        temperature: this.temperature,
        num_predict: 768,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (networkErr: any) {
        // Fallback for Windows IPv6 vs IPv4 resolution (127.0.0.1:11434 vs localhost:11434)
        let altEndpoint: string | null = null;
        if (endpoint.includes('127.0.0.1:11434')) {
          altEndpoint = endpoint.replace('127.0.0.1:11434', 'localhost:11434');
        } else if (endpoint.includes('localhost:11434')) {
          altEndpoint = endpoint.replace('localhost:11434', '127.0.0.1:11434');
        }
        if (altEndpoint) {
          response = await this.fetchFn(altEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } else {
          throw networkErr;
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(
          `[OpenAICompatibleAdapter] Ollama HTTP ${response.status}: ${errText}`
        );
        (err as any).status = response.status;
        throw err;
      }

      const data = (await response.json()) as any;
      // /api/chat non-streaming response: { message: { role, content }, done: true }
      const content =
        (typeof data?.message?.content === 'string' && data.message.content.trim()
          ? data.message.content
          : '') ||
        (typeof data?.response === 'string' && data.response.trim() ? data.response : '') ||
        (typeof data?.message?.thinking === 'string' && data.message.thinking.trim()
          ? data.message.thinking
          : '');

      if (content) {
        return content;
      }
      throw new Error(
        `[OpenAICompatibleAdapter] Ollama /api/chat returned empty content (done=${data?.done}).`
      );
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
   * Executes a single chat completion attempt with strict timeout and response_format fallback.
   * Routes local Ollama requests to /api/chat (native) to allow think:false.
   */
  private async executeSingleChatCompletion(
    messages: readonly { role: string; content: string }[],
    model: string
  ): Promise<string> {
    let baseUrl = this.resolveBaseUrlForModel(model);
    if (baseUrl.includes('localhost:11434')) {
      baseUrl = baseUrl.replace('localhost:11434', '127.0.0.1:11434');
    }

    const lowerModel = model.toLowerCase();
    const isCloud =
      lowerModel.includes('gemini') ||
      lowerModel.startsWith('gpt-') ||
      lowerModel.startsWith('o1') ||
      lowerModel.startsWith('o3') ||
      lowerModel.startsWith('o4');

    const isLocalOllama = !isCloud && Boolean(
      baseUrl.includes('11434') ||
      (model && (
        model.includes(':') ||
        lowerModel.includes('qwen') ||
        lowerModel.includes('llama') ||
        lowerModel.includes('mistral') ||
        lowerModel.includes('deepseek') ||
        lowerModel.includes('phi')
      ))
    );

    // Route to native /api/chat so think:false is honoured, eliminating reasoning loops.
    // Only skip this if an API key was explicitly provided in the adapter config (meaning the user
    // intentionally configured a cloud/authenticated Ollama endpoint). Auto-discovered env keys
    // (GEMINI_API_KEY, etc.) must NOT prevent routing local Ollama models to /api/chat.
    if (isLocalOllama && !this.hasExplicitApiKey) {
      return this.executeOllamaChat(messages, model);
    }

    // ── Standard OpenAI-compatible path ────────────────────────────────────
    const endpoint = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      if (this.apiKey.startsWith('AIza') || this.apiKey.startsWith('AQ.')) {
        headers['x-goog-api-key'] = this.apiKey;
      }
    }

    const isReasoningOrOllamaNoKey = Boolean(
      (!this.apiKey && isLocalOllama) ||
      model.toLowerCase().includes('qwen') ||
      model.toLowerCase().includes('deepseek')
    );

    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: this.temperature,
      max_tokens: 1024,
    };

    if (!isReasoningOrOllamaNoKey) {
      payload['response_format'] = { type: 'json_object' };
    }

    if (lowerModel.includes('gemini-3') || lowerModel.includes('o1') || lowerModel.includes('o3')) {
      payload['reasoning_effort'] = 'low';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (networkErr: any) {
        let altEndpoint: string | null = null;
        if (endpoint.includes('127.0.0.1:11434')) {
          altEndpoint = endpoint.replace('127.0.0.1:11434', 'localhost:11434');
        } else if (endpoint.includes('localhost:11434')) {
          altEndpoint = endpoint.replace('localhost:11434', '127.0.0.1:11434');
        }
        if (altEndpoint) {
          response = await this.fetchFn(altEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } else {
          throw networkErr;
        }
      }

      if (!response.ok && response.status === 400) {
        const errorBody = await response.text();
        if (/response_format|reasoning_effort|extra_fields/i.test(errorBody)) {
          const fallbackPayload = { model, messages, temperature: this.temperature };
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
          `[OpenAICompatibleAdapter] HTTP ${response.status} ${response.statusText} (${endpoint}): ${errText}`
        );
        (err as any).status = response.status;
        throw err;
      }

      const data = (await response.json()) as any;
      const choice = data?.choices?.[0];
      const message = choice?.message;

      let content = typeof message?.content === 'string' ? message.content : '';

      if (!content.trim() || !content.includes('{')) {
        const candidates = [
          message?.reasoning,
          message?.reasoning_content,
          message?.thinking,
          message?.thought,
          choice?.reasoning,
          choice?.reasoning_content,
          choice?.text,
          choice?.delta?.content,
          data?.response,
          data?.thinking,
          data?.thought,
          data?.message?.content,
          data?.message?.reasoning,
          data?.message?.thinking,
        ];

        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim()) {
            if (!content.trim() || candidate.includes('{')) {
              content = candidate;
              if (content.includes('{')) break;
            }
          }
        }
      }

      if (typeof content !== 'string' || !content.trim()) {
        const debugKeys = [
          `choice=[${Object.keys(choice || {}).join(',')}]`,
          `message=[${Object.keys(message || {}).join(',')}]`,
          `data=[${Object.keys(data || {}).join(',')}]`,
        ].join('; ');
        throw new Error(
          `[OpenAICompatibleAdapter] Model returned empty content (finish_reason: ${choice?.finish_reason || 'unknown'}, ${debugKeys}).`
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

        // Auto-heal retired Google models: if Google returns 404 for an older or unrecognised model
        if (
          status === 404 &&
          /no longer available|NOT_FOUND|not found/i.test(err.message) &&
          (model.toLowerCase().includes('gemini') || (this.apiKey && (this.apiKey.startsWith('AIza') || this.apiKey.startsWith('AQ.'))))
        ) {
          if (model !== 'gemini-3.5-flash-lite' && model !== 'gemini-3.8-flash') {
            model = 'gemini-3.5-flash-lite';
            continue;
          } else if (model === 'gemini-3.5-flash-lite') {
            model = 'gemini-3.8-flash';
            continue;
          }
        }

        const isTimeout = Boolean(err.isTimeout);

        // Daily quota exhaustion:
        // Retrying within seconds is futile and wastes time; abort immediately with actionable advice.
        const isDailyQuotaExhausted = /per day limit exceeded|GenerateRequestsPerDay|retry in \d+h/i.test(err.message);
        if (isDailyQuotaExhausted) {
          throw new Error(
            `[OpenAICompatibleAdapter] Free Tier Daily Quota Exceeded for ${model}: ${err.message}. Switch model to gemini-3.5-flash-lite or clear API key for Offline Mock mode.`
          );
        }

        // Plan restriction (limit: 0 for Pro / Carbon / Argon on Free Tier):
        // Retrying is futile because a Free Tier key will never have quota > 0 for paid models.
        const isPaidOnlyModel = model.includes('carbon') || model.includes('argon') || model.includes('pro');
        const isPlanBillingRestricted =
          isPaidOnlyModel && (
            /limit:\s*0(?!\d)|limit\s*['"]0['"]|quota_limit["']?:\s*["']?0["']?(?!\d)|quota limit of 0(?!\d)/i.test(err.message) ||
            (/RESOURCE_EXHAUSTED/i.test(err.message) && /\blimit\b\D*['"]?0['"]?(?!\d)/i.test(err.message))
          );
        if (isPlanBillingRestricted) {
          throw new Error(
            `[OpenAICompatibleAdapter] Plan Restriction (Free Tier Limit: 0) for ${model}: Google AI Studio requires a paid billing account (Pay-As-You-Go) for this model. Switch to a Free Tier model (like gemini-3.5-flash-lite or gemini-4-hydrogen) or enable billing in Google Cloud Console.`
          );
        }

        const isEmptyOrLength = /finish_reason:\s*length|empty content/i.test(err.message);
        const isTransient =
          isTimeout ||
          isEmptyOrLength ||
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

    const systemPrompt = `You are a software engineer participating as a GENERATOR agent in the NashGate consensus protocol.
Your task is to write a pure, deterministic JavaScript function that solves the given problem specification.
You must stake reputation capital on your solution.
Game-theoretic payoff rules:
- If your solution fails an auditor's test case, you forfeit your ENTIRE stake to the auditor.
- If unchallenged, you earn a +10% dividend on your stake.
- If challenged and your code survives, you earn a +50% resilience bonus.

Output strictly valid JSON with this exact schema:
{
  "solution": "executable JavaScript function string",
  "stake": <number between ${MIN_STAKE} and ${agent.capital}>,
  "reasoning": "brief explanation under 15 words"
}
CRITICAL: /no_think. Output raw JSON starting with '{'. Do not include <think> tags or verbose text.`;

    const userPrompt = `Problem: ${problem.title}
Task: ${problem.task}
${problem.description ? `Details: ${problem.description}\n` : ''}${
      problem.entrypoint ? `Expected function name: ${problem.entrypoint}\n` : ''
    }
Agent ID: ${agent.id}
Available Capital: ${agent.capital}
Minimum Stake: ${MIN_STAKE}
Maximum Stake: ${agent.capital}

Start response directly with '{':`;

    const rawContent = await this.callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      agent.model
    );

    let parsed: Partial<RawProposalOutput> | null = null;
    try {
      parsed = extractJsonFromText(rawContent) as Partial<RawProposalOutput>;
    } catch (_parseErr) {
      // If direct parsing failed, attempt a 1-time fallback re-prompt to recover the JSON
      try {
        const recoveryContent = await this.callChatCompletion(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: rawContent },
            {
              role: 'user',
              content: 'Please output ONLY the valid JSON object with keys "solution", "stake", and "reasoning". No markdown fences, no conversational text.',
            },
          ],
          agent.model
        );
        parsed = extractJsonFromText(recoveryContent) as Partial<RawProposalOutput>;
      } catch {
        // Re-throw original parse error if recovery also fails
        parsed = extractJsonFromText(rawContent) as Partial<RawProposalOutput>;
      }
    }

    if (!parsed || typeof parsed.solution !== 'string' || !parsed.solution.trim()) {
      // Heuristic fallback: check if rawContent contains a JS function that we can salvage
      const codeMatch = rawContent.match(
        /(?:function\s+[a-zA-Z0-9_$]+|\(?\s*[a-zA-Z0-9_$,\s]*\)?\s*=>)\s*\{[\s\S]*\}/
      );
      if (codeMatch) {
        parsed = {
          solution: codeMatch[0],
          stake: Math.max(MIN_STAKE, roundToPrecision(agent.capital * 0.25, 2)),
          reasoning: 'Extracted JavaScript function directly from model response',
        };
      } else {
        throw new Error(
          `[OpenAICompatibleAdapter] Generator response missing valid 'solution' string.`
        );
      }
    }

    const solutionText = parsed?.solution ?? '';
    const cleanSolution = solutionText
      .replace(/^```(?:javascript|js|ts)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const defaultStake = calculateGeneratorStake({
      capital: agent.capital,
      confidence: 0.85,
      riskProfile: 'balanced',
    }).stake;
    const rawStake = typeof parsed.stake === 'number' ? parsed.stake : defaultStake;
    const clampedStake = this.normalizeStake(rawStake, agent.capital);

    return {
      agentId: agent.id,
      solution: cleanSolution,
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

    const systemPrompt = `You are an auditor participating in the NashGate consensus protocol.
Your role is to inspect the proposed JavaScript code against the problem specification.
You must decide whether to CHALLENGE the solution or DECLINE.

Game-theoretic payoff rules:
- If you challenge and the generator's code FAILS your test, you win the generator's staked capital (+${proposal.stake}) as a bounty.
- If you challenge and the generator's code PASSES your test (false positive / spam), you suffer an asymmetric penalty of -1.5x your stake (-1.5 * stake).
- If the solution is robust and correct, DECLINE to challenge (shouldChallenge: false) to protect your capital.

Output strictly valid JSON with this exact schema:
{
  "shouldChallenge": boolean,
  "testInput": <the parameter value or array of parameters to pass to the function>,
  "expectedOutput": <the strictly correct expected return value>,
  "stake": <number between ${MIN_STAKE} and ${auditor.capital}>,
  "reasoning": "brief explanation under 15 words"
}
CRITICAL: /no_think. Output raw JSON starting with '{'. Do not include <think> tags or verbose text.`;

    const userPrompt = `Problem: ${problem.title}
Task: ${problem.task}
${problem.description ? `Details: ${problem.description}\n` : ''}${
      problem.entrypoint ? `Expected function name: ${problem.entrypoint}\n` : ''
    }
Target Generator: ${targetGenerator.id}
Target Staked Capital: ${proposal.stake}

Proposed Solution Code:
\`\`\`javascript
${proposal.solution}
\`\`\`

Auditor ID: ${auditor.id}
Auditor Available Capital: ${auditor.capital}

Note: If the function accepts multiple arguments, testInput should be an array of arguments (e.g. [5, 10, 0] or ["Debit Card", "Bad Credit"]).
Carefully verify if there is an edge case that breaks this solution.
Start response directly with '{':`;

    const rawContent = await this.callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      auditor.model
    );

    let parsed: Partial<RawChallengeOutput> | null = null;
    try {
      parsed = extractJsonFromText(rawContent) as Partial<RawChallengeOutput>;
    } catch {
      // If parsing fails for auditor, auditor safely declines challenge -> avoids false penalty
      return null;
    }

    if (!parsed || !parsed.shouldChallenge) {
      // Auditor declines challenge -> protects against -1.5x false positive penalty
      return null;
    }

    if (parsed.testInput === undefined) {
      // Cannot challenge without input
      return null;
    }

    const defaultStake = calculateAuditorStake({
      capital: auditor.capital,
      targetStake: proposal.stake,
      confidence: 0.75,
      riskProfile: 'balanced',
    }).stake;
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
    return clampStake(rawStake, agentCapital);
  }
}
