import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DashboardServer,
  createInitialAgents,
  tournamentProblems,
  DEFAULT_PORT,
  DEFAULT_PACE_DELAY_MS,
} from '../src/server/dashboard.ts';

describe('DashboardServer & Web Visualizer', () => {
  it('createInitialAgents initializes 4 agents with 100 capital and ACTIVE status', () => {
    const agents = createInitialAgents(false);
    assert.equal(agents.length, 4);

    const alpha = agents.find((a) => a.id === 'AlphaGen');
    assert.ok(alpha);
    assert.equal(alpha.role, 'GENERATOR');
    assert.equal(alpha.capital, 100);
    assert.equal(alpha.status, 'ACTIVE');

    const sharp = agents.find((a) => a.id === 'SharpAuditor');
    assert.ok(sharp);
    assert.equal(sharp.role, 'AUDITOR');
    assert.equal(sharp.capital, 100);
    assert.equal(sharp.status, 'ACTIVE');
  });

  it('tournamentProblems contains 3 standard consensus benchmark problems', () => {
    assert.equal(tournamentProblems.length, 3);
    assert.equal(tournamentProblems[0].id, 'is-palindrome');
    assert.equal(tournamentProblems[1].id, 'clamp-number');
    assert.equal(tournamentProblems[2].id, 'sum-array');
    for (const p of tournamentProblems) {
      assert.ok(p.title);
      assert.ok(p.task);
      assert.ok(p.entrypoint);
    }
  });

  it('DashboardServer exposes initial state snapshot', () => {
    const server = new DashboardServer({ paceMs: 10 });
    const snapshot = server.getStateSnapshot();

    assert.equal(snapshot.isRunning, false);
    assert.equal(snapshot.agents.length, 4);
    assert.equal(snapshot.totalProblems, 3);
    assert.equal(snapshot.adapterMode, 'offline-mock');
    assert.equal(snapshot.connectedClients, 0);
  });

  it('DashboardServer broadcast writes SSE formatted event stream', () => {
    const server = new DashboardServer({ paceMs: 10 });
    const writes: string[] = [];

    // Mock ServerResponse
    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };

    // Add client via SSE request simulation
    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };

    let headersSet: any = null;
    let statusCode = 0;
    mockRes.writeHead = (code: number, headers: any) => {
      statusCode = code;
      headersSet = headers;
    };

    // Call private handleRequest via reflection
    (server as any).handleRequest(mockReq, mockRes);

    assert.equal(statusCode, 200);
    assert.equal(headersSet['Content-Type'], 'text/event-stream');
    assert.ok(writes.length >= 2); // : keepalive and event: state:init

    // Now test broadcast
    server.broadcast('custom:test', { hello: 'world' });
    const lastWrite = writes[writes.length - 1];
    assert.ok(lastWrite.includes('event: custom:test'));
    assert.ok(lastWrite.includes('{"hello":"world"}'));
  });

  it('DashboardServer serves static index.html and api endpoints via handleRequest', async () => {
    const server = new DashboardServer({ paceMs: 10 });

    // Test GET /
    let htmlContent = '';
    let htmlStatus = 0;
    let htmlHeaders: any = {};
    const mockReqHtml: any = new EventEmitter();
    mockReqHtml.url = '/';
    mockReqHtml.method = 'GET';
    mockReqHtml.headers = { host: 'localhost:3000' };

    const mockResHtml: any = new EventEmitter();
    mockResHtml.writeHead = (status: number, headers: any) => {
      htmlStatus = status;
      htmlHeaders = headers;
    };
    mockResHtml.end = (content: string) => {
      htmlContent = content;
    };

    (server as any).handleRequest(mockReqHtml, mockResHtml);

    // Wait microtask for fs.readFile
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(htmlStatus, 200);
    assert.ok(htmlHeaders['Content-Type'].includes('text/html'));
    assert.ok(htmlContent.includes('NASHGATE'));
    assert.ok(htmlContent.includes('Start Tournament'));

    // Test GET /api/status
    let statusContent = '';
    let statusStatusCode = 0;
    const mockReqStatus: any = new EventEmitter();
    mockReqStatus.url = '/api/status';
    mockReqStatus.method = 'GET';
    mockReqStatus.headers = { host: 'localhost:3000' };

    const mockResStatus: any = new EventEmitter();
    mockResStatus.writeHead = (status: number) => {
      statusStatusCode = status;
    };
    mockResStatus.end = (content: string) => {
      statusContent = content;
    };

    (server as any).handleRequest(mockReqStatus, mockResStatus);
    assert.equal(statusStatusCode, 200);
    const parsed = JSON.parse(statusContent);
    assert.equal(parsed.isRunning, false);
    assert.equal(parsed.agents.length, 4);
  });

  it('DashboardServer handles tournament start lifecycle and prevents duplicate starts', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    const firstStart = await server.startTournament();
    assert.equal(firstStart.started, true);

    // Immediately try to start again while running
    const secondStart = await server.startTournament();
    assert.equal(secondStart.started, false);
    assert.equal(secondStart.reason, 'Tournament is already in progress');

    // Wait until background tournament completes
    const start = Date.now();
    while (server.getStateSnapshot().isRunning && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const snapshot = server.getStateSnapshot();
    assert.equal(snapshot.isRunning, false);
    assert.ok(snapshot.lastResult);
    assert.equal(snapshot.lastResult.totalRoundsPlayed, 3);
  });

  it('DashboardServer handleRequest accepts JSON body with custom model on POST /api/start', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    let statusCode = 0;
    let responseBody = '';

    const mockReq: any = new EventEmitter();
    mockReq.url = '/api/start';
    mockReq.method = 'POST';
    mockReq.headers = { host: 'localhost:3000', 'content-type': 'application/json' };

    const mockRes: any = new EventEmitter();
    mockRes.writeHead = (code: number) => {
      statusCode = code;
    };
    mockRes.end = (content: string) => {
      responseBody = content;
    };

    (server as any).handleRequest(mockReq, mockRes);

    // Emit payload chunk and end
    mockReq.emit('data', JSON.stringify({ model: 'my-chosen-model' }));
    mockReq.emit('end');

    // Wait microtask
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(statusCode, 200);
    const parsed = JSON.parse(responseBody);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.model, 'my-chosen-model');
  });

  it('createInitialAgents(true) dynamically resolves model for all agents based on env', () => {
    const originalEnv = { ...process.env };
    try {
      // Test 1: Gemini AIza key
      delete process.env.LLM_MODEL;
      process.env.LLM_API_KEY = 'AIzaSyTestKey123';
      const geminiAgents = createInitialAgents(true);
      assert.equal(geminiAgents.length, 4);
      for (const a of geminiAgents) {
        assert.equal(a.model, 'gemini-3.5-flash-lite');
      }

      // Test 2: Ollama 11434 url
      delete process.env.LLM_API_KEY;
      delete process.env.GEMINI_API_KEY;
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      const ollamaAgents = createInitialAgents(true);
      for (const a of ollamaAgents) {
        assert.equal(a.model, 'llama3.2');
      }

      // Test 3: Explicit LLM_MODEL override
      process.env.LLM_MODEL = 'deepseek-coder:6.7b';
      const customAgents = createInitialAgents(true);
      for (const a of customAgents) {
        assert.equal(a.model, 'deepseek-coder:6.7b');
      }

      // Test 4: Custom defaultModel and per-agent agentModels
      const customized = createInitialAgents(true, 'claude-3-5-sonnet', {
        AlphaGen: 'gemini-3.8-flash',
        BuggyGen: 'llama3.2',
      });
      assert.equal(customized.find((a) => a.id === 'AlphaGen')?.model, 'gemini-3.8-flash');
      assert.equal(customized.find((a) => a.id === 'BuggyGen')?.model, 'llama3.2');
      assert.equal(customized.find((a) => a.id === 'SharpAuditor')?.model, 'claude-3-5-sonnet');
      assert.equal(customized.find((a) => a.id === 'RecklessAuditor')?.model, 'claude-3-5-sonnet');
    } finally {
      process.env = originalEnv;
    }
  });

  it('DashboardServer broadcasts engine:error event on adapter failure', () => {
    const server = new DashboardServer({ paceMs: 1 });
    const writes: string[] = [];

    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };

    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };

    mockRes.writeHead = () => {};
    (server as any).handleRequest(mockReq, mockRes);

    // Simulate broadcasting engine:error
    server.broadcast('engine:error', {
      error: '404 Model Not Found',
      phase: 'proposal',
      agent: { id: 'AlphaGen', model: 'gemini-3.8-flash' },
      roundNumber: 1,
    });

    const errorEvent = writes.find((w) => w.includes('event: engine:error'));
    assert.ok(errorEvent);
    assert.ok(errorEvent.includes('404 Model Not Found'));
    assert.ok(errorEvent.includes('gemini-3.8-flash'));
  });

  it('DashboardServer replays event buffer to newly connected SSE clients', () => {
    const server = new DashboardServer({ paceMs: 1 });

    // Broadcast two events before client connects
    server.broadcast('round:start', { roundNumber: 1 });
    server.broadcast('proposal:submitted', { agent: { id: 'AlphaGen' } });

    const writes: string[] = [];
    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    mockRes.writeHead = () => {};

    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };

    (server as any).handleRequest(mockReq, mockRes);

    // Verify buffer was replayed
    assert.ok(writes.some((w) => w.includes('event: round:start')));
    assert.ok(writes.some((w) => w.includes('event: proposal:submitted')));
  });

  it('abortTournament and POST /api/reset gracefully resets state to STANDBY', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    (server as any).isTournamentRunning = true;
    (server as any).currentRoundNumber = 2;

    const writes: string[] = [];
    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    mockRes.writeHead = () => {};

    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReq, mockRes);

    // Call abortTournament
    const res = server.abortTournament();
    assert.equal(res.stopped, true);
    assert.equal((server as any).isTournamentRunning, false);
    assert.equal((server as any).currentRoundNumber, 0);

    // Verify reset events were broadcasted
    assert.ok(writes.some((w) => w.includes('event: tournament:reset')));
    assert.ok(writes.some((w) => w.includes('event: tournament:state')));
  });

  it('DashboardServer startTournament respects custom rounds slice', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const writes: string[] = [];
    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    mockRes.writeHead = () => {};
    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReq, mockRes);

    await server.startTournament({ rounds: 1 });
    // Let tournament complete
    await new Promise((r) => setTimeout(r, 80));

    const startEvent = writes.find((w) => w.includes('event: tournament:start'));
    assert.ok(startEvent, 'tournament:start event should be emitted');
    assert.ok(startEvent.includes('"totalRounds":1'), 'Should slice to exactly 1 round');
  });

  it('DashboardServer handles /api/agents CRUD operations', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    // 1. GET /api/agents
    let getBody = '';
    let getStatus = 0;
    const mockResGet: any = new EventEmitter();
    mockResGet.writeHead = (code: number) => { getStatus = code; };
    mockResGet.end = (content: string) => { getBody = content; };
    const mockReqGet: any = new EventEmitter();
    mockReqGet.url = '/api/agents';
    mockReqGet.method = 'GET';
    mockReqGet.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReqGet, mockResGet);

    assert.equal(getStatus, 200);
    const parsedGet = JSON.parse(getBody);
    assert.equal(parsedGet.ok, true);
    assert.equal(parsedGet.agents.length, 4);

    // 2. POST /api/agents (Add custom agent)
    let postBody = '';
    let postStatus = 0;
    const mockResPost: any = new EventEmitter();
    mockResPost.writeHead = (code: number) => { postStatus = code; };
    mockResPost.end = (content: string) => { postBody = content; };
    const mockReqPost: any = new EventEmitter();
    mockReqPost.url = '/api/agents';
    mockReqPost.method = 'POST';
    mockReqPost.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReqPost, mockResPost);
    mockReqPost.emit('data', JSON.stringify({
      id: 'CustomGen1',
      role: 'GENERATOR',
      model: 'gemini-3.5-flash-lite',
      capital: 150,
      apiKey: 'test-secret-key',
    }));
    mockReqPost.emit('end');

    assert.equal(postStatus, 200);
    const parsedPost = JSON.parse(postBody);
    assert.equal(parsedPost.ok, true);
    assert.equal(parsedPost.agents.length, 5);
    const customAgent = parsedPost.agents.find((a: any) => a.id === 'CustomGen1');
    assert.ok(customAgent);
    assert.equal(customAgent.hasDedicatedKey, true);
    assert.equal(customAgent.apiKey, '••••••••', 'Raw API key should be masked');

    // 3. DELETE /api/agents/CustomGen1
    let delBody = '';
    let delStatus = 0;
    const mockResDel: any = new EventEmitter();
    mockResDel.writeHead = (code: number) => { delStatus = code; };
    mockResDel.end = (content: string) => { delBody = content; };
    const mockReqDel: any = new EventEmitter();
    mockReqDel.url = '/api/agents/CustomGen1';
    mockReqDel.method = 'DELETE';
    mockReqDel.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReqDel, mockResDel);

    assert.equal(delStatus, 200);
    const parsedDel = JSON.parse(delBody);
    assert.equal(parsedDel.ok, true);
    assert.equal(parsedDel.agents.length, 4);

    // 4. POST /api/agents/reset
    let resetBody = '';
    let resetStatus = 0;
    const mockResReset: any = new EventEmitter();
    mockResReset.writeHead = (code: number) => { resetStatus = code; };
    mockResReset.end = (content: string) => { resetBody = content; };
    const mockReqReset: any = new EventEmitter();
    mockReqReset.url = '/api/agents/reset';
    mockReqReset.method = 'POST';
    mockReqReset.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReqReset, mockResReset);

    assert.equal(resetStatus, 200);
    const parsedReset = JSON.parse(resetBody);
    assert.equal(parsedReset.ok, true);
    assert.equal(parsedReset.agents.length, 4);
  });

  it('DashboardServer startTournament executes with custom agent roster and per-agent credentials', async () => {
    const server = new DashboardServer({ paceMs: 1 });
    const writes: string[] = [];
    const mockRes: any = new EventEmitter();
    mockRes.write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    mockRes.writeHead = () => {};
    const mockReq: any = new EventEmitter();
    mockReq.url = '/events';
    mockReq.method = 'GET';
    mockReq.headers = { host: 'localhost:3000' };
    (server as any).handleRequest(mockReq, mockRes);

    const customRoster = [
      { id: 'CustomAlpha', role: 'GENERATOR' as const, model: 'gemini-3.5-flash-lite', capital: 120, apiKey: 'agent-key-1' },
      { id: 'CustomSharp', role: 'AUDITOR' as const, model: 'gpt-4o-mini', capital: 100, apiKey: 'agent-key-2' },
    ];

    const startRes = await server.startTournament({
      agents: customRoster,
      rounds: 1,
    });

    assert.equal(startRes.started, true);
    await new Promise((r) => setTimeout(r, 80));

    const startEvent = writes.find((w) => w.includes('event: tournament:start'));
    assert.ok(startEvent);
    assert.ok(startEvent.includes('CustomAlpha'));
    assert.ok(startEvent.includes('CustomSharp'));
  });

  it('DashboardServer startTournament rejects invalid roster missing auditors or generators', async () => {
    const server = new DashboardServer({ paceMs: 1 });

    const invalidRoster = [
      { id: 'Gen1', role: 'GENERATOR' as const, model: 'gemini-3.5-flash-lite', capital: 100 },
      { id: 'Gen2', role: 'GENERATOR' as const, model: 'gemini-3.5-flash-lite', capital: 100 },
    ];

    const startRes = await server.startTournament({
      agents: invalidRoster,
      rounds: 1,
    });

    assert.equal(startRes.started, false);
    assert.ok(startRes.reason?.includes('AUDITOR'), 'Should reject roster without auditors');
  });
});
