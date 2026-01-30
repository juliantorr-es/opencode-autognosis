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
    try {
        const config = JSON.parse(fsSync.readFileSync(path.join(PROJECT_ROOT, "opencode.jsonc"), "utf-8"));
        if (config.plugin) config.plugin.forEach((p: string) => plugins.add(p));
    } catch {} // Ignore errors if config file doesn't exist
    try {
        const pkg = JSON.parse(fsSync.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        Object.keys(allDeps).forEach(d => { if (d.includes("opencode")) plugins.add(d); });
    } catch {} // Ignore errors if package.json doesn't exist
    return Array.from(plugins);
}

async function updateBridgePrompt(plugins: string[]) {
    const bridgePath = "/Users/user/.config/opencode/prompts/bridge.md";
    if (!fsSync.existsSync(bridgePath)) return "bridge.md not found at " + bridgePath;

    const toolsSection = `
## Current Consolidated Tools (Autognosis v2.3)
- code_search: Universal search (semantic, symbol, filename, content).
- code_analyze: Deep structural analysis and impact reports.
- code_context: Working memory (ActiveSet) management, LRU eviction, and Symbol Graffiti.
- code_read: Precise symbol jumping and file slicing with Mutex Lock checks.
- code_propose: Planning, patch generation, PR promotion, and Intent indexing.
- code_status: System health, background jobs, Multi-Agent Blackboard, and Resource Locks.
- code_setup: Environment initialization, AI setup, and Architectural Boundaries.

## Other Detected Plugins
${plugins.filter(p => p !== "opencode-autognosis").map(p => `- ${p}`).join('\n')}
`;

    let content = fsSync.readFileSync(bridgePath, "utf-8");
    if (content.includes("## Current Consolidated Tools")) {
        content = content.replace(/## Current Consolidated Tools[\s\S]*?(?=\n#|$)/, toolsSection);
    } else {
        content += "\n" + toolsSection;
    }
    fsSync.writeFileSync(bridgePath, content);
    return "Updated bridge.md with consolidated tools and detected plugins.";
}

export function unifiedTools(): { [key: string]: any } {
  const agentName = process.env.AGENT_NAME || `agent-${process.pid}`;

  return {
    code_search: tool({
      description: "Search the codebase using various engines (filename, content, symbol, or semantic/vector).",
      args: {
        query: tool.schema.string().describe("Search query"),
        mode: tool.schema.enum(["filename", "content", "symbol", "semantic"]).optional().default("filename"),
        path: tool.schema.string().optional().default("."),
        limit: tool.schema.number().optional().default(10),
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
          case "callers": return internal.graph_search_symbols.execute({ query: args.target }); 
          default: return internal.chunk_create_card.execute({ file_path: args.target, chunk_type: args.mode as any, force_recreate: args.force });
        }
      }
    }),

    code_context: tool({
      description: "Manage working memory (ActiveSets). Limits context window usage by loading/unloading specific chunks.",
      args: {
        action: tool.schema.enum(["create", "load", "add", "remove", "status", "list", "close", "evict"]),
        target: tool.schema.string().optional().describe("ActiveSet ID or Chunk IDs"),
        name: tool.schema.string().optional(),
        limit: tool.schema.number().optional().default(5),
        plan_id: tool.schema.string().optional()
      },
      async execute(args) {
        switch (args.action) {
          case "create": return internal.activeset_create.execute({ name: args.name || "Context", chunk_ids: args.target?.split(',').map(s => s.trim()) });
          case "load": return internal.activeset_load.execute({ set_id: args.target! });
          case "add": return internal.activeset_add_chunks.execute({ chunk_ids: args.target?.split(',').map(s => s.trim())! });
          case "remove": return internal.activeset_remove_chunks.execute({ chunk_ids: args.target?.split(',').map(s => s.trim())! });
          case "evict": {
              const lru = getDb().getLruChunks(args.limit);
              return internal.activeset_remove_chunks.execute({ chunk_ids: lru.map(c => c.chunk_id) });
          }
          case "list": return internal.activeset_list.execute({});
          case "close": return internal.activeset_close.execute({});
          default: return internal.activeset_get_current.execute({});
        }
      }
    }),

    code_read: tool({
      description: "Precise reading of symbols or file slices. Follows current plan. Checks for locks and returns graffiti.",
      args: {
        symbol: tool.schema.string().optional().describe("Symbol to jump to"),
        file: tool.schema.string().optional().describe("File path to read"),
        start_line: tool.schema.number().optional(),
        end_line: tool.schema.number().optional(),
        plan_id: tool.schema.string().optional()
      },
      async execute(args) {
        const resourceId = args.symbol || args.file;
        if (resourceId) {
            getDb().logAccess(resourceId, args.plan_id);
            const lock = getDb().isLocked(resourceId);
            const graffiti = getDb().getGraffiti(resourceId);
            
            let result: any;
            if (args.symbol) {
                result = await internal.jump_to_symbol.execute({ symbol: args.symbol, plan_id: args.plan_id });
            } else {
                result = await internal.read_slice.execute({ file: args.file!, start_line: args.start_line!, end_line: args.end_line!, plan_id: args.plan_id });
            }

            const parsed = JSON.parse(result);
            return JSON.stringify({
                ...parsed,
                coordination: {
                    lock_status: lock ? `LOCKED by ${lock.owner_agent}` : "FREE",
                    graffiti: graffiti.length > 0 ? graffiti : undefined
                }
            }, null, 2);
        }
        throw new Error("Either 'symbol' or 'file' must be provided.");
      }
    }),

    code_propose: tool({
      description: "Plan, propose, and promote changes. Automatically handles coordination pulse and lock checks.",
      args: {
        action: tool.schema.enum(["plan", "patch", "validate", "finalize", "promote"]),
        symbol: tool.schema.string().optional(),
        intent: tool.schema.string().optional(),
        reasoning: tool.schema.string().optional(),
        message: tool.schema.string().optional(),
        patch_path: tool.schema.string().optional(),
        branch: tool.schema.string().optional(),
        plan_id: tool.schema.string().optional(),
        outcome: tool.schema.string().optional()
      },
      async execute(args) {
        switch (args.action) {
          case "plan": {
              getDb().postToBlackboard(agentName, `Planning ${args.intent} for ${args.symbol}`, "pulse");
              return internal.brief_fix_loop.execute({ symbol: args.symbol!, intent: args.intent! });
          }
          case "patch": {
              // 1. Check for locks on all changed files
              const { stdout: diff } = await (internal as any).runCmd("git diff");
              const { stdout: files } = await (internal as any).runCmd("git diff --name-only");
              const changedFiles = files.split('\n').filter(Boolean);
              
              for (const file of changedFiles) {
                  const lock = getDb().isLocked(file);
                  if (lock && lock.owner_agent !== agentName) {
                      return JSON.stringify({ status: "COLLISION_PREVENTED", message: `File ${file} is locked by ${lock.owner_agent}. Use 'code_status' to investigate.` });
                  }
              }

              // 2. Run Policy Engine
              const violations = policyEngine.checkDiff(diff);
              if (violations.some(v => v.severity === "error")) {
                  return JSON.stringify({ status: "POLICY_VIOLATION", violations, message: "Patch rejected by policy engine." }, null, 2);
              }

              // 3. Prepare patch and record intent
              const res = await internal.prepare_patch.execute({ message: args.message!, plan_id: args.plan_id });
              const json = JSON.parse(res);
              if (json.status === "SUCCESS") {
                  if (args.reasoning) getDb().storeIntent(json.patch_id, args.reasoning, args.plan_id || "adhoc");
                  getDb().postToBlackboard(agentName, `Proposed patch ${json.patch_id}: ${args.message}`, "pulse");
              }
              return res;
          }
          case "validate": {
              getDb().postToBlackboard(agentName, `Validating patch ${args.patch_path}`, "pulse");
              return internal.validate_patch.execute({ patch_path: args.patch_path!, plan_id: args.plan_id });
          }
          case "promote": {
              const branch = args.branch || `autognosis-fix-${Date.now()}`;
              const { execSync } = await import("node:child_process");
              try {
                  execSync(`git checkout -b ${branch}`);
                  execSync(`git apply ${args.patch_path}`);
                  execSync(`git add . && git commit -m "${args.message || 'Automated promotion'}"`);
                  execSync(`gh pr create --title "${args.message}" --body "Automated promotion from Autognosis v2."`);
                  getDb().postToBlackboard(agentName, `Promoted patch to PR on branch ${branch}`, "pulse");
                  return JSON.stringify({ status: "SUCCESS", promoted_to: branch, pr: "OPENED" }, null, 2);
              } catch (e: any) { return JSON.stringify({ status: "ERROR", message: e.message }, null, 2); }
          }
          case "finalize": {
              getDb().postToBlackboard(agentName, `Finalized plan ${args.plan_id} with outcome: ${args.outcome}`, "pulse");
              return internal.finalize_plan.execute({ plan_id: args.plan_id!, outcome: args.outcome! });
          }
        }
      }
    }),

    code_status: tool({
      description: "Monitor system health, background jobs, Multi-Agent Blackboard, and Resource Locks.",
      args: {
        mode: tool.schema.enum(["stats", "hot_files", "jobs", "plan", "doctor", "blackboard", "locks"]).optional().default("stats"),
        action: tool.schema.enum(["post", "read", "lock", "unlock"]).optional(),
        topic: tool.schema.string().optional().default("general"),
        target: tool.schema.string().optional().describe("Resource ID (file/symbol) for locks or Symbol ID for graffiti"),
        message: tool.schema.string().optional(),
        job_id: tool.schema.string().optional(),
        plan_id: tool.schema.string().optional(),
        path: tool.schema.string().optional().default("")
      },
      async execute(args) {
        switch (args.mode) {
          case "locks": {
              if (args.action === "lock") {
                  getDb().acquireLock(args.target!, agentName);
                  return JSON.stringify({ status: "SUCCESS", message: `Locked ${args.target}` });
              } else if (args.action === "unlock") {
                  getDb().releaseLock(args.target!, agentName);
                  return JSON.stringify({ status: "SUCCESS", message: `Unlocked ${args.target}` });
              }
              return JSON.stringify({ status: "SUCCESS", active_locks: getDb().listLocks() });
          }
          case "blackboard": {
              if (args.action === "post") {
                  getDb().postToBlackboard(agentName, args.message!, args.topic, args.target);
                  return JSON.stringify({ status: "SUCCESS", message: "Posted to blackboard." });
              }
              return JSON.stringify({ status: "SUCCESS", entries: getDb().readBlackboard(args.topic) });
          }
          case "hot_files": return internal.journal_query_hot_files.execute({ path_prefix: args.path });
          case "jobs": return internal.graph_background_status.execute({ job_id: args.job_id });
          case "plan": return internal.graph_get_plan_metrics.execute({ plan_id: args.plan_id! });
          case "doctor": {
              const stats = getDb().getStats();
              let logSnippet = "";
              try { logSnippet = fsSync.readFileSync(path.join(PROJECT_ROOT, ".opencode", "logs", "autognosis.log"), "utf-8").split('\n').slice(-20).join('\n'); } catch (e) {}
              return JSON.stringify({ status: "HEALTHY", stats, recent_logs: logSnippet }, null, 2);
          }
          default: return internal.graph_stats.execute({});
        }
      }
    }),

    code_setup: tool({
      description: "Setup and maintenance tasks (AI, Git Journal, Indexing, Prompt Scouting, Arch Boundaries).",
      args: {
        action: tool.schema.enum(["init", "ai", "index", "journal", "scout", "arch_rule"]),
        provider: tool.schema.enum(["ollama", "mlx"]).optional().default("ollama"),
        model: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
        source: tool.schema.string().optional().describe("Source target pattern"),
        target: tool.schema.string().optional().describe("Target target pattern (forbidden)")
      },
      async execute(args) {
        switch (args.action) {
          case "arch_rule": {
              getDb().addArchRule(args.source!, args.target!);
              return JSON.stringify({ status: "SUCCESS", message: `Architecture rule added: ${args.source} cannot import ${args.target}` });
          }
          case "ai": return internal.autognosis_setup_ai.execute({ provider: args.provider, model: args.model });
          case "index": return internal.perf_incremental_index.execute({ background: true });
          case "journal": return internal.journal_build.execute({ limit: args.limit });
          case "scout": { const plugins = await scoutPlugins(); return updateBridgePrompt(plugins); }
          default: return internal.autognosis_init.execute({ mode: "apply", token: "adhoc" });
        }
      }
    }),

    internal_call: tool({
      description: "Advanced access to specialized internal tools.",
      args: { tool_name: tool.schema.string(), args: tool.schema.any() },
      async execute({ tool_name, args }) {
        const target = (internal as any)[tool_name];
        if (!target) throw new Error(`Internal tool '${tool_name}' not found.`);
        return target.execute(args);
      }
    })
  };
}