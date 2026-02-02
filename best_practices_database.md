# Best Practices: Database (Bun & SQLite)

## 1. Schema Evolution & Migrations
### Industry Best Practice
*   **Declarative Migrations:** Use tools like Atlas or Drizzle Migrations to manage schema changes. Never run raw `CREATE TABLE` in application code.
*   **Versioned SQL:** Store migrations in version-controlled `.sql` files to ensure environmental parity.

### Current Implementation Analysis
*   **Constructor Initialization:** `database.ts` runs a massive multi-line SQL string in the `initialize()` method. This makes schema updates risky (manual `ALTER TABLE` or table dropping).
*   **No Migration History:** There is no way to track which version of the schema a user is running.

## 2. Query Performance & Safety
### Industry Best Practice
*   **Prepared Statement Caching:** Reuse prepared statements to avoid re-parsing SQL.
*   **WAL Mode:** Always enable Write-Ahead Logging for concurrent read/write performance in agent environments.
*   **Transaction Integrity:** Group related inserts (e.g., file + chunks + symbols) into a single ACID transaction.

### Current Implementation Analysis
*   **Good WAL Usage:** `PRAGMA journal_mode = WAL` is already implemented.
*   **Inconsistent Transactions:** While `ingestChunkCard` uses transactions, other operations like `postToBlackboard` do multi-step inserts without a transaction, risking orphaned queue items.
*   **SQL Injection Risks:** Some internal query builders use string interpolation rather than parameters.

### Refinement Plan
1.  **Migration System:** Move schema definition to `src/db/migrations/` and implement a simple runner that checks a `user_version` PRAGMA.
2.  **Transactional Safety:** Wrap all multi-table ingestions in `db.transaction()`.
3.  **Typed Prepared Statements:** Define prepared statements as class properties during initialization to maximize Bun's performance.
