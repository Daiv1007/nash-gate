# Security Policy

## Supported Versions

We release security patches and updates for the active release line of **NashGate**.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

---

## Reporting a Vulnerability

We take the security of NashGate seriously. If you discover a security vulnerability, please **do not** open a public issue. Instead, report it responsibly:

- **Security Contact:** Iván Murguiondo Azpilicueta
- **Email:** [ivandavidaras@gmail.com](mailto:ivandavidaras@gmail.com)
- **Response Time:** We will acknowledge receipt of your vulnerability report within 48 hours and provide a detailed assessment and estimated remediation timeline.

Please include:
1. Description of the vulnerability and its potential impact.
2. Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
3. Any suggested remediations or mitigations.

---

## Security Model & Threat Boundaries

### 1. Deterministic Sandbox Oracle (`/src/oracle/sandbox.ts`)
- **Isolation Scope:** Code submitted by generator agents is executed in Node's native `vm` module inside an isolated execution realm.
- **Enforced Defenses:**
  - `codeGeneration: { strings: false, wasm: false }` blocks dynamic code execution escapes via `eval()` or `Function()`.
  - Ambient globals (`process`, `require`, `import`, `fs`, `net`, `child_process`) are strictly excluded from the guest realm.
  - Guest inputs and outputs are isolated via native `structuredClone()`, preventing cross-realm prototype pollution or in-place mutation of caller objects.
  - Strict wall-clock execution timeouts (default: 2000ms) terminate infinite loops or spin-locks.
- **Reporting Scope:** Any technique that enables a guest proposal to access the host operating system, host environment variables, host filesystem, or network sockets from within `evaluateChallenge` is considered a critical vulnerability.

### 2. Dashboard Server & Local Proxy (`/src/server/dashboard.ts`)
- **Path Traversal Protection:** Static asset delivery strictly enforces directory boundaries, rejecting paths with `..` or encoded directory traversals with `403 Forbidden`.
- **SSRF Defense:** The `/api/models/discover` proxy only permits connections to validated AI provider domains (`*.googleapis.com`, `api.openai.com`, `api.groq.com`, `api.anthropic.com`) and local loopback instances (`localhost`, `127.0.0.1`, `::1`). Requests targeting internal link-local metadata addresses (e.g., `169.254.169.254`) or internal subnets are blocked.
- **API Key Handling:** API keys entered into the web visualizer are held in volatile client session memory (`sessionStorage`) and dispatched only to the matching upstream provider during live tournaments. Keys are never written to disk, telemetry, or server-side logs.

---

## Best Practices for Operators

1. **API Key Security:** When operating in shared environments, use granular per-agent API keys or local offline models (such as Ollama) rather than root administrative keys.
2. **Node.js Runtime:** Run NashGate on modern Node.js runtimes (Node 22+) to benefit from the latest V8 security mitigations and native TypeScript support.
