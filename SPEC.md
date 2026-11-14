# NashGate — Technical Specification v0.1

## 1. Overview
A deterministic consensus and arbitration engine for multi-agent AI systems grounded in Game Theory (Mechanism Design). Agents stake reputation capital on their generated outputs; challenger/auditor agents earn that capital by proving hallucinations or logical failures through verifiable tests.

## 2. Core Entities
- **Agent (`Agent`):**
  - `id`: string
  - `role`: `"GENERATOR"` | `"AUDITOR"`
  - `model`: string (e.g., `"gemini-2.5-flash"`, `"llama3"`, `"gpt-4o-mini"`)
  - `capital`: number (initialized at `100`)
  - `status`: `"ACTIVE"` | `"BANKRUPT"`
- **Proposal (`Proposal`):**
  - `agentId`: string
  - `solution`: string (code snippet or structured output)
  - `stake`: number (`1 <= stake <= agent.capital`)
  - `reasoning`: string
- **Challenge (`Challenge`):**
  - `auditorId`: string
  - `targetAgentId`: string
  - `testInput`: any (edge case designed to break the proposed solution)
  - `expectedOutput`: any
  - `stake`: number (`1 <= stake <= auditor.capital`)

## 3. Payoff Matrix (Settlement Rules)
For each `(Generator G, Auditor A)` pair evaluated by the deterministic Oracle:
1. **Generator FAILS (Auditor's edge case breaks the solution):**
   - `G.capital -= G.stake`
   - `A.capital += G.stake`
2. **Generator PASSES (Auditor's challenge was a false positive):**
   - `A.capital -= (1.5 * A.stake)` *(asymmetric anti-spam penalty)*
   - `G.capital += (0.5 * G.stake)`
3. **Unchallenged Proposal:**
   - `G.capital += (0.1 * G.stake)`
4. **Bankruptcy Condition:**
   - If `agent.capital <= 0`, set `agent.capital = 0` and `agent.status = "BANKRUPT"`. Bankrupt agents are permanently excluded from subsequent rounds in the session.

## 4. Directory Architecture
- `/src/core/`: Pure game-theoretic logic, ledger management, and state machine (zero external API dependencies).
- `/src/oracle/`: Sandboxed execution runner with a strict timeout (`2000ms`) to verify code and unit tests deterministically.
- `/src/adapters/`: Model provider connectors (local Ollama, Gemini, OpenAI) enforcing strict JSON structured outputs.
- `/tests/`: Unit tests covering payoff equations, edge cases, and bankruptcy transitions.