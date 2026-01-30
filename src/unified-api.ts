import { tool } from "@opencode-ai/plugin";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { systemTools } from "./system-tools.js";
import { activeSetTools } from "./activeset.js";
import { chunkCardsTools } from "./chunk-cards.js";
import { moduleSummariesTools } from "./module-summaries.js";
import { performanceTools } from "./performance-optimization.js";
import { graphTools, getDb } from "./database.js";
import { policyEngine } from "./services/policy.js";

const PROJECT_ROOT = process.cwd();

// Aggregate all internal tools
const internal = {
  ...systemTools(),
  ...activeSetTools(),
  ...chunkCardsTools(),
  ...moduleSummariesTools(),
  ...performanceTools(),
  ...graphTools(),
};

async function scoutPlugins() {
    const plugins = new Set<string>();
    
    // 1. Check opencode.jsonc
    try {
        const config = JSON.parse(fsSync.readFileSync(path.join(PROJECT_ROOT, "opencode.jsonc"), "utf-8"));
        if (config.plugin) config.plugin.forEach((p: string) => plugins.add(p));
    } catch {}

    // 2. Check package.json dependencies
    try {
        const pkg = JSON.parse(fsSync.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        Object.keys(allDeps).forEach(d => {
            if (d.includes("opencode")) plugins.add(d);
        });
    } catch {}

    return Array.from(plugins);
}

async function updateBridgePrompt(plugins: string[]) {
    const bridgePath = "/Users/user/.config/opencode/prompts/bridge.md";
    if (!fsSync.existsSync(bridgePath)) return "bridge.md not found at " + bridgePath;

    const toolsSection = `
## Current Consolidated Tools (Autognosis v2)
- code_search: Universal search (semantic, symbol, filename, content).
- code_analyze: Deep structural analysis and impact reports.
- code_context: Working memory (ActiveSet) management.
- code_read: Precise symbol jumping and file slicing.
- code_propose: Planning, patch generation, and PR promotion.
- code_status: System health, background job monitoring, and compliance metrics.
- code_setup: Environment initialization and maintenance.

## Other Detected Plugins
${plugins.filter(p => p !== "opencode-autognosis").map(p => `- ${p}`).join('\n')}
`;

    let content = fsSync.readFileSync(bridgePath, "utf-8");
    
    // Replace or Append Tool Usage section
    if (content.includes("## Current Consolidated Tools")) {
        content = content.replace(/## Current Consolidated Tools[\s\S]*?(?=\n#|$)/, toolsSection);
    } else {
        content += "\n" + toolsSection;
    }

    fsSync.writeFileSync(bridgePath, content);
    return "Updated bridge.md with consolidated tools and detected plugins.";
}

export function unifiedTools(): { [key: string]: any } {
  return {
    code_search: tool({
      description: "Search the codebase using various engines (filename, content, symbol, or semantic/vector).",
      args: {
        query: tool.schema.string().describe("Search query"),
        mode: tool.schema.enum(["filename", "content", "symbol", "semantic"]).optional().default("filename").describe("Search strategy"),
        path: tool.schema.string().optional().default(".").describe("Root path for search"),
        limit: tool.schema.number().optional().default(10).describe("Max results"),
        plan_id: tool.schema.string().optional()
      },
      async execute(args) {
        switch (args.mode) {
          case "content": return internal.fast_search.execute({ ...args, mode: "content" });
          case "symbol": return internal.graph_search_symbols.execute({ query: args.query });
          case "semantic": return internal.graph_semantic_search.execute({ query: args.query, limit: args.limit });
          default: return internal.fast_search.execute({ ...args, mode: "filename" });
        }
      }
    }),

    code_analyze: tool({
      description: "Perform structural analysis on files or modules. Generates summaries, API maps, and impact reports.",
      args: {
        target: tool.schema.string().describe("File path or module ID"),
        mode: tool.schema.enum(["summary", "api", "invariant", "module", "impact", "reasoning", "callers"]).optional().default("summary"),
        force: tool.schema.boolean().optional().default(false),
        plan_id: tool.schema.string().optional()
      },
      async execute(args) {
        switch (args.mode) {
          case "module": return internal.module_synthesize.execute({ file_path: args.target, force_resynthesize: args.force });
          case "impact": return internal.brief_fix_loop.execute({ symbol: args.target, intent: "impact_analysis" });
          case "reasoning": return internal.module_hierarchical_reasoning.execute({ module_id: args.target });
          case "callers": return internal.graph_search_symbols.execute({ query: args.target }); // Fallback or direct DB query
          default: return internal.chunk_create_card.execute({ file_path: args.target, chunk_type: args.mode as any, force_recreate: args.force });
        }
      }
    }),

    code_context: tool({
      description: "Manage working memory (ActiveSets). Limits context window usage by loading/unloading specific chunks.",
      args: {
        action: tool.schema.enum(["create", "load", "add", "remove", "status", "list", "close", "evict"]),
        target: tool.schema.string().optional().describe("ActiveSet ID or Chunk IDs (comma separated)"),
        name: tool.schema.string().optional().describe("Name for new ActiveSet"),
        limit: tool.schema.number().optional().default(5).describe("Eviction limit"),
        plan_id: tool.schema.string().optional()
      },
      async execute(args) {
        switch (args.action) {
          case "create": {
              const chunk_ids = args.target?.split(',').map(s => s.trim());
              return internal.activeset_create.execute({ name: args.name || "Context", chunk_ids });
          }
          case "load": return internal.activeset_load.execute({ set_id: args.target! });
          case "add": {
              const chunk_ids = args.target?.split(',').map(s => s.trim());
              return internal.activeset_add_chunks.execute({ chunk_ids: chunk_ids! });
          }
          case "remove": {
              const chunk_ids = args.target?.split(',').map(s => s.trim());
              return internal.activeset_remove_chunks.execute({ chunk_ids: chunk_ids! });
          }
          case "evict": {
              const lru = getDb().getLruChunks(args.limit);
              const chunk_ids = lru.map(c => c.chunk_id);
              return internal.activeset_remove_chunks.execute({ chunk_ids });
          }
          case "list": return internal.activeset_list.execute({});
          case "close": return internal.activeset_close.execute({});
          default: return internal.activeset_get_current.execute({});
        }
      }
    }),

    code_read: tool({
      description: "Precise reading of symbols or file slices. Follows the current plan.",
      args: {
        symbol: tool.schema.string().optional().describe("Symbol to jump to"),
        file: tool.schema.string().optional().describe("File path to read"),
        start_line: tool.schema.number().optional(),
        end_line: tool.schema.number().optional(),
        plan_id: tool.schema.string().optional()
      },
      async execute(args) {
        // Log access for LRU eviction
        if (args.symbol) {
            // Find chunk id for symbol first (simplified)
            getDb().logAccess(args.symbol, args.plan_id);
            return internal.jump_to_symbol.execute({ symbol: args.symbol, plan_id: args.plan_id });
        }
        if (args.file && args.start_line && args.end_line) {
          getDb().logAccess(args.file, args.plan_id);
          return internal.read_slice.execute({ file: args.file, start_line: args.start_line, end_line: args.end_line, plan_id: args.plan_id });
        }
        throw new Error("Either 'symbol' or 'file' with line range must be provided.");
      }
    }),

    code_propose: tool({
      description: "Plan, propose, and promote changes. Includes patch generation and PR promotion.",
      args: {
        action: tool.schema.enum(["plan", "patch", "validate", "finalize", "promote"]),
        symbol: tool.schema.string().optional().describe("Locus symbol for plan"),
        intent: tool.schema.string().optional().describe("Work intent"),
        message: tool.schema.string().optional().describe("Commit/PR message"),
        patch_path: tool.schema.string().optional().describe("Path to .diff file"),
        branch: tool.schema.string().optional().describe("Branch name for promotion"),
        plan_id: tool.schema.string().optional(),
        outcome: tool.schema.string().optional()
      },
      async execute(args) {
        switch (args.action) {
          case "plan": return internal.brief_fix_loop.execute({ symbol: args.symbol!, intent: args.intent! });
          case "patch": {
              const { stdout: diff } = await (internal as any).runCmd("git diff");
              const violations = policyEngine.checkDiff(diff);
              if (violations.some(v => v.severity === "error")) {
                  return JSON.stringify({ status: "POLICY_VIOLATION", violations, message: "Patch rejected by policy engine." }, null, 2);
              }
              return internal.prepare_patch.execute({ message: args.message!, plan_id: args.plan_id });
          }
          case "validate": return internal.validate_patch.execute({ patch_path: args.patch_path!, plan_id: args.plan_id });
          case "promote": {
              const branch = args.branch || `autognosis-fix-${Date.now()}`;
              const { execSync } = await import("node:child_process");
              try {
                  execSync(`git checkout -b ${branch}`);
                  execSync(`git apply ${args.patch_path}`);
                  execSync(`git add . && git commit -m "${args.message || 'Automated promotion'}"`);
                  execSync(`gh pr create --title "${args.message}" --body "Automated promotion from Autognosis v2."`);
                  return JSON.stringify({ status: "SUCCESS", promoted_to: branch, pr: "OPENED" }, null, 2);
              } catch (e: any) {
                  return JSON.stringify({ status: "ERROR", message: e.message }, null, 2);
              }
          }
          case "finalize": return internal.finalize_plan.execute({ plan_id: args.plan_id!, outcome: args.outcome! });
        }
      }
    }),

    code_status: tool({
      description: "Monitor system health, background jobs, and plan metrics.",
      args: {
        mode: tool.schema.enum(["stats", "hot_files", "jobs", "plan", "doctor"]).optional().default("stats"),
        job_id: tool.schema.string().optional(),
        plan_id: tool.schema.string().optional(),
        path: tool.schema.string().optional().default("")
      },
      async execute(args) {
        switch (args.mode) {
          case "hot_files": return internal.journal_query_hot_files.execute({ path_prefix: args.path });
          case "jobs": return internal.graph_background_status.execute({ job_id: args.job_id });
          case "plan": return internal.graph_get_plan_metrics.execute({ plan_id: args.plan_id! });
          case "doctor": {
              const stats = getDb().getStats();
              let logSnippet = "";
              try {
                  logSnippet = fsSync.readFileSync(path.join(PROJECT_ROOT, ".opencode", "logs", "autognosis.log"), "utf-8").split('\n').slice(-20).join('\n');
              } catch (e) {}
              return JSON.stringify({ status: "HEALTHY", stats, recent_logs: logSnippet }, null, 2);
          }
          default: return internal.graph_stats.execute({});
        }
      }
    }),

    code_setup: tool({
      description: "One-time setup and maintenance tasks (AI, Git Journal, Indexing, Prompt Scouting).",
      args: {
        action: tool.schema.enum(["init", "ai", "index", "journal", "scout"]),
        provider: tool.schema.enum(["ollama", "mlx"]).optional().default("ollama"),
        model: tool.schema.string().optional().describe("AI Model name"),
        limit: tool.schema.number().optional().describe("History limit")
      },
      async execute(args) {
        switch (args.action) {
          case "ai": return internal.autognosis_setup_ai.execute({ provider: args.provider, model: args.model });
          case "index": return internal.perf_incremental_index.execute({ background: true });
          case "journal": return internal.journal_build.execute({ limit: args.limit });
          case "scout": {
              const plugins = await scoutPlugins();
              return updateBridgePrompt(plugins);
          }
          default: return internal.autognosis_init.execute({ mode: "apply", token: "adhoc" });
        }
      }
    }),

    internal_call: tool({
      description: "Advanced access to specialized internal tools. Use only when unified tools are insufficient.",
      args: {
        tool_name: tool.schema.string().describe("Internal tool name"),
        args: tool.schema.any().describe("Arguments for the internal tool")
      },
      async execute({ tool_name, args }) {
        const target = (internal as any)[tool_name];
        if (!target) throw new Error(`Internal tool '${tool_name}' not found.`);
        return target.execute(args);
      }
    })
  };
}