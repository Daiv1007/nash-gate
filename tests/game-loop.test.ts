/**
 * Unit Tests: NashGate Multi-Round Game Loop (/src/engine/game-loop.ts)
 * Verifies round execution, adversarial consensus, payoff transfers,
 * bankruptcy handling, and tournament lifecycle orchestration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runRound, runTournament } from '../src/engine/index.ts';
import { MockAdapter, type ProblemContext } from '../src/adapters/index.ts';
import { createAgent, type Agent } from '../src/core/index.ts';

const problem1: ProblemContext = {
  id: 'is-palindrome',
  title: 'Palindrome Verification',
  task: 'Implement isPalindrome(s: string): boolean handling spaces and casing.',
  entrypoint: 'isPalindrome',
};

const problem2: ProblemContext = {
  id: 'clamp-number',
  title: 'Number Clamping',
  task: 'Implement clamp(val: number, min: number, max: number): number.',
  entrypoint: 'clamp',
};

const problem3: ProblemContext = {
  id: 'sum-array',
  title: 'Array Summation',
  task: 'Implement sumArray(numbers: number[]): number.',
  entrypoint: 'sumArray',
};

// ---------------------------------------------------------------------------
// 1. Single Round Orchestration Tests
// ---------------------------------------------------------------------------

test('runRound: Buggy generator proposal fails sharp auditor challenge -> capital transfer bounty', async () => {
  const gen = createAgent({ id: 'BuggyGen', role: 'GENERATOR', model: 'naive', capital: 100 });
  const aud = createAgent({ id: 'SharpAuditor', role: 'AUDITOR', model: 'sharp', capital: 100 });
  const agentMap = new Map<string, Agent>([
    [gen.id, gen],
    [aud.id, aud],
  ]);

  const adapter = new MockAdapter();
  const roundResult = await runRound({
    roundNumber: 1,
    problem: problem1,
    agents: agentMap,
    getAdapter: () => adapter,
  });

  assert.equal(roundResult.roundNumber, 1);
  assert.equal(roundResult.proposals.length, 1);
  assert.equal(roundResult.challenges.length, 1);
  assert.equal(roundResult.evaluations.length, 1);

  // Oracle verdict: Buggy generator fails on punctuation
  assert.equal(roundResult.evaluations[0].verdict, 'FAILED');
  assert.equal(roundResult.evaluations[0].generatorPassed, false);

  // Settlement: BuggyGen loses 40 stake -> transferred to SharpAuditor
  const updatedGen = agentMap.get('BuggyGen')!;
  const updatedAud = agentMap.get('SharpAuditor')!;

  assert.equal(updatedGen.capital, 60);
  assert.equal(updatedAud.capital, 140);
  assert.equal(updatedGen.status, 'ACTIVE');
  assert.equal(updatedAud.status, 'ACTIVE');
});

test('runRound: Solid generator withstands reckless auditor challenge -> asymmetric penalty and reward', async () => {
  const gen = createAgent({ id: 'SolidGen', role: 'GENERATOR', model: 'solid', capital: 100 });
  const aud = createAgent({ id: 'RecklessAuditor', role: 'AUDITOR', model: 'reckless', capital: 100 });
  const agentMap = new Map<string, Agent>([
    [gen.id, gen],
    [aud.id, aud],
  ]);

  const adapter = new MockAdapter();
  const roundResult = await runRound({
    roundNumber: 1,
    problem: problem1,
    agents: agentMap,
    getAdapter: () => adapter,
  });

  assert.equal(roundResult.evaluations.length, 1);
  assert.equal(roundResult.evaluations[0].verdict, 'PASSED');
  assert.equal(roundResult.evaluations[0].generatorPassed, true);

  const updatedGen = agentMap.get('SolidGen')!;
  const updatedAud = agentMap.get('RecklessAuditor')!;

  // Gen staked 30: +0.5 * 30 = +15 -> 115
  assert.equal(updatedGen.capital, 115);
  // Aud staked 25: -1.5 * 25 = -37.5 -> 62.5
  assert.equal(updatedAud.capital, 62.5);
});

test('runRound: Unchallenged solid proposal awards +10% dividend to generator', async () => {
  const gen = createAgent({ id: 'SolidGen', role: 'GENERATOR', model: 'solid', capital: 100 });
  const aud = createAgent({ id: 'PrudentAuditor', role: 'AUDITOR', model: 'prudent', capital: 100 });
  const agentMap = new Map<string, Agent>([
    [gen.id, gen],
    [aud.id, aud],
  ]);

  const adapter = new MockAdapter();
  const roundResult = await runRound({
    roundNumber: 1,
    problem: problem1,
    agents: agentMap,
    getAdapter: () => adapter,
  });

  // Prudent auditor declined to challenge
  assert.equal(roundResult.challenges.length, 0);
  assert.equal(roundResult.evaluations.length, 0);
  assert.equal(roundResult.settlement.unchallengedSettlements.length, 1);

  const updatedGen = agentMap.get('SolidGen')!;
  // Gen staked 30: +10% dividend = +3 -> 103
  assert.equal(updatedGen.capital, 103);
});

test('runRound: All-in loss triggers bankruptcy and transitions agent to BANKRUPT', async () => {
  const gen = createAgent({ id: 'BuggyGen', role: 'GENERATOR', model: 'naive', capital: 40 });
  const aud = createAgent({ id: 'SharpAuditor', role: 'AUDITOR', model: 'sharp', capital: 100 });
  const agentMap = new Map<string, Agent>([
    [gen.id, gen],
    [aud.id, aud],
  ]);

  // Adapter forcing all-in stake (40 capital)
  const adapter = new MockAdapter({
    proposalHandler: () => ({
      solution: 'function isPalindrome(s) { return s === s.split("").reverse().join(""); }',
      stake: 40,
      reasoning: 'all-in',
    }),
  });

  const bankruptciesRecorded: string[] = [];
  const roundResult = await runRound({
    roundNumber: 1,
    problem: problem1,
    agents: agentMap,
    getAdapter: () => adapter,
    hooks: {
      onBankruptcy: (agent) => {
        bankruptciesRecorded.push(agent.id);
      },
    },
  });

  assert.deepEqual(bankruptciesRecorded, ['BuggyGen']);
  assert.deepEqual(roundResult.bankruptAgentIds, ['BuggyGen']);

  const updatedGen = agentMap.get('BuggyGen')!;
  assert.equal(updatedGen.capital, 0);
  assert.equal(updatedGen.status, 'BANKRUPT');
});

// ---------------------------------------------------------------------------
// 2. Full Multi-Round Tournament Tests
// ---------------------------------------------------------------------------

test('runTournament: 3-round tournament with 4 agents executes end-to-end', async () => {
  const agents = [
    createAgent({ id: 'AlphaGen', role: 'GENERATOR', model: 'solid', capital: 100 }),
    createAgent({ id: 'BuggyGen', role: 'GENERATOR', model: 'buggy', capital: 100 }),
    createAgent({ id: 'SharpAuditor', role: 'AUDITOR', model: 'sharp', capital: 100 }),
    createAgent({ id: 'RecklessAuditor', role: 'AUDITOR', model: 'reckless', capital: 100 }),
  ];

  const problems = [problem1, problem2, problem3];
  const adapter = new MockAdapter();

  const lifecycleEvents: string[] = [];

  const tournamentResult = await runTournament({
    agents,
    problems,
    adapter,
    hooks: {
      onTournamentStart: () => {
        lifecycleEvents.push('start');
      },
      onRoundStart: (r) => {
        lifecycleEvents.push(`round-${r}-start`);
      },
      onRoundEnd: (r) => {
        lifecycleEvents.push(`round-${r.roundNumber}-end`);
      },
      onTournamentEnd: () => {
        lifecycleEvents.push('end');
      },
    },
  });

  assert.equal(tournamentResult.completed, true);
  assert.equal(tournamentResult.totalRoundsPlayed, 3);
  assert.equal(tournamentResult.rounds.length, 3);

  // Verify lifecycle hook ordering
  assert.equal(lifecycleEvents[0], 'start');
  assert.equal(lifecycleEvents[1], 'round-1-start');
  assert.equal(lifecycleEvents[2], 'round-1-end');
  assert.equal(lifecycleEvents[3], 'round-2-start');
  assert.equal(lifecycleEvents[4], 'round-2-end');
  assert.equal(lifecycleEvents[5], 'round-3-start');
  assert.equal(lifecycleEvents[6], 'round-3-end');
  assert.equal(lifecycleEvents[7], 'end');

  // Verify leaderboard ordering: descending by capital
  const leaderboard = tournamentResult.leaderboard;
  for (let i = 0; i < leaderboard.length - 1; i++) {
    assert.ok(
      leaderboard[i].capital >= leaderboard[i + 1].capital,
      `Leaderboard not descending at index ${i}`
    );
  }
});

test('runTournament: Early halting when all generators go bankrupt', async () => {
  const agents = [
    createAgent({ id: 'BuggyGen', role: 'GENERATOR', model: 'buggy', capital: 20 }),
    createAgent({ id: 'SharpAuditor', role: 'AUDITOR', model: 'sharp', capital: 100 }),
  ];

  // Adapter forcing BuggyGen to lose all 20 capital in round 1
  const adapter = new MockAdapter({
    proposalHandler: () => ({
      solution: 'function isPalindrome(s) { return false; }',
      stake: 20,
      reasoning: 'all-in',
    }),
    challengeHandler: () => ({
      shouldChallenge: true,
      testInput: 'racecar',
      expectedOutput: true,
      stake: 20,
    }),
  });

  const tournamentResult = await runTournament({
    agents,
    problems: [problem1, problem2, problem3],
    adapter,
  });

  // Round 1 causes BuggyGen to lose all 20 capital -> bankrupt
  // Round 2 cannot run because no active generators remain
  assert.equal(tournamentResult.totalRoundsPlayed, 1);
  assert.equal(tournamentResult.bankruptAgents.length, 1);
  assert.equal(tournamentResult.bankruptAgents[0].id, 'BuggyGen');
  assert.ok(tournamentResult.terminationReason.includes('GENERATOR agents are BANKRUPT'));
});
