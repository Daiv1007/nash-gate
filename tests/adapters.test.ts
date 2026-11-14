/**
 * Unit Tests: NashGate Adapters (MockAdapter & OpenAICompatibleAdapter)
 * Verifies proposal generation, adversarial challenge creation, strict JSON parsing,
 * and stake normalization across adapter implementations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockAdapter,
  OpenAICompatibleAdapter,
  extractJsonFromText,
  resolveDefaultModel,
  type ProblemContext,
} from '../src/adapters/index.ts';
import { createAgent } from '../src/core/index.ts';
import { executeInSandbox } from '../src/oracle/index.ts';

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

test('resolveDefaultModel: defaults to gemini-2.5-flash when LLM_API_KEY starts with AIza', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.LLM_MODEL;
    process.env.LLM_API_KEY = 'AIzaSyFakeGeminiKey123';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    // AIza key takes precedence over 11434 base URL
    assert.equal(resolveDefaultModel(), 'gemini-2.5-flash');
  } finally {
    process.env = originalEnv;
  }
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
