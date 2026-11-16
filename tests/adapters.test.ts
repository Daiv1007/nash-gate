/**
 * Unit Tests: NashGate Adapters (MockAdapter & OpenAICompatibleAdapter)
 * Verifies proposal generation, adversarial challenge creation, strict JSON parsing,
 * and stake normalization across adapter implementations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockAdapter,
  DEFAULT_MOCK_CATALOG,
  OpenAICompatibleAdapter,
  createAgentAdapter,
  extractJsonFromText,
  resolveDefaultModel,
  normalizeModelName,
  getModelFallbacks,
  type ProblemContext,
} from '../src/adapters/index.ts';
import { createAgent } from '../src/core/index.ts';
import { executeInSandbox, executeInSandboxSync } from '../src/oracle/index.ts';

const testProblem: ProblemContext = {
  id: 'is-palindrome',
  title: 'Palindrome Verification',
  task: 'Implement isPalindrome(s: string): boolean handling punctuation, casing, and spaces.',
  entrypoint: 'isPalindrome',
};

// ---------------------------------------------------------------------------
// 1. MockAdapter Tests
// ---------------------------------------------------------------------------

test('MockAdapter: Solid generator produces executable solution that passes standard tests', async () => {
  const adapter = new MockAdapter();
  const agent = createAgent({
    id: 'AlphaGen',
    role: 'GENERATOR',
    model: 'deterministic-solid',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  assert.equal(proposal.agentId, 'AlphaGen');
  assert.ok(proposal.solution.includes('function isPalindrome'));
  assert.ok(proposal.stake >= 1 && proposal.stake <= 100);

  // Execute in oracle to verify correctness
  const oracleResult = await executeInSandbox(
    proposal.solution,
    'A man, a plan, a canal: Panama',
    true
  );
  assert.equal(oracleResult.verdict, 'PASSED');
});

test('MockAdapter: Buggy generator produces flawed solution that fails on punctuation', async () => {
  const adapter = new MockAdapter();
  const agent = createAgent({
    id: 'BuggyGen',
    role: 'GENERATOR',
    model: 'heuristic-naive',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  assert.equal(proposal.agentId, 'BuggyGen');
  // Oracle execution against multi-word palindrome must fail
  const oracleResult = await executeInSandbox(
    proposal.solution,
    'A man, a plan, a canal: Panama',
    true
  );
  assert.equal(oracleResult.verdict, 'FAILED');
});

test('MockAdapter: Sharp auditor detects flaw in buggy generator proposal', async () => {
  const adapter = new MockAdapter();
  const generator = createAgent({
    id: 'BuggyGen',
    role: 'GENERATOR',
    model: 'buggy-model',
    capital: 100,
  });
  const auditor = createAgent({
    id: 'SharpAuditor',
    role: 'AUDITOR',
    model: 'sharp-tester',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent: generator, problem: testProblem });
  const challenge = await adapter.generateChallenge({
    auditor,
    targetGenerator: generator,
    proposal,
    problem: testProblem,
  });

  assert.ok(challenge !== null);
  assert.equal(challenge.auditorId, 'SharpAuditor');
  assert.equal(challenge.targetAgentId, 'BuggyGen');
  assert.equal(challenge.testInput, 'A man, a plan, a canal: Panama');
  assert.equal(challenge.expectedOutput, true);
  assert.ok(challenge.stake >= 1 && challenge.stake <= 100);
});

test('MockAdapter: Prudent auditor declines to challenge solid generator proposal (returns null)', async () => {
  const adapter = new MockAdapter();
  const generator = createAgent({
    id: 'SolidGen',
    role: 'GENERATOR',
    model: 'solid-model',
    capital: 100,
  });
  const auditor = createAgent({
    id: 'PrudentAuditor',
    role: 'AUDITOR',
    model: 'prudent-tester',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent: generator, problem: testProblem });
  const challenge = await adapter.generateChallenge({
    auditor,
    targetGenerator: generator,
    proposal,
    problem: testProblem,
  });

  // Solid code with prudent auditor should decline challenge to avoid -1.5x penalty
  assert.equal(challenge, null);
});

test('MockAdapter: Reckless auditor lodges false-positive challenge against solid generator', async () => {
  const adapter = new MockAdapter();
  const generator = createAgent({
    id: 'SolidGen',
    role: 'GENERATOR',
    model: 'solid-model',
    capital: 100,
  });
  const auditor = createAgent({
    id: 'RecklessAuditor',
    role: 'AUDITOR',
    model: 'reckless-spammer',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent: generator, problem: testProblem });
  const challenge = await adapter.generateChallenge({
    auditor,
    targetGenerator: generator,
    proposal,
    problem: testProblem,
  });

  assert.ok(challenge !== null);
  assert.equal(challenge.auditorId, 'RecklessAuditor');
  assert.equal(challenge.targetAgentId, 'SolidGen');

  // Solid generator will actually pass this challenge, penalizing the reckless auditor
  const execResult = await executeInSandbox(
    proposal.solution,
    challenge.testInput,
    challenge.expectedOutput
  );
  assert.equal(execResult.verdict, 'PASSED');
});

test('MockAdapter: Custom handlers override default generation logic', async () => {
  const adapter = new MockAdapter({
    proposalHandler: () => ({
      solution: 'function customSolve() { return 42; }',
      stake: 50,
      reasoning: 'Custom fixed solution',
    }),
    challengeHandler: () => ({
      shouldChallenge: true,
      testInput: 'test',
      expectedOutput: 99,
      stake: 35,
    }),
  });

  const agent = createAgent({ id: 'G1', role: 'GENERATOR', model: 'test', capital: 100 });
  const auditor = createAgent({ id: 'A1', role: 'AUDITOR', model: 'test', capital: 100 });

  const proposal = await adapter.generateProposal({ agent, problem: testProblem });
  assert.equal(proposal.solution, 'function customSolve() { return 42; }');
  assert.equal(proposal.stake, 50);

  const challenge = await adapter.generateChallenge({
    auditor,
    targetGenerator: agent,
    proposal,
    problem: testProblem,
  });
  assert.ok(challenge !== null);
  assert.equal(challenge.expectedOutput, 99);
  assert.equal(challenge.stake, 35);
});

// ---------------------------------------------------------------------------
// 2. Strict JSON Extraction Utility Tests
// ---------------------------------------------------------------------------

test('extractJsonFromText: parses clean JSON string directly', () => {
  const input = '{"solution": "function test() {}", "stake": 25, "reasoning": "Valid"}';
  const result = extractJsonFromText(input) as any;
  assert.equal(result.stake, 25);
  assert.equal(result.solution, 'function test() {}');
});

test('extractJsonFromText: strips markdown code fences', () => {
  const input = `\`\`\`json
{
  "solution": "function foo() { return 1; }",
  "stake": 15,
  "reasoning": "fenced"
}
\`\`\``;
  const result = extractJsonFromText(input) as any;
  assert.equal(result.stake, 15);
  assert.equal(result.solution, 'function foo() { return 1; }');
});

test('extractJsonFromText: extracts JSON object embedded in conversational commentary', () => {
  const input = `Sure! Here is the JSON response for the challenge:
{
  "shouldChallenge": true,
  "testInput": 0,
  "expectedOutput": 0,
  "stake": 20
}
Let me know if you need more edge cases.`;
  const result = extractJsonFromText(input) as any;
  assert.equal(result.shouldChallenge, true);
  assert.equal(result.stake, 20);
});

test('extractJsonFromText: throws clean error when no JSON can be parsed', () => {
  assert.throws(
    () => extractJsonFromText('I cannot provide a JSON response right now.'),
    /Failed to parse strict JSON/
  );
});

test('extractJsonFromText: tolerates trailing commas in objects and arrays emitted by small LLMs', () => {
  const input = `{
    "solution": "function solve() { return true; }",
    "stake": 30,
    "reasoning": "Valid with trailing comma",
  }`;
  const result = extractJsonFromText(input) as any;
  assert.equal(result.stake, 30);
  assert.equal(result.solution, 'function solve() { return true; }');
  assert.equal(result.reasoning, 'Valid with trailing comma');
});

test('extractJsonFromText: strips thinking tags emitted by reasoning models like Qwen or DeepSeek', () => {
  const input = `<think>
I need to check palindrome edge cases and sanitize non-alphanumeric chars.
The function isPalindrome should clean string and compare reversed.
</think>
\`\`\`json
{
  "solution": "function isPalindrome(s) { const clean = s.toLowerCase().replace(/[^a-z0-9]/g, ''); return clean === clean.split('').reverse().join(''); }",
  "stake": 25,
  "reasoning": "Normalized palindrome check"
}
\`\`\``;
  const result = extractJsonFromText(input) as any;
  assert.equal(result.stake, 25);
  assert.ok(result.solution.includes('isPalindrome'));
  assert.equal(result.reasoning, 'Normalized palindrome check');
});

test('createAgentAdapter: dynamically routes to OpenAICompatibleAdapter when agent has dedicated apiKey', () => {
  const agent = createAgent({
    id: 'AgentGemini',
    role: 'GENERATOR',
    model: 'gemini-3.5-flash-lite',
    capital: 100,
    apiKey: 'AIzaSyTestDedicatedKey',
  });
  const adapter = createAgentAdapter(agent);
  assert.ok(adapter instanceof OpenAICompatibleAdapter);
  assert.equal((adapter as any).apiKey, 'AIzaSyTestDedicatedKey');
  assert.equal((adapter as any).defaultModel, 'gemini-3.5-flash-lite');
});

test('createAgentAdapter: routes to local Ollama when agent has custom baseUrl', () => {
  const agent = createAgent({
    id: 'AgentOllama',
    role: 'AUDITOR',
    model: 'llama3.2',
    capital: 100,
    baseUrl: 'http://localhost:11434/v1',
  });
  const adapter = createAgentAdapter(agent);
  assert.ok(adapter instanceof OpenAICompatibleAdapter);
  assert.equal((adapter as any).resolveBaseUrlForModel(), 'http://localhost:11434/v1');
});

test('createAgentAdapter: falls back to MockAdapter when no credentials are provided and offline', () => {
  const origEnv = { ...process.env };
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const agent = createAgent({
      id: 'OfflineGen',
      role: 'GENERATOR',
      model: 'mock-model',
      capital: 100,
    });
    const adapter = createAgentAdapter(agent);
    assert.ok(adapter instanceof MockAdapter);
  } finally {
    process.env = origEnv;
  }
});

// ---------------------------------------------------------------------------
// 3. OpenAICompatibleAdapter Tests (Using Mock Fetch)
// ---------------------------------------------------------------------------

test('OpenAICompatibleAdapter: Generates proposal via mock fetch with strict JSON response', async () => {
  const mockFetch: typeof fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/chat/completions'));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format?.type, 'json_object');

    const fakeResponseBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              solution: 'function isPalindrome(s) { return true; }',
              stake: 45,
              reasoning: 'Trivial true implementation',
            }),
          },
        },
      ],
    };

    return new Response(JSON.stringify(fakeResponseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const adapter = new OpenAICompatibleAdapter({
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    fetchFn: mockFetch,
  });

  const agent = createAgent({ id: 'LLMGen', role: 'GENERATOR', model: 'llama3', capital: 80 });
  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  assert.equal(proposal.agentId, 'LLMGen');
  assert.equal(proposal.solution, 'function isPalindrome(s) { return true; }');
  assert.equal(proposal.stake, 45);
});

test('OpenAICompatibleAdapter: Generates challenge when model returns shouldChallenge=true', async () => {
  const mockFetch: typeof fetch = async () => {
    const fakeResponseBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              shouldChallenge: true,
              testInput: 'not-a-palindrome',
              expectedOutput: false,
              stake: 30,
              reasoning: 'Input is asymmetric',
            }),
          },
        },
      ],
    };

    return new Response(JSON.stringify(fakeResponseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const adapter = new OpenAICompatibleAdapter({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  const generator = createAgent({ id: 'G1', role: 'GENERATOR', model: 'm1', capital: 100 });
  const auditor = createAgent({ id: 'A1', role: 'AUDITOR', model: 'm2', capital: 100 });
  const proposal = { agentId: 'G1', solution: 'function isPalindrome() { return true; }', stake: 20, reasoning: 'all true' };

  const challenge = await adapter.generateChallenge({
    auditor,
    targetGenerator: generator,
    proposal,
    problem: testProblem,
  });

  assert.ok(challenge !== null);
  assert.equal(challenge.auditorId, 'A1');
  assert.equal(challenge.targetAgentId, 'G1');
  assert.equal(challenge.testInput, 'not-a-palindrome');
  assert.equal(challenge.expectedOutput, false);
  assert.equal(challenge.stake, 30);
});

test('OpenAICompatibleAdapter: Declines challenge when model returns shouldChallenge=false', async () => {
  const mockFetch: typeof fetch = async () => {
    const fakeResponseBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              shouldChallenge: false,
              reasoning: 'Code looks perfectly solid; avoiding false positive penalty.',
            }),
          },
        },
      ],
    };

    return new Response(JSON.stringify(fakeResponseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const adapter = new OpenAICompatibleAdapter({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  const generator = createAgent({ id: 'G1', role: 'GENERATOR', model: 'm1', capital: 100 });
  const auditor = createAgent({ id: 'A1', role: 'AUDITOR', model: 'm2', capital: 100 });
  const proposal = { agentId: 'G1', solution: 'function isPalindrome(s) { ... }', stake: 20, reasoning: 'solid' };

  const challenge = await adapter.generateChallenge({
    auditor,
    targetGenerator: generator,
    proposal,
    problem: testProblem,
  });

  assert.equal(challenge, null);
});

test('OpenAICompatibleAdapter: Clamps excessive stake to available agent capital', async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                solution: 'function test() {}',
                stake: 500, // Exceeds agent capital (50)
                reasoning: 'Overconfident stake',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  const agent = createAgent({ id: 'Gen1', role: 'GENERATOR', model: 'test', capital: 50 });
  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  // Stake must be clamped to capital (50)
  assert.equal(proposal.stake, 50);
});

test('OpenAICompatibleAdapter: Handles 400 response_format rejection with seamless retry', async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async (_, init) => {
    callCount++;
    const body = JSON.parse(String(init?.body));
    if (callCount === 1) {
      assert.ok(body.response_format);
      return new Response('{"error": "response_format is not supported"}', { status: 400 });
    }
    // Second call: response_format removed
    assert.equal(body.response_format, undefined);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"solution": "function retry() { return 1; }", "stake": 10, "reasoning": "retry ok"}',
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  const agent = createAgent({ id: 'RetryGen', role: 'GENERATOR', model: 'test', capital: 100 });
  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  assert.equal(callCount, 2);
  assert.equal(proposal.solution, 'function retry() { return 1; }');
  assert.equal(proposal.stake, 10);
});

test('OpenAICompatibleAdapter: Routes Ollama local models to native /api/chat with think:false', async () => {
  let calledUrl = '';
  let calledBody: any = null;

  const mockFetch: typeof fetch = async (url, init) => {
    calledUrl = String(url);
    calledBody = JSON.parse(String(init?.body));
    // Simulate Ollama /api/chat non-streaming response
    return new Response(
      JSON.stringify({
        model: 'qwen3.5:4b',
        message: {
          role: 'assistant',
          content: '{"solution": "function isPalindrome(s) { return true; }", "stake": 25, "reasoning": "Direct"}',
        },
        done: true,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    model: 'qwen3.5:4b',
    fetchFn: mockFetch,
  });

  const agent = createAgent({ id: 'QwenGen', role: 'GENERATOR', model: 'qwen3.5:4b', capital: 100 });
  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  // Must use native /api/chat endpoint
  assert.ok(calledUrl.includes('/api/chat'), `Expected /api/chat, got: ${calledUrl}`);
  // Must send think:false to disable reasoning loops
  assert.equal(calledBody.think, false);
  assert.equal(proposal.solution, 'function isPalindrome(s) { return true; }');
  assert.equal(proposal.stake, 25);
  assert.equal(proposal.reasoning, 'Direct');
});

// ---------------------------------------------------------------------------
// 4. Dynamic Model Resolution Tests
// ---------------------------------------------------------------------------

test('resolveDefaultModel: returns exact model name when LLM_MODEL is set', () => {
  const originalEnv = { ...process.env };
  try {
    process.env.LLM_MODEL = 'qwen2.5-coder:7b';
    process.env.LLM_API_KEY = 'AIzaSy123456';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    // LLM_MODEL takes precedence over everything
    assert.equal(resolveDefaultModel(), 'qwen2.5-coder:7b');
  } finally {
    process.env = originalEnv;
  }
});

test('resolveDefaultModel: defaults to gemini-3.5-flash-lite when LLM_API_KEY starts with AIza', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.LLM_MODEL;
    process.env.LLM_API_KEY = 'AIzaSyFakeGeminiKey123';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    // AIza key takes precedence over 11434 base URL
    assert.equal(resolveDefaultModel(), 'gemini-3.5-flash-lite');
  } finally {
    process.env = originalEnv;
  }
});

test('resolveDefaultModel: defaults to gemini-3.5-flash-lite when LLM_API_KEY starts with AQ. (Google AI Studio format)', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.LLM_MODEL;
    process.env.LLM_API_KEY = 'AQ.Ab8RNFakeKey123';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    assert.equal(resolveDefaultModel(), 'gemini-3.5-flash-lite');
  } finally {
    process.env = originalEnv;
  }
});

test('OpenAICompatibleAdapter: routes to Google Generative Language endpoint for AQ. keys and gemini models', () => {
  const adapterWithKey = new OpenAICompatibleAdapter({ apiKey: 'AQ.Ab8RNTestKey' });
  assert.equal((adapterWithKey as any).baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');

  const adapterWithModel = new OpenAICompatibleAdapter({ model: 'gemini-3.5-flash-lite', apiKey: 'custom-key' });
  assert.equal((adapterWithModel as any).baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('resolveDefaultModel: defaults to llama3.2 when LLM_BASE_URL contains 11434 (Ollama)', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.LLM_MODEL;
    delete process.env.LLM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    assert.equal(resolveDefaultModel(), 'llama3.2');
  } finally {
    process.env = originalEnv;
  }
});

test('resolveDefaultModel: defaults to gpt-4o-mini as universal fallback', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.LLM_MODEL;
    delete process.env.LLM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.LLM_BASE_URL;

    assert.equal(resolveDefaultModel(), 'gpt-4o-mini');
  } finally {
    process.env = originalEnv;
  }
});

test('resolveDefaultModel: falls back to gpt-4o-mini when non-AIza key and non-11434 url are used', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.LLM_MODEL;
    process.env.LLM_API_KEY = 'sk-proj-openai12345';
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1';

    assert.equal(resolveDefaultModel(), 'gpt-4o-mini');
  } finally {
    process.env = originalEnv;
  }
});

test('normalizeModelName: preserves model name and strips models/ prefix without fake aliases', () => {
  assert.equal(normalizeModelName('models/gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(normalizeModelName('models/gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(normalizeModelName('models/gemini-4-hydrogen'), 'gemini-4-hydrogen');
  assert.equal(normalizeModelName('  gemini-2.5-flash  '), 'gemini-3.5-flash-lite');
  assert.equal(normalizeModelName('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(normalizeModelName('gpt-4o'), 'gpt-4o');
  assert.equal(normalizeModelName('llama3.2'), 'llama3.2');
});

test('createAgentAdapter: smartly resolves providerKeys based on model family', () => {
  const geminiAgent = createAgent({ id: 'Gemini1', role: 'GENERATOR', model: 'gemini-1.5-flash', capital: 100 });
  const openAiAgent = createAgent({ id: 'OpenAI1', role: 'AUDITOR', model: 'gpt-4o-mini', capital: 100 });
  const ollamaAgent = createAgent({ id: 'Ollama1', role: 'GENERATOR', model: 'qwen3.5:4b', capital: 100 });

  const providerKeys = {
    gemini: 'AIzaSyGeminiKey999',
    openai: 'sk-proj-OpenAiKey888',
  };

  const adapterGemini = createAgentAdapter(geminiAgent, { providerKeys }) as any;
  assert.equal(adapterGemini.apiKey, 'AIzaSyGeminiKey999');

  const adapterOpenAI = createAgentAdapter(openAiAgent, { providerKeys }) as any;
  assert.equal(adapterOpenAI.apiKey, 'sk-proj-OpenAiKey888');

  const adapterOllama = createAgentAdapter(ollamaAgent, { providerKeys }) as any;
  assert.equal(adapterOllama.apiKey, undefined);
  assert.ok(adapterOllama.baseUrl.includes('11434'));
});

test('createAgentAdapter: never routes gemini or openai models to local Ollama even if baseUrl is Ollama', () => {
  const geminiAgentWithOllamaUrl = createAgent({
    id: 'GeminiPolluted',
    role: 'GENERATOR',
    model: 'gemini-2.0-flash',
    capital: 100,
    baseUrl: 'http://127.0.0.1:11434/v1',
  });

  const adapter = createAgentAdapter(geminiAgentWithOllamaUrl, {
    globalBaseUrl: 'http://127.0.0.1:11434/v1',
    providerKeys: { gemini: 'AIzaSyGoogleKey123' },
  }) as any;

  assert.equal(adapter.apiKey, 'AIzaSyGoogleKey123');
  assert.equal(adapter.resolveBaseUrlForModel(), 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('OpenAICompatibleAdapter: resolveBaseUrlForModel routes gemini to Google even if customBaseUrl is Ollama', () => {
  const adapter = new OpenAICompatibleAdapter({
    model: 'gemini-2.0-flash',
    apiKey: 'AQ.TestKey',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });

  assert.equal(adapter.resolveBaseUrlForModel(), 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('OpenAICompatibleAdapter: preserves agent model even when agent specifies gemini-3.5-flash-lite', async () => {
  let capturedBody: any = null;
  const mockFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                solution: 'function isPalindrome(s) { return true; }',
                stake: 20,
                reasoning: 'Normalized test',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'AQ.TestKey',
    fetchFn: mockFetch,
  });

  const agent = createAgent({
    id: 'AlphaGen',
    role: 'GENERATOR',
    model: 'gemini-3.5-flash-lite',
    capital: 100,
  });

  await adapter.generateProposal({ agent, problem: testProblem });

  assert.ok(capturedBody !== null);
  assert.equal(capturedBody.model, 'gemini-3.5-flash-lite');
});

test('OpenAICompatibleAdapter: routes Ollama models to localhost:11434', () => {
  const adapter = new OpenAICompatibleAdapter();
  assert.equal(adapter.resolveBaseUrlForModel('llama3.2'), 'http://localhost:11434/v1');
  assert.equal(adapter.resolveBaseUrlForModel('qwen2.5-coder:7b'), 'http://localhost:11434/v1');
  assert.equal(adapter.resolveBaseUrlForModel('deepseek-chat'), 'http://localhost:11434/v1');
});

test('getModelFallbacks: returns fallback candidates for models', () => {
  assert.deepEqual(getModelFallbacks('gemini-3.8-flash'), ['gemini-3.5-flash-lite', 'gemini-3.6-flash']);
  assert.deepEqual(getModelFallbacks('gemini-4-argon'), ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(getModelFallbacks('gemini-2.0-flash'), ['gemini-3.8-flash', 'gemini-4-hydrogen']);
  assert.deepEqual(getModelFallbacks('gpt-4o'), ['gpt-4o-mini']);
  assert.deepEqual(getModelFallbacks('llama3.2'), []);
});

test('OpenAICompatibleAdapter: retries transient 503 Service Unavailable and recovers', async () => {
  let attemptCount = 0;
  const mockFetch: typeof fetch = async () => {
    attemptCount++;
    if (attemptCount === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                solution: 'function isPalindrome(s) { return true; }',
                stake: 25,
                reasoning: 'Recovered from 503',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    model: 'gemini-1.5-flash',
    apiKey: 'AQ.TestKey',
    maxRetries: 2,
    retryDelayMs: 10,
    fetchFn: mockFetch,
  });

  const agent = createAgent({
    id: 'AlphaGen',
    role: 'GENERATOR',
    model: 'gemini-1.5-flash',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent, problem: testProblem });
  assert.equal(attemptCount, 2);
  assert.equal(proposal.agentId, 'AlphaGen');
  assert.equal(proposal.stake, 25);
});

test('OpenAICompatibleAdapter: configures reasoning_effort: "low" on Gemini 3 models', async () => {
  let capturedBody: any = null;
  const mockFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                solution: 'function isPalindrome(s) { return true; }',
                stake: 30,
                reasoning: 'Reasoning effort low test',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    model: 'gemini-3.8-flash',
    apiKey: 'AQ.TestKey',
    fetchFn: mockFetch,
  });

  const agent = createAgent({
    id: 'AlphaGen',
    role: 'GENERATOR',
    model: 'gemini-3.8-flash',
    capital: 100,
  });

  await adapter.generateProposal({ agent, problem: testProblem });

  assert.equal(capturedBody.model, 'gemini-3.8-flash');
  assert.equal(capturedBody.reasoning_effort, 'low');
});

test('OpenAICompatibleAdapter: strictly retries the exact chosen model without substituting models', async () => {
  const attemptedModels: string[] = [];
  let attempts = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    attempts++;
    const body = JSON.parse(init?.body as string);
    attemptedModels.push(body.model);

    if (attempts === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'High demand spike' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                solution: 'function isPalindrome(s) { return true; }',
                stake: 30,
                reasoning: 'Generated by exact model after retry',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    model: 'gemini-3.8-flash',
    apiKey: 'AQ.TestKey',
    maxRetries: 2,
    retryDelayMs: 10,
    fetchFn: mockFetch,
  });

  const agent = createAgent({
    id: 'AlphaGen',
    role: 'GENERATOR',
    model: 'gemini-3.8-flash',
    capital: 100,
  });

  const proposal = await adapter.generateProposal({ agent, problem: testProblem });

  // Both attempts strictly used the exact chosen model 'gemini-3.8-flash'
  assert.equal(attempts, 2);
  assert.equal(attemptedModels.length, 2);
  assert.ok(attemptedModels.every((m) => m === 'gemini-3.8-flash'));
  assert.equal(proposal.agentId, 'AlphaGen');
});

test('OpenAICompatibleAdapter: aborts immediately on plan restriction (limit: 0) without wasteful retries', async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          message:
            "Quota exceeded for quota metric 'Generate Content Requests' and limit '0' of service 'generativelanguage.googleapis.com'",
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const adapter = new OpenAICompatibleAdapter({
    model: 'gemini-4-carbon',
    apiKey: 'AQ.TestKey',
    maxRetries: 3,
    retryDelayMs: 10,
    fetchFn: mockFetch,
  });

  const agent = createAgent({
    id: 'CarbonGen',
    role: 'GENERATOR',
    model: 'gemini-4-carbon',
    capital: 100,
  });

  await assert.rejects(
    async () => {
      await adapter.generateProposal({ agent, problem: testProblem });
    },
    (err: Error) => {
      assert.ok(err.message.includes('Plan Restriction (Free Tier Limit: 0)'));
      assert.ok(err.message.includes('gemini-4-carbon'));
      assert.ok(err.message.includes('requires a paid billing account'));
      return true;
    }
  );

  // Exactly 1 attempt made, aborted immediately without 3 wasteful retries
  assert.equal(callCount, 1);
});

test('DEFAULT_MOCK_CATALOG: All 10 catalog entries verified against flawChallenge inputs (solid passes, buggy fails)', () => {
  const problemIds = Object.keys(DEFAULT_MOCK_CATALOG);
  assert.equal(problemIds.length, 10, `Expected exactly 10 problems in DEFAULT_MOCK_CATALOG, got ${problemIds.length}`);

  for (const id of problemIds) {
    const entry = DEFAULT_MOCK_CATALOG[id];
    assert.ok(entry, `Catalog entry for '${id}' must exist`);
    assert.ok(entry.solid, `Solid definition for '${id}' must exist`);
    assert.ok(entry.buggy, `Buggy definition for '${id}' must exist`);
    assert.ok(entry.flawChallenge, `Flaw challenge for '${id}' must exist`);

    const solidResult = executeInSandboxSync(
      entry.solid.solution,
      entry.flawChallenge.testInput,
      entry.flawChallenge.expectedOutput
    );
    assert.equal(
      solidResult.passed,
      true,
      `Solid solution for '${id}' must PASS flawChallenge input (${JSON.stringify(entry.flawChallenge.testInput)} -> expected ${JSON.stringify(entry.flawChallenge.expectedOutput)}). Got verdict ${solidResult.verdict}, actual: ${JSON.stringify(solidResult.actualOutput)}`
    );

    const buggyResult = executeInSandboxSync(
      entry.buggy.solution,
      entry.flawChallenge.testInput,
      entry.flawChallenge.expectedOutput
    );
    assert.equal(
      buggyResult.passed,
      false,
      `Buggy solution for '${id}' must FAIL flawChallenge input (${JSON.stringify(entry.flawChallenge.testInput)} -> expected ${JSON.stringify(entry.flawChallenge.expectedOutput)}). Got verdict ${buggyResult.verdict}, actual: ${JSON.stringify(buggyResult.actualOutput)}`
    );
  }
});
