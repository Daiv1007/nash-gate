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
  const agentKey = agent.apiKey?.trim() || options?.globalApiKey?.trim();
  const agentUrl = agent.baseUrl?.trim() || options?.globalBaseUrl?.trim();
  const agentModel = agent.model?.trim() || options?.globalModel?.trim();

  const isLive = Boolean(agentKey || agentUrl || isLiveMode());

  if (isLive) {
    return new OpenAICompatibleAdapter({
      name: `OpenAICompatibleAdapter:${agent.id}`,
      apiKey: agentKey || undefined,
      baseUrl: agentUrl || undefined,
      model: agentModel ? normalizeModelName(agentModel) : resolveDefaultModel(),
      onRetry: options?.onRetry
        ? (info) => options.onRetry!({ ...info, agentId: agent.id })
        : undefined,
      fetchFn: options?.fetchFn,
    });
  }

  return new MockAdapter({ name: `MockAdapter:${agent.id}` });
}

