/**
 * NashGate Real-Time Web Visualizer Server
 * Zero-framework HTTP server utilizing Node.js native http module and Server-Sent Events (SSE).
 * Streams game loop hooks, proposals, challenges, oracle verdicts, and Nash settlements live.
 * Grounded in Game Theory and Mechanism Design.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, type Agent } from '../core/index.ts';
import {
  MockAdapter,
  OpenAICompatibleAdapter,
  type AgentAdapter,
  type ProblemContext,
} from '../adapters/index.ts';
import {
  runTournament,
  type TournamentResult,
  type RoundResult,
} from '../engine/index.ts';

// ---------------------------------------------------------------------------
// Path & Configuration
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HTML_FILE_PATH = path.join(PUBLIC_DIR, 'index.html');

export const DEFAULT_PORT = Number(process.env.PORT) || 3000;
export const DEFAULT_HOST = process.env.HOST || 'localhost';
export const DEFAULT_PACE_DELAY_MS = 600;

// ---------------------------------------------------------------------------
// Tournament Problems Catalog
// ---------------------------------------------------------------------------

export const tournamentProblems: ProblemContext[] = [
  {
    id: 'is-palindrome',
    round: 1,
    title: 'Palindrome Normalization',
    task: 'Implement isPalindrome(s: string): boolean that strips non-alphanumeric characters and ignores case.',
    description: "Example: 'A man, a plan, a canal: Panama' must evaluate to true.",
    entrypoint: 'isPalindrome',
  },
  {
    id: 'clamp-number',
    round: 2,
    title: 'Defensive Value Clamping',
    task: 'Implement clamp(val: number, min: number, max: number): number that constrains val within [min, max].',
    description: 'Must defensively handle inverted boundaries where min > max and negative ranges.',
    entrypoint: 'clamp',
  },
  {
    id: 'sum-array',
    round: 3,
    title: 'Resilient Array Summation',
    task: 'Implement sumArray(numbers: number[]): number that calculates total sum.',
    description: 'Gracefully returns 0 for empty arrays [] and handles non-array inputs.',
    entrypoint: 'sumArray',
  },
];

/**
 * Creates fresh initial roster of 4 agents with 100 capital each.
 */
export function createInitialAgents(hasApiKey: boolean = false): Agent[] {
  return [
    createAgent({
      id: 'AlphaGen',
      role: 'GENERATOR',
      model: hasApiKey ? 'gpt-4o-mini' : 'deterministic-solid',
      capital: 100,
    }),
    createAgent({
      id: 'BuggyGen',
      role: 'GENERATOR',
      model: hasApiKey ? 'llama-3-8b' : 'heuristic-naive',
      capital: 100,
    }),
    createAgent({
      id: 'SharpAuditor',
      role: 'AUDITOR',
      model: hasApiKey ? 'claude-3-5-sonnet' : 'adversarial-verifier',
      capital: 100,
    }),
    createAgent({
      id: 'RecklessAuditor',
      role: 'AUDITOR',
      model: hasApiKey ? 'gpt-4o-mini' : 'speculative-challenger',
      capital: 100,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) Manager & Tournament Orchestration State
// ---------------------------------------------------------------------------

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private isTournamentRunning = false;
  private currentAgents: Agent[] = createInitialAgents(Boolean(process.env.LLM_API_KEY));
  private lastTournamentResult: TournamentResult | null = null;
  private currentRoundNumber = 0;
  private readonly paceMs: number;

  constructor(options?: { paceMs?: number }) {
    this.paceMs = options?.paceMs ?? DEFAULT_PACE_DELAY_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Broadcasts an SSE message to all connected browsers.
   */
  public broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  /**
   * Returns snapshot of current state for new connections.
   */
  public getStateSnapshot() {
    return {
      isRunning: this.isTournamentRunning,
      agents: this.currentAgents,
      currentRound: this.currentRoundNumber,
      totalProblems: tournamentProblems.length,
      problems: tournamentProblems,
      adapterMode: process.env.LLM_API_KEY ? 'live-llm' : 'offline-mock',
      lastResult: this.lastTournamentResult,
      connectedClients: this.sseClients.size,
    };
  }

  /**
   * Triggers and executes a full multi-round tournament, streaming every hook step.
   */
  public async startTournament(): Promise<{ started: boolean; reason?: string }> {
    if (this.isTournamentRunning) {
      return { started: false, reason: 'Tournament is already in progress' };
    }

    this.isTournamentRunning = true;
    this.currentRoundNumber = 0;

    // Reset initial agents for a clean tournament run
    const apiKey = process.env.LLM_API_KEY;
    this.currentAgents = createInitialAgents(Boolean(apiKey));
    const adapter: AgentAdapter = apiKey
      ? new OpenAICompatibleAdapter({ apiKey })
      : new MockAdapter();

    // Broadcast tournament kickoff
    this.broadcast('tournament:start', {
      initialAgents: this.currentAgents,
      totalRounds: tournamentProblems.length,
      adapterMode: apiKey ? 'live-llm' : 'offline-mock',
    });

    // Execute asynchronously with pacing delay so human viewers can follow live
    (async () => {
      try {
        await this.sleep(this.paceMs);

        const result = await runTournament({
          agents: this.currentAgents,
          problems: tournamentProblems,
          adapter,
          hooks: {
            onRoundStart: async (round, problem, activeAgents) => {
              this.currentRoundNumber = round;
              this.broadcast('round:start', {
                roundNumber: round,
                problem,
                activeAgents,
              });
              await this.sleep(this.paceMs);
            },

            onProposalSubmitted: async (proposal, agent) => {
              this.broadcast('proposal:submitted', { proposal, agent });
              await this.sleep(this.paceMs);
            },

            onProposalRejected: async (agent, errors) => {
              this.broadcast('proposal:rejected', { agent, errors });
              await this.sleep(this.paceMs);
            },

            onChallengeSubmitted: async (challenge, auditor, targetGenerator) => {
              this.broadcast('challenge:submitted', {
                challenge,
                auditor,
                targetGenerator,
              });
              await this.sleep(this.paceMs);
            },

            onChallengeDeclined: async (auditor, targetGenerator) => {
              this.broadcast('challenge:declined', {
                auditor,
                targetGenerator,
              });
              await this.sleep(this.paceMs);
            },

            onChallengeRejected: async (auditor, errors) => {
              this.broadcast('challenge:rejected', { auditor, errors });
              await this.sleep(this.paceMs);
            },

            onEvaluationCompleted: async (evaluation) => {
              this.broadcast('evaluation:completed', { evaluation });
              await this.sleep(this.paceMs);
            },

            onSettlementCompleted: async (roundNumber, settlement) => {
              // Update local state registry
              this.currentAgents = [...settlement.updatedAgents];
              this.broadcast('settlement:completed', {
                roundNumber,
                settlement,
                updatedAgents: settlement.updatedAgents,
              });
              await this.sleep(this.paceMs);
            },

            onBankruptcy: async (agent, roundNumber) => {
              this.broadcast('agent:bankruptcy', { agent, roundNumber });
              await this.sleep(this.paceMs);
            },

            onRoundEnd: async (roundResult: RoundResult) => {
              this.broadcast('round:end', { roundResult });
              await this.sleep(this.paceMs);
            },

            onTournamentEnd: async (tournamentResult: TournamentResult) => {
              this.lastTournamentResult = tournamentResult;
              this.currentAgents = [...tournamentResult.finalAgents];
              this.broadcast('tournament:end', { tournamentResult });
              await this.sleep(this.paceMs);
            },
          },
        });

        this.lastTournamentResult = result;
      } catch (err: any) {
        this.broadcast('tournament:error', {
          message: err?.message || 'Tournament execution error',
        });
      } finally {
        this.isTournamentRunning = false;
        this.broadcast('tournament:state', { isRunning: false });
      }
    })();

    return { started: true };
  }

  /**
   * Request handler for native Node.js HTTP server.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase() ?? 'GET';

    // CORS Headers for flexible access
    if (typeof res.setHeader === 'function') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Single Page Dashboard App (HTML)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      fs.readFile(HTML_FILE_PATH, 'utf-8', (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`[NashGate Error] Failed to load dashboard: ${err.message}`);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      });
      return;
    }

    // 2. Real-time Server-Sent Events (SSE) Stream
    if (method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.write(': keepalive\n\n');

      // Send initial snapshot on connection
      res.write(`event: state:init\ndata: ${JSON.stringify(this.getStateSnapshot())}\n\n`);

      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 3. API: Start Tournament
    if (method === 'POST' && (pathname === '/api/start' || pathname === '/api/tournament/start')) {
      this.startTournament().then((result) => {
        if (!result.started) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: result.reason }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Tournament started successfully' }));
      });
      return;
    }

    // 4. API: Status Snapshot
    if (method === 'GET' && pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStateSnapshot()));
      return;
    }

    // 5. 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint Not Found', pathname }));
  }

  /**
   * Starts listening on the specified port and host.
   */
  public listen(port: number = DEFAULT_PORT, host: string = DEFAULT_HOST): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(port, host, () => {
        const address = this.server?.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        resolve(actualPort);
      });
    });
  }

  /**
   * Gracefully shuts down the HTTP server and disconnects active SSE clients.
   */
  public close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.sseClients) {
        try {
          client.end();
        } catch {}
      }
      this.sseClients.clear();

      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Direct Execution Entrypoint
// ---------------------------------------------------------------------------

async function runDirect() {
  const server = new DashboardServer();
  const port = DEFAULT_PORT;
  const host = DEFAULT_HOST;

  try {
    const actualPort = await server.listen(port, host);
    const url = `http://${host}:${actualPort}`;

    console.log(`
\x1b[36m╔═══════════════════════════════════════════════════════════════════════════════╗
║                               \x1b[1mNASHGATE UI\x1b[0m\x1b[36m                                     ║
║            \x1b[33mReal-Time Game-Theoretic Multi-Agent Visualizer\x1b[0m\x1b[36m                    ║
╚═══════════════════════════════════════════════════════════════════════════════╝\x1b[0m

  \x1b[32m⚡ Visualizer Dashboard:\x1b[0m \x1b[1m\x1b[4m${url}\x1b[0m
  \x1b[35m📡 SSE Event Stream:\x1b[0m     ${url}/events
  \x1b[34m🤖 Engine Mode:\x1b[0m          ${process.env.LLM_API_KEY ? '\x1b[32mLive OpenAI-Compatible API\x1b[0m' : '\x1b[33mDeterministic Mock Catalog\x1b[0m'}
  \x1b[90m⏱️  Pacing Step Delay:\x1b[0m    ${DEFAULT_PACE_DELAY_MS}ms per step

  \x1b[90mPress Ctrl+C to stop the dashboard server.\x1b[0m
`);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31m[Error] Port ${port} is already in use. Please specify another port via PORT=<number>.\x1b[0m`);
    } else {
      console.error(`\x1b[31m[Fatal Error] Failed to start NashGate dashboard server:\x1b[0m`, err);
    }
    process.exit(1);
  }
}

// Auto-run if executed as main file
if (process.argv[1] && (process.argv[1].endsWith('dashboard.ts') || process.argv[1].endsWith('dashboard.js'))) {
  runDirect();
}
