# Contributing to NashGate

Thank you for your interest in contributing to **NashGate**! We welcome contributions to game-theoretic mechanism design, deterministic code verification, model adapters, and visualization tools.

---

## 🏛️ Core Engineering Principles

Before contributing, please review our core development rules (from `AGENTS.md`):

1. **Strict Separation of Concerns:**
   - Keep `/src/core/` **100% pure and deterministic**.
   - Never introduce `fetch`, network I/O, file system operations, or LLM SDKs inside `/src/core/` (staking, validation, settlement, bankruptcy).
2. **Zero External Runtime Dependencies:**
   - Rely strictly on Node.js standard library features (`node:http`, `node:vm`, `node:assert`, `node:url`, `node:fs`).
   - Production dependencies in `package.json` must remain `{}` (zero runtime dependencies). Only `@types/node` and `typescript` are permitted in `devDependencies`.
3. **Mathematical Transparency:**
   - Every economic formula and payoff equation must include concise inline comments explaining its game-theoretic rationale and mechanism design properties.
4. **Comprehensive Test Coverage:**
   - All new features and edge cases must be accompanied by automated unit tests in `/tests/`.

---

## 🛠️ Development Setup

### Prerequisites
- Node.js **v22.0.0** or higher.
- Git.

### Clone & Test
```bash
git clone https://github.com/Daiv1007/nash-gate.git
cd nash-gate

# Run all test suites
npm test

# Verify TypeScript types without emitting files
npx tsc --noEmit

# Run the CLI interactive simulation
npm run demo

# Launch the real-time visualizer dashboard
npm run ui
```

---

## 📂 Codebase Overview

| Directory | Responsibility | Purity Rule |
| :--- | :--- | :--- |
| `src/core/` | Payoffs, dynamic staking, validation, bankruptcy | **100% Pure & Deterministic** (No I/O) |
| `src/oracle/` | Isolated AST preprocessing and sandbox execution | Deterministic VM sandbox |
| `src/adapters/` | OpenAI-compatible, Google Gemini, Ollama, & Mock adapters | Network I/O permitted |
| `src/engine/` | Multi-round tournament loop and event orchestration | State management & async hooks |
| `src/server/` | Zero-dependency HTTP & SSE server + SPA visualizer | Native HTTP server (`node:http`) |

---

## 🧩 Adding a New Benchmark Problem

To contribute a new deterministic challenge problem:
1. Open `src/server/dashboard.ts` (or submit via the Web UI `+ Problem` button / API `POST /api/problems`).
2. Add an entry conforming to the `BenchmarkProblem` schema:
   ```typescript
   {
     id: 'unique-slug',
     title: 'Descriptive Problem Title',
     task: 'Specification of input parameters and expected return type',
     entrypoint: 'functionName',
     description: 'Edge case requirements and constraints'
   }
   ```
3. Add a corresponding test or mock verification in `src/adapters/mock.ts` and `tests/`.

---

## 🧪 Pull Request Guidelines

1. **Create a Topic Branch:**
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **Run Quality Gates:**
   Ensure both test suites and typechecks pass before opening a PR:
   ```bash
   npm test
   npx tsc --noEmit
   ```
3. **Commit Messages:**
   Use Conventional Commits (e.g. `feat(core): add Gittins index staking`, `fix(server): sanitize asset relative path`).
4. **Open a PR:**
   Provide a clear description of the problem solved, game-theoretic rationale, and link any related issues.
