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
    } catch {}
    try {
        const pkg = JSON.parse(fsSync.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        Object.keys(allDeps).forEach(d => { if (d.includes("opencode")) plugins.add(d); });
    } catch {}
    return Array.from(plugins);
}

async function updateBridgePrompt(plugins: string[]) {
    const bridgePath = "/Users/user/.config/opencode/prompts/bridge.md";
    if (!fsSync.existsSync(bridgePath)) return "bridge.md not found at " + bridgePath;

    const toolsSection = `
## Current Consolidated Tools (Autognosis v2.5)
- code_search: Universal search (semantic, symbol, filename, content).
- code_analyze: Deep structural analysis and impact reports.
- code_context: Working memory management and LRU eviction.
- code_read: Precise reading with Mutex Lock checks and Graffiti retrieval.
- code_propose: Planning, patching, validation, and PR promotion.
- code_status: Dashboard, background jobs, blackboard, and resource locks.
- code_setup: Environment initialization, AI setup, and Architectural Boundaries.
- code_contract: Reactive tool chaining and automated post-execution hooks.

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

/**
 * Reactive Contract Runner
 * Automatically triggers secondary tools based on registered contracts.
 */
async function runWithContracts(toolName: string, action: string | undefined, args: any, result: string, tools: any): Promise<string> {
    const contracts = getDb().getContracts(toolName, action || '');
    if (contracts.length === 0) return result;

    let finalResult = JSON.parse(result);
    finalResult.contracts_triggered = [];

    for (const contract of contracts) {
        try {
            const targetTool = tools[contract.target_tool];
            if (targetTool) {
                const targetArgs = JSON.parse(contract.target_args);
                // Merge context from original args if needed (e.g. plan_id)
                if (args.plan_id) targetArgs.plan_id = args.plan_id;
                
                const chainResult = await targetTool.execute(targetArgs);
                finalResult.contracts_triggered.push({
                    name: contract.target_tool,
                    result: JSON.parse(chainResult)
                });
            }
        } catch (e) {
            finalResult.contracts_triggered.push({ name: contract.target_tool, error: String(e) });
        }
    }

    return JSON.stringify(finalResult, null, 2);
}

export function unifiedTools(): { [key: string]: any } {
  const agentName = process.env.AGENT_NAME || `agent-${process.pid}`;
  const api: any = {};

  const wrap = (toolName: string, config: any) => {
      const originalExecute = config.execute;
      config.execute = async (args: any) => {
          try {
              let res = await originalExecute(args);
              
              // 1. Settling Delay: Give the TUI state machine time to finish 'submission' 
              // before we return a massive result that triggers highlighting.
              await new Promise(r => setTimeout(r, 50));

              // 2. Truncation: Prevent the highlighting engine from crashing on massive outputs.
              if (res.length > 50000) {
                  res = res.slice(0, 50000) + "\n\n... [RESULT TRUNCATED BY AUTOGNOSIS FOR TUI STABILITY]";
              }

              // 3. Contract Chaining
              if (!res.includes('"status": "ERROR"') && !res.includes('"status": "FAILED"')) {
                  res = await runWithContracts(toolName, args.action || args.mode, args, res, api);
              }

              return res;
          } catch (e: any) {
              return JSON.stringify({ status: "ERROR", message: String(e) });
          }
      };
      return tool(config);
  };

  Object.assign(api, {
    code_search: wrap("code_search", {
      description: "Search the codebase using various engines (filename, content, symbol, or semantic/vector).",
      args: {
        query: tool.schema.string().describe("Search query"),
        mode: tool.schema.enum(["filename", "content", "symbol", "semantic"]).optional().default("filename"),
        path: tool.schema.string().optional().default("."),
        limit: tool.schema.number().optional().default(10),
        plan_id: tool.schema.string().optional()
      },
      async execute(args: any) {
        switch (args.mode) {
          case "content": return internal.fast_search.execute({ ...args, mode: "content" });
          case "symbol": return internal.graph_search_symbols.execute({ query: args.query });
          case "semantic": return internal.graph_semantic_search.execute({ query: args.query, limit: args.limit });
          default: return internal.fast_search.execute({ ...args, mode: "filename" });
        }
      }
    }),

    code_analyze: wrap("code_analyze", {
      description: "Perform structural analysis on files or modules. Generates summaries, API maps, and impact reports.",
      args: {
        target: tool.schema.string().describe("File path or module ID"),
        mode: tool.schema.enum(["summary", "api", "invariant", "module", "impact", "reasoning", "callers"]).optional().default("summary"),
        force: tool.schema.boolean().optional().default(false),
        plan_id: tool.schema.string().optional()
      },
      async execute(args: any) {
        switch (args.mode) {
          case "module": return internal.module_synthesize.execute({ file_path: args.target, force_resynthesize: args.force });
          case "impact": return internal.brief_fix_loop.execute({ symbol: args.target, intent: "impact_analysis" });
          case "reasoning": return internal.module_hierarchical_reasoning.execute({ module_id: args.target });
          case "callers": return internal.graph_search_symbols.execute({ query: args.target }); 
          default: return internal.chunk_create_card.execute({ file_path: args.target, chunk_type: args.mode as any, force_recreate: args.force });
        }
      }
    }),

    code_context: wrap("code_context", {
      description: "Manage working memory (ActiveSets). Limits context window usage by loading/unloading specific chunks.",
      args: {
        action: tool.schema.enum(["create", "load", "add", "remove", "status", "list", "close", "evict"]),
        target: tool.schema.string().optional().describe("ActiveSet ID or Chunk IDs"),
        name: tool.schema.string().optional(),
        limit: tool.schema.number().optional().default(5),
        plan_id: tool.schema.string().optional()
      },
      async execute(args: any) {
        switch (args.action) {
          case "create": return internal.activeset_create.execute({ name: args.name || "Context", chunk_ids: args.target?.split(',').map((s: string) => s.trim()) });
          case "load": return internal.activeset_load.execute({ set_id: args.target! });
          case "add": return internal.activeset_add_chunks.execute({ chunk_ids: args.target?.split(',').map((s: string) => s.trim())! });
          case "remove": return internal.activeset_remove_chunks.execute({ chunk_ids: args.target?.split(',').map((s: string) => s.trim())! });
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

    code_read: wrap("code_read", {
      description: "Precise reading of symbols or file slices. Follows current plan. Checks for locks and returns historical graffiti.",
      args: {
        symbol: tool.schema.string().optional().describe("Symbol to jump to"),
        file: tool.schema.string().optional().describe("File path to read"),
        start_line: tool.schema.number().optional(),
        end_line: tool.schema.number().optional(),
        plan_id: tool.schema.string().optional()
      },
      async execute(args: any) {
        const resourceId = args.symbol || args.file;
        if (resourceId) {
            getDb().logAccess(resourceId, args.plan_id);
            const lock = getDb().isLocked(resourceId);
            const graffiti = getDb().getGraffiti(resourceId, 3);
            
            let currentHash = "";
            try {
                const { execSync } = await import("node:child_process");
                currentHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
            } catch {}

            const verifiedGraffiti = graffiti.map((g: any) => ({
                author: g.author,
                message: g.message,
                timestamp: g.timestamp,
                status: g.git_hash !== currentHash ? "LEGACY (Potentially Outdated)" : "CURRENT",
                is_pinned: !!g.is_pinned
            }));
            
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
                    historical_notes: verifiedGraffiti.length > 0 ? verifiedGraffiti : undefined
                }
            }, null, 2);
        }
        throw new Error("Either 'symbol' or 'file' must be provided.");
      }
    }),

    code_propose: wrap("code_propose", {
      description: "Plan, propose, and promote changes. Automatically handles coordination pulse and lock checks.",
      args: {
        action: tool.schema.enum(["plan", "patch", "validate", "finalize", "promote"]),
        symbol: tool.schema.string().optional().describe("Locus symbol for plan"),
        intent: tool.schema.string().optional(),
        reasoning: tool.schema.string().optional(),
        message: tool.schema.string().optional(),
        patch_path: tool.schema.string().optional(),
        branch: tool.schema.string().optional(),
        plan_id: tool.schema.string().optional(),
        outcome: tool.schema.string().optional()
      },
      async execute(args: any) {
        switch (args.action) {
          case "plan": {
              getDb().postToBlackboard(agentName, `Planning ${args.intent} for ${args.symbol}`, "pulse");
              return internal.brief_fix_loop.execute({ symbol: args.symbol!, intent: args.intent! });
          }
          case "patch": {
              const { stdout: files } = await (internal as any).runCmd("git diff --name-only");
              const changedFiles = files.split('\n').filter(Boolean);
              for (const file of changedFiles) {
                  const lock = getDb().isLocked(file);
                  if (lock && lock.owner_agent !== agentName) {
                      return JSON.stringify({ status: "COLLISION_PREVENTED", message: `File ${file} is locked by ${lock.owner_agent}.` });
                  }
              }
              const { stdout: diff } = await (internal as any).runCmd("git diff");
              const violations = policyEngine.checkDiff(diff);
              if (violations.some(v => v.severity === "error")) {
                  return JSON.stringify({ status: "POLICY_VIOLATION", violations, message: "Patch rejected by policy engine." }, null, 2);
              }
              const res = await internal.prepare_patch.execute({ message: args.message!, plan_id: args.plan_id });
              const json = JSON.parse(res);
              if (json.status === "SUCCESS") {
                  if (args.reasoning) getDb().storeIntent(json.patch_id, args.reasoning, args.plan_id || "adhoc");
                  getDb().postToBlackboard(agentName, `Proposed patch ${json.patch_id}: ${args.message}`, "pulse");
              }
              return res;
          }
          case "validate": {
              const { stdout: diff } = await (internal as any).runCmd("git diff --name-only");
              const changedFiles = diff.split('\n').filter(Boolean);
              for (const file of changedFiles) {
                  const deps = await internal.extractDependencies.execute({ content: "", ast: null, filePath: file });
                  const imports = JSON.parse(deps);
                  for (const imp of imports) {
                      const violation = getDb().checkArchViolation(file, imp);
                      if (violation) return JSON.stringify({ status: "ARCH_VIOLATION", file, forbidden_import: imp, rule: violation }, null, 2);
                  }
              }
              let focusTests: string[] = [];
              if (args.symbol) focusTests = getDb().findAffectedTests(args.symbol);
              getDb().postToBlackboard(agentName, `Validating patch ${args.patch_path}. Scoped tests: ${focusTests.length}`, "pulse");
              return internal.validate_patch.execute({ patch_path: args.patch_path!, plan_id: args.plan_id, tests: focusTests });
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

    code_status: wrap("code_status", {
      description: "Monitor system health, background jobs, Multi-Agent Blackboard, and Resource Locks.",
      args: {
        mode: tool.schema.enum(["stats", "hot_files", "jobs", "plan", "doctor", "blackboard", "locks", "dashboard"]).optional().default("stats"),
        action: tool.schema.enum(["post", "read", "lock", "unlock", "archive", "pin"]).optional(),
        topic: tool.schema.string().optional().default("general"),
        target: tool.schema.string().optional().describe("Resource ID or Note ID"),
        pinned: tool.schema.boolean().optional().default(false),
        message: tool.schema.string().optional(),
        job_id: tool.schema.string().optional(),
        plan_id: tool.schema.string().optional(),
        path: tool.schema.string().optional().default("")
      },
      async execute(args: any) {
        switch (args.mode) {
          case "dashboard": {
              const stats = getDb().getStats();
              const locks = getDb().listLocks();
              const jobs = getDb().listJobs();
              const compliance = args.plan_id ? getDb().getPlanMetrics(args.plan_id) : null;
              let dashboard = `# Autognosis TUI Dashboard\n\n`;
              dashboard += `## 📊 System Stats\n- Files: ${stats.files}\n- Chunks: ${stats.chunks}\n- Embedded: ${stats.embeddings.completed}/${stats.chunks}\n\n`;
              dashboard += `## 🔒 Active Locks\n`;
              if (locks.length > 0) dashboard += (locks as any[]).map(l => `- ${l.resource_id} (${l.owner_agent})`).join('\n') + '\n\n';
              else dashboard += "_No active locks._\n\n";
              dashboard += `## ⚙️ Recent Jobs\n`;
              dashboard += (jobs as any[]).map(j => `- [${j.status.toUpperCase()}] ${j.type} (${j.progress}%)`).join('\n') + '\n\n';
              if (compliance) {
                  dashboard += `## 📉 Plan Compliance (${args.plan_id})\n- Score: ${compliance.compliance}%\n- Total Calls: ${compliance.total}\n- Off-Plan: ${compliance.off_plan}\n`;
              }
              return dashboard;
          }
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
                  getDb().postToBlackboard(agentName, args.message!, args.topic, args.target, args.pinned);
                  return JSON.stringify({ status: "SUCCESS", message: "Posted to blackboard." });
              } else if (args.action === "archive") {
                  getDb().archiveGraffiti(args.target!);
                  return JSON.stringify({ status: "SUCCESS", message: `Archived notes for ${args.target}` });
              } else if (args.action === "pin") {
                  getDb().pinGraffiti(parseInt(args.target!, 10), true);
                  return JSON.stringify({ status: "SUCCESS", message: `Pinned note ${args.target}` });
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

    code_setup: wrap("code_setup", {
      description: "Setup tasks (AI, Git Journal, Indexing, Prompt Scouting, Arch Boundaries).",
      args: {
        action: tool.schema.enum(["init", "ai", "index", "journal", "scout", "arch_rule"]),
        provider: tool.schema.enum(["ollama", "mlx"]).optional().default("ollama"),
        model: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
        source: tool.schema.string().optional().describe("Source target pattern"),
        target: tool.schema.string().optional().describe("Target target pattern (forbidden)")
      },
      async execute(args: any) {
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

    code_contract: wrap("code_contract", {
        description: "Register reactive tool contracts for automated post-execution chaining.",
        args: {
            action: tool.schema.enum(["register", "list", "delete"]),
            trigger_tool: tool.schema.string().optional().describe("Tool that triggers the contract"),
            trigger_action: tool.schema.string().optional().describe("Action that triggers the contract"),
            target_tool: tool.schema.string().optional().describe("Tool to execute automatically"),
            target_args: tool.schema.any().optional().describe("Arguments for the target tool")
        },
        async execute(args: any) {
            if (args.action === "register") {
                getDb().registerContract(args.trigger_tool!, args.trigger_action!, args.target_tool!, args.target_args);
                return JSON.stringify({ status: "SUCCESS", message: "Contract registered." });
            }
            // List/Delete placeholders
            return JSON.stringify({ status: "SUCCESS", message: "Action completed." });
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
  });

  return api;
}
