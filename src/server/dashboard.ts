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
import { createAgent, validateAgentRoster, type Agent } from '../core/index.ts';
import {
  MockAdapter,
  OpenAICompatibleAdapter,
  createAgentAdapter,
  resolveDefaultModel,
  normalizeModelName,
  isLiveMode,
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
 * When isLive is true, dynamically applies custom model or resolves the model name across all agents.
 */
export function createInitialAgents(
  isLive: boolean = isLiveMode(),
  defaultModel?: string,
  agentModels?: Record<string, string>
): Agent[] {
  const fallbackModel = isLive ? normalizeModelName(defaultModel || resolveDefaultModel()) : null;
  return [
    createAgent({
      id: 'AlphaGen',
      role: 'GENERATOR',
      model: agentModels?.['AlphaGen'] ? normalizeModelName(agentModels['AlphaGen']) : (fallbackModel || 'deterministic-solid'),
      capital: 100,
    }),
    createAgent({
      id: 'BuggyGen',
      role: 'GENERATOR',
      model: agentModels?.['BuggyGen'] ? normalizeModelName(agentModels['BuggyGen']) : (fallbackModel || 'heuristic-naive'),
      capital: 100,
    }),
    createAgent({
      id: 'SharpAuditor',
      role: 'AUDITOR',
      model: agentModels?.['SharpAuditor'] ? normalizeModelName(agentModels['SharpAuditor']) : (fallbackModel || 'adversarial-verifier'),
      capital: 100,
    }),
    createAgent({
      id: 'RecklessAuditor',
      role: 'AUDITOR',
      model: agentModels?.['RecklessAuditor'] ? normalizeModelName(agentModels['RecklessAuditor']) : (fallbackModel || 'speculative-challenger'),
      capital: 100,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) Manager & Tournament Orchestration State
// ---------------------------------------------------------------------------

export interface DashboardServerOptions {
  readonly paceMs?: number;
}

export interface StartTournamentOptions {
  readonly model?: string;
  readonly agentModels?: Record<string, string>;
  readonly apiKey?: string;
  readonly agentApiKeys?: Record<string, string>;
  readonly agentBaseUrls?: Record<string, string>;
  readonly agents?: readonly (Agent | {
    id: string;
    role: 'GENERATOR' | 'AUDITOR';
    model: string;
    capital?: number;
    apiKey?: string;
    baseUrl?: string;
  })[];
  readonly rounds?: number;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private isTournamentRunning = false;
  private currentAgents: Agent[] = createInitialAgents(isLiveMode());
  private lastTournamentResult: TournamentResult | null = null;
  private currentRoundNumber = 0;
  private readonly paceMs: number;
  private eventHistory: Array<{ event: string; data: unknown }> = [];
  private currentAbortController: AbortController | null = null;

  constructor(options?: DashboardServerOptions) {
    this.paceMs = options?.paceMs ?? DEFAULT_PACE_DELAY_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns current agents with sensitive API keys masked for client security.
   */
  public getSanitizedAgents(): (Agent & { hasDedicatedKey?: boolean })[] {
    return this.currentAgents.map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      capital: a.capital,
      status: a.status,
      hasDedicatedKey: Boolean(a.apiKey && a.apiKey.trim().length > 0),
      ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
      ...(a.apiKey ? { apiKey: '••••••••' } : {}),
    }));
  }

  /**
   * Adds or updates an agent in the configured roster.
   */
  public upsertAgent(params: {
    id: string;
    role: 'GENERATOR' | 'AUDITOR';
    model: string;
    capital?: number;
    apiKey?: string;
    baseUrl?: string;
  }): { ok: boolean; agent?: Agent; error?: string } {
    if (this.isTournamentRunning) {
      return { ok: false, error: 'Cannot modify agents while tournament is running.' };
    }
    try {
      const newAgent = createAgent({
        id: params.id,
        role: params.role,
        model: params.model,
        capital: params.capital ?? 100,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });

      const existingIndex = this.currentAgents.findIndex((a) => a.id === newAgent.id);
      let updatedList: Agent[];
      if (existingIndex >= 0) {
        updatedList = [...this.currentAgents];
        updatedList[existingIndex] = newAgent;
      } else {
        updatedList = [...this.currentAgents, newAgent];
      }

      const rosterValidation = validateAgentRoster(updatedList);
      if (!rosterValidation.valid) {
        return { ok: false, error: rosterValidation.errors.join('; ') };
      }

      this.currentAgents = updatedList;
      this.broadcast('agents:updated', { agents: this.getSanitizedAgents() });
      return { ok: true, agent: newAgent };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Deletes an agent from the roster by ID.
   */
  public deleteAgent(agentId: string): { ok: boolean; error?: string } {
    if (this.isTournamentRunning) {
      return { ok: false, error: 'Cannot delete agents while tournament is running.' };
    }
    const filtered = this.currentAgents.filter((a) => a.id !== agentId);
    if (filtered.length === this.currentAgents.length) {
      return { ok: false, error: `Agent '${agentId}' not found.` };
    }
    const rosterValidation = validateAgentRoster(filtered);
    if (!rosterValidation.valid) {
      return { ok: false, error: rosterValidation.errors.join('; ') };
    }
    this.currentAgents = filtered;
    this.broadcast('agents:updated', { agents: this.getSanitizedAgents() });
    return { ok: true };
  }

  /**
   * Resets agents back to standard initial 4-agent roster.
   */
  public resetAgents(defaultModel?: string): Agent[] {
    if (this.isTournamentRunning) {
      this.abortTournament();
    }
    this.currentAgents = createInitialAgents(isLiveMode(), defaultModel);
    this.broadcast('agents:updated', { agents: this.getSanitizedAgents() });
    return this.currentAgents;
  }

  /**
   * Broadcasts an SSE message to all connected browsers and buffers it for reconnections.
   */
  public broadcast(event: string, data: unknown): void {
    this.eventHistory.push({ event, data });
    if (this.eventHistory.length > 200) {
      this.eventHistory.shift();
    }

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
   * Aborts an active tournament immediately and resets dashboard state to STANDBY.
   */
  public abortTournament(): { stopped: boolean } {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.isTournamentRunning = false;
    this.currentRoundNumber = 0;
    this.eventHistory = [];
    this.currentAgents = createInitialAgents(isLiveMode());
    this.broadcast('tournament:reset', { message: 'Tournament was reset by user request.' });
    this.broadcast('tournament:state', { isRunning: false });
    return { stopped: true };
  }

  /**
   * Returns snapshot of current state for new connections.
   */
  public getStateSnapshot() {
    const isLive = isLiveMode();
    return {
      isRunning: this.isTournamentRunning,
      agents: this.getSanitizedAgents(),
      currentRound: this.currentRoundNumber,
      totalProblems: tournamentProblems.length,
      problems: tournamentProblems,
      adapterMode: isLive ? 'live-llm' : 'offline-mock',
      resolvedModel: isLive ? resolveDefaultModel() : undefined,
      lastResult: this.lastTournamentResult,
      connectedClients: this.sseClients.size,
    };
  }

  /**
   * Triggers and executes a full multi-round tournament, streaming every hook step.
   * Supports custom agent rosters, per-agent API keys, per-agent base URLs, and custom models.
   */
  public async startTournament(options?: StartTournamentOptions): Promise<{ started: boolean; reason?: string }> {
    if (this.isTournamentRunning) {
      return { started: false, reason: 'Tournament is already in progress' };
    }

    this.isTournamentRunning = true;
    this.currentRoundNumber = 0;
    this.eventHistory = [];
    this.currentAbortController = new AbortController();

    const selectedProblems = options?.rounds && options.rounds > 0
      ? tournamentProblems.slice(0, Math.min(options.rounds, tournamentProblems.length))
      : tournamentProblems;

    // Resolve models and keys
    const uiApiKey = options?.apiKey?.trim() || undefined;
    const isLive = isLiveMode() || Boolean(uiApiKey);
    const liveModel = options?.model?.trim() ? normalizeModelName(options.model) : resolveDefaultModel();
    const sanitizedAgentModels: Record<string, string> | undefined = options?.agentModels
      ? Object.fromEntries(
          Object.entries(options.agentModels).map(([k, v]) => [k, normalizeModelName(v)])
        )
      : undefined;

    // Use custom roster if provided, otherwise initialize standard roster
    if (options?.agents && options.agents.length > 0) {
      try {
        const configured = options.agents.map((a) =>
          createAgent({
            id: a.id,
            role: a.role,
            model: a.model ? normalizeModelName(a.model) : (sanitizedAgentModels?.[a.id] || liveModel),
            capital: a.capital ?? 100,
            apiKey: a.apiKey || options?.agentApiKeys?.[a.id],
            baseUrl: a.baseUrl || options?.agentBaseUrls?.[a.id],
          })
        );
        const rosterValidation = validateAgentRoster(configured);
        if (!rosterValidation.valid) {
          this.isTournamentRunning = false;
          return { started: false, reason: rosterValidation.errors.join('; ') };
        }
        this.currentAgents = configured;
      } catch (err: any) {
        this.isTournamentRunning = false;
        return { started: false, reason: `Invalid agent configuration: ${err?.message || String(err)}` };
      }
    } else {
      this.currentAgents = createInitialAgents(isLive, liveModel, sanitizedAgentModels);
    }

    // Dynamic per-agent adapter resolver supporting independent API keys, base URLs, and models
    const adapterResolver = (agent: Agent): AgentAdapter => {
      const key = agent.apiKey || options?.agentApiKeys?.[agent.id] || uiApiKey;
      const url = agent.baseUrl || options?.agentBaseUrls?.[agent.id];
      const model = agent.model || sanitizedAgentModels?.[agent.id] || liveModel;

      return createAgentAdapter(
        { ...agent, apiKey: key, baseUrl: url, model },
        {
          globalApiKey: uiApiKey,
          globalModel: liveModel,
          onRetry: (info) => {
            this.broadcast('agent:retry', info);
          },
        }
      );
    };

    // Broadcast tournament kickoff
    this.broadcast('tournament:start', {
      initialAgents: this.getSanitizedAgents(),
      totalRounds: selectedProblems.length,
      adapterMode: isLive ? 'live-llm' : 'offline-mock',
      resolvedModel: isLive ? liveModel : undefined,
    });

    // Execute asynchronously with pacing delay so human viewers can follow live
    (async () => {
      try {
        await this.sleep(this.paceMs);

        const result = await runTournament({
          agents: this.currentAgents,
          problems: selectedProblems,
          adapter: adapterResolver,
          abortSignal: this.currentAbortController?.signal,
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

            onAgentActionStart: async (agent, phase, targetGenerator) => {
              this.broadcast('agent:action:start', {
                agent,
                phase,
                targetGenerator,
                roundNumber: this.currentRoundNumber,
              });
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
                updatedAgents: this.getSanitizedAgents(),
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

            onError: async (error, context) => {
              this.broadcast('engine:error', {
                error: error.message || String(error),
                phase: context.phase,
                agent: context.agent,
                targetGenerator: context.targetGenerator,
                roundNumber: context.roundNumber,
              });
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
        this.currentAbortController = null;
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

      // Replay all buffered events from current tournament so newly connected or refreshed tabs get full feed
      for (const item of this.eventHistory) {
        res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
      }

      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      res.on('error', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 3. API: Agents Roster CRUD
    if (method === 'GET' && pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: this.getSanitizedAgents() }));
      return;
    }

    if (method === 'POST' && pathname === '/api/agents') {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(bodyText);
          const result = this.upsertAgent(payload);
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.error }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agent: result.agent, agents: this.getSanitizedAgents() }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Malformed JSON payload' }));
        }
      });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/agents/')) {
      const agentId = decodeURIComponent(pathname.substring('/api/agents/'.length));
      const result = this.deleteAgent(agentId);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: result.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: this.getSanitizedAgents() }));
      return;
    }

    if (method === 'POST' && pathname === '/api/agents/reset') {
      this.resetAgents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Agents reset to default roster', agents: this.getSanitizedAgents() }));
      return;
    }

    // 4. API: Reset / Abort Active Tournament
    if (method === 'POST' && (pathname === '/api/reset' || pathname === '/api/stop' || pathname === '/api/tournament/reset')) {
      this.abortTournament();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Tournament aborted and reset to standby' }));
      return;
    }

    // 5. API: Start Tournament (accepts optional JSON payload with custom agents, models, keys)
    if (method === 'POST' && (pathname === '/api/start' || pathname === '/api/tournament/start')) {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', () => {
        let payload: StartTournamentOptions = {};
        if (bodyText.trim()) {
          try {
            payload = JSON.parse(bodyText);
          } catch {}
        }
        this.startTournament(payload).then((result) => {
          if (!result.started) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.reason }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Tournament started successfully', model: payload.model }));
        });
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

  const isLive = isLiveMode();
  const engineDesc = isLive
    ? `\x1b[32mLive OpenAI-Compatible API (${resolveDefaultModel()})\x1b[0m`
    : '\x1b[33mDeterministic Mock Catalog\x1b[0m';

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
  \x1b[34m🤖 Engine Mode:\x1b[0m          ${engineDesc}
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
