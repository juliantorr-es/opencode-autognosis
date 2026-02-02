# Best Practices: TypeScript (Enterprise 2026)

## 1. Type Safety & Strictness
### Industry Best Practice
*   **Absolute Strictness:** `strict: true` in `tsconfig.json` is mandatory. Avoid `any` at all costs, preferring `unknown` for external data and narrowing it with Type Guards.
*   **Discriminated Unions:** Use for complex state and response types to ensure exhaustive handling.
*   **Satisfies Operator:** Use `satisfies` to validate object shapes without widening the inferred type.
*   **Zod/Valibot Integration:** Validate all external inputs (API responses, file contents) at the boundary.

### Current Implementation Analysis
*   **The `any` Plague:** Files like `database.ts` and `index.ts` use `any` extensively for return types, arguments, and even internal logic (e.g., `getContracts`, `execute({ client }: any)`).
*   **Lack of Validation:** Tool inputs use `tool.schema`, which is good, but internal data flows (like reading cache files or DB rows) often bypass validation, leading to "silent" runtime errors.
*   **Type Widening:** Many interfaces are too permissive, failing to leverage the precision of literal types or `readonly` modifiers.

### Refinement Plan
1.  **Purge `any`:** Replace `any` with specific interfaces or `unknown`.
2.  **Schema Enforcement:** Integrate `zod` for parsing JSON files in the `.opencode/cache` and `.opencode/metrics` directories.
3.  **Exhaustive Checks:** Implement discriminated unions for `BackgroundTask` statuses (`pending`, `running`, `completed`, `failed`) to ensure all UI states are handled.
