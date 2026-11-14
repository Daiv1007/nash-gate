/**
 * Unit Tests: Stake and Entity Validation
 * Verifies mathematical bounds, type constraints, and solvency checks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgent,
  validateStake,
  validateProposal,
  validateChallenge,
  validateRoundParticipation,
  validateAgentRoster,
  DEFAULT_INITIAL_CAPITAL,
  MIN_STAKE,
} from '../src/core/index.ts';
import type { Agent, Proposal, Challenge } from '../src/core/index.ts';

test('createAgent initializes default capital and active status', () => {
  const agent = createAgent({
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
  });

  assert.strictEqual(agent.id, 'gen-1');
  assert.strictEqual(agent.role, 'GENERATOR');
  assert.strictEqual(agent.model, 'gemini-2.5-flash');
  assert.strictEqual(agent.capital, DEFAULT_INITIAL_CAPITAL);
  assert.strictEqual(agent.status, 'ACTIVE');
});

test('createAgent accepts custom capital', () => {
  const agent = createAgent({
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 250,
  });

  assert.strictEqual(agent.capital, 250);
  assert.strictEqual(agent.status, 'ACTIVE');
});

test('createAgent with 0 capital is marked BANKRUPT', () => {
  const agent = createAgent({
    id: 'dead-agent',
    role: 'GENERATOR',
    model: 'llama3',
    capital: 0,
  });

  assert.strictEqual(agent.capital, 0);
  assert.strictEqual(agent.status, 'BANKRUPT');
});

test('createAgent throws on invalid parameters', () => {
  assert.throws(() => createAgent({ id: '', role: 'GENERATOR', model: 'llama3' }), /id must be a non-empty string/);
  assert.throws(() => createAgent({ id: 'a', role: 'INVALID' as any, model: 'llama3' }), /Invalid agent role/);
  assert.throws(() => createAgent({ id: 'a', role: 'GENERATOR', model: '' }), /model must be a non-empty string/);
  assert.throws(() => createAgent({ id: 'a', role: 'GENERATOR', model: 'llama3', capital: -10 }), /cannot be negative/);
  assert.throws(() => createAgent({ id: 'a', role: 'GENERATOR', model: 'llama3', capital: NaN }), /valid finite number/);
});

test('validateStake accepts valid stakes within [1, capital]', () => {
  const res1 = validateStake(1, 100);
  assert.strictEqual(res1.valid, true);

  const res2 = validateStake(50, 100);
  assert.strictEqual(res2.valid, true);

  // All-in boundary
  const res3 = validateStake(100, 100);
  assert.strictEqual(res3.valid, true);
});

test('validateStake rejects stakes below MIN_STAKE (1)', () => {
  const res0 = validateStake(0, 100);
  assert.strictEqual(res0.valid, false);
  assert.match(res0.errors[0], /must be at least MIN_STAKE/);

  const resNeg = validateStake(-10, 100);
  assert.strictEqual(resNeg.valid, false);

  const resFraction = validateStake(0.5, 100);
  assert.strictEqual(resFraction.valid, false);
});

test('validateStake rejects stakes exceeding agent capital', () => {
  const res = validateStake(101, 100);
  assert.strictEqual(res.valid, false);
  assert.match(res.errors[0], /cannot exceed available agent capital/);
});

test('validateStake rejects non-numeric or non-finite stakes', () => {
  const resNaN = validateStake(NaN, 100);
  assert.strictEqual(resNaN.valid, false);

  const resInf = validateStake(Infinity, 100);
  assert.strictEqual(resInf.valid, false);

  const resCapNaN = validateStake(10, NaN);
  assert.strictEqual(resCapNaN.valid, false);
});

test('validateStake rejects when agent capital is below MIN_STAKE', () => {
  const res = validateStake(1, 0.5);
  assert.strictEqual(res.valid, false);
  assert.match(res.errors[0], /insufficient capital/);
});

test('validateProposal validates valid generator proposals', () => {
  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposal: Proposal = {
    agentId: 'gen-1',
    solution: 'def solve(x): return x * 2',
    stake: 25,
    reasoning: 'O(1) optimal implementation',
  };

  const res = validateProposal(proposal, generator);
  assert.strictEqual(res.valid, true);
});

test('validateProposal rejects invalid proposal submissions', () => {
  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const bankruptGen: Agent = {
    ...generator,
    id: 'gen-dead',
    capital: 0,
    status: 'BANKRUPT',
  };

  const auditorAgent: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  // Bankrupt generator
  const resBankrupt = validateProposal({ agentId: 'gen-dead', solution: 'code', stake: 10, reasoning: '' }, bankruptGen);
  assert.strictEqual(resBankrupt.valid, false);
  assert.match(resBankrupt.errors[0], /BANKRUPT/);

  // Wrong role (auditor submitting proposal)
  const resRole = validateProposal({ agentId: 'aud-1', solution: 'code', stake: 10, reasoning: '' }, auditorAgent);
  assert.strictEqual(resRole.valid, false);
  assert.match(resRole.errors[0], /Only 'GENERATOR'/);

  // Mismatched agentId
  const resMismatch = validateProposal({ agentId: 'other-id', solution: 'code', stake: 10, reasoning: '' }, generator);
  assert.strictEqual(resMismatch.valid, false);
  assert.match(resMismatch.errors[0], /does not match/);

  // Empty solution
  const resEmptySol = validateProposal({ agentId: 'gen-1', solution: '   ', stake: 10, reasoning: '' }, generator);
  assert.strictEqual(resEmptySol.valid, false);
  assert.match(resEmptySol.errors[0], /non-empty string/);

  // Excessive stake
  const resHighStake = validateProposal({ agentId: 'gen-1', solution: 'code', stake: 150, reasoning: '' }, generator);
  assert.strictEqual(resHighStake.valid, false);
  assert.match(resHighStake.errors[0], /cannot exceed/);
});

test('validateChallenge validates compliant auditor challenges', () => {
  const auditor: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const challenge: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'gen-1',
    testInput: -5,
    expectedOutput: -10,
    stake: 20,
  };

  const res = validateChallenge(challenge, auditor, generator);
  assert.strictEqual(res.valid, true);
});

test('validateChallenge rejects non-compliant challenges', () => {
  const auditor: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const generator: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  // Self-challenge
  const selfChallenge: Challenge = {
    auditorId: 'aud-1',
    targetAgentId: 'aud-1',
    testInput: 1,
    expectedOutput: 2,
    stake: 10,
  };
  const resSelf = validateChallenge(selfChallenge, auditor, auditor as any);
  assert.strictEqual(resSelf.valid, false);

  // Non-auditor attempting to challenge
  const resGenChal = validateChallenge(
    { auditorId: 'gen-1', targetAgentId: 'gen-1', testInput: 1, expectedOutput: 2, stake: 10 },
    generator,
    generator
  );
  assert.strictEqual(resGenChal.valid, false);
  assert.match(resGenChal.errors[0], /Only 'AUDITOR'/);

  // Bankrupt auditor
  const bankruptAud: Agent = { ...auditor, capital: 0, status: 'BANKRUPT' };
  const resBankruptAud = validateChallenge(
    { auditorId: 'aud-1', targetAgentId: 'gen-1', testInput: 1, expectedOutput: 2, stake: 10 },
    bankruptAud,
    generator
  );
  assert.strictEqual(resBankruptAud.valid, false);
  assert.match(resBankruptAud.errors[0], /BANKRUPT/);

  // Target generator is bankrupt
  const bankruptGen: Agent = { ...generator, capital: 0, status: 'BANKRUPT' };
  const resBankruptGen = validateChallenge(
    { auditorId: 'aud-1', targetAgentId: 'gen-1', testInput: 1, expectedOutput: 2, stake: 10 },
    auditor,
    bankruptGen
  );
  assert.strictEqual(resBankruptGen.valid, false);
  assert.match(resBankruptGen.errors[0], /BANKRUPT/);
});

test('validateRoundParticipation detects over-committed cumulative stakes', () => {
  const auditor: Agent = {
    id: 'aud-1',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 100,
    status: 'ACTIVE',
  };

  const gen1: Agent = {
    id: 'gen-1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 100,
    status: 'ACTIVE',
  };

  const gen2: Agent = {
    id: 'gen-2',
    role: 'GENERATOR',
    model: 'llama3',
    capital: 100,
    status: 'ACTIVE',
  };

  const proposals: Proposal[] = [
    { agentId: 'gen-1', solution: 'code1', stake: 30, reasoning: '' },
    { agentId: 'gen-2', solution: 'code2', stake: 40, reasoning: '' },
  ];

  // Auditor has 100 capital, but stakes 60 + 60 = 120
  const challenges: Challenge[] = [
    { auditorId: 'aud-1', targetAgentId: 'gen-1', testInput: 1, expectedOutput: 2, stake: 60 },
    { auditorId: 'aud-1', targetAgentId: 'gen-2', testInput: 2, expectedOutput: 4, stake: 60 },
  ];

  const res = validateRoundParticipation([auditor, gen1, gen2], proposals, challenges);
  assert.strictEqual(res.valid, false);
  assert.match(res.errors[0], /over-committed capital/);
});

test('validateAgentRoster accepts valid roster with at least 1 generator and 1 auditor', () => {
  const roster = [
    createAgent({ id: 'G1', role: 'GENERATOR', model: 'm1', capital: 100 }),
    createAgent({ id: 'A1', role: 'AUDITOR', model: 'm2', capital: 100 }),
  ];
  const res = validateAgentRoster(roster);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.errors.length, 0);
});

test('validateAgentRoster rejects roster with fewer than 2 agents', () => {
  const roster = [createAgent({ id: 'G1', role: 'GENERATOR', model: 'm1', capital: 100 })];
  const res = validateAgentRoster(roster);
  assert.strictEqual(res.valid, false);
  assert.match(res.errors[0], /at least 2 agents/);
});

test('validateAgentRoster rejects duplicate agent IDs', () => {
  const roster = [
    createAgent({ id: 'DuplicateId', role: 'GENERATOR', model: 'm1', capital: 100 }),
    createAgent({ id: 'DuplicateId', role: 'AUDITOR', model: 'm2', capital: 100 }),
  ];
  const res = validateAgentRoster(roster);
  assert.strictEqual(res.valid, false);
  assert.match(res.errors[0], /Duplicate agent ID/);
});

test('validateAgentRoster rejects roster with no active generators or no active auditors', () => {
  const noAuditors = [
    createAgent({ id: 'G1', role: 'GENERATOR', model: 'm1', capital: 100 }),
    createAgent({ id: 'G2', role: 'GENERATOR', model: 'm2', capital: 100 }),
  ];
  const resNoAud = validateAgentRoster(noAuditors);
  assert.strictEqual(resNoAud.valid, false);
  assert.match(resNoAud.errors[0], /at least one active AUDITOR/);

  const noGenerators = [
    createAgent({ id: 'A1', role: 'AUDITOR', model: 'm1', capital: 100 }),
    createAgent({ id: 'A2', role: 'AUDITOR', model: 'm2', capital: 100 }),
  ];
  const resNoGen = validateAgentRoster(noGenerators);
  assert.strictEqual(resNoGen.valid, false);
  assert.match(resNoGen.errors[0], /at least one active GENERATOR/);
});
