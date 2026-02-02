# Best Practices: Performance Monitoring & Reliability

## 1. Telemetry & Metrics
### Industry Best Practice
*   **Structured Logs:** Use JSON logging with correlation IDs to track a single request across tools and background jobs.
*   **Performance Baselines:** Automatically alert or log when operations (like embedding) deviate from historical averages.

### Current Implementation Analysis
*   **File-Per-Metric:** `performance-optimization.ts` creates a new JSON file for *every* metric event. This will clutter the file system and make analysis slow (O(N) file reads).
*   **Silent Failures:** Many `try-catch` blocks catch errors but only log them to a file, providing no feedback to the agent.

### Refinement Plan
1.  **Metric Aggregation:** Store metrics in a dedicated SQLite table (`performance_metrics`) instead of individual JSON files.
2.  **Health Dashboard:** Add a `perf_system_health` tool that summarizes recent failures and latency spikes.
3.  **Actionable Errors:** Refine catch blocks to return "Agent-Friendly" error messages that suggest specific fixes (e.g., "Ollama is down, run `autognosis_setup_ai`").
