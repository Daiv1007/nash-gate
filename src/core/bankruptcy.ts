/**
 * NashGate Bankruptcy Handling and Capital Normalization
 * Pure functions governing agent solvency and permanent market exclusion.
 */

import type { Agent } from './types.ts';

/**
 * Normalizes floating-point precision to avoid IEEE 754 precision artifacts.
 *
 * @param value - The numerical value to round.
 * @param decimals - Number of decimal places (default 4).
 * @returns Deterministically rounded number.
 */
export function roundToPrecision(value: number, decimals: number = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Checks whether an agent is bankrupt or insolvent.
 * An agent is deemed bankrupt if marked BANKRUPT or if capital is <= 0.
 *
 * @param agent - The agent to inspect.
 * @returns true if the agent is insolvent or marked bankrupt.
 */
export function isBankrupt(agent: Pick<Agent, 'capital' | 'status'>): boolean {
  return agent.status === 'BANKRUPT' || agent.capital <= 0;
}

/**
 * Applies the canonical bankruptcy condition to an agent.
 *
 * Game-theoretic rationale:
 * Once an agent's capital reaches zero or below, it possesses zero collateral to back
 * commitments. Setting capital = 0 and transitioning status = 'BANKRUPT' eliminates moral hazard
 * and prevents uncollateralized liabilities from polluting future rounds.
 *
 * @param agent - The agent state to evaluate.
 * @returns A new Agent object with updated capital and status.
 */
export function applyBankruptcy(agent: Agent): Agent {
  if (agent.capital <= 0 || agent.status === 'BANKRUPT') {
    return {
      ...agent,
      capital: 0,
      status: 'BANKRUPT',
    };
  }

  return {
    ...agent,
    capital: roundToPrecision(agent.capital),
  };
}

/**
 * Filters a collection of agents to return only active, solvent agents.
 * Bankrupt agents are permanently excluded from subsequent rounds in the session.
 *
 * @param agents - Collection of agents.
 * @returns Array of active, solvent agents.
 */
export function filterActiveAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => !isBankrupt(agent));
}

/**
 * Validates that an agent is solvent and active.
 * Throws an Error if the agent is bankrupt.
 *
 * @param agent - The agent to check.
 * @param context - Optional context string for the error message.
 */
export function assertSolvent(agent: Agent, context: string = 'Operation'): void {
  if (isBankrupt(agent)) {
    throw new Error(
      `[BankruptcyError] Agent '${agent.id}' is BANKRUPT (capital: ${agent.capital}) and cannot perform: ${context}`
    );
  }
}
