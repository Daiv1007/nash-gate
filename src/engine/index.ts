/**
 * NashGate Engine Module
 * Multi-round game loop, round orchestration, and tournament execution.
 */

export type {
  RoundResult,
  TournamentResult,
  GameLoopHooks,
  GameLoopErrorContext,
  RunRoundParams,
  RunTournamentParams,
} from './game-loop.ts';

export {
  runRound,
  runTournament,
} from './game-loop.ts';
