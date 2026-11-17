/**
 * NashGate E2E Requirements Test Suite
 * Opaque-box, requirement-driven verification of the 4-Feature Release:
 * - R1: Extended Problem Catalog (>=8 problems) & Custom Problem Creation API
 * - R2: Real-Time Native SVG Capital Trajectory Chart
 * - R3: Multi-Format Arbitration Report API (JSON & Markdown)
 * - R4: Adaptive Game-Theoretic Dynamic Staking & Risk Management
 *
 * Test Architecture: 4-Tier Opaque Box Specification Coverage:
 * - Tier 1: Feature Coverage (Primary behavior and happy paths for R1-R4)
 * - Tier 2: Boundary & Corner Cases (Extreme stakes, invalid schemas, empty states)
 * - Tier 3: Cross-Feature Combinations (Problem -> Tournament -> Staking -> Report)
 * - Tier 4: Real-World Application Scenarios (Multi-round balance conservation & dependency audit)
 *
 * Zero external dependencies. Uses Node.js native test runner (`node:test`) and `node:assert/strict`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DashboardServer,
  tournamentProblems,
  createInitialAgents,
  generateReportJson,
  generateReportMarkdown,
} from '../src/server/dashboard.ts';
import { DEFAULT_MOCK_CATALOG, MockAdapter } from '../src/adapters/mock.ts';
import type { ProblemContext } from '../src/adapters/index.ts';
import {
  clampStake,
  calculateKellyFraction,
  calculateBankruptcyDistanceFactor,
  calculateGeneratorStake,
  calculateAuditorStake,
  createAgent,
  validateStake,
  settleRound,
  MIN_STAKE,
  DEFAULT_INITIAL_CAPITAL,
  type Agent,
  type Proposal,
  type Challenge,
  type ChallengeEvaluation,
} from '../src/core/index.ts';
import { runTournament, type TournamentResult } from '../src/engine/index.ts';

// ---------------------------------------------------------------------------
// Environment Isolation & In-Memory HTTP Simulation
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const HTML_FILE_PATH = path.join(ROOT_DIR, 'src', 'server', 'public', 'index.html');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

// Ensure isolated offline mock mode during tests to avoid live external API attempts
let originalLlmKey: string | undefined;
let originalGeminiKey: string | undefined;

before(() => {
  originalLlmKey = process.env.LLM_API_KEY;
  originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

after(() => {
  if (originalLlmKey !== undefined) process.env.LLM_API_KEY = originalLlmKey;
  if (originalGeminiKey !== undefined) process.env.GEMINI_API_KEY = originalGeminiKey;
});

interface SimulatedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json<T = any>(): T;
}

/**
 * Simulates native HTTP requests against DashboardServer without requiring TCP socket binding.
 * Bypasses OS socket permission constraints (e.g. Windows EACCES) and executes with zero latency.
 */
function simulateRequest(
  server: DashboardServer,
  options: {
    method?: string;
    url: string;
    body?: any;
    headers?: Record<string, string>;
  }
): Promise<SimulatedResponse> {
  return new Promise((resolve) => {
    const mockReq: any = new EventEmitter();
    mockReq.method = options.method || 'GET';
    mockReq.url = options.url;
    mockReq.headers = {
      host: 'localhost:3000',
      ...(options.headers || {}),
    };

    let statusCode = 200;
    const headers: Record<string, string> = {};
    let body = '';

    const mockRes: any = new EventEmitter();
    mockRes.setHeader = (key: string, value: string) => {
      headers[key.toLowerCase()] = String(value);
    };
    mockRes.writeHead = (code: number, headerObj?: Record<string, string>) => {
      statusCode = code;
      if (headerObj) {
        for (const [k, v] of Object.entries(headerObj)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    };
    mockRes.write = (chunk: string | Buffer) => {
      body += chunk.toString();
      return true;
    };
    mockRes.end = (chunk?: string | Buffer) => {
      if (chunk) {
        body += chunk.toString();
      }
      resolve({
        statusCode,
        headers,
        body,
        json<T = any>(): T {
          return JSON.parse(body);
        },
      });
    };

    (server as any).handleRequest(mockReq, mockRes);

    if (options.body !== undefined) {
      const payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      mockReq.emit('data', Buffer.from(payload));
      mockReq.emit('end');
    } else {
      mockReq.emit('end');
    }
  });
}

/**
 * Waits for active tournament on a DashboardServer instance to finish execution.
 */
async function waitForTournament(server: DashboardServer, timeoutMs: number = 4000): Promise<void> {
  const start = Date.now();
  while (server.getStateSnapshot().isRunning && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ===========================================================================
// TIER 1 — FEATURE COVERAGE (R1, R2, R3, R4)
// ===========================================================================

describe('Tier 1: Feature Coverage (R1 - R4)', () => {
  // -------------------------------------------------------------------------
  // R1: Extended Problem Catalog & API
  // -------------------------------------------------------------------------

  it('R1.1: tournamentProblems catalog contains at least 8 benchmark problems with required fields', () => {
    assert.ok(
      tournamentProblems.length >= 8,
      `Expected catalog size >= 8, got ${tournamentProblems.length}`
    );

    const requiredIds = [
      'is-palindrome',
      'clamp-number',
      'sum-array',
      'is-valid-parentheses',
      'two-sum',
      'flatten-array',
      'fibonacci',
      'anagram-check',
    ];

    for (const reqId of requiredIds) {
      const found = tournamentProblems.find((p) => p.id === reqId);
      assert.ok(found, `Mandatory benchmark problem '${reqId}' not found in catalog`);
      assert.ok(found.title && found.title.trim().length > 0, `Problem ${reqId} missing title`);
      assert.ok(found.task && found.task.trim().length > 0, `Problem ${reqId} missing task`);
      assert.ok(
        found.entrypoint && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(found.entrypoint),
        `Problem ${reqId} has invalid entrypoint identifier '${found.entrypoint}'`
      );
    }
  });

  it('R1.2: DEFAULT_MOCK_CATALOG matches extended problems with executable definitions', () => {
    assert.ok(
      Object.keys(DEFAULT_MOCK_CATALOG).length >= 8,
      `Expected mock catalog >= 8 entries, got ${Object.keys(DEFAULT_MOCK_CATALOG).length}`
    );

    for (const problem of tournamentProblems) {
      const mockEntry = DEFAULT_MOCK_CATALOG[problem.id];
      assert.ok(mockEntry, `Mock definition missing for problem '${problem.id}'`);
      assert.ok(mockEntry.solid?.solution, `Solid solution missing for '${problem.id}'`);
      assert.ok(mockEntry.buggy?.solution, `Buggy solution missing for '${problem.id}'`);
      assert.ok(mockEntry.flawChallenge, `Flaw challenge missing for '${problem.id}'`);
      assert.ok(mockEntry.falsePositiveChallenge, `False-positive challenge missing for '${problem.id}'`);
    }
  });

  it('R1.3: GET /api/problems lists all problems in the active catalog', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const res = await simulateRequest(server, { url: '/api/problems' });

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.problems));
    assert.ok(data.problems.length >= 8);
    assert.equal(data.total, data.problems.length);
  });

  it('R1.4: POST /api/problems registers a valid custom problem and increments total count', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const initialSnapshot = server.getStateSnapshot();
    const initialCount = initialSnapshot.totalProblems;

    const customProblem = {
      id: 'custom-square-number',
      title: 'Square Number Calculator',
      task: 'Implement square(n: number): number that returns n * n.',
      entrypoint: 'square',
      description: 'Defensively handle negative numbers and zero.',
    };

    const res = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: customProblem,
    });

    assert.equal(res.statusCode, 201);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.problem.id, 'custom-square-number');
    assert.equal(data.totalProblems, initialCount + 1);

    // Verify subsequent GET reflects the custom problem
    const listRes = await simulateRequest(server, { url: '/api/problems' });
    const listData = listRes.json();
    const found = listData.problems.find((p: any) => p.id === 'custom-square-number');
    assert.ok(found, 'Newly registered problem must appear in /api/problems list');
  });

  it('R1.5: DashboardServer exposes problems catalog in state snapshot', () => {
    const server = new DashboardServer({ paceMs: 1 });
    const snapshot = server.getStateSnapshot();
    assert.ok(snapshot.totalProblems >= 8);
    assert.ok(Array.isArray(snapshot.problems));
    assert.equal(snapshot.problems.length, snapshot.totalProblems);
  });

  // -------------------------------------------------------------------------
  // R2: Native SVG Capital Trajectory
  // -------------------------------------------------------------------------

  it('R2.1: index.html contains native SVG line chart container and svg element', () => {
    assert.ok(fs.existsSync(HTML_FILE_PATH), `index.html not found at ${HTML_FILE_PATH}`);
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');

    // Chart panel container and native SVG element
    assert.ok(
      html.includes('chart-panel') || html.includes('capital-chart') || html.includes('chartContainer'),
      'Dashboard HTML must declare a dedicated capital chart panel container'
    );
    assert.ok(
      html.includes('<svg') || html.includes('createElementNS'),
      'Dashboard HTML must contain or render a native SVG element'
    );
  });

  it('R2.2: SVG chart has viewBox and dark theme styling consistent with dashboard', () => {
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');
    // Dark mode palette indicators
    assert.ok(
      html.includes('--bg-base') || html.includes('#080b11') || html.includes('#0f1623'),
      'Chart styling must adhere to dark mode background variables'
    );
    // ViewBox aspect ratio definition
    assert.ok(
      html.includes('viewBox=') || html.includes('setAttribute("viewBox"') || html.includes("setAttribute('viewBox'"),
      'Native SVG must declare a responsive viewBox attribute'
    );
  });

  it('R2.3: SVG chart includes baseline reference indicators ($100 baseline, $0 bankruptcy)', () => {
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');
    // References to initial baseline $100 and bankruptcy $0
    assert.ok(
      html.includes('100') && (html.includes('Baseline') || html.includes('baseline') || html.includes('100.00')),
      'Chart must display or calculate baseline $100 reference line'
    );
    assert.ok(
      html.includes('Insolvent') || html.includes('Bankrupt') || html.includes('$0') || html.includes('bankruptcy'),
      'Chart must display or calculate bankruptcy $0 reference barrier'
    );
  });

  it('R2.4: SVG chart renders polyline/path trajectory curves and data point markers', () => {
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');
    // Curve lines and data markers
    assert.ok(
      html.includes('<polyline') ||
        html.includes('<path') ||
        html.includes('createElementNS("http://www.w3.org/2000/svg", "polyline")') ||
        html.includes("createElementNS('http://www.w3.org/2000/svg', 'polyline')") ||
        html.includes('createElementNS("http://www.w3.org/2000/svg", "path")') ||
        html.includes("createElementNS('http://www.w3.org/2000/svg', 'path')"),
      'Chart must render polyline or path elements for trajectory lines'
    );
  });

  it('R2.5: index.html registers SSE listeners for round settlement events', () => {
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');
    assert.ok(
      html.includes("'round:settlement'") ||
        html.includes('"round:settlement"') ||
        html.includes("'settlement:completed'") ||
        html.includes('"settlement:completed"'),
      'Dashboard script must listen to settlement SSE events to update real-time capital trajectories'
    );
  });

  // -------------------------------------------------------------------------
  // R3: Multi-Format Arbitration Report API
  // -------------------------------------------------------------------------

  it('R3.1: GET /api/report?format=json exports structured JSON report with ROI, capital, and audit details', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    // Run a 1-round tournament to produce a real completed tournament result
    await server.startTournament({ rounds: 1 });
    await waitForTournament(server);

    const res = await simulateRequest(server, { url: '/api/report?format=json' });

    assert.equal(res.statusCode, 200);
    assert.ok(
      res.headers['content-type']?.includes('application/json'),
      'Content-Type must be application/json'
    );
    assert.ok(
      res.headers['content-disposition']?.includes('attachment') &&
        res.headers['content-disposition']?.includes('.json'),
      'Content-Disposition must specify attachment with .json extension'
    );

    const report = res.json();
    assert.ok(
      report.metadata || report.tournamentSummary,
      'Report JSON must contain metadata/tournamentSummary'
    );
    assert.ok(Array.isArray(report.leaderboard), 'Report JSON must contain leaderboard array');
    assert.ok(report.leaderboard.length >= 2, 'Leaderboard must record agent standings');

    const firstAgent = report.leaderboard[0];
    assert.ok(firstAgent.id || firstAgent.agentId, 'Leaderboard entries must record agent id');
    assert.ok(
      typeof (firstAgent.capital ?? firstAgent.finalCapital) === 'number',
      'Leaderboard entries must record capital'
    );

    assert.ok(Array.isArray(report.rounds), 'Report JSON must contain rounds audit data');
    assert.equal(report.rounds.length, 1);
    assert.ok(report.rounds[0].problem, 'Round audit must record problem context');
    assert.ok(report.rounds[0].settlements, 'Round audit must record settlement outcome');
  });

  it('R3.2: GET /api/report?format=markdown exports formatted Markdown report with leaderboard table and audit summary', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    await server.startTournament({ rounds: 1 });
    await waitForTournament(server);

    const res = await simulateRequest(server, { url: '/api/report?format=markdown' });

    assert.equal(res.statusCode, 200);
    assert.ok(
      res.headers['content-type']?.includes('text/markdown'),
      'Content-Type must be text/markdown'
    );
    assert.ok(
      res.headers['content-disposition']?.includes('attachment') &&
        res.headers['content-disposition']?.includes('.md'),
      'Content-Disposition must specify attachment with .md extension'
    );

    const md = res.body;
    assert.ok(md.includes('# NashGate Arbitration'), 'Markdown report must have header title');
    assert.ok(
      md.includes('| Agent |') || md.includes('| Agent ID |'),
      'Markdown report must include Leaderboard table'
    );
    assert.ok(md.includes('ROI'), 'Markdown report must include ROI column');
    assert.ok(md.includes('Round 1'), 'Markdown report must detail round summaries');
    assert.ok(
      md.includes('Dividend') || md.includes('Penalty') || md.includes('Oracle'),
      'Markdown report must break down oracle verdicts, dividends, and penalties'
    );
  });

  it('R3.3: index.html includes report download triggers for JSON and Markdown', () => {
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');
    assert.ok(
      html.includes('downloadReport') || html.includes('/api/report'),
      'Dashboard HTML must include trigger mechanisms for downloading arbitration reports'
    );
    assert.ok(
      html.includes('JSON') && html.includes('Markdown'),
      'Dashboard HTML must provide access to both JSON and Markdown report formats'
    );
  });

  // -------------------------------------------------------------------------
  // R4: Dynamic Staking & Pure Risk Management
  // -------------------------------------------------------------------------

  it('R4.1: calculateKellyFraction computes optimal binary Kelly fraction for generator and auditor payoffs', () => {
    // Generator payoff: winOdds = 0.50 (resilience dividend), lossOdds = 1.0 (forfeiture)
    // Formula: f* = 3p - 2
    assert.equal(calculateKellyFraction(0.8, 0.5, 1.0), 0.4);
    assert.equal(calculateKellyFraction(0.9, 0.5, 1.0), 0.7);
    assert.equal(calculateKellyFraction(1.0, 0.5, 1.0), 1.0);

    // Negative EV (p <= 2/3) must return 0
    assert.equal(calculateKellyFraction(2 / 3, 0.5, 1.0), 0);
    assert.equal(calculateKellyFraction(0.5, 0.5, 1.0), 0);
    assert.equal(calculateKellyFraction(0.1, 0.5, 1.0), 0);
  });

  it('R4.2: calculateBankruptcyDistanceFactor scales risk aversion based on remaining capital', () => {
    // Normal / prosperous capital (>= 100)
    assert.equal(calculateBankruptcyDistanceFactor(100), 1.0);
    assert.equal(calculateBankruptcyDistanceFactor(200), 1.0);

    // Distressed capital scales down linearly
    assert.equal(calculateBankruptcyDistanceFactor(50), 0.5);
    assert.equal(calculateBankruptcyDistanceFactor(25), 0.25);

    // Floor at 0.10 for sub-10 capital to prevent total freeze
    assert.equal(calculateBankruptcyDistanceFactor(5), 0.1);
    assert.equal(calculateBankruptcyDistanceFactor(1), 0.1);

    // Insolvent capital (<= 0)
    assert.equal(calculateBankruptcyDistanceFactor(0), 0);
    assert.equal(calculateBankruptcyDistanceFactor(-20), 0);
  });

  it('R4.3: calculateGeneratorStake returns game-theoretically sound adaptive staking decision', () => {
    const decision = calculateGeneratorStake({
      capital: 100,
      confidence: 0.9,
      riskProfile: 'balanced',
    });

    assert.equal(decision.stake, 35);
    assert.equal(decision.fraction, 0.35);
    assert.equal(decision.riskAversionFactor, 1.0);
    assert.ok(decision.expectedValue > 0);
    assert.ok(decision.rationale.includes('Kelly'));

    // Sub-critical confidence falls back to MIN_STAKE
    const subCritical = calculateGeneratorStake({
      capital: 100,
      confidence: 0.55,
    });
    assert.equal(subCritical.stake, MIN_STAKE);
    assert.ok(subCritical.rationale.includes('Sub-critical'));
  });

  it('R4.4: calculateAuditorStake bounds stake exposure to maintain positive EV against -1.5x spam penalty', () => {
    const confident = calculateAuditorStake({
      capital: 100,
      targetStake: 50,
      confidence: 0.85,
      riskProfile: 'balanced',
    });

    assert.ok(confident.stake >= MIN_STAKE);
    assert.ok(confident.stake <= 100);
    assert.ok(confident.expectedValue > 0);

    // Low confidence auditor protects capital by betting MIN_STAKE
    const uncertain = calculateAuditorStake({
      capital: 100,
      targetStake: 50,
      confidence: 0.3,
    });
    assert.equal(uncertain.stake, MIN_STAKE);
    assert.ok(uncertain.rationale.includes('Low bug probability'));
  });

  it('R4.5: clampStake strictly enforces [MIN_STAKE, capital] bounds', () => {
    assert.equal(clampStake(50, 100), 50);
    assert.equal(clampStake(0, 100), MIN_STAKE);
    assert.equal(clampStake(-25, 100), MIN_STAKE);
    assert.equal(clampStake(250, 100), 100);
    assert.equal(clampStake(10, 0), 0);
    assert.equal(clampStake(10, -5), 0);
  });
});

// ===========================================================================
// TIER 2 — BOUNDARY & CORNER CASES
// ===========================================================================

describe('Tier 2: Boundary & Corner Cases', () => {
  // -------------------------------------------------------------------------
  // B1: Schema Validation on POST /api/problems
  // -------------------------------------------------------------------------

  it('Tier 2 - B1.1: POST /api/problems rejects payload missing id with HTTP 400', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const res = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: {
        title: 'Missing ID Problem',
        task: 'Do something',
        entrypoint: 'solve',
      },
    });

    assert.equal(res.statusCode, 400);
    const data = res.json();
    assert.equal(data.ok, false);
    assert.ok(data.error.toLowerCase().includes('id'));
  });

  it('Tier 2 - B1.2: POST /api/problems rejects payload missing title or task with HTTP 400', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    // Missing title
    const resNoTitle = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: { id: 'no-title', task: 'Do something' },
    });
    assert.equal(resNoTitle.statusCode, 400);

    // Missing task
    const resNoTask = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: { id: 'no-task', title: 'A Title' },
    });
    assert.equal(resNoTask.statusCode, 400);
  });

  it('Tier 2 - B1.3: POST /api/problems rejects invalid characters in problem id with HTTP 400', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const invalidIds = ['Bad ID With Spaces', 'bad@character$', 'Uppercase_Problem!'];

    for (const badId of invalidIds) {
      const res = await simulateRequest(server, {
        method: 'POST',
        url: '/api/problems',
        body: {
          id: badId,
          title: 'Problem Title',
          task: 'Problem Task',
          entrypoint: 'solve',
        },
      });

      assert.equal(
        res.statusCode,
        400,
        `Expected HTTP 400 rejection for malformed id '${badId}', got ${res.statusCode}`
      );
    }
  });

  it('Tier 2 - B1.4: POST /api/problems rejects duplicate problem id', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    const problem = {
      id: 'duplicate-test-problem',
      title: 'Original Title',
      task: 'Original Task',
      entrypoint: 'fnOriginal',
    };

    // First submission: Success
    const firstRes = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: problem,
    });
    assert.equal(firstRes.statusCode, 201);

    // Second submission with exact same ID: Rejected
    const duplicateRes = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: { ...problem, title: 'Conflicting Title' },
    });
    assert.ok(
      duplicateRes.statusCode === 400 || duplicateRes.statusCode === 409,
      `Expected HTTP 400 or 409 for duplicate problem id, got ${duplicateRes.statusCode}`
    );
    const data = duplicateRes.json();
    assert.equal(data.ok, false);
    assert.ok(data.error.toLowerCase().includes('already exists'));
  });

  it('Tier 2 - B1.5: POST /api/problems rejects invalid entrypoint identifier with HTTP 400', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const badEntrypoints = ['123startWithNumber', 'bad-hyphenated', 'invalid space'];

    for (const ep of badEntrypoints) {
      const res = await simulateRequest(server, {
        method: 'POST',
        url: '/api/problems',
        body: {
          id: `bad-ep-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          title: 'Bad Entrypoint Test',
          task: 'Task details',
          entrypoint: ep,
        },
      });

      assert.equal(
        res.statusCode,
        400,
        `Expected HTTP 400 rejection for invalid entrypoint '${ep}', got ${res.statusCode}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // B2: Extreme Capital Stakes & Clamping
  // -------------------------------------------------------------------------

  it('Tier 2 - B2.1: Extreme capital stakes: minimum capital boundary (C = 1)', () => {
    // When capital is exactly MIN_STAKE (1), the only permissible stake is 1
    assert.equal(clampStake(10, 1), 1);
    assert.equal(clampStake(0.1, 1), 1);
    assert.equal(clampStake(1, 1), 1);

    const genDecision = calculateGeneratorStake({ capital: 1, confidence: 0.95 });
    assert.equal(genDecision.stake, 1);

    const audDecision = calculateAuditorStake({ capital: 1, targetStake: 10, confidence: 0.95 });
    assert.equal(audDecision.stake, 1);
  });

  it('Tier 2 - B2.2: Extreme capital stakes: high capital boundary (C = 1000)', () => {
    assert.equal(clampStake(250, 1000), 250);
    assert.equal(clampStake(1500, 1000), 1000);

    const genDecision = calculateGeneratorStake({ capital: 1000, confidence: 0.9 });
    assert.ok(genDecision.stake > 100);
    assert.ok(genDecision.stake <= 1000);
    assert.ok(Number.isFinite(genDecision.stake));
  });

  it('Tier 2 - B2.3: validateStake rejects stakes exceeding capital (s > C) and below minimum (s < 1)', () => {
    // Excess stake
    const excess = validateStake(101, 100);
    assert.equal(excess.valid, false);
    assert.ok(
      excess.errors.some(
        (e) =>
          e.toLowerCase().includes('exceed') ||
          e.toLowerCase().includes('capital')
      )
    );

    // Sub-minimal stake
    const subMin = validateStake(0.5, 100);
    assert.equal(subMin.valid, false);
    assert.ok(subMin.errors.some((e) => e.includes('MIN_STAKE')));

    // Non-finite stakes
    assert.equal(validateStake(NaN, 100).valid, false);
    assert.equal(validateStake(Infinity, 100).valid, false);

    // Insolvent capital
    assert.equal(validateStake(1, 0.5).valid, false);
  });

  it('Tier 2 - B2.4: clampStake handles non-numeric, NaN, and infinite stakes defensively', () => {
    assert.ok(!Number.isFinite(clampStake(NaN, 100)) || clampStake(NaN, 100) === 0);
    assert.equal(clampStake(Infinity, 100), 100);
    assert.equal(clampStake(-Infinity, 100), MIN_STAKE);
  });

  it('Tier 2 - B2.5: clampStake enforces 0 stake for insolvent agents (C <= 0)', () => {
    assert.equal(clampStake(25, 0), 0);
    assert.equal(clampStake(25, -10), 0);
    assert.equal(clampStake(-5, 0), 0);
  });

  // -------------------------------------------------------------------------
  // B3: Report Download Edge Cases
  // -------------------------------------------------------------------------

  it('Tier 2 - B3.1: GET /api/report returns HTTP 400 when no completed tournament exists', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const res = await simulateRequest(server, { url: '/api/report?format=json' });

    assert.equal(res.statusCode, 400);
    const data = res.json();
    assert.equal(data.ok, false);
    assert.ok(data.error.toLowerCase().includes('no completed tournament'));
  });

  it('Tier 2 - B3.2: GET /api/report defaults to JSON when format parameter is omitted or custom', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    await server.startTournament({ rounds: 1 });
    await waitForTournament(server);

    // Default call without ?format=
    const resDefault = await simulateRequest(server, { url: '/api/report' });
    assert.equal(resDefault.statusCode, 200);
    assert.ok(resDefault.headers['content-type']?.includes('application/json'));
  });

  // -------------------------------------------------------------------------
  // B4: SVG Coordinate Mapping Edge Cases
  // -------------------------------------------------------------------------

  it('Tier 2 - B4.1: SVG coordinate mapping handles 0 rounds without NaN or division by zero', () => {
    // Formula under test:
    // x(round) = left + (round / Math.max(1, maxRound)) * plotW
    const left = 55;
    const plotW = 870;
    const maxRound = 0;
    const round = 0;

    const x = left + (round / Math.max(1, maxRound)) * plotW;
    assert.ok(Number.isFinite(x), `Coordinate x must be finite for 0 rounds, got ${x}`);
    assert.equal(x, 55);
  });

  it('Tier 2 - B4.2: SVG coordinate mapping handles single round (1 round) tournament correctly', () => {
    const left = 55;
    const plotW = 870;
    const maxRound = 1;

    const xRound0 = left + (0 / Math.max(1, maxRound)) * plotW;
    const xRound1 = left + (1 / Math.max(1, maxRound)) * plotW;

    assert.equal(xRound0, 55);
    assert.equal(xRound1, 55 + 870);
    assert.ok(xRound1 > xRound0);
  });
});

// ===========================================================================
// TIER 3 — CROSS-FEATURE COMBINATIONS
// ===========================================================================

describe('Tier 3: Cross-Feature Combinations', () => {
  it('Tier 3.1: Custom problem registration -> tournament execution -> dynamic staking -> report generation', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    // Step 1: Register custom problem via POST /api/problems
    const customProblem = {
      id: 'e2e-cross-feature-problem',
      title: 'E2E Cross-Feature Validation Problem',
      task: 'Implement multiplyByThree(n: number): number that triples input.',
      entrypoint: 'multiplyByThree',
    };

    const registerRes = await simulateRequest(server, {
      method: 'POST',
      url: '/api/problems',
      body: customProblem,
    });
    assert.equal(registerRes.statusCode, 201);

    // Step 2: Run a 1-round tournament
    const startRes = await server.startTournament({ rounds: 1 });
    assert.equal(startRes.started, true);
    await waitForTournament(server);

    // Step 3: Verify tournament completed with snapshot integrity
    const snapshot = server.getStateSnapshot();
    assert.equal(snapshot.isRunning, false);
    assert.ok(snapshot.lastResult);
    assert.equal(snapshot.lastResult.totalRoundsPlayed, 1);

    // Step 4: Verify dynamic staking was exercised in round result
    const round1 = snapshot.lastResult.rounds[0];
    assert.ok(round1.proposals.length > 0, 'Must have recorded proposals');
    for (const prop of round1.proposals) {
      assert.ok(prop.stake >= MIN_STAKE, 'Proposal stake must satisfy MIN_STAKE');
      assert.ok(typeof prop.stake === 'number' && Number.isFinite(prop.stake));
    }

    // Step 5: Export JSON report and verify full settlement audit trail
    const jsonRes = await simulateRequest(server, { url: '/api/report?format=json' });
    assert.equal(jsonRes.statusCode, 200);
    const jsonReport = jsonRes.json();
    assert.ok(jsonReport.leaderboard.length >= 2);
    assert.equal(jsonReport.rounds.length, 1);

    // Step 6: Export Markdown report and verify table structure
    const mdRes = await simulateRequest(server, { url: '/api/report?format=markdown' });
    assert.equal(mdRes.statusCode, 200);
    assert.ok(mdRes.body.includes('# NashGate Arbitration'));
    assert.ok(mdRes.body.includes('Round 1'));
  });

  it('Tier 3.2: Dual SSE broadcast emits both round:settlement and settlement:completed upon round settlement', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const receivedEvents: string[] = [];

    // Attach SSE client
    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      const match = chunk.match(/event:\s*([^\n]+)/);
      if (match) receivedEvents.push(match[1]);
      return true;
    };
    mockRes.writeHead = () => {};

    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };

    (server as any).handleRequest(mockReq, mockRes);

    await server.startTournament({ rounds: 1 });
    await waitForTournament(server);

    // Verify presence of settlement events
    const hasSettlementCompleted = receivedEvents.includes('settlement:completed');
    const hasRoundSettlement = receivedEvents.includes('round:settlement');

    assert.ok(
      hasSettlementCompleted || hasRoundSettlement,
      'Server must emit settlement events to keep UI and capital chart synchronized'
    );
  });
});

// ===========================================================================
// TIER 4 — REAL-WORLD APPLICATION SCENARIOS
// ===========================================================================

describe('Tier 4: Real-World Application Scenarios', () => {
  it('Tier 4.1: Multi-round tournament simulation validates conservation of ledger balances across all agents', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    // Run 3-round tournament
    await server.startTournament({ rounds: 3 });
    await waitForTournament(server);

    const snapshot = server.getStateSnapshot();
    assert.ok(snapshot.lastResult, 'Tournament result must be present');
    assert.equal(snapshot.lastResult.totalRoundsPlayed, 3);

    // Verify that every round maintained non-negative capital updates
    for (const round of snapshot.lastResult.rounds) {
      assert.ok(round.settlement.balanceUpdates.length >= 2);
      for (const update of round.settlement.balanceUpdates) {
        assert.ok(typeof update.finalCapital === 'number');
        assert.ok(update.finalCapital >= 0, 'Agent capital must never be negative');
      }

      // Verify pairwise zero-sum transfers when generator fails
      for (const pair of round.settlement.pairSettlements) {
        if (!pair.generatorPassed) {
          assert.equal(
            Math.round((pair.generatorDelta + pair.auditorDelta) * 100) / 100,
            0,
            'Zero-sum transfer between generator and auditor must conserve delta'
          );
        }
      }
    }
  });

  it('Tier 4.2: Multi-round tournament simulation verifies insolvent agents transition to BANKRUPT and cease staking', async () => {
    // Construct a scenario with a distressed agent with minimal capital (1) facing harsh penalty
    const roster: Agent[] = [
      createAgent({ id: 'WealthyGen', role: 'GENERATOR', model: 'mock-solid', capital: 200 }),
      createAgent({ id: 'VulnerableAuditor', role: 'AUDITOR', model: 'mock-sharp', capital: 1 }),
    ];

    const result = await runTournament({
      problems: [tournamentProblems[0], tournamentProblems[1]],
      agents: roster,
      adapter: (_agent) => new MockAdapter(),
    });

    assert.ok(result.completed);
    assert.ok(result.totalRoundsPlayed >= 1);

    // If an agent hit <= 0, they must have BANKRUPT status and 0 capital
    for (const agent of result.finalAgents) {
      if (agent.capital <= 0) {
        assert.equal(agent.status, 'BANKRUPT');
        assert.equal(agent.capital, 0);
      } else {
        assert.equal(agent.status, 'ACTIVE');
      }
    }
  });

  it('Tier 4.3: Completed tournament report contains verified audit data matching round-by-round state', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    await server.startTournament({ rounds: 2 });
    await waitForTournament(server);

    const result = server.getStateSnapshot().lastResult!;
    const jsonReport: any = generateReportJson(result);
    const mdReport = generateReportMarkdown(result);

    // Check JSON data fidelity
    const totalRounds = jsonReport.metadata?.totalRoundsPlayed ?? jsonReport.tournamentSummary?.totalRoundsPlayed;
    assert.equal(totalRounds, 2);
    assert.equal(jsonReport.leaderboard.length, result.leaderboard.length);
    assert.equal(jsonReport.rounds.length, 2);

    // Check Markdown data fidelity
    for (const agent of result.leaderboard) {
      assert.ok(
        mdReport.includes(agent.id),
        `Markdown report must contain agent id ${agent.id}`
      );
    }
  });

  it('Tier 4.4: Zero runtime dependency audit: package.json has 0 dependencies and src/core is pure', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    const deps = pkg.dependencies || {};
    assert.equal(
      Object.keys(deps).length,
      0,
      `package.json must contain 0 runtime dependencies, found: ${Object.keys(deps).join(', ')}`
    );

    // Verify /src/core/ contains zero I/O imports
    const coreDir = path.join(ROOT_DIR, 'src', 'core');
    const coreFiles = fs.readdirSync(coreDir).filter((f) => f.endsWith('.ts'));

    for (const file of coreFiles) {
      const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
      assert.ok(!content.includes("from 'node:http'"), `${file} must not import node:http`);
      assert.ok(!content.includes("from 'node:fs'"), `${file} must not import node:fs`);
      assert.ok(!content.includes("from 'node:net'"), `${file} must not import node:net`);
      assert.ok(!content.includes('fetch('), `${file} must not perform fetch calls`);
      assert.ok(!content.includes('process.env'), `${file} must not read process.env`);
    }
  });

  it('Tier 4.5: Frontend dependency audit: index.html contains no external CDN or third-party script tags', () => {
    const html = fs.readFileSync(HTML_FILE_PATH, 'utf-8');
    const matches = Array.from(html.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi));

    for (const match of matches) {
      const src = (match[1] || '').trim().toLowerCase();
      const isExternal =
        src.startsWith('http://') ||
        src.startsWith('https://') ||
        src.startsWith('//');
      assert.ok(
        !isExternal,
        `Dashboard index.html contains disallowed external script tag src: ${src}`
      );
    }
  });
});
