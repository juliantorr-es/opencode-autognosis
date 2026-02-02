# Autognosis: Kernel & Substrate Strategy

## 1. The "Cognition Layer" Identity
Autognosis is not an orchestration harness. It is a **Cognition and Evidence Substrate**.
*   **Role:** Turn ephemeral code reads into durable, queryable artifacts.
*   **Goal:** Provide the "Canonical Repo Brain" that orchestration harnesses (`opencode-workspace`, `oh-my-opencode`) consult to prevent hallucinations and memory-wipe during compaction.

## 2. Kernel Interface (Drivers vs. Core)
To avoid "feature soup," Autognosis adopts a Kernel/Driver model:
*   **The Kernel (Core):** SQLite Index, Chunking logic, Compaction Interception, and Schema Enforcement.
*   **The Drivers (Optional Features):** AI Providers (Ollama/MLX), Git Journaling, and External Tool Connectors.

## 3. Epistemic Hygiene (Verification-Ready Memory)
Memory is only useful if it is verifiable. 
*   **Refinement:** Every `ChunkCard` will now include `verification_hooks`. 
*   **Usage:** When an agent retrieves a card, it doesn't just see *what* the code does; it sees *how to prove* it works (e.g., `npm test src/auth.test.ts`).

## 4. Integration Contracts
Autognosis wins by being "boringly consistent."
*   **Schema Versioning:** All JSON artifacts in `.opencode/` carry a mandatory `schema_version`.
*   **Deterministic Replay:** A new `internal_replay_hooks` tool allows developers to feed captured OpenCode events into Autognosis to verify artifact production is identical across versions.
*   **Compatibility:** Expose a "Cognition API" that allows other plugins to query the SQLite index directly without using the high-level "tool" interface.

## 5. Coordination vs. Cognition
*   **Coordination (Harnesses):** Handles multi-agent routing, PTY management, and worktrees.
*   **Cognition (Autognosis):** Handles memory hygiene, structural understanding, and evidence persistence.
*   **Combo:** Harnesses *delegate* the memory-rehydration task to Autognosis during the `experimental.session.compacting` hook.
