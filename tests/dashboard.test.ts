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
});
