/**
 * Unit Tests: Bankruptcy and Solvency Transitions
 * Verifies non-negativity constraints, clamping, and market exclusion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBankrupt,
  applyBankruptcy,
  filterActiveAgents,
  assertSolvent,
  roundToPrecision,
} from '../src/core/index.ts';
import type { Agent } from '../src/core/index.ts';

test('isBankrupt accurately identifies insolvency and bankrupt status', () => {
  const solventAgent: Agent = {
    id: 'a1',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 50,
    status: 'ACTIVE',
  };

  const zeroCapAgent: Agent = {
    id: 'a2',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 0,
    status: 'ACTIVE',
  };

  const negativeCapAgent: Agent = {
    id: 'a3',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: -15,
    status: 'ACTIVE',
  };

  const markedBankruptAgent: Agent = {
    id: 'a4',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: 0,
    status: 'BANKRUPT',
  };

  assert.strictEqual(isBankrupt(solventAgent), false);
  assert.strictEqual(isBankrupt(zeroCapAgent), true);
  assert.strictEqual(isBankrupt(negativeCapAgent), true);
  assert.strictEqual(isBankrupt(markedBankruptAgent), true);
});

test('applyBankruptcy clamps zero and negative capital to zero and sets status to BANKRUPT', () => {
  const agentZero: Agent = {
    id: 'gen-zero',
    role: 'GENERATOR',
    model: 'llama3',
    capital: 0,
    status: 'ACTIVE',
  };

  const resultZero = applyBankruptcy(agentZero);
  assert.strictEqual(resultZero.capital, 0);
  assert.strictEqual(resultZero.status, 'BANKRUPT');

  const agentNegative: Agent = {
    id: 'aud-neg',
    role: 'AUDITOR',
    model: 'gpt-4o-mini',
    capital: -35.5,
    status: 'ACTIVE',
  };

  const resultNegative = applyBankruptcy(agentNegative);
  assert.strictEqual(resultNegative.capital, 0);
  assert.strictEqual(resultNegative.status, 'BANKRUPT');
});

test('applyBankruptcy preserves solvent agent state and applies precision rounding', () => {
  const solventAgent: Agent = {
    id: 'gen-solvent',
    role: 'GENERATOR',
    model: 'gemini-2.5-flash',
    capital: 125.7500000001,
    status: 'ACTIVE',
  };

  const result = applyBankruptcy(solventAgent);
  assert.strictEqual(result.capital, 125.75);
  assert.strictEqual(result.status, 'ACTIVE');
  assert.strictEqual(result.id, 'gen-solvent');
});

test('filterActiveAgents excludes bankrupt agents from the active pool', () => {
  const agents: Agent[] = [
    { id: 'a1', role: 'GENERATOR', model: 'm1', capital: 100, status: 'ACTIVE' },
    { id: 'a2', role: 'GENERATOR', model: 'm1', capital: 0, status: 'BANKRUPT' },
    { id: 'a3', role: 'AUDITOR', model: 'm2', capital: 50, status: 'ACTIVE' },
    { id: 'a4', role: 'AUDITOR', model: 'm2', capital: -10, status: 'ACTIVE' },
  ];

  const active = filterActiveAgents(agents);
  assert.strictEqual(active.length, 2);
  assert.deepStrictEqual(
    active.map((a) => a.id),
    ['a1', 'a3']
  );
});

test('assertSolvent passes for solvent agents and throws for bankrupt agents', () => {
  const solvent: Agent = { id: 's', role: 'GENERATOR', model: 'm', capital: 10, status: 'ACTIVE' };
  const bankrupt: Agent = { id: 'b', role: 'GENERATOR', model: 'm', capital: 0, status: 'BANKRUPT' };

  assert.doesNotThrow(() => assertSolvent(solvent, 'testing'));
  assert.throws(() => assertSolvent(bankrupt, 'staking'), /BankruptcyError/);
});

test('roundToPrecision handles edge rounding accurately', () => {
  assert.strictEqual(roundToPrecision(0.1 + 0.2, 4), 0.3);
  assert.strictEqual(roundToPrecision(100.00004, 4), 100);
  assert.strictEqual(roundToPrecision(100.00006, 4), 100.0001);
});
