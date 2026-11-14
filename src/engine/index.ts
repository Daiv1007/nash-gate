/**
 * NashGate Engine Module
 * Multi-round game loop, round orchestration, and tournament execution.
 */

export type {
  RoundResult,
  TournamentResult,
  GameLoopHooks,
  RunRoundParams,
  RunTournamentParams,
} from './game-loop.ts';

export {
  runRound,
  runTournament,
} from './game-loop.ts';
