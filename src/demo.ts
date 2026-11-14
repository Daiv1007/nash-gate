/**
 * NashGate Interactive CLI Demo
 * Runs a 3-round tournament demonstrating the game-theoretic consensus protocol,
 * deterministic oracle execution, capital transfers, dividends, and bankruptcies.
 * Grounded in Game Theory and Mechanism Design.
 */

import { createAgent, type Agent } from './core/index.ts';
import {
  MockAdapter,
  OpenAICompatibleAdapter,
  type AgentAdapter,
  type ProblemContext,
} from './adapters/index.ts';
import { runTournament } from './engine/index.ts';

// ---------------------------------------------------------------------------
// Terminal Color Palette (Zero External Dependencies)
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

function formatCapital(val: number): string {
  return `${val >= 0 ? val.toFixed(2) : '0.00'}`;
}

function formatDelta(val: number): string {
  if (val > 0) return `${c.green}+${val.toFixed(2)}${c.reset}`;
  if (val < 0) return `${c.red}${val.toFixed(2)}${c.reset}`;
  return `${c.gray}0.00${c.reset}`;
}

// ---------------------------------------------------------------------------
// 3 Tournament Problems
// ---------------------------------------------------------------------------

const tournamentProblems: ProblemContext[] = [
  {
    id: 'is-palindrome',
    title: 'Palindrome Normalization',
    task: 'Implement isPalindrome(s: string): boolean that strips non-alphanumeric characters and ignores case.',
    description: "Example: 'A man, a plan, a canal: Panama' must evaluate to true.",
    entrypoint: 'isPalindrome',
  },
  {
    id: 'clamp-number',
    title: 'Defensive Value Clamping',
    task: 'Implement clamp(val: number, min: number, max: number): number that constrains val within [min, max].',
    description: 'Must defensively handle inverted boundaries where min > max and negative ranges.',
    entrypoint: 'clamp',
  },
  {
    id: 'sum-array',
    title: 'Resilient Array Summation',
    task: 'Implement sumArray(numbers: number[]): number that calculates total sum.',
    description: 'Must gracefully return 0 for empty arrays [] and non-array inputs.',
    entrypoint: 'sumArray',
  },
];

// ---------------------------------------------------------------------------
// Main Demo Orchestrator
// ---------------------------------------------------------------------------

async function main() {
  console.clear?.();
  console.log(`
${c.cyan}╔═══════════════════════════════════════════════════════════════════════════════╗
║                               ${c.bold}NASHGATE${c.reset}${c.cyan}                                        ║
║         ${c.yellow}Game-Theoretic Consensus & Multi-Agent Arbitration Engine${c.reset}${c.cyan}             ║
╚═══════════════════════════════════════════════════════════════════════════════╝${c.reset}
`);

  // Detect Adapter Configuration
  const apiKey = process.env.LLM_API_KEY;
  let adapter: AgentAdapter;

  if (apiKey) {
    console.log(
      `${c.green}⚡ Adapter:${c.reset} ${c.bold}OpenAICompatibleAdapter${c.reset} (Live API key detected via LLM_API_KEY)`
    );
    adapter = new OpenAICompatibleAdapter({ apiKey });
  } else {
    console.log(
      `${c.magenta}⚡ Adapter:${c.reset} ${c.bold}MockAdapter${c.reset} (Deterministic Offline Mode - Zero API keys required)`
    );
    console.log(
      `${c.gray}   Tip: Set process.env.LLM_API_KEY to test against live Ollama/Gemini/OpenAI endpoints.${c.reset}\n`
    );
    adapter = new MockAdapter();
  }

  // 4 Participating Agents
  const initialAgents: Agent[] = [
    createAgent({
      id: 'AlphaGen',
      role: 'GENERATOR',
      model: apiKey ? 'gpt-4o-mini' : 'deterministic-solid',
      capital: 100,
    }),
    createAgent({
      id: 'BuggyGen',
      role: 'GENERATOR',
      model: apiKey ? 'llama-3-8b' : 'heuristic-naive',
      capital: 100,
    }),
    createAgent({
      id: 'SharpAuditor',
      role: 'AUDITOR',
      model: apiKey ? 'claude-3-5-sonnet' : 'adversarial-verifier',
      capital: 100,
    }),
    createAgent({
      id: 'RecklessAuditor',
      role: 'AUDITOR',
      model: apiKey ? 'gpt-4o-mini' : 'speculative-challenger',
      capital: 100,
    }),
  ];

  console.log(`${c.bold}Initial Agents Roster:${c.reset}`);
  console.log(`${c.gray}┌──────────────────┬─────────────┬──────────────────────────┬──────────┬──────────┐${c.reset}`);
  console.log(`${c.gray}│${c.reset} ${c.bold}Agent ID        ${c.reset}${c.gray}│${c.reset} ${c.bold}Role        ${c.reset}${c.gray}│${c.reset} ${c.bold}Model                    ${c.reset}${c.gray}│${c.reset} ${c.bold}Capital  ${c.reset}${c.gray}│${c.reset} ${c.bold}Status   ${c.reset}${c.gray}│${c.reset}`);
  console.log(`${c.gray}├──────────────────┼─────────────┼──────────────────────────┼──────────┼──────────┤${c.reset}`);
  for (const a of initialAgents) {
    const roleColor = a.role === 'GENERATOR' ? c.blue : c.magenta;
    const statusColor = a.status === 'ACTIVE' ? c.green : c.red;
    console.log(
      `${c.gray}│${c.reset} ${a.id.padEnd(16)} ${c.gray}│${c.reset} ${roleColor}${a.role.padEnd(11)}${c.reset} ${c.gray}│${c.reset} ${a.model.padEnd(24)} ${c.gray}│${c.reset} ${formatCapital(a.capital).padStart(8)} ${c.gray}│${c.reset} ${statusColor}${a.status.padEnd(8)}${c.reset} ${c.gray}│${c.reset}`
    );
  }
  console.log(`${c.gray}└──────────────────┴─────────────┴──────────────────────────┴──────────┴──────────┘${c.reset}\n`);

  // Execute Tournament with Rich Terminal Hooks
  const result = await runTournament({
    agents: initialAgents,
    problems: tournamentProblems,
    adapter,
    hooks: {
      onRoundStart: (roundNumber, problem, activeAgents) => {
        console.log(`\n${c.cyan}╔═══════════════════════════════════════════════════════════════════════════════╗`);
        console.log(`║ ${c.bold}ROUND ${roundNumber} OF 3: ${problem.title.toUpperCase()}${c.reset}${c.cyan}`.padEnd(80) + '║');
        console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝${c.reset}`);
        console.log(`${c.yellow}Task:${c.reset} ${problem.task}`);
        if (problem.description) {
          console.log(`${c.gray}Note:${c.reset} ${problem.description}`);
        }
        const activeNames = activeAgents.map((a) => `${a.id} (${a.capital})`).join(', ');
        console.log(`${c.dim}Active Solvent Pool: [${activeNames}]${c.reset}\n`);
      },

      onProposalSubmitted: (proposal, agent) => {
        console.log(`  ${c.blue}📝 Proposal from ${c.bold}${agent.id}${c.reset} (Role: GENERATOR):`);
        console.log(`     ${c.dim}Stake Staked:${c.reset} ${c.bold}${proposal.stake} capital${c.reset} (Collateralized)`);
        console.log(`     ${c.dim}Reasoning:${c.reset} ${c.italic}${proposal.reasoning}${c.reset}`);
        const preview = proposal.solution.split('\n').slice(0, 3).map((l) => '       ' + l).join('\n');
        console.log(`     ${c.dim}Code Preview:${c.reset}\n${c.gray}${preview}\n       ...${c.reset}`);
      },

      onChallengeSubmitted: (challenge, auditor, targetGen) => {
        console.log(`\n  ${c.magenta}⚔️  Challenge from ${c.bold}${auditor.id}${c.reset} vs ${c.bold}${targetGen.id}${c.reset}:`);
        console.log(`     ${c.dim}Auditor Stake:${c.reset} ${c.bold}${challenge.stake} capital${c.reset}`);
        console.log(`     ${c.dim}Test Input:${c.reset} ${JSON.stringify(challenge.testInput)}`);
        console.log(`     ${c.dim}Expected Output:${c.reset} ${JSON.stringify(challenge.expectedOutput)}`);
      },

      onChallengeDeclined: (auditor, targetGen) => {
        console.log(
          `  ${c.gray}🛡️  Auditor ${c.bold}${auditor.id}${c.reset}${c.gray} inspected ${targetGen.id}'s code and DECLINED to challenge (prudent protection against -1.5x spam penalty).${c.reset}`
        );
      },

      onEvaluationCompleted: (evaluation) => {
        const passed = evaluation.generatorPassed;
        const verdictBadge = passed
          ? `${c.bgGreen}${c.bold} ORACLE: PASSED ${c.reset}`
          : `${c.bgRed}${c.bold} ORACLE: FAILED ${c.reset}`;

        console.log(`\n  ${verdictBadge} (Execution Duration: ${evaluation.executionTimeMs}ms)`);
        if (passed) {
          console.log(
            `     ${c.green}✔ Generator survived adversarial test input! Auditor's challenge was a false positive.${c.reset}`
          );
        } else {
          console.log(
            `     ${c.red}✖ Auditor successfully broke the generator's proposed solution!${c.reset}`
          );
          if (evaluation.error) {
            console.log(`     ${c.dim}Oracle Error Output:${c.reset} ${c.red}${evaluation.error}${c.reset}`);
          }
        }
      },

      onSettlementCompleted: (roundNum, settlement) => {
        console.log(`\n  ${c.bold}📊 Capital Settlement & Payoff Accounting (Round ${roundNum}):${c.reset}`);

        // Pairwise transfers
        for (const pair of settlement.pairSettlements) {
          if (!pair.generatorPassed) {
            console.log(
              `     ${c.red}🔻 ${pair.generatorId}${c.reset} forfeited -${pair.generatorStake} stake.`
            );
            console.log(
              `     ${c.green}🏆 ${pair.auditorId}${c.reset} awarded +${pair.generatorStake} bounty for proving solution failure.`
            );
          } else {
            console.log(
              `     ${c.red}⚠️  ${pair.auditorId}${c.reset} penalized ${pair.auditorDelta} (-1.5x stake) for false positive spam.`
            );
            console.log(
              `     ${c.green}🛡️  ${pair.generatorId}${c.reset} rewarded +${pair.generatorDelta} (+0.5x stake) resilience dividend.`
            );
          }
        }

        // Unchallenged dividends
        for (const unch of settlement.unchallengedSettlements) {
          console.log(
            `     ${c.green}✨ ${unch.agentId}${c.reset} proposal was UNCHALLENGED: awarded +${unch.delta} (+10% dividend) for honest contribution.`
          );
        }

        // Ledger state table
        console.log(`\n     ${c.dim}Ledger Status After Round ${roundNum}:${c.reset}`);
        for (const u of settlement.balanceUpdates) {
          const deltaStr = formatDelta(u.netDelta);
          const statusStr =
            u.currentStatus === 'BANKRUPT'
              ? `${c.bgRed}${c.bold} BANKRUPT ${c.reset}`
              : `${c.green}ACTIVE${c.reset}`;
          console.log(
            `       • ${c.bold}${u.agentId.padEnd(16)}${c.reset} ${formatCapital(u.initialCapital)} -> ${formatCapital(u.finalCapital)} (${deltaStr}) [${statusStr}]`
          );
        }
      },

      onBankruptcy: (agent, roundNum) => {
        console.log(`\n  ${c.bgRed}${c.white}${c.bold} 💀 BANKRUPTCY EVENT: ${agent.id.toUpperCase()} HAS REACHED 0 CAPITAL! ${c.reset}`);
        console.log(
          `     ${c.red}Game-Theoretic Rule:${c.reset} ${agent.id} possesses zero collateral. Permanently excluded from all future rounds in this tournament.`
        );
      },
    },
  });

  // ---------------------------------------------------------------------------
  // Final Tournament Summary & Leaderboard
  // ---------------------------------------------------------------------------
  console.log(`\n\n${c.cyan}╔═══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║                         ${c.bold}FINAL TOURNAMENT LEADERBOARD${c.reset}${c.cyan}                          ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝${c.reset}`);

  console.log(`\n${c.bold}Status:${c.reset} ${result.terminationReason}`);
  console.log(`${c.bold}Rounds Executed:${c.reset} ${result.totalRoundsPlayed} / 3\n`);

  console.log(`${c.gray}┌──────┬──────────────────┬─────────────┬────────────────┬──────────┬────────────┐${c.reset}`);
  console.log(`${c.gray}│${c.reset} ${c.bold}Rank${c.reset} ${c.gray}│${c.reset} ${c.bold}Agent ID        ${c.reset}${c.gray}│${c.reset} ${c.bold}Role        ${c.reset}${c.gray}│${c.reset} ${c.bold}Final Capital  ${c.reset}${c.gray}│${c.reset} ${c.bold}ROI (%)  ${c.reset}${c.gray}│${c.reset} ${c.bold}Status     ${c.reset}${c.gray}│${c.reset}`);
  console.log(`${c.gray}├──────┼──────────────────┼─────────────┼────────────────┼──────────┼────────────┤${c.reset}`);

  const medals = ['🥇 1st', '🥈 2nd', '🥉 3rd', '💀 4th'];
  result.leaderboard.forEach((agent, idx) => {
    const medal = medals[idx] ?? `  ${idx + 1}th`;
    const roleColor = agent.role === 'GENERATOR' ? c.blue : c.magenta;
    const isSolvent = agent.status === 'ACTIVE';
    const statusBadge = isSolvent
      ? `${c.green}SOLVENT${c.reset}`
      : `${c.red}BANKRUPT${c.reset}`;
    const roi = ((agent.capital - 100) / 100) * 100;
    const roiStr =
      roi >= 0
        ? `${c.green}+${roi.toFixed(1)}%${c.reset}`
        : `${c.red}${roi.toFixed(1)}%${c.reset}`;

    console.log(
      `${c.gray}│${c.reset} ${medal} ${c.gray}│${c.reset} ${c.bold}${agent.id.padEnd(16)}${c.reset}${c.gray}│${c.reset} ${roleColor}${agent.role.padEnd(11)}${c.reset} ${c.gray}│${c.reset} ${formatCapital(agent.capital).padStart(14)} ${c.gray}│${c.reset} ${roiStr.padStart(17)} ${c.gray}│${c.reset} ${statusBadge.padEnd(18)} ${c.gray}│${c.reset}`
    );
  });
  console.log(`${c.gray}└──────┴──────────────────┴─────────────┴────────────────┴──────────┴────────────┘${c.reset}`);

  console.log(`\n${c.bold}Game-Theoretic Mechanism Takeaways:${c.reset}`);
  console.log(`  1. ${c.green}Skin-in-the-Game:${c.reset} Uncollateralized cheap-talk is impossible; all outputs require real stake commitments.`);
  console.log(`  2. ${c.green}Bounty Alignment:${c.reset} Auditors only earn capital when finding verifiable, deterministic code defects.`);
  console.log(`  3. ${c.green}Anti-Spam Deterrent:${c.reset} False positive challenges trigger a crushing -150% penalty, disincentivizing spam.`);
  console.log(`  4. ${c.green}Market Resilience:${c.reset} Bankrupt agents are permanently liquidated, ensuring zero contagion in future rounds.\n`);
}

main().catch((err) => {
  console.error(`\n${c.red}[Fatal Error] Demo execution halted:${c.reset}`, err);
  process.exit(1);
});
