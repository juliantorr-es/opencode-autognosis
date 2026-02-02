# Best Practices: LLM Agent Plugin Architecture

## 1. Context Window Optimization
### Industry Best Practice
*   **Observation Compression:** Tool outputs should be summarized or "pruned" if they exceed a certain token limit before being returned to the agent.
*   **Dynamic Tool Selection:** Only expose relevant tools based on the current agent state to save "system prompt" tokens.

### Current Implementation Analysis
*   **Verbose JSON:** Most tools return `JSON.stringify(..., null, 2)`. While readable, this is token-expensive.
*   **ActiveSet Memory:** The `experimental.session.compacting` hook is a brilliant feature of this project, ensuring context preservation during session resets.

## 2. Background Task Management
### Industry Best Practice
*   **Non-Blocking Operations:** Long-running tasks (indexing, embedding) must be fully detached with robust status polling.
*   **Resource Throttling:** Limit CPU/Memory usage of background workers to avoid slowing down the user's primary IDE/Environment.

### Current Implementation Analysis
*   **Manual Task Polling:** Uses file-based `.json` tasks and a SQLite `background_jobs` table. This is dual-tracked and inconsistent.
*   **Worker Safety:** `startWorker()` uses a simple `setTimeout` loop. If a task hangs, it blocks the loop.

### Refinement Plan
1.  **Unified Job System:** Migrate all background tasks exclusively to the SQLite `background_jobs` table.
2.  **Token Budgeting:** Implement a helper to truncate or summarize tool outputs that exceed 2000 tokens.
3.  **Worker Pool:** Use Bun's `Worker` API to move heavy indexing and embedding logic off the main plugin thread.
