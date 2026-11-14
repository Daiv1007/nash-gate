/**
 * Unit Tests: Edge Cases, Complex Multi-Agent Settlements, and Bankruptcy Cascades
 * Verifies all boundary conditions, zero/negative balances, and multi-auditor interactions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  settleRound,
  createAgent,
  filterActiveAgents,
  isBankrupt,
} from '../src/core/index.ts';
import type {
  Agent,
  Proposal,
  Challenge,
  ChallengeEvaluation,
} from '../src/core/index.ts';

test('Edge Case: All-in Generator FAILS and transitions to BANKRUPT at exact 0 capital', () => {
  const generator: Agent = {
    id: 'gen-allin',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const auditor: Agent = {
    id: 'aud-hunter',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-allin',
    solution: 'vulnerable_code()',
    stake: 100, // All-in stake
    reasoning: 'High confidence',
  };

  const challenge: Challenge = {
    auditorId: 'aud-hunter',
    targetAgentId: 'gen-allin',
    testInput: 'exploit',
    expectedOutput: 'safe',
    stake: 50,
  };

  const evaluations: ChallengeEvaluation[] = [
    {
      challenge,
      generatorPassed: false, // Exploit succeeds, generator fails
    },
  ];

  const result = settleRound({
    agents: [generator, auditor],
    proposals: [proposal],
    evaluations,
  });

  const updatedGen = result.updatedAgents.find((a) => a.id === 'gen-allin')!;
  const updatedAud = result.updatedAgents.find((a) => a.id === 'aud-hunter')!;

  assert.strictEqual(updatedGen.capital, 0, 'Capital clamped to 0');
  assert.strictEqual(updatedGen.status, 'BANKRUPT', 'Status transitions to BANKRUPT');
  assert.deepStrictEqual(result.bankruptAgentIds, ['gen-allin']);

  assert.strictEqual(updatedAud.capital, 200, 'Auditor earns 100 stake bounty (100 + 100)');
  assert.strictEqual(updatedAud.status, 'ACTIVE');
});

test('Edge Case: Auditor false positive penalty exceeds capital -> clamped to 0 and becomes BANKRUPT', () => {
  // Auditor capital = 50, stakes 40.
  // 1.5 * 40 = 60 penalty.
  // 50 - 60 = -10 -> Clamped to 0, BANKRUPT
  const generator: Agent = {
    id: 'gen-solid',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const auditor: Agent = {
    id: 'aud-reckless',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 50,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-solid',
    solution: 'robust_code()',
    stake: 40,
    reasoning: 'Resilient implementation',
  };

  const challenge: Challenge = {
    auditorId: 'aud-reckless',
    targetAgentId: 'gen-solid',
    testInput: 'random_noise',
    expectedOutput: 'error',
    stake: 40,
  };

  const evaluations: ChallengeEvaluation[] = [
    {
      challenge,
      generatorPassed: true, // Generator survives, auditor false positive
    },
  ];

  const result = settleRound({
    agents: [generator, auditor],
    proposals: [proposal],
    evaluations,
  });

  const updatedAud = result.updatedAgents.find((a) => a.id === 'aud-reckless')!;
  const updatedGen = result.updatedAgents.find((a) => a.id === 'gen-solid')!;

  // 50 - 60 = -10, clamped to 0
  assert.strictEqual(updatedAud.capital, 0);
  assert.strictEqual(updatedAud.status, 'BANKRUPT');
  assert.deepStrictEqual(result.bankruptAgentIds, ['aud-reckless']);

  // Generator earned 0.5 * 40 = 20
  assert.strictEqual(updatedGen.capital, 120);
  assert.strictEqual(updatedGen.status, 'ACTIVE');
});

test('Edge Case: Multiple auditors challenge the same proposal with mixed outcomes', () => {
  // G has stake 60.
  // Auditor A1 challenges with stake 20 -> G passes (A1 loses 1.5 * 20 = 30, G gains 0.5 * 60 = 30)
  // Auditor A2 challenges with stake 25 -> G fails (G loses 60, A2 gains 60)
  // Net G: 100 + 30 - 60 = 70
  // Net A1: 100 - 30 = 70
  // Net A2: 100 + 60 = 160
  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const auditor1: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const auditor2: Agent = {
    id: 'aud-2',
    role: 'AUDITOR',
    model: 'llama3',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-1',
    solution: 'partial_solution()',
    stake: 60,
    reasoning: '',
  };

  const challenge1: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'gen-1',
    testInput: 'trivial_case',
    expectedOutput: 'ok',
    stake: 20,
  };

  const challenge2: Challenge = {
    auditorId: 'aud-2',
    targetAgentId: 'gen-1',
    testInput: 'subtle_edge_case',
    expectedOutput: 'break',
    stake: 25,
  };

  const evaluations: ChallengeEvaluation[] = [
    { challenge: challenge1, generatorPassed: true },
    { challenge: challenge2, generatorPassed: false },
  ];

  const result = settleRound({
    agents: [generator, auditor1, auditor2],
    proposals: [proposal],
    evaluations,
  });

  const agentMap = new Map(result.updatedAgents.map((a) => [a.id, a]));

  assert.strictEqual(agentMap.get('gen-1')?.capital, 70);
  assert.strictEqual(agentMap.get('aud-1')?.capital, 70);
  assert.strictEqual(agentMap.get('aud-2')?.capital, 160);
});

test('Edge Case: Auditor challenges multiple generators simultaneously', () => {
  const auditor: Agent = { id: 'aud-pro', role: 'AUDITOR', model: 'gpt-4o', capital: 100, status: 'ACTIVE' };
  const gen1: Agent = { id: 'gen-1', role: 'GENERATOR', model: 'm1', capital: 100, status: 'ACTIVE' };
  const gen2: Agent = { id: 'gen-2', role: 'GENERATOR', model: 'm2', capital: 100, status: 'ACTIVE' };

  const prop1: Proposal = { agentId: 'gen-1', solution: 'code1', stake: 50, reasoning: '' };
  const prop2: Proposal = { agentId: 'gen-2', solution: 'code2', stake: 40, reasoning: '' };

  // Auditor challenges gen-1 (breaks it) and gen-2 (false positive)
  const chal1: Challenge = { auditorId: 'aud-pro', targetAgentId: 'gen-1', testInput: 1, expectedOutput: 2, stake: 30 };
  const chal2: Challenge = { auditorId: 'aud-pro', targetAgentId: 'gen-2', testInput: 2, expectedOutput: 3, stake: 20 };

  const evaluations: ChallengeEvaluation[] = [
    { challenge: chal1, generatorPassed: false }, // gen-1 fails -> aud gains 50
    { challenge: chal2, generatorPassed: true },  // gen-2 passes -> aud loses 1.5 * 20 = 30
  ];

  const result = settleRound({
    agents: [auditor, gen1, gen2],
    proposals: [prop1, prop2],
    evaluations,
  });

  const agentMap = new Map(result.updatedAgents.map((a) => [a.id, a]));

  // aud-pro: 100 + 50 - 30 = 120
  assert.strictEqual(agentMap.get('aud-pro')?.capital, 120);

  // gen-1: 100 - 50 = 50
  assert.strictEqual(agentMap.get('gen-1')?.capital, 50);

  // gen-2: 100 + (0.5 * 40) = 120
  assert.strictEqual(agentMap.get('gen-2')?.capital, 120);
});

test('Edge Case: Floating-point precision with fractional stakes and dividends', () => {
  const generator: Agent = { id: 'gen-f', role: 'GENERATOR', model: 'm1', capital: 100, status: 'ACTIVE' };
  const auditor: Agent = { id: 'aud-f', role: 'AUDITOR', model: 'm2', capital: 100, status: 'ACTIVE' };

  // Stake = 7.75
  const proposal: Proposal = { agentId: 'gen-f', solution: 'code', stake: 7.75, reasoning: '' };
  const challenge: Challenge = { auditorId: 'aud-f', targetAgentId: 'gen-f', testInput: 'x', expectedOutput: 'y', stake: 3.25 };

  // Generator passes:
  // gen dividend: 0.5 * 7.75 = 3.875
  // aud penalty: -1.5 * 3.25 = -4.875
  const evaluations: ChallengeEvaluation[] = [
    { challenge, generatorPassed: true },
  ];

  const result = settleRound({
    agents: [generator, auditor],
    proposals: [proposal],
    evaluations,
  });

  const agentMap = new Map(result.updatedAgents.map((a) => [a.id, a]));

  assert.strictEqual(agentMap.get('gen-f')?.capital, 103.875);
  assert.strictEqual(agentMap.get('aud-f')?.capital, 95.125);
});

test('Edge Case: Bankrupt agents are permanently rejected from subsequent rounds', () => {
  const bankruptGen: Agent = {
    id: 'gen-bankrupt',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 0,
    status: 'BANKRUPT',
  };

  const activeAud: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-bankrupt',
    solution: 'code',
    stake: 10,
    reasoning: '',
  };

  assert.throws(
    () =>
      settleRound({
        agents: [bankruptGen, activeAud],
        proposals: [proposal],
        evaluations: [],
      }),
    /Bankrupt agent 'gen-bankrupt' cannot submit proposals/
  );
});

test('Edge Case: Target generator with no active proposal throws during settlement', () => {
  const generator: Agent = { id: 'gen-1', role: 'GENERATOR', model: 'm1', capital: 100, status: 'ACTIVE' };
  const auditor: Agent = { id: 'aud-1', role: 'AUDITOR', model: 'm2', capital: 100, status: 'ACTIVE' };

  const challenge: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'gen-1',
    testInput: 1,
    expectedOutput: 2,
    stake: 20,
  };

  assert.throws(
    () =>
      settleRound({
        agents: [generator, auditor],
        proposals: [], // No proposal submitted!
        evaluations: [{ challenge, generatorPassed: false }],
      }),
    /Target generator 'gen-1' has no active proposal/
  );
});
