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
  isLiveMode,
  type OpenAICompatibleAdapterConfig,
} from './openai-compatible.ts';
