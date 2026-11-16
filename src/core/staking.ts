/**
 * NashGate Dynamic Staking & Risk Management Module
 * Pure, deterministic mathematical models for adaptive capital allocation.
 * Grounded in Game Theory, Kelly Criterion, and Bankruptcy Avoidance.
 * Strict separation of concerns: ZERO I/O, ZERO network, ZERO SDKs, ZERO randomness.
 */

import {
  MIN_STAKE,
  DEFAULT_INITIAL_CAPITAL,
  GENERATOR_PASS_REWARD_MULTIPLIER,
  AUDITOR_FAIL_PENALTY_MULTIPLIER,
} from './types.ts';
import { roundToPrecision } from './bankruptcy.ts';

/**
 * Risk aversion profile governing fractional Kelly multipliers.
 * - conservative: Quarter-Kelly (kappa = 0.25) for high drawdown protection.
 * - balanced: Half-Kelly (kappa = 0.50) balancing growth and volatility.
 * - aggressive: Three-Quarter Kelly (kappa = 0.75) maximizing capital accumulation.
 */
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';

export interface StakingDecision {
  /** Clamped stake amount in [MIN_STAKE, agentCapital] with 2 decimal precision */
  readonly stake: number;
  /** Fraction of agent capital committed (stake / capital) */
  readonly fraction: number;
  /** Mathematical Expected Value (EV) of the staked action */
  readonly expectedValue: number;
  /** Unadjusted raw Kelly fraction f* */
  readonly kellyFraction: number;
  /** Bankruptcy distance scaling factor alpha in [0.10, 1.0] */
  readonly riskAversionFactor: number;
  /** Concise game-theoretic justification for auditability */
  readonly rationale: string;
}

export interface GeneratorStakingParams {
  /** Available agent capital */
  readonly capital: number;
  /** Baseline initial capital (defaults to DEFAULT_INITIAL_CAPITAL = 100) */
  readonly initialCapital?: number;
  /** Estimated probability that generator code is correct in [0, 1] */
  readonly confidence?: number;
  /** Risk profile determining fractional Kelly multiplier */
  readonly riskProfile?: RiskProfile;
}

export interface AuditorStakingParams {
  /** Available auditor capital */
  readonly capital: number;
  /** Target generator's staked collateral under audit */
  readonly targetStake: number;
  /** Baseline initial capital (defaults to DEFAULT_INITIAL_CAPITAL = 100) */
  readonly initialCapital?: number;
  /** Estimated probability that generator proposal is flawed in [0, 1] */
  readonly confidence?: number;
  /** Risk profile determining fractional Kelly multiplier */
  readonly riskProfile?: RiskProfile;
}

/**
 * Clamps raw stake strictly within [MIN_STAKE, agentCapital].
 * Preserves ledger solvency: an agent can never commit more than available capital,
 * and cannot stake below protocol MIN_STAKE (1) unless insolvent.
 *
 * Game-theoretic rationale:
 * Enforces collateralization invariant (s <= C) ensuring all potential liabilities
 * are backed 100% by sovereign agent capital.
 */
export function clampStake(rawStake: number, agentCapital: number): number {
  if (agentCapital <= 0 || !Number.isFinite(agentCapital)) {
    return 0;
  }
  if (typeof rawStake !== 'number' || Number.isNaN(rawStake)) {
    return 0;
  }
  if (agentCapital < MIN_STAKE) {
    return roundToPrecision(agentCapital, 2);
  }
  const bounded = Math.max(MIN_STAKE, Math.min(rawStake, agentCapital));
  const rounded = roundToPrecision(bounded, 2);
  // Guarantee that rounding to 2 decimal places never exceeds available sovereign capital
  if (rounded > agentCapital) {
    return roundToPrecision(Math.floor(bounded * 100) / 100, 2);
  }
  return rounded;
}

/**
 * Calculates optimal Kelly fraction for a binary bet:
 * f* = (p * b - (1 - p) * a) / (b * a)
 * where:
 * - p = win probability in [0, 1]
 * - winOdds (b) = net profit ratio upon win
 * - lossOdds (a) = net loss ratio upon loss (default 1.0 for full forfeiture)
 *
 * Returns 0 if expected value is negative (p * b <= (1 - p) * a).
 */
export function calculateKellyFraction(
  p: number,
  winOdds: number,
  lossOdds: number = 1.0
): number {
  if (
    !Number.isFinite(p) ||
    p <= 0 ||
    !Number.isFinite(winOdds) ||
    winOdds <= 0 ||
    !Number.isFinite(lossOdds) ||
    lossOdds <= 0
  ) {
    return 0;
  }
  if (p >= 1.0) {
    return 1.0;
  }

  // f* = p / lossOdds - (1 - p) / winOdds
  const numerator = p * winOdds - (1 - p) * lossOdds;
  if (numerator <= 0) {
    return 0;
  }

  const rawKelly = numerator / (winOdds * lossOdds);
  if (!Number.isFinite(rawKelly)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(1.0, rawKelly));
  return roundToPrecision(clamped, 4);
}

/**
 * Calculates bankruptcy distance factor alpha(C, C_0) in [0.10, 1.0].
 *
 * Game-theoretic rationale:
 * Repeated tournaments feature absorbing ruin boundaries at C <= 0.
 * As capital depletes below initial baseline (C < C_0), risk aversion
 * scales linearly to throttle bet size, preventing sudden elimination.
 */
export function calculateBankruptcyDistanceFactor(
  capital: number,
  initialCapital: number = DEFAULT_INITIAL_CAPITAL
): number {
  if (!Number.isFinite(capital) || capital <= 0) {
    return 0;
  }
  const baseline =
    Number.isFinite(initialCapital) && initialCapital > 0
      ? initialCapital
      : DEFAULT_INITIAL_CAPITAL;
  const ratio = capital / baseline;
  const alpha = Math.min(1.0, Math.max(0.1, ratio));
  return roundToPrecision(alpha, 4);
}

/**
 * Resolves fractional Kelly multiplier (kappa) from risk profile.
 */
function resolveRiskMultiplier(profile?: RiskProfile): number {
  switch (profile) {
    case 'conservative':
      return 0.25; // Quarter-Kelly
    case 'aggressive':
      return 0.75; // Three-Quarter Kelly
    case 'balanced':
    default:
      return 0.5; // Half-Kelly
  }
}

/**
 * Calculates game-theoretic adaptive stake for GENERATOR agents.
 *
 * Game-theoretic rationale:
 * Generator payout on audit:
 * - Pass: +0.50 * s_G (resilience dividend b = 0.50)
 * - Fail: -1.00 * s_G (total forfeiture a = 1.00)
 * Break-even probability: p* = a / (a + b) = 1.0 / 1.50 = 2/3 (~66.7%).
 * Kelly optimal fraction: f* = (0.5p - (1 - p)) / 0.5 = 3p - 2.
 * If p <= 2/3, EV is non-positive; agent stakes minimum bound (MIN_STAKE).
 */
export function calculateGeneratorStake(params: GeneratorStakingParams): StakingDecision {
  const capital = Number.isFinite(params.capital) ? params.capital : 0;
  if (capital <= 0) {
    return {
      stake: 0,
      fraction: 0,
      expectedValue: 0,
      kellyFraction: 0,
      riskAversionFactor: 0,
      rationale: 'Insolvent agent: capital <= 0, zero stake permitted.',
    };
  }

  const initialCap =
    typeof params.initialCapital === 'number' &&
    Number.isFinite(params.initialCapital) &&
    params.initialCapital > 0
      ? params.initialCapital
      : DEFAULT_INITIAL_CAPITAL;
  const rawConf =
    typeof params.confidence === 'number' && Number.isFinite(params.confidence)
      ? params.confidence
      : 0.85;
  const confidence = Math.max(0, Math.min(1.0, rawConf));
  const kappa = resolveRiskMultiplier(params.riskProfile);
  const alpha = calculateBankruptcyDistanceFactor(capital, initialCap);

  // Kelly formula for Generator with b = 0.50, a = 1.00
  const winOdds = GENERATOR_PASS_REWARD_MULTIPLIER; // 0.5
  const lossOdds = 1.0;
  const kellyFraction = calculateKellyFraction(confidence, winOdds, lossOdds);

  // Scaled fraction using fractional Kelly and bankruptcy distance
  const adjustedFraction = kellyFraction * kappa * alpha;
  const rawStake = roundToPrecision(capital * adjustedFraction, 2);
  const stake = clampStake(rawStake, capital);
  const actualFraction = capital > 0 ? roundToPrecision(stake / capital, 4) : 0;

  // Expected Value: E = stake * (p * 0.5 - (1 - p) * 1.0)
  const ev = roundToPrecision(stake * (confidence * winOdds - (1 - confidence) * lossOdds), 2);

  const rationale =
    confidence < 2 / 3
      ? `Sub-critical confidence (${(confidence * 100).toFixed(1)}% < 66.7% breakeven). Staking minimum collateral $${stake} to limit downside.`
      : `Kelly f*=${kellyFraction} scaled by ${params.riskProfile ?? 'balanced'} kappa=${kappa} and bankruptcy distance alpha=${alpha}. Stake $${stake} (${(actualFraction * 100).toFixed(1)}% cap, EV=+$${ev}).`;

  return {
    stake,
    fraction: actualFraction,
    expectedValue: ev,
    kellyFraction,
    riskAversionFactor: alpha,
    rationale,
  };
}

/**
 * Calculates game-theoretic adaptive stake for AUDITOR agents.
 *
 * Game-theoretic rationale:
 * Auditor payout on audit:
 * - Win (generator fails): +1.00 * s_G (generator's stake as bounty)
 * - Loss (generator passes): -1.50 * s_A (asymmetric anti-spam penalty)
 * Expected Value: E[delta_A] = p * s_G - (1 - p) * 1.50 * s_A
 * For positive EV, auditor stake must satisfy: s_A < (p * s_G) / (1.50 * (1 - p)).
 * Stake is bounded by capital fraction, EV-safe ceiling, and bankruptcy distance.
 */
export function calculateAuditorStake(params: AuditorStakingParams): StakingDecision {
  const capital = Number.isFinite(params.capital) ? params.capital : 0;
  const targetStake = Math.max(0, Number.isFinite(params.targetStake) ? params.targetStake : 0);

  if (capital <= 0) {
    return {
      stake: 0,
      fraction: 0,
      expectedValue: 0,
      kellyFraction: 0,
      riskAversionFactor: 0,
      rationale: 'Insolvent agent: capital <= 0, zero stake permitted.',
    };
  }

  const initialCap =
    typeof params.initialCapital === 'number' &&
    Number.isFinite(params.initialCapital) &&
    params.initialCapital > 0
      ? params.initialCapital
      : DEFAULT_INITIAL_CAPITAL;
  const rawConf =
    typeof params.confidence === 'number' && Number.isFinite(params.confidence)
      ? params.confidence
      : 0.75;
  const confidence = Math.max(0, Math.min(1.0, rawConf));
  const kappa = resolveRiskMultiplier(params.riskProfile);
  const alpha = calculateBankruptcyDistanceFactor(capital, initialCap);

  // Effective win return ratio relative to assumed auditor stake exposure
  const nominalExposure = Math.max(MIN_STAKE, capital * 0.25);
  const winOdds = roundToPrecision(targetStake / nominalExposure, 4);
  const lossOdds = AUDITOR_FAIL_PENALTY_MULTIPLIER; // 1.5

  const kellyFraction = calculateKellyFraction(confidence, Math.max(0.1, winOdds), lossOdds);

  // Maximum safe stake to preserve positive EV with buffer
  const pLoss = 1 - confidence;
  const maxSafeEvStake =
    pLoss > 0.001
      ? roundToPrecision((confidence * targetStake) / (lossOdds * pLoss + 0.05), 2)
      : capital;

  // Ruin protection cap: An auditor facing a -1.5x penalty on false positive must NEVER
  // be ruined (1.5 * s_A <= capital) in a single audit round, even under an aggressive risk profile (kappa = 0.75).
  // Cap at at most C / 1.5 (using capital * 0.60 to strictly ensure 1.5 * s_A <= capital).
  const maxRuinSafeStake = Math.max(
    MIN_STAKE,
    roundToPrecision(capital * 0.60, 2)
  );

  // Calculate raw stake combining fractional Kelly budget, EV ceiling, and ruin protection cap
  const kellyBudget = roundToPrecision(capital * kellyFraction * kappa * alpha, 2);
  const rawStake = Math.min(kellyBudget, maxSafeEvStake, maxRuinSafeStake);

  // If confidence is low (<= 0.40) or raw stake is negligible, bet minimum bound
  const candidateStake =
    confidence <= 0.4 ? MIN_STAKE : Math.min(maxRuinSafeStake, Math.max(MIN_STAKE, rawStake));
  const stake = clampStake(candidateStake, capital);
  const actualFraction = capital > 0 ? roundToPrecision(stake / capital, 4) : 0;

  // Expected Value: E[delta_A] = p * targetStake - (1 - p) * 1.5 * stake
  const ev = roundToPrecision(confidence * targetStake - pLoss * lossOdds * stake, 2);

  const rationale =
    confidence <= 0.4
      ? `Low bug probability (${(confidence * 100).toFixed(1)}%). Committing defensive minimum stake $${stake} to avoid -1.5x false-positive penalty.`
      : `Auditing target stake $${targetStake} with ${(confidence * 100).toFixed(1)}% confidence. Safe stake $${stake} (${(actualFraction * 100).toFixed(1)}% cap, EV=+$${ev}).`;

  return {
    stake,
    fraction: actualFraction,
    expectedValue: ev,
    kellyFraction,
    riskAversionFactor: alpha,
    rationale,
  };
}
