/**
 * NashGate Adapters Module
 * Bridges external models and mock scripts to the consensus engine.
 */

export type {
  ProblemContext,
  GenerateProposalParams,
  GenerateChallengeParams,
  RawProposalOutput,
  RawChallengeOutput,
  AgentAdapter,
} from './types.ts';

export {
  MockAdapter,
  DEFAULT_MOCK_CATALOG,
  registerMockProblem,
  type MockAdapterOptions,
  type MockProposalDefinition,
  type MockChallengeDefinition,
} from './mock.ts';

export {
  OpenAICompatibleAdapter,
  extractJsonFromText,
  resolveDefaultModel,
  normalizeModelName,
  getModelFallbacks,
  isLiveMode,
  type OpenAICompatibleAdapterConfig,
} from './openai-compatible.ts';

import type { Agent } from '../core/types.ts';
import { MockAdapter } from './mock.ts';
import {
  OpenAICompatibleAdapter,
  isLiveMode,
  normalizeModelName,
  resolveDefaultModel,
  type OpenAICompatibleAdapterConfig,
} from './openai-compatible.ts';
import type { AgentAdapter } from './types.ts';

export interface CreateAgentAdapterOptions {
  readonly globalApiKey?: string;
  readonly globalBaseUrl?: string;
  readonly globalModel?: string;
  readonly providerKeys?: {
    readonly gemini?: string;
    readonly openai?: string;
    readonly [provider: string]: string | undefined;
  };
  readonly onRetry?: (info: {
    model: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: string;
    agentId?: string;
  }) => void;
  readonly fetchFn?: typeof fetch;
}

/**
 * Dynamically instantiates an AgentAdapter tailored for a specific agent.
 * Respects agent's individual apiKey, baseUrl, and model.
 * If the agent or tournament configuration has live credentials, routes through OpenAICompatibleAdapter.
 * Otherwise, falls back to deterministic MockAdapter.
 */
export function createAgentAdapter(
  agent: Agent,
  options?: CreateAgentAdapterOptions
): AgentAdapter {
  const agentModel = agent.model?.trim() || options?.globalModel?.trim();
  const lower = (agentModel || '').toLowerCase();
  const isGeminiModel = lower.includes('gemini');
  const isOpenAiModel =
    lower.startsWith('gpt-') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4');

  const isOllamaModel = Boolean(
    agentModel &&
      !isGeminiModel &&
      !isOpenAiModel &&
      (agentModel.includes(':') ||
        lower.includes('qwen') ||
        lower.includes('llama') ||
        lower.includes('mistral') ||
        lower.includes('phi') ||
        lower.includes('deepseek'))
  );

  let agentKey: string | undefined = agent.apiKey?.trim();
  let agentUrl: string | undefined = agent.baseUrl?.trim();

  // If agentUrl was set to local Ollama (11434), but the model is a cloud model (Gemini or OpenAI),
  // drop the local Ollama URL so it routes to the cloud provider!
  if (
    (isGeminiModel || isOpenAiModel) &&
    agentUrl &&
    (agentUrl.includes('11434') ||
      agentUrl.includes('localhost') ||
      agentUrl.includes('127.0.0.1'))
  ) {
    agentUrl = undefined;
  }

  if (isOllamaModel) {
    if (!agentUrl) {
      agentUrl = 'http://127.0.0.1:11434/v1';
    }
    // Local Ollama models do not require cloud API keys
    agentKey = undefined;
  } else if (isGeminiModel) {
    if (!agentKey && options?.providerKeys?.gemini) {
      agentKey = options.providerKeys.gemini.trim();
    }
    if (
      !agentKey &&
      options?.globalApiKey &&
      (options.globalApiKey.startsWith('AIza') || options.globalApiKey.startsWith('AQ.'))
    ) {
      agentKey = options.globalApiKey.trim();
    }
    if (!agentKey && process.env.GEMINI_API_KEY) {
      agentKey = process.env.GEMINI_API_KEY.trim();
    }
    // Gemini models should never inherit a global Ollama baseUrl
    if (!agentUrl && options?.globalBaseUrl && !options.globalBaseUrl.includes('11434')) {
      agentUrl = options.globalBaseUrl.trim();
    }
  } else if (isOpenAiModel) {
    if (!agentKey && options?.providerKeys?.openai) {
      agentKey = options.providerKeys.openai.trim();
    }
    if (!agentKey && options?.globalApiKey && options.globalApiKey.startsWith('sk-')) {
      agentKey = options.globalApiKey.trim();
    }
    if (!agentKey && process.env.OPENAI_API_KEY) {
      agentKey = process.env.OPENAI_API_KEY.trim();
    }
    if (!agentUrl && options?.globalBaseUrl && !options.globalBaseUrl.includes('11434')) {
      agentUrl = options.globalBaseUrl.trim();
    }
  } else {
    // Smart multi-provider matching: resolve key by model family
    if (!agentKey && options?.providerKeys) {
      if (lower.includes('gemini') && options.providerKeys.gemini) {
        agentKey = options.providerKeys.gemini.trim();
      } else if (
        (lower.includes('gpt-') ||
          lower.startsWith('o1') ||
          lower.startsWith('o3') ||
          lower.startsWith('o4')) &&
        options.providerKeys.openai
      ) {
        agentKey = options.providerKeys.openai.trim();
      }
    }
    if (!agentKey) {
      agentKey = options?.globalApiKey?.trim();
    }
    if (!agentUrl) {
      agentUrl = options?.globalBaseUrl?.trim();
    }
  }

  const isLive = Boolean(agentKey || agentUrl || isOllamaModel || isLiveMode());

  if (isLive) {
    const isLocalOllama =
      isOllamaModel ||
      Boolean(
        !isGeminiModel &&
          !isOpenAiModel &&
          (agentUrl?.includes('11434') || options?.globalBaseUrl?.includes('11434'))
      );
    return new OpenAICompatibleAdapter({
      name: `OpenAICompatibleAdapter:${agent.id}`,
      apiKey: agentKey || undefined,
      baseUrl: agentUrl || undefined,
      model: agentModel ? normalizeModelName(agentModel) : resolveDefaultModel(),
      timeoutMs: isLocalOllama ? 90_000 : 60_000,
      maxRetries: isLocalOllama ? 1 : 2,
      onRetry: options?.onRetry
        ? (info) => options.onRetry!({ ...info, agentId: agent.id })
        : undefined,
      fetchFn: options?.fetchFn,
    });
  }

  return new MockAdapter({ name: `MockAdapter:${agent.id}` });
}

