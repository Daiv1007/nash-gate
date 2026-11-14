/**
 * Unit Tests: Round Settlement and Payoff Matrix
 * Verifies exact game-theoretic formulas, zero-sum transfers, and asymmetric penalties.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePairPayoff,
  calculateUnchallengedPayoff,
  settlePair,
  settleUnchallenged,
  settleRound,
  UNCHALLENGED_REWARD_MULTIPLIER,
  GENERATOR_PASS_REWARD_MULTIPLIER,
  AUDITOR_FAIL_PENALTY_MULTIPLIER,
} from '../src/core/index.ts';
import type {
  Agent,
  Proposal,
  Challenge,
  ChallengeEvaluation,
} from '../src/core/index.ts';

test('Payoff Rule 1: Generator FAILS (Auditor breaks the solution)', () => {
  // G.capital -= G.stake
  // A.capital += G.stake
  const generatorStake = 30;
  const auditorStake = 20;
  const generatorPassed = false; // Generator fails

  const payoff = calculatePairPayoff(generatorStake, auditorStake, generatorPassed);

  assert.strictEqual(payoff.generatorDelta, -30, 'Generator forfeits exact stake');
  assert.strictEqual(payoff.auditorDelta, +30, 'Auditor earns generator stake as bounty');
  assert.match(payoff.rationale, /Generator failed adversarial check/);
});

test('Payoff Rule 2: Generator PASSES (Auditor false positive spam)', () => {
  // A.capital -= (1.5 * A.stake) [asymmetric anti-spam penalty]
  // G.capital += (0.5 * G.stake) [resilience reward]
  const generatorStake = 40;
  const auditorStake = 20;
  const generatorPassed = true; // Generator passes

  const payoff = calculatePairPayoff(generatorStake, auditorStake, generatorPassed);

  const expectedGenDelta = 0.5 * generatorStake; // 20
  const expectedAudDelta = -(1.5 * auditorStake); // -30

  assert.strictEqual(payoff.generatorDelta, expectedGenDelta);
  assert.strictEqual(payoff.auditorDelta, expectedAudDelta);
  assert.match(payoff.rationale, /Generator passed adversarial check/);
});

test('Payoff Rule 3: Unchallenged Proposal awards 10% dividend', () => {
  // G.capital += (0.1 * G.stake)
  const generatorStake = 50;
  const payoff = calculateUnchallengedPayoff(generatorStake);

  const expectedDelta = 0.1 * generatorStake; // 5
  assert.strictEqual(payoff.generatorDelta, expectedDelta);
  assert.match(payoff.rationale, /Proposal unchallenged/);
});

test('settlePair performs pairwise settlement with full audit data', () => {
  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-1',
    solution: 'const add = (a, b) => a + b;',
    stake: 20,
    reasoning: 'Basic addition',
  };

  const auditor: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const challenge: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'gen-1',
    testInput: [1, 2],
    expectedOutput: 3,
    stake: 10,
  };

  const evalPass: ChallengeEvaluation = {
    challenge,
    generatorPassed: true,
  };

  const resultPass = settlePair(generator, proposal, auditor, evalPass);
  assert.strictEqual(resultPass.generatorId, 'gen-1');
  assert.strictEqual(resultPass.auditorId, 'aud-1');
  assert.strictEqual(resultPass.generatorPassed, true);
  assert.strictEqual(resultPass.generatorDelta, 10); // 0.5 * 20
  assert.strictEqual(resultPass.auditorDelta, -15); // -1.5 * 10

  const evalFail: ChallengeEvaluation = {
    challenge,
    generatorPassed: false,
  };

  const resultFail = settlePair(generator, proposal, auditor, evalFail);
  assert.strictEqual(resultFail.generatorPassed, false);
  assert.strictEqual(resultFail.generatorDelta, -20); // -20
  assert.strictEqual(resultFail.auditorDelta, 20); // +20
});

test('settleUnchallenged returns accurate dividend record', () => {
  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-1',
    solution: 'solution',
    stake: 60,
    reasoning: '',
  };

  const res = settleUnchallenged(generator, proposal);
  assert.strictEqual(res.agentId, 'gen-1');
  assert.strictEqual(res.stake, 60);
  assert.strictEqual(res.delta, 6); // 0.1 * 60
});

test('settleRound executes full deterministic consensus settlement', () => {
  const gen1: Agent = { id: 'gen-1', role: 'GENERATOR', model: 'm1', capital: 100, status: 'ACTIVE' };
  const gen2: Agent = { id: 'gen-2', role: 'GENERATOR', model: 'm2', capital: 100, status: 'ACTIVE' };
  const aud1: Agent = { id: 'aud-1', role: 'AUDITOR', model: 'm3', capital: 100, status: 'ACTIVE' };
  const aud2: Agent = { id: 'aud-2', role: 'AUDITOR', model: 'm4', capital: 100, status: 'ACTIVE' };

  // gen-1 proposal: challenged by aud-1, generator fails
  const prop1: Proposal = { agentId: 'gen-1', solution: 'code1', stake: 30, reasoning: '' };

  // gen-2 proposal: unchallenged
  const prop2: Proposal = { agentId: 'gen-2', solution: 'code2', stake: 40, reasoning: '' };

  const challenge1: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'gen-1',
    testInput: 'bug',
    expectedOutput: 'pass',
    stake: 20,
  };

  const evaluations: ChallengeEvaluation[] = [
    {
      challenge: challenge1,
      generatorPassed: false, // gen-1 fails
    },
  ];

  const roundResult = settleRound({
    agents: [gen1, gen2, aud1, aud2],
    proposals: [prop1, prop2],
    evaluations,
  });

  // Verify pair settlements
  assert.strictEqual(roundResult.pairSettlements.length, 1);
  assert.strictEqual(roundResult.pairSettlements[0].generatorDelta, -30);
  assert.strictEqual(roundResult.pairSettlements[0].auditorDelta, +30);

  // Verify unchallenged settlements
  assert.strictEqual(roundResult.unchallengedSettlements.length, 1);
  assert.strictEqual(roundResult.unchallengedSettlements[0].agentId, 'gen-2');
  assert.strictEqual(roundResult.unchallengedSettlements[0].delta, 4); // 0.1 * 40

  // Verify balances
  const agentMap = new Map(roundResult.updatedAgents.map((a) => [a.id, a]));

  // gen-1: 100 - 30 = 70
  assert.strictEqual(agentMap.get('gen-1')?.capital, 70);
  assert.strictEqual(agentMap.get('gen-1')?.status, 'ACTIVE');

  // aud-1: 100 + 30 = 130
  assert.strictEqual(agentMap.get('aud-1')?.capital, 130);
  assert.strictEqual(agentMap.get('aud-1')?.status, 'ACTIVE');

  // gen-2: 100 + 4 = 104
  assert.strictEqual(agentMap.get('gen-2')?.capital, 104);
  assert.strictEqual(agentMap.get('gen-2')?.status, 'ACTIVE');

  // aud-2 (unparticipating): 100
  assert.strictEqual(agentMap.get('aud-2')?.capital, 100);
  assert.strictEqual(agentMap.get('aud-2')?.status, 'ACTIVE');
});
