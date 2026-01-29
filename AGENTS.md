# Agent Guide for opencode-autognosis

This documentation defines the standards and workflows for AI agents working on the `opencode-autognosis` repository.
This project is a TypeScript-based **Model Context Protocol (MCP)** server extension.

## 1. Build, Lint, and Test

### Build System
The project uses `tsc` (TypeScript Compiler) for building. There is no separate linter config; `tsc` in strict mode serves as the primary code quality gate.

*   **Build Command:**
    ```bash
    npm run build
    ```
    *Always run this after making changes to verify type safety.*

### Testing
There is currently no unit testing framework (like Jest or Mocha) installed.
*   **Verification Strategy:** Rely on the TypeScript compiler (`npm run build`) for structural correctness.
*   **Smoke Testing:** To verify the built artifact can be imported and executed by Node.js, run:
    ```bash
    node -e "import('./dist/index.js').then(() => console.log('Module loaded successfully')).catch(err => { console.error(err); process.exit(1); })"
    ```
*   **Manual Testing:** If adding logic that can be tested in isolation, consider creating a temporary script in `scripts/` (ignoring it in git) to verify behavior before finalizing.

## 2. Code Style & Conventions

### Formatting Rules
*   **Indentation:** 2 spaces (soft tabs).
*   **Quotes:** Double quotes (`"`) for all strings and import paths.
*   **Semicolons:** Mandatory at the end of every statement.
*   **Trailing Commas:** ES5 style (objects, arrays).
*   **Line Length:** Aim for < 100 characters where possible, but clarity takes precedence.
*   **File Endings:** All files must end with a single newline character.

### TypeScript Config
*   **Target:** `ES2022`
*   **Module:** `ESNext`
*   **Strict Mode:** Enabled (`"strict": true`).
    *   **No `any`:** Avoid `any` explicitly. Use `unknown` with narrowing or generic types.
    *   **Null Checks:** `strictNullChecks` is on. Handle `null` and `undefined` explicitly.

### Naming Conventions
*   **Files:** `kebab-case.ts` (e.g., `text-processor.ts`).
*   **Classes/Types/Interfaces:** `PascalCase` (e.g., `AnalysisResult`).
*   **Functions/Methods/Variables:** `camelCase` (e.g., `calculateMetrics`).
*   **Constants:** `UPPER_CASE` for global constants; `camelCase` for immutable local variables.

### Imports
*   Use named imports where possible.
*   Group imports:
    1.  Standard Node.js modules (`path`, `fs`).
    2.  External dependencies (`@modelcontextprotocol/sdk`, `zod`).
    3.  Internal modules (`./utils`, `../types`).

### Error Handling
*   Use `try/catch` blocks for all async operations and I/O.
*   Throw standard `Error` objects or custom error classes.
*   When implementing MCP tools, catch errors and return a user-friendly error message in the tool response if possible, rather than crashing the server.

## 3. Architecture: Model Context Protocol (MCP)

This project implements an MCP server using `@modelcontextprotocol/sdk`.

### Tool Implementation Pattern
All tools should be registered using the `server.tool()` method (or `server.registerTool` if using an older SDK version, check usage in `src/index.ts`).

**Standard Pattern:**
```typescript
import { z } from "zod";

// Define input schema using Zod
const InputSchema = z.object({
  filepath: z.string().describe("Absolute path to the file"),
  depth: z.number().optional().describe("Analysis depth"),
});

// Register the tool
server.tool(
  "tool-name",
  "Description of what the tool does (visible to the LLM)",
  { inputSchema: InputSchema },
  async (args) => {
    // 1. Validate/Parse args (Zod does this automatically usually, but be safe)
    const { filepath, depth } = args;

    // 2. Perform logic
    try {
      const result = await analyzeFile(filepath, depth);

      // 3. Return MCP formatted result
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);
```

### Dependencies
*   **`@modelcontextprotocol/sdk`**: Core SDK for server/client communication.
*   **`zod`**: Schema validation for tool arguments.

## 4. Workflow for Agents

1.  **Read:** Start by reading `src/index.ts` to see the current server setup and registered tools.
2.  **Edit:** Make changes or add new tools in separate files if complex, or `src/index.ts` if simple.
3.  **Verify:** Run `npm run build` immediately to catch type errors.
4.  **Refine:** Fix any strict mode violations.

## 5. Directory Structure
*   `src/`: Source code.
*   `dist/`: Compiled output (do not edit).
*   `package.json`: Dependency management.
*   `.github/workflows`: CI/CD configurations.

---
*Refer to this document for all stylistic and architectural decisions.*
