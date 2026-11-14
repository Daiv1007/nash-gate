/**
 * NashGate
 * A deterministic consensus and arbitration engine for multi-agent AI systems,
 * grounded in Game Theory and Mechanism Design.
 *
 * Zero external production dependencies.
 */

// Core game-theoretic entities, validation, bankruptcy, and settlement logic
export * from './core/index.ts';

// Deterministic sandbox oracle
export * from './oracle/index.ts';

// Model adapters and mock catalog
export * from './adapters/index.ts';

// Multi-round game loop and tournament orchestration
export * from './engine/index.ts';

// Lightweight web visualizer and dashboard server
export {
  DashboardServer,
  createInitialAgents,
  tournamentProblems,
  DEFAULT_PORT,
  DEFAULT_PACE_DELAY_MS,
  type DashboardServerOptions,
} from './server/dashboard.ts';
