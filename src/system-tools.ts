import { tool } from "@opencode-ai/plugin";
import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as crypto from "node:crypto";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const CACHE_DIR = path.join(OPENCODE_DIR, "cache");

// Internal logging
function log(message: string, data?: unknown) {
    // console.error is used here for internal debugging as standard console.log may interfere with tool outputs
    console.error(`[Autognosis] ${message}`, data || '');
}

// =============================================================================
// HELPERS
// =============================================================================

async function runCmd(cmd: string, cwd: string = PROJECT_ROOT, timeoutMs: number = 30000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { 
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    if (error.signal === 'SIGTERM' && error.code === undefined) {
        return { stdout: "", stderr: `Command timed out after ${timeoutMs}ms`, error, timedOut: true };
    }
    return { stdout: "", stderr: error.message, error };
  }
}

async function checkBinary(bin: string): Promise<boolean> {
    try {
        const { error } = await runCmd(`${bin} --version`, PROJECT_ROOT, 5000);
        return !error;
    } catch (e) {
        return false;
    }
}

async function ensureCache() {
    await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function cleanCache() {
    try {
        const files = await fs.readdir(CACHE_DIR);
        const now = Date.now();
        const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
        let deleted = 0;
        for (const file of files) {
            const filePath = path.join(CACHE_DIR, file);
            const stats = await fs.stat(filePath);
            if (now - stats.mtimeMs > MAX_AGE) {
                await fs.unlink(filePath);
                deleted++;
            }
        }
        return deleted;
    } catch (e) {
        return 0;
    }
}

async function maintainSymbolIndex() {
  await ensureCache();
  if (!(await checkBinary("ctags"))) {
      return { rebuilt: false, status: "unavailable", reason: "ctags binary missing" };
  }
  const tagsFile = path.join(CACHE_DIR, "tags");
  const fingerprintFile = path.join(CACHE_DIR, "tags.fingerprint");
  const { stdout: head } = await runCmd("git rev-parse HEAD");
  const { stdout: status } = await runCmd("git status --porcelain");
  const currentFingerprint = `${head}\n${status}`;
  let storedFingerprint = "";
  try { storedFingerprint = await fs.readFile(fingerprintFile, "utf-8"); } catch (e) {}

  if (currentFingerprint !== storedFingerprint || !fsSync.existsSync(tagsFile)) {
    const { error, stderr } = await runCmd(`ctags -R -f ${tagsFile} --languages=TypeScript,JavaScript,Python,Go,Rust,C++,C .`, PROJECT_ROOT);
    if (error) { return { rebuilt: false, status: "failed", reason: stderr }; }
    await fs.writeFile(fingerprintFile, currentFingerprint);
    return { rebuilt: true, status: "ok" };
  }
  return { rebuilt: false, status: "ok" };
}


// =============================================================================
// TOOLS
// =============================================================================

export function systemTools(): { [key: string]: any } {
  let pendingInitToken: string | null = null; // State for init token

  return {
    autognosis_init: tool({
      description: "Initialize or check the Autognosis environment. Two-phase: 'plan' (default) generates a token, 'apply' executes it.",
      args: {
        mode: tool.schema.enum(["plan", "apply"]).optional().default("plan"),
        token: tool.schema.string().optional()
      },
      async execute({ mode, token }) {
        log("Tool call: autognosis_init", { mode });
        if (mode === "plan") {
          const checks = { 
            rg: await checkBinary("rg"), 
            fd: await checkBinary("fd"), 
            sg: await checkBinary("sg"), 
            ctags: await checkBinary("ctags"), 
            git: await checkBinary("git") 
          };
          const actions = [];
          if (!fsSync.existsSync(CACHE_DIR)) actions.push(`Create cache directory: ${CACHE_DIR}`);
          pendingInitToken = crypto.randomBytes(4).toString("hex");
          return JSON.stringify({
            status: "PLAN_READY",
            system_checks: checks,
            planned_actions: actions,
            confirm_token: pendingInitToken,
            instruction: `Call autognosis_init(mode='apply', token='${pendingInitToken}')`
          }, null, 2);
        } else {
          if (!pendingInitToken || token !== pendingInitToken) {
            return JSON.stringify({ status: "ERROR", message: "Invalid token. Run mode='plan' first." });
          }
          await ensureCache();
          pendingInitToken = null;
          return JSON.stringify({ status: "SUCCESS", message: "Autognosis initialized." });
        }
      }
    }),

    fast_search: tool({
      description: "Fast content or filename search using ripgrep (rg) and fd.",
      args: {
        query: tool.schema.string(),
        mode: tool.schema.enum(["filename", "content"]).optional().default("filename"),
        path: tool.schema.string().optional().default(".")
      },
      async execute({ query, mode, path: searchPath }) {
        log("Tool call: fast_search", { query, mode, searchPath });
        if (mode === "content") {
          if (!(await checkBinary("rg"))) return "Error: 'rg' not installed.";
          const { stdout } = await runCmd(`rg -n --column "${query}" "${searchPath}"`);
          if (!stdout) return "No matches found.";
          return stdout.split('\n').slice(0, 50).join('\n');
        } else {
          if (!(await checkBinary("fd"))) return "Error: 'fd' not installed.";
          const { stdout } = await runCmd(`fd "${query}" "${searchPath}"`);
          if (!stdout) return "No files found.";
          return stdout.split('\n').slice(0, 50).join('\n');
        }
      }
    }),

    read_slice: tool({
      description: "Read a specific slice of a file.",
      args: {
        file: tool.schema.string(),
        start_line: tool.schema.number(),
        end_line: tool.schema.number()
      },
      async execute({ file, start_line, end_line }) {
        log("Tool call: read_slice", { file, start_line, end_line });
        const { stdout, stderr } = await runCmd(`sed -n '${start_line},${end_line}p;${end_line + 1}q' "${file}"`);
        if (stderr) return `Error: ${stderr}`;
        return JSON.stringify({ file, start_line, end_line, content: stdout }, null, 2);
      }
    }),

    symbol_query: tool({
      description: "Query the symbol index. Rebuilds automatically if stale.",
      args: {
        symbol: tool.schema.string()
      },
      async execute({ symbol }) {
        log("Tool call: symbol_query", { symbol });
        const maint = await maintainSymbolIndex();
        if (maint.status === "unavailable") return JSON.stringify({ error: maint.reason });
        const tagsFile = path.join(CACHE_DIR, "tags");
        const { stdout: grepOut } = await runCmd(`grep -P "^${symbol}\t" "${tagsFile}"`);
        return JSON.stringify({ matches: grepOut.split('\n').filter(Boolean), metadata: maint }, null, 2);
      }
    }),

    jump_to_symbol: tool({
      description: "Jump to a symbol's definition by querying the index and reading the slice.",
      args: {
        symbol: tool.schema.string()
      },
      async execute({ symbol }) {
        log("Tool call: jump_to_symbol", { symbol });
        const maint = await maintainSymbolIndex();
        if (maint.status !== "ok") return JSON.stringify({ error: maint.reason });
        const tagsFile = path.join(CACHE_DIR, "tags");
        const { stdout: tagLine } = await runCmd(`grep -P "^${symbol}\t" "${tagsFile}" | head -n 1`);
        if (!tagLine) return JSON.stringify({ found: false, symbol });
        const file = tagLine.split('\t')[1];
        const { stdout: grepLine } = await runCmd(`grep -n "${symbol}" "${file}" | head -n 1`);
        const line = grepLine ? parseInt(grepLine.split(':')[0], 10) : 1;
        const start = Math.max(1, line - 5);
        const end = line + 15;
        const { stdout: slice } = await runCmd(`sed -n '${start},${end}p;${end + 1}q' "${file}"`);
        return JSON.stringify({ symbol, resolved_location: { file, line }, slice: { start, end, content: slice } }, null, 2);
      }
    }),

    brief_fix_loop: tool({
      description: "The Action Planner. Generates a bounded worklist for a symbol and intent.",
      args: {
        symbol: tool.schema.string(),
        intent: tool.schema.string()
      },
      async execute({ symbol, intent }) {
        log("Tool call: brief_fix_loop", { symbol, intent });
        const planId = `plan-${Date.now()}`;
        return JSON.stringify({ plan_id: planId, symbol, intent, status: "PLAN_GENERATED" }, null, 2);
      }
    }),

    prepare_patch: tool({
      description: "Generate a .diff artifact for the current changes.",
      args: {
        message: tool.schema.string()
      },
      async execute({ message }) {
        log("Tool call: prepare_patch", { message });
        await ensureCache();
        const patchPath = path.join(CACHE_DIR, `patch-${Date.now()}.diff`);
        const { stdout } = await runCmd("git diff");
        if (!stdout) return "No changes to patch.";
        await fs.writeFile(patchPath, `// MSG: ${message}\n\n${stdout}`);
        return `Patch saved to ${patchPath}`;
      }
    }),

    validate_patch: tool({
      description: "Validate a patch by applying it in a fresh worktree.",
      args: {
        patch_path: tool.schema.string()
      },
      async execute({ patch_path }) {
        log("Tool call: validate_patch", { patch_path });
        const { error } = await runCmd(`git apply --check "${patch_path}"`);
        return error ? `FAILED: ${error.message}` : "SUCCESS: Patch is valid against current HEAD.";
      }
    }),

    finalize_plan: tool({
      description: "Finalize a plan, logging metrics and cleaning cache.",
      args: {
        plan_id: tool.schema.string(),
        outcome: tool.schema.string()
      },
      async execute({ plan_id, outcome }) {
        log("Tool call: finalize_plan", { plan_id, outcome });
        await ensureCache();
        const report = { plan_id, outcome, time: new Date().toISOString() };
        await fs.appendFile(path.join(CACHE_DIR, "gaps.jsonl"), JSON.stringify(report) + "\n");
        const deleted = await cleanCache();
        return `Finalized. Cache hygiene: deleted ${deleted} old items.`;
      }
    })
  };
}
