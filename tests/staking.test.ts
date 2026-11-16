/**
 * Unit Tests: NashGate Dynamic Staking & Core Risk Management (Requirement R4)
 * Verifies Kelly criterion formulas, bankruptcy distance scaling, boundary clamping,
 * and ledger balance conservation under dynamic staking models.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampStake,
  calculateKellyFraction,
  calculateBankruptcyDistanceFactor,
  calculateGeneratorStake,
  calculateAuditorStake,
  MIN_STAKE,
  DEFAULT_INITIAL_CAPITAL,
  createAgent,
  settleRound,
  type Proposal,
  type Challenge,
  type ChallengeEvaluation,
} from '../src/core/index.ts';

// ---------------------------------------------------------------------------
// 1. clampStake Tests
// ---------------------------------------------------------------------------

test('clampStake: strictly enforces [MIN_STAKE, agentCapital] for solvent agents', () => {
  // Typical solvent capital
  assert.equal(clampStake(25, 100), 25);
  assert.equal(clampStake(0, 100), MIN_STAKE);
  assert.equal(clampStake(-50, 100), MIN_STAKE);
  assert.equal(clampStake(150, 100), 100);
  assert.equal(clampStake(100, 100), 100);
  assert.equal(clampStake(1, 100), 1);

  // Exact MIN_STAKE capital
  assert.equal(clampStake(5, 1), 1);
  assert.equal(clampStake(0.5, 1), 1);

  // Fractional stakes rounded to 2 decimals
  assert.equal(clampStake(12.3456, 100), 12.35);
  assert.equal(clampStake(99.999, 100), 100);
});

test('clampStake: handles insolvency and sub-minimal capital defensively', () => {
  // Insolvent agents (capital <= 0) must stake 0
  assert.equal(clampStake(10, 0), 0);
  assert.equal(clampStake(10, -5), 0);
  assert.equal(clampStake(0, 0), 0);

  // Capital below MIN_STAKE (0 < capital < 1)
  assert.equal(clampStake(0.8, 0.5), 0.5);
  assert.equal(clampStake(0.2, 0.5), 0.5);
});

test('clampStake: handles non-finite and NaN raw stakes safely', () => {
  assert.equal(clampStake(NaN, 100), 0);
  assert.equal(clampStake(Infinity, 100), 100);
  assert.equal(clampStake(-Infinity, 100), MIN_STAKE);
  assert.equal(clampStake(undefined as unknown as number, 100), 0);
  assert.equal(clampStake(NaN, 0), 0);
  assert.equal(clampStake(NaN, -10), 0);
});

// ---------------------------------------------------------------------------
// 2. calculateKellyFraction Tests
// ---------------------------------------------------------------------------

test('calculateKellyFraction: accurately calculates binary Kelly fraction', () => {
  // Generator scenario: winOdds = 0.5, lossOdds = 1.0
  // Formula: f* = 3p - 2
  // p = 0.8 -> 3(0.8) - 2 = 0.40
  assert.equal(calculateKellyFraction(0.8, 0.5, 1.0), 0.4);

  // p = 0.9 -> 3(0.9) - 2 = 0.70
  assert.equal(calculateKellyFraction(0.9, 0.5, 1.0), 0.7);

  // p = 1.0 -> 1.0
  assert.equal(calculateKellyFraction(1.0, 0.5, 1.0), 1.0);

  // Breakeven p = 2/3 (~0.6667) -> 0
  assert.equal(calculateKellyFraction(2 / 3, 0.5, 1.0), 0);

  // Sub-critical p = 0.50 -> 0 (negative EV)
  assert.equal(calculateKellyFraction(0.5, 0.5, 1.0), 0);
  assert.equal(calculateKellyFraction(0.2, 0.5, 1.0), 0);
  assert.equal(calculateKellyFraction(0, 0.5, 1.0), 0);

  // Symmetric 1:1 odds (coin flip with 60% edge)
  // f* = 2(0.60) - 1 = 0.20
  assert.equal(calculateKellyFraction(0.6, 1.0, 1.0), 0.2);

  // Invalid / non-positive odds return 0
  assert.equal(calculateKellyFraction(0.8, 0, 1.0), 0);
  assert.equal(calculateKellyFraction(0.8, 0.5, 0), 0);

  // Non-finite and NaN odds return 0
  assert.equal(calculateKellyFraction(NaN, 0.5, 1.0), 0);
  assert.equal(calculateKellyFraction(0.8, NaN, 1.0), 0);
  assert.equal(calculateKellyFraction(0.8, 0.5, NaN), 0);
  assert.equal(calculateKellyFraction(0.8, Infinity, 1.0), 0);
  assert.equal(calculateKellyFraction(0.8, 0.5, Infinity), 0);
  assert.equal(calculateKellyFraction(-0.5, 0.5, 1.0), 0);
  assert.equal(calculateKellyFraction(0.8, -1.0, 1.0), 0);
  assert.equal(calculateKellyFraction(0.8, 0.5, -1.0), 0);
});

// ---------------------------------------------------------------------------
// 3. calculateBankruptcyDistanceFactor Tests
// ---------------------------------------------------------------------------

test('calculateBankruptcyDistanceFactor: scales risk aversion proportionally to capital', () => {
  // At or above baseline (100) -> 1.0 full risk tolerance
  assert.equal(calculateBankruptcyDistanceFactor(100), 1.0);
  assert.equal(calculateBankruptcyDistanceFactor(250), 1.0);

  // Distressed regime: linear reduction
  assert.equal(calculateBankruptcyDistanceFactor(50), 0.5);
  assert.equal(calculateBankruptcyDistanceFactor(25), 0.25);
  assert.equal(calculateBankruptcyDistanceFactor(10), 0.1);

  // Floor at 0.10 when capital is critically low but > 0
  assert.equal(calculateBankruptcyDistanceFactor(5), 0.1);
  assert.equal(calculateBankruptcyDistanceFactor(1), 0.1);

  // Insolvent capital <= 0 -> 0
  assert.equal(calculateBankruptcyDistanceFactor(0), 0);
  assert.equal(calculateBankruptcyDistanceFactor(-10), 0);
  assert.equal(calculateBankruptcyDistanceFactor(NaN), 0);
  assert.equal(calculateBankruptcyDistanceFactor(Infinity), 0);
});

// ---------------------------------------------------------------------------
// 4. calculateGeneratorStake Tests
// ---------------------------------------------------------------------------

test('calculateGeneratorStake: computes game-theoretically sound adaptive stakes', () => {
  // Standard healthy agent with high confidence (0.90)
  // Kelly f* = 0.70, balanced kappa = 0.50, alpha = 1.0 -> adjFraction = 0.35 -> stake = $35
  const dec = calculateGeneratorStake({
    capital: 100,
    confidence: 0.9,
    riskProfile: 'balanced',
  });

  assert.equal(dec.stake, 35);
  assert.equal(dec.fraction, 0.35);
  assert.equal(dec.kellyFraction, 0.7);
  assert.equal(dec.riskAversionFactor, 1.0);
  assert.ok(dec.expectedValue > 0);
  assert.ok(dec.rationale.includes('Kelly'));

  // Low confidence (< 2/3) must bet defensive MIN_STAKE
  const subCritical = calculateGeneratorStake({
    capital: 100,
    confidence: 0.6,
  });
  assert.equal(subCritical.stake, MIN_STAKE);
  assert.equal(subCritical.kellyFraction, 0);
  assert.ok(subCritical.rationale.includes('Sub-critical'));

  // Risk profile variations: conservative (kappa=0.25) vs aggressive (kappa=0.75)
  const conservative = calculateGeneratorStake({
    capital: 100,
    confidence: 0.9,
    riskProfile: 'conservative',
  });
  const aggressive = calculateGeneratorStake({
    capital: 100,
    confidence: 0.9,
    riskProfile: 'aggressive',
  });

  assert.ok(conservative.stake < dec.stake);
  assert.ok(aggressive.stake > dec.stake);
  assert.equal(conservative.stake, 17.5);
  assert.equal(aggressive.stake, 52.5);

  // Distressed capital scales down stake via bankruptcy distance factor
  const distressed = calculateGeneratorStake({
    capital: 20,
    confidence: 0.9,
    riskProfile: 'balanced',
  });
  // capital 20 -> alpha = 0.20 -> adj = 0.70 * 0.50 * 0.20 = 0.07 -> 20 * 0.07 = 1.4
  assert.equal(distressed.riskAversionFactor, 0.2);
  assert.equal(distressed.stake, 1.4);
  assert.ok(distressed.stake >= MIN_STAKE && distressed.stake <= 20);

  // Insolvent agent receives 0 stake
  const insolvent = calculateGeneratorStake({ capital: 0 });
  assert.equal(insolvent.stake, 0);
  assert.equal(insolvent.expectedValue, 0);
});

// ---------------------------------------------------------------------------
// 5. calculateAuditorStake Tests
// ---------------------------------------------------------------------------

test('calculateAuditorStake: sizes auditor stake to maintain positive EV against -1.5x penalty', () => {
  // Confident auditor (confidence 0.85) auditing generator with $40 target stake
  const decision = calculateAuditorStake({
    capital: 100,
    targetStake: 40,
    confidence: 0.85,
    riskProfile: 'balanced',
  });

  assert.ok(decision.stake >= MIN_STAKE);
  assert.ok(decision.stake <= 100);
  assert.ok(decision.expectedValue > 0);
  assert.ok(decision.rationale.includes('Auditing'));

  // Low confidence auditor (<= 0.40) must stake MIN_STAKE to protect against -1.5x spam penalty
  const lowConf = calculateAuditorStake({
    capital: 100,
    targetStake: 40,
    confidence: 0.3,
  });
  assert.equal(lowConf.stake, MIN_STAKE);
  assert.ok(lowConf.rationale.includes('defensive minimum stake'));

  // Insolvent auditor receives 0 stake
  const insolvent = calculateAuditorStake({
    capital: 0,
    targetStake: 50,
  });
  assert.equal(insolvent.stake, 0);
});

test('calculateAuditorStake: ruin protection guarantees aggressive profile never exceeds C / 1.5', () => {
  // Test across multiple capital levels under aggressive risk profile (kappa = 0.75) and maximum confidence
  const testCapitals = [10, 50, 100, 200, 500, 1000];
  for (const cap of testCapitals) {
    const aggressiveDecision = calculateAuditorStake({
      capital: cap,
      targetStake: cap, // high target stake to maximize Kelly budget
      confidence: 1.0,  // 100% confidence
      riskProfile: 'aggressive',
    });

    // Stake must never exceed C / 1.5 (with safe margin)
    assert.ok(
      aggressiveDecision.stake <= cap / 1.5,
      `Auditor stake ${aggressiveDecision.stake} exceeded ${cap} / 1.5 (${cap / 1.5})`
    );

    // Single false-positive penalty (-1.5 * s_A) must never ruin the auditor (1.5 * s_A <= C)
    const penalty = 1.5 * aggressiveDecision.stake;
    const remainingCapital = cap - penalty;
    assert.ok(
      remainingCapital >= 0,
      `Auditor ruined on false positive! Capital=${cap}, Stake=${aggressiveDecision.stake}, Penalty=${penalty}, Remaining=${remainingCapital}`
    );
  }
});

test('calculateGeneratorStake and calculateAuditorStake: safely handle non-finite inputs without NaN propagation', () => {
  const gDec = calculateGeneratorStake({
    capital: NaN,
    confidence: NaN,
    initialCapital: NaN,
  });
  assert.equal(gDec.stake, 0);
  assert.ok(Number.isFinite(gDec.expectedValue));

  const gDec2 = calculateGeneratorStake({
    capital: 100,
    confidence: NaN,
    initialCapital: NaN,
  });
  assert.ok(Number.isFinite(gDec2.stake));
  assert.ok(gDec2.stake >= MIN_STAKE && gDec2.stake <= 100);

  const aDec = calculateAuditorStake({
    capital: NaN,
    targetStake: NaN,
    confidence: NaN,
  });
  assert.equal(aDec.stake, 0);
  assert.ok(Number.isFinite(aDec.expectedValue));

  const aDec2 = calculateAuditorStake({
    capital: 100,
    targetStake: NaN,
    confidence: NaN,
  });
  assert.ok(Number.isFinite(aDec2.stake));
  assert.ok(aDec2.stake >= MIN_STAKE && aDec2.stake <= 100);
});

// ---------------------------------------------------------------------------
// 6. Stake Bounds & Ledger Balance Invariants
// ---------------------------------------------------------------------------

test('Invariants: dynamic stake always satisfies [MIN_STAKE, capital] across simulated sweeps', () => {
  // Test 100 distinct combinations of capital and confidence
  for (let cap = 1; cap <= 500; cap += 5) {
    for (let conf = 0.1; conf <= 1.0; conf += 0.1) {
      const gDec = calculateGeneratorStake({
        capital: cap,
        confidence: conf,
      });
      assert.ok(
        gDec.stake >= MIN_STAKE && gDec.stake <= cap,
        `Generator stake ${gDec.stake} outside [1, ${cap}] for conf ${conf}`
      );

      const aDec = calculateAuditorStake({
        capital: cap,
        targetStake: 30,
        confidence: conf,
      });
      assert.ok(
        aDec.stake >= MIN_STAKE && aDec.stake <= cap,
        `Auditor stake ${aDec.stake} outside [1, ${cap}] for conf ${conf}`
      );
    }
  }
});

test('Ledger Balance Conservation: round settlement with dynamic staking preserves accounting invariants', () => {
  const g1 = createAgent({ id: 'GenSolid', role: 'GENERATOR', capital: 100, model: 'solid-model' });
  const g2 = createAgent({ id: 'GenBuggy', role: 'GENERATOR', capital: 100, model: 'buggy-model' });
  const a1 = createAgent({ id: 'AuditorSharp', role: 'AUDITOR', capital: 100, model: 'sharp-model' });

  // Dynamically calculate stakes
  const sG1 = calculateGeneratorStake({ capital: g1.capital, confidence: 0.95 }).stake;
  const sG2 = calculateGeneratorStake({ capital: g2.capital, confidence: 0.70 }).stake;
  const sA1_on_G2 = calculateAuditorStake({
    capital: a1.capital,
    targetStake: sG2,
    confidence: 0.9,
  }).stake;

  const proposals: Proposal[] = [
    {
      agentId: g1.id,
      solution: 'function isPalindrome(s) { return true; }',
      stake: sG1,
      reasoning: 'Solid palindrome check',
    },
    {
      agentId: g2.id,
      solution: 'function isPalindrome(s) { return false; }',
      stake: sG2,
      reasoning: 'Buggy palindrome check',
    },
  ];

  // Auditor sharp challenges GenBuggy
  const challenges: Challenge[] = [
    {
      auditorId: a1.id,
      targetAgentId: g2.id,
      testInput: 'racecar',
      expectedOutput: true,
      stake: sA1_on_G2,
    },
  ];

  // Oracle evaluation: g1 unchallenged, g2 fails challenge
  const evaluations: ChallengeEvaluation[] = [
    {
      challenge: challenges[0],
      generatorPassed: false, // GenBuggy broke!
    },
  ];

  const settlement = settleRound({
    agents: [g1, g2, a1],
    proposals,
    evaluations,
  });

  const finalG1 = settlement.updatedAgents.find((a) => a.id === g1.id)!;
  const finalG2 = settlement.updatedAgents.find((a) => a.id === g2.id)!;
  const finalA1 = settlement.updatedAgents.find((a) => a.id === a1.id)!;

  // GenSolid unchallenged: receives +10% dividend
  assert.equal(finalG1.capital, 100 + sG1 * 0.1);

  // GenBuggy failed: forfeits full stake sG2 to AuditorSharp
  assert.equal(finalG2.capital, 100 - sG2);
  assert.equal(finalA1.capital, 100 + sG2);

  // Exact pairwise conservation between GenBuggy and AuditorSharp:
  // delta(GenBuggy) + delta(AuditorSharp) === 0
  const deltaG2 = finalG2.capital - 100;
  const deltaA1 = finalA1.capital - 100;
  assert.equal(deltaG2 + deltaA1, 0);

  // Solvency invariant holds: no solvent agent dropped below 0
  assert.ok(finalG1.capital > 0);
  assert.ok(finalG2.capital > 0);
  assert.ok(finalA1.capital > 0);
});
