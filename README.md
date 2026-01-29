# opencode-autognosis

**Self-knowledge for your codebase.** A suite of tools for OpenCode that enables rapid discovery, structural search, and safe iteration.

This plugin transforms your agent from a file-reader into a "Miniature Engineer" capable of understanding project structure, navigating by symbols, and planning changes safely.

## Prerequisites

This plugin relies on the following high-performance system binaries. Please ensure they are installed and in your PATH:

- **ripgrep (`rg`)**: For fast content searching.
- **fd (`fd`)**: For fast file finding.
- **ast-grep (`sg`)**: For structural code search.
- **universal-ctags (`ctags`)**: For symbol indexing.
- **git**: For version control integration.

## Installation

### Via npm (Recommended)

1. Install the package:
   ```bash
   npm install opencode-autognosis
   ```

2. Configure `opencode.json`:
   ```json
   {
     "plugin": ["opencode-autognosis"]
   }
   ```

### Local Plugin

1. Clone this repository.
2. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
3. Copy `dist/index.js` to your project's `.opencode/plugins/autognosis.js` (or reference the build directory).

## End-to-End Demo

Here is how the "Miniature Engineer" workflow looks in practice:

1.  **Initialize & Plan**:
    ```javascript
    // Agent initializes environment and gets a plan ID
    autognosis_init({ mode: "apply", token: "..." })
    brief_fix_loop({ symbol: "AuthService", intent: "refactor" })
    // Returns: { plan_id: "plan-123", ... }
    ```

2.  **Navigate & Read**:
    ```javascript
    // Agent jumps to definition using the plan ID
    jump_to_symbol({ symbol: "AuthService", plan_id: "plan-123" })
    // Returns: { resolved_location: "src/auth.ts", slice: "..." }
    ```

3.  **Propose Change**:
    ```javascript
    // Agent edits file (via standard write_file or replace)
    // Then captures the change as a patch artifact
    prepare_patch({ plan_id: "plan-123", message: "Refactor login method" })
    // Returns: "Patch saved to .opencode/cache/patch-123.diff"
    ```

4.  **Validate**:
    ```javascript
    // Agent ensures the patch is valid before committing
    validate_patch({ patch_path: ".opencode/cache/patch-123.diff" })
    // Returns: { status: "SUCCESS", checks: { git_apply_check: "passed" } }
    ```

5.  **Finalize**:
    ```javascript
    // Agent closes the loop
    finalize_plan({ plan_id: "plan-123", outcome: "success" })
    // Returns: "Plan finalized. Metrics logged."
    ```

## Tools Capabilities

### Discovery & Navigation
- **`fast_search`**: Optimized text search using `rg` (content) and `fd` (files). Enforces "filename-first" discovery.
- **`structural_search`**: Find code by grammatical pattern using `ast-grep`.
- **`symbol_query`**: Instant symbol lookup using a content-addressable tags index.
- **`jump_to_symbol`**: The primary navigation tool. Resolves a symbol and returns a bounded "slice" of code.
- **`read_slice`**: Efficiently reads specific line ranges from files.

### Engineering Workflow
- **`brief_fix_loop`**: Generates a bounded **Plan** containing the definition, dependents, and context.
- **`prepare_patch`**: Generates a `.diff` artifact for the current changes.
- **`validate_patch`**: Validates a patch in a clean git worktree.
- **`finalize_plan`**: Closes the session loop, logs metrics, and cleans up the cache.

## Initialization

Run the initialization tool to verify your environment:

```javascript
autognosis_init() // Default mode="plan"
```

This will check for required binaries and provide a token to confirm initialization.
