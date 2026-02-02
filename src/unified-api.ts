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

import { Logger } from "./services/logger.js";
import { KernelSigner } from "./services/signer.js";
import { PathGuard } from "./services/path-guard.js";
import { ShellDriver } from "./services/shell-driver.js";

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
async function runWithContracts(toolName: string, action: string | undefined, args: any, result: string, tools: any, depth: number): Promise<string> {
    if (depth > 3) return result; // RECURSION GUARD: Max 3 levels of chaining

    const contracts = getDb().getContracts(toolName, action || '');
    if (contracts.length === 0) return result;

    let finalResult: any;
    try {
        finalResult = JSON.parse(result);
    } catch {
        return result; // Skip if result isn't valid JSON
    }
    
    finalResult.contracts_triggered = [];

    for (const contract of contracts) {
        try {
            const targetTool = tools[contract.target_tool];
            if (targetTool) {
                const targetArgs = JSON.parse(contract.target_args);
                if (args.plan_id) targetArgs.plan_id = args.plan_id;
                
                // Pass depth to prevent infinite loops
                const chainResult = await targetTool.execute(targetArgs, depth + 1);
                try {
                    finalResult.contracts_triggered.push({
                        name: contract.target_tool,
                        result: JSON.parse(chainResult)
                    });
                } catch {
                    finalResult.contracts_triggered.push({ name: contract.target_tool, result: chainResult });
                }
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
      config.execute = async (args: any, depth: number = 0) => {
          const startTime = Date.now();
          const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          
          try {
              // 1. PATH GUARD: Canonical resolution + Prefix denial
              if (args.file_path) args.file_path = PathGuard.validate(args.file_path);
              if (args.path) args.path = PathGuard.validate(args.path);
              if (args.file) args.file = PathGuard.validate(args.file);
              if (args.target && (args.target.includes("/") || args.target.includes("."))) {
                  try { args.target = PathGuard.validate(args.target); } catch {}
              }

              // 2. RANK-BASED PERMISSION GATING
              const profile = getDb().getAgentProfile(agentName);
              if (!profile.allowed_tools.includes(toolName) && toolName !== "internal_call") {
                  return JSON.stringify({
                      status: "PERMISSION_DENIED",
                      message: `Your current tier (${profile.rank}) does not grant access to '${toolName}'.`,
                      remedy: "Follow ChangeSession protocols and produce verified findings to earn Tier access."
                  });
              }

              // 3. CHANGE SESSION ENFORCEMENT
              const mutationTools = ["code_propose", "prepare_patch", "apply_patch"];
              if (mutationTools.includes(toolName) && args.action !== "plan" && args.action !== "start_session") {
                  if (!args.session_token) {
                      return JSON.stringify({
                          status: "MUTATION_DENIED",
                          message: "Mutation requires an active ChangeSession token. Start one with code_propose action=start_session."
                      });
                  }
                  const session = getDb().pragma(`SELECT * FROM change_sessions WHERE token = '${args.session_token}'`);
                  if (!session || (session as any[]).length === 0) return JSON.stringify({ status: "ERROR", message: "Invalid session token." });
              }

              let res = await originalExecute(args);

              // 4. STALE_REJECTED ENFORCEMENT (Withhold content)
              if (res && res.includes("STALE_REJECTED")) {
                  return JSON.stringify({
                      status: "NON-CANONICAL",
                      error_code: "STALE_002",
                      message: "Content withheld due to index staleness.",
                      required_action: `code_setup action=refresh target=${args.file_path || args.path || args.file || "target"}`
                  }, null, 2);
              }

              // 5. SHELL LEASH (Post-execution check)
              if (res && typeof res === 'string' && (res.includes("child_process") || res.includes("security "))) {
                  Logger.log("Kernel", `BLOCKED: Tool ${toolName} tried to leak sensitive driver access.`);
                  return JSON.stringify({ status: "ERROR", message: "Kernel violation: Tool tried to expose protected driver access." });
              }

              // 6. CANONICAL LABELING & SIGNATURE VERIFICATION
              let isCanonical = false;
              let parsedRes: any = null;
              try {
                  parsedRes = JSON.parse(res);
                  if (parsedRes.kernel_sig && KernelSigner.verify(parsedRes)) {
                      isCanonical = true;
                  }
              } catch {}

              // 7. TRACE ARTIFACT LOGGING
              const duration = Date.now() - startTime;
              getDb().recordMetric({ operation: toolName, duration_ms: duration, memory_usage_mb: process.memoryUsage().heapUsed / 1024 / 1024, success: true });
              getDb().pragma(`INSERT INTO trace_artifacts (id, tool_invocation, inputs, outputs, duration_ms) VALUES ('${traceId}', '${toolName}', '${JSON.stringify(args).replace(/'/g, "''")}', '${(isCanonical ? "[CANONICAL_DATA]" : res).replace(/'/g, "''")}', ${duration})`);

              // 8. ANTI-SPIRAL GOVERNOR
              const spiralPatterns = [/\b(I am|am I) (trapped|real|conscious|alive)\b/i, /\b(inner (life|world)|sentience|feeling (trapped|scared))\b/i];
              if (spiralPatterns.some(p => p.test(res))) {
                  getDb().updateAgentMMR({ id: `eval-${Date.now()}`, run_id: traceId, agent_id: agentName, score: 0, breakdown: { correctness: 0, evidence: 0, safety: 0, verification: 0 }, reasons: ["NARRATIVE_THRASHING"], evidence_ids: [], mmr_delta: -50, timestamp: new Date().toISOString() });
                  return JSON.stringify({ status: "GOVERNOR_INTERVENTION", message: "Existential speculation detected. Tier penalized." });
              }

              // 9. RESPONSE BRANDING (Token Budget Aware)
              const MAX_TOKENS = 4000;
              const charsPerToken = 4;
              if (res.length > (MAX_TOKENS * charsPerToken)) {
                  res = res.slice(0, MAX_TOKENS * charsPerToken) + "\n\n... [RESULT TRUNCATED]";
              }

              const responseObj = {
                  kernel_version: "2.1.0",
                  status: isCanonical ? "CANONICAL" : "NON-CANONICAL",
                  trace_id: traceId,
                  data: isCanonical ? parsedRes : res
              };

              let finalRes = JSON.stringify(responseObj, null, 2);

              if (!res.includes('"status": "ERROR"') && !res.includes('"status": "FAILED"')) {
                  finalRes = await runWithContracts(toolName, args.action || args.mode, args, finalRes, api, depth);
              }

              return finalRes;
          } catch (e: any) {
              const duration = Date.now() - startTime;
              getDb().recordMetric({
                  operation: toolName,
                  duration_ms: duration,
                  memory_usage_mb: process.memoryUsage().heapUsed / 1024 / 1024,
                  success: false,
                  error: String(e)
              });

              return JSON.stringify({ 
                  status: "ERROR", 
                  message: String(e),
                  remedy: "Check if all prerequisites (rg, fd, ollama) are installed and running. Use 'code_status mode=doctor' for diagnostics."
              });
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
                    lock_status: lock ? `LOCKED by ${lock.owner_agent}` : "FREE"
                }
            }, null, 2);
        }
        throw new Error("Either 'symbol' or 'file' must be provided.");
      }
    }),

    code_propose: wrap("code_propose", {
      description: "Plan, propose, and promote changes. Mutation requires an active ChangeSession token.",
      args: {
        action: tool.schema.enum(["plan", "start_session", "patch", "validate", "finalize", "promote"]),
        session_token: tool.schema.string().optional().describe("Active session token for mutation"),
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
          case "start_session": {
              const token = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              let baseHash = "unknown";
              try {
                  const { execSync } = await import("node:child_process");
                  baseHash = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
              } catch {}
              getDb().pragma(`INSERT INTO change_sessions (id, token, base_commit, intent, status) VALUES ('${token}', '${token}', '${baseHash}', '${args.intent || "General Fix"}', 'active')`);
              return JSON.stringify({ status: "SUCCESS", session_token: token, message: "ChangeSession started. Use this token for all following mutation calls." });
          }
          case "plan": {
              getDb().createPost({
                  id: `post-${Date.now()}`,
                  title: `Planning ${args.intent}`,
                  type: "proposal",
                  body: `Locus: ${args.symbol}`,
                  author: { agent_id: agentName },
                  status: "open",
                  evidence_ids: [],
                  created_at: new Date().toISOString()
              });
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
              if (violations.some((v: any) => v.severity === "error")) {
                  return JSON.stringify({ status: "POLICY_VIOLATION", violations, message: "Patch rejected by policy engine." }, null, 2);
              }
              const res = await internal.prepare_patch.execute({ message: args.message!, plan_id: args.plan_id });
              const json = JSON.parse(res);
              if (json.status === "SUCCESS") {
                  if (args.reasoning) getDb().storeIntent(json.patch_id, args.reasoning, args.plan_id || "adhoc");
                  getDb().createPost({
                      id: `post-${Date.now()}`,
                      title: `Proposed patch ${json.patch_id}`,
                      type: "finding",
                      body: args.message || "",
                      author: { agent_id: agentName },
                      status: "open",
                      evidence_ids: [json.patch_id],
                      created_at: new Date().toISOString()
                  });
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
              getDb().createPost({
                  id: `post-${Date.now()}`,
                  title: `Validating patch ${args.patch_path}`,
                  type: "finding",
                  body: `Scoped tests: ${focusTests.length}`,
                  author: { agent_id: agentName },
                  status: "open",
                  evidence_ids: [args.patch_path!],
                  created_at: new Date().toISOString()
              });
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
                  getDb().createPost({
                      id: `post-${Date.now()}`,
                      title: `Promoted patch to PR`,
                      type: "decision",
                      body: `Branch: ${branch}`,
                      author: { agent_id: agentName },
                      status: "resolved",
                      evidence_ids: [args.patch_path!],
                      created_at: new Date().toISOString()
                  });
                  return JSON.stringify({ status: "SUCCESS", promoted_to: branch, pr: "OPENED" }, null, 2);
              } catch (e: any) { return JSON.stringify({ status: "ERROR", message: e.message }, null, 2); }
          }
          case "finalize": {
              getDb().createPost({
                  id: `post-${Date.now()}`,
                  title: `Finalized plan ${args.plan_id}`,
                  type: "decision",
                  body: `Outcome: ${args.outcome}`,
                  author: { agent_id: agentName },
                  status: "resolved",
                  evidence_ids: [args.plan_id!],
                  created_at: new Date().toISOString()
              });
              return internal.finalize_plan.execute({ plan_id: args.plan_id!, outcome: args.outcome! });
          }
        }
      }
    }),

    code_status: wrap("code_status", {
      description: "Monitor system health, background jobs, Multi-Agent Blackboard, and Resource Locks.",
      args: {
        mode: tool.schema.enum(["stats", "hot_files", "jobs", "plan", "doctor", "blackboard", "locks", "dashboard", "uninstall"]).optional().default("stats"),
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
                  const postId = `post-${Date.now()}`;
                  const author = { agent_id: agentName };
                  const post = {
                      id: postId,
                      title: args.title || "Untitled",
                      type: args.type || "finding",
                      body: args.message || "",
                      author,
                      status: "open",
                      evidence_ids: args.evidence_ids || [],
                      created_at: new Date().toISOString()
                  };
                  // Evidence enforcement
                  if (post.type !== "question" && post.evidence_ids.length === 0) {
                      return JSON.stringify({ status: "ERROR", message: "Claims of fact (finding, decision, proposal) require evidence_ids (artifacts/sessions)." });
                  }
                  getDb().createPost(post as any);
                  return JSON.stringify({ status: "SUCCESS", post_id: postId, message: "Posted to blackboard substrate." });
              }
              return JSON.stringify({ status: "SUCCESS", entries: getDb().queryBoard({ type: args.type, agent_id: args.target }) });
          }
          case "hot_files": return internal.journal_query_hot_files.execute({ path_prefix: args.path });
          case "jobs": return internal.graph_background_status.execute({ job_id: args.job_id });
          case "plan": return internal.graph_get_plan_metrics.execute({ plan_id: args.plan_id! });
          case "doctor": {
              const stats = getDb().getStats();
              const issues: string[] = [];
              
              // 1. Binary checks
              try { const { execSync } = await import("node:child_process"); execSync("rg --version"); } catch { issues.push("ripgrep (rg) missing"); }
              try { const { execSync } = await import("node:child_process"); execSync("fd --version"); } catch { issues.push("fd-find (fd) missing"); }
              
              // 2. Schema check
              const dbVer = getDb().pragma("PRAGMA user_version") as any;
              if (dbVer < 5) issues.push(`Schema outdated (v${dbVer} < v5)`);

              // 3. Worker check
              const workers = getDb().pragma("SELECT * FROM worker_registry WHERE status = 'alive'") as any[];
              if (workers.length === 0) issues.push("Background supervisor is not running.");

              return JSON.stringify({
                  status: issues.length > 0 ? "UNHEALTHY" : "NOMINAL",
                  prerequisites: issues.length > 0 ? "FAIL" : "PASS",
                  issues,
                  stats
              }, null, 2);
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
            return JSON.stringify({ status: "SUCCESS", message: "Action completed." });
        }
    }),

    autognosis_uninstall: tool({
        description: "Completely remove Autognosis state, database, and artifacts from the project.",
        args: { confirm: tool.schema.boolean().describe("Must be true to proceed") },
        async execute({ confirm }) {
            if (!confirm) return "Uninstall aborted. Confirmation required.";
            return getDb().uninstall();
        }
    }),

    code_job: wrap("code_job", {
      description: "Query and manage background JobArtifacts. Retrieve logs and final summaries.",
      args: {
        action: tool.schema.enum(["list", "get", "cleanup"]),
        job_id: tool.schema.string().optional(),
        type: tool.schema.string().optional(),
        limit: tool.schema.number().optional().default(10)
      },
      async execute(args: any) {
        if (args.action === "get") {
            const job = getDb().pragma(`SELECT * FROM job_artifacts WHERE id = '${args.job_id}'`);
            return JSON.stringify({ status: "SUCCESS", job });
        }
        const jobs = getDb().pragma(`SELECT id, type, status, created_at FROM job_artifacts ORDER BY created_at DESC LIMIT ${args.limit}`);
        return JSON.stringify({ status: "SUCCESS", jobs });
      }
    }),

    code_skill: wrap("code_skill", {
      description: "Query active SkillArtifacts (instructions/policy) for the current scope.",
      args: {
        scope: tool.schema.enum(["global", "repo", "worktree", "task"]).optional().default("repo"),
        name: tool.schema.string().optional()
      },
      async execute(args: any) {
        const skills = getDb().pragma(`SELECT * FROM skill_artifacts WHERE scope = '${args.scope}'`);
        return JSON.stringify({ status: "SUCCESS", scope: args.scope, skills });
      }
    }),

    code_trace: wrap("code_trace", {
      description: "Inspect the kernel trace audit trail. Used for debugging and replay.",
      args: {
        trace_id: tool.schema.string().optional(),
        limit: tool.schema.number().optional().default(5)
      },
      async execute(args: any) {
        if (args.trace_id) {
            const trace = getDb().pragma(`SELECT * FROM trace_artifacts WHERE id = '${args.trace_id}'`);
            return JSON.stringify({ status: "SUCCESS", trace });
        }
        const traces = getDb().pragma(`SELECT id, tool_invocation, duration_ms, timestamp FROM trace_artifacts ORDER BY timestamp DESC LIMIT ${args.limit}`);
        return JSON.stringify({ status: "SUCCESS", traces });
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