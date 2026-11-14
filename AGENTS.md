# Development Agent Guidelines

## Engineering Principles
1. **Strict Separation of Concerns:** Keep `/src/core/` 100% pure and deterministic. Never mix `fetch` calls, network I/O, or LLM SDKs inside stake calculation and settlement logic.
2. **Minimal Dependencies:** Rely on standard library features whenever possible. Only lightweight schema validators (e.g., Zod or Pydantic) and official model SDKs are permitted.
3. **Incremental Execution:** Implement and verify one phase at a time. Do not scaffold files for future phases until all unit tests for the current phase pass.
4. **Mathematical Transparency:** Include concise inline comments explaining the game-theoretic rationale behind every payoff formula for easy auditing.