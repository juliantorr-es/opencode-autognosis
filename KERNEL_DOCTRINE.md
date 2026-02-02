# Autognosis Kernel Doctrine v1

## 1. Identity & Scope
Autognosis is a **Durable Repository Kernel**. 
*   **Kernel Responsibilities:** Schema enforcement, artifact IO discipline, index primitives, compaction digest steering, and enforcement gates.
*   **Module Responsibilities (Non-Kernel):** MMR/Access Tier logic, background indexing, AI provider connectors, and UI rendering.
*   **Rule:** If a module fails, the kernel must remain stable. The kernel must never silently degrade or hallucinate structure.

## 2. Epistemic Hygiene
*   **Canonical vs. Non-Canonical:** Only artifacts with versioned schemas, provenance, and evidence links are "Canonical." Everything else is a disposable "Hint."
*   **Evidence Mandatory:** Claims of fact (findings, decisions) require Evidence IDs. No receipt, no claim.
*   **Lazy Forensics:** Do not hash files on every read. Use stat-checks and cached hashes. Only perform full checksums for safety-critical operations (e.g., before applying a patch).

## 3. The Safety BIOS (Compaction)
*   The compaction hook is the system's BIOS. It must inject:
    1.  **Current Policy:** Access Tier, active ChangeSession token, and tool restrictions.
    2.  **Canonical Map:** Last 3 decisions from the Blackboard and active Focus Lens (ActiveSet) summaries.
    3.  **Incident Status:** Any open incidents and the path to remediation.

## 4. Execution Isolation
*   **ChangeSessions:** Every mutation requires a dedicated Git worktree and a session-scoped artifact directory. 
*   **Rollback:** Rollback must be deterministic (git reset --hard + git clean -fd + directory purge).
*   **Bypass Escape Hatch:** Emergency edits require a `bypass_reason`, automatically trigger an `incident` artifact, and produce a rollback/verification receipt.

## 5. Kernel Contract (Appendix)

| Event | Condition | Action |
|-------|-----------|--------|
| **Mutation** | `session_token` missing or invalid | `FAIL_LOUDLY (PERMISSION_DENIED)` |
| **Claim** | `evidence_id` missing for "finding" | `FAIL_LOUDLY (CLAIM_REJECTED)` |
| **Read** | File stat differs from cached hash | `REFRESH_INDEX` then `PROCEED` |
| **Startup** | `git_hash` != `last_indexed_hash` | `SET_STATUS (STALE)` |
| **Upgrade** | `schema_version` > `kernel_version` | `REFUSE_SILENT_READ` (Loud Degradation) |
| **Spiral** | Existential/Narrative thrashing detected | `TRIGGER_INCIDENT` + `DEMOTE_TIER` |
