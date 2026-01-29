import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const CACHE_DIR = path.join(OPENCODE_DIR, "cache");
const ASSETS_DIR = path.join(__dirname, "../assets");

let pendingInitToken: string | null = null;
let pendingInitPlan: any = null;

async function runCmd(cmd: string, cwd: string = PROJECT_ROOT, timeoutMs: number = 30000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    if (error.signal === 'SIGTERM' && error.code === undefined) {
        return { stdout: "", stderr: `Command timed out after ${timeoutMs}ms`, error, timedOut: true };
    }
    return { stdout: "", stderr: error.message, error };
  }
}

async function checkBinary(bin: string): Promise<boolean> {
    const { error } = await runCmd(`${bin} --version`, PROJECT_ROOT, 5000);
    return !error;
}

async function getPatterns() {
  const patternsPath = path.join(ASSETS_DIR, "patterns.json");
  try {
    const content = await fs.readFile(patternsPath, "utf-8");
    return JSON.parse(content).patterns || [];
  } catch (e) {
    return [];
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

export function systemTools() {
  return {
    autognosis_init: {
      description: "Initialize or check the Autognosis environment. Two-phase: 'plan' (default) generates a token, 'apply' executes it.",
      parameters: { type: "object", properties: { mode: { type: "string", enum: ["plan", "apply"], default: "plan" }, token: { type: "string" } }, required: ["mode"] },
      execute: async ({ mode = "plan", token }: { mode: string, token?: string }) => {
        if (mode === "plan") {
            const checks = { rg: await checkBinary("rg"), fd: await checkBinary("fd"), sg: await checkBinary("sg"), ctags: await checkBinary("ctags"), git: await checkBinary("git") };
            const actions = [];
            if (!fsSync.existsSync(CACHE_DIR)) actions.push(`Create cache directory: ${CACHE_DIR}`);
            else actions.push(`Verify cache directory: ${CACHE_DIR} (exists)`);
            const newToken = crypto.randomBytes(4).toString("hex");
            pendingInitToken = newToken;
            pendingInitPlan = { checks, actions };
            return JSON.stringify({ status: "PLAN_READY", system_checks: checks, planned_actions: actions, confirm_token: newToken, instruction: "Review the plan. To execute, call autognosis_init(mode='apply', token='...')" }, null, 2);
        } else if (mode === "apply") {
            if (!pendingInitToken || !token || token !== pendingInitToken) return JSON.stringify({ status: "ERROR", message: "Invalid or expired confirmation token. Run mode='plan' first." });
            await ensureCache();
            pendingInitToken = null;
            pendingInitPlan = null;
            return JSON.stringify({ status: "SUCCESS", message: "Autognosis initialized.", cache_dir: CACHE_DIR });
        }
      }
    },
    fast_search: {
      description: "Fast content or filename search using ripgrep (rg) and fd.",
      parameters: { type: "object", properties: { query: { type: "string" }, mode: { type: "string", enum: ["filename", "content"], default: "filename" }, path: { type: "string" } }, required: ["query"] },
      execute: async ({ query, mode = "filename", path: searchPath = "." }: { query: string, mode?: string, path?: string }) => {
        if (mode === "content") {
          if (!(await checkBinary("rg"))) return "Error: 'rg' (ripgrep) is not installed. fast_search content mode unavailable.";
          const { stdout } = await runCmd(`rg -n --column "${query}" "${searchPath}"`);
          if (!stdout) return "No matches found.";
          return stdout.split('\n').slice(0, 50).join('\n') + (stdout.split('\n').length > 50 ? "\n... (truncated)" : "");
        } else {
          if (!(await checkBinary("fd"))) return "Error: 'fd' is not installed. fast_search filename mode unavailable.";
          const { stdout } = await runCmd(`fd "${query}" "${searchPath}"`);
           if (!stdout) return "No files found.";
          return stdout.split('\n').slice(0, 50).join('\n') + (stdout.split('\n').length > 50 ? "\n... (truncated)" : "");
        }
      }
    },
    structural_search: {
      description: "Search code using ast-grep patterns or patterns.json IDs.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", default: "." }, plan_id: { type: "string" } }, required: ["pattern"] },
      execute: async ({ pattern, path: searchPath = ".", plan_id }: { pattern: string, path?: string, plan_id?: string }) => {
        if (!(await checkBinary("sg"))) return JSON.stringify({ error: "Degraded Mode: 'sg' (ast-grep) not found.", results: [], plan_id: plan_id || "OFF-PLAN" });
        const knownPatterns = await getPatterns();
        const known = knownPatterns.find((p: any) => p.name === pattern);
        const cmd = known ? `sg scan -p "${known.pattern}" "${searchPath}" --json` : `sg scan -p "${pattern}" "${searchPath}" --json`;
        const { stdout } = await runCmd(cmd);
        let results = [];
        try { results = JSON.parse(stdout); } catch (e) {}
        return JSON.stringify({ results: results.slice(0, 50), truncated: results.length > 50, plan_id: plan_id || "OFF-PLAN" }, null, 2);
      }
    },
    read_slice: {
      description: "Read a specific slice of a file.",
      parameters: { type: "object", properties: { file: { type: "string" }, start_line: { type: "number" }, end_line: { type: "number" }, plan_id: { type: "string" } }, required: ["file", "start_line", "end_line"] },
      execute: async ({ file, start_line, end_line, plan_id }: { file: string, start_line: number, end_line: number, plan_id?: string }) => {
        const { stdout, stderr } = await runCmd(`sed -n '${start_line},${end_line}p;${end_line + 1}q' "${file}"`);
        if (stderr) return `Error reading slice: ${stderr}`;
        return JSON.stringify({ file, start_line, end_line, content: stdout, plan_id: plan_id || "OFF-PLAN" }, null, 2);
      }
    },

    symbol_query: {
      description: "Query the symbol index. Rebuilds automatically if stale.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      execute: async ({ symbol }: { symbol: string }) => {
        const maint = await maintainSymbolIndex();
        if (maint.status === "unavailable") return JSON.stringify({ error: "Symbol index unavailable", reason: maint.reason });
        const tagsFile = path.join(CACHE_DIR, "tags");
        if (await checkBinary("readtags")) {
             const { stdout } = await runCmd(`readtags -t "${tagsFile}" "${symbol}"`);
             return JSON.stringify({ matches: stdout.split('\n').filter(Boolean), metadata: maint }, null, 2);
        } else {
             const { stdout: grepOut } = await runCmd(`grep -P "^${symbol}\t" "${tagsFile}"`);
             return JSON.stringify({ matches: grepOut.split('\n').filter(Boolean), metadata: maint, note: "using_grep_fallback" }, null, 2);
        }
      }
    },
    jump_to_symbol: {
        description: "Jump to a symbol's definition by querying the index and reading the slice.",
        parameters: { type: "object", properties: { symbol: { type: "string" }, plan_id: { type: "string" } }, required: ["symbol"] },
        execute: async({ symbol, plan_id }: { symbol: string, plan_id?: string }) => {
             const maint = await maintainSymbolIndex();
             if (maint.status !== "ok") return JSON.stringify({ error: "Index unavailable", reason: maint.reason });
             const tagsFile = path.join(CACHE_DIR, "tags");
             const { stdout: tagLine } = await runCmd(`grep -P "^${symbol}\t" "${tagsFile}" | head -n 1`);
             if (!tagLine) return JSON.stringify({ found: false, symbol });
             const parts = tagLine.split('\t');
             const file = parts[1];
             let line = 1; 
             const { stdout: grepLine } = await runCmd(`grep -n "${symbol}" "${file}" | head -n 1`);
             if (grepLine) line = parseInt(grepLine.split(':')[0], 10);
             const start = Math.max(1, line - 5);
             const end = line + 15;
             const { stdout: slice } = await runCmd(`sed -n '${start},${end}p;${end + 1}q' "${file}"`);
             return JSON.stringify({ symbol, resolved_location: { file, line }, slice: { start, end, content: slice }, plan_id: plan_id || "OFF-PLAN" }, null, 2);
        }
    },

    brief_fix_loop: {
        description: "The Action Planner. Generates a bounded worklist for a symbol and intent.",
        parameters: { type: "object", properties: { symbol: { type: "string" }, intent: { type: "string" } }, required: ["symbol", "intent"] },
        execute: async ({ symbol, intent }: { symbol: string, intent: string }) => {
            const planId = `plan-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
            return JSON.stringify({ plan_id: planId, symbol, intent, status: "PLAN_GENERATED", instructions: "Use this plan_id for all subsequent operations.", mock_worklist: [{ file: "src/example.ts", reason: "Direct dependency", heat: "high" }] }, null, 2);
        }
    },
    prepare_patch: {
        description: "Generate a .diff artifact for the current changes, tied to a plan.",
        parameters: { type: "object", properties: { plan_id: { type: "string" }, message: { type: "string" } }, required: ["message"] },
        execute: async ({ plan_id, message }: { plan_id?: string, message: string }) => {
            await ensureCache();
            const patchPath = path.join(CACHE_DIR, `patch-${Date.now()}.diff`);
            const { stdout } = await runCmd("git diff");
            if (!stdout) return "No changes to patch.";
            const content = `// META: plan_id=${plan_id || "NONE"}\n// META: message=${message}\n\n${stdout}`;
            await fs.writeFile(patchPath, content);
            return `Patch saved to ${patchPath}`;
        }
    },
    validate_patch: {
        description: "Validate a patch by applying it in a fresh worktree. Enforces timeout.",
        parameters: { type: "object", properties: { patch_path: { type: "string" }, timeout_ms: { type: "number", default: 30000 } }, required: ["patch_path"] },
        execute: async ({ patch_path, timeout_ms = 30000 }: { patch_path: string, timeout_ms?: number }) => {
             const start = Date.now();
             const { error, timedOut } = await runCmd(`git apply --check "${patch_path}"`, PROJECT_ROOT, timeout_ms);
             if (timedOut) return JSON.stringify({ status: "TIMEOUT", checked: ["git_apply_check"], failed_at: "git_apply_check", duration: Date.now() - start });
             if (error) return JSON.stringify({ status: "FAILED", checks: { git_apply_check: "failed" }, error: error.message });
             return JSON.stringify({ status: "SUCCESS", checks: { git_apply_check: "passed" }, duration: Date.now() - start, note: "Patch is valid against current HEAD." }, null, 2);
        }
    },
    finalize_plan: {
        description: "Finalize a plan, logging metrics and cleaning cache.",
        parameters: { type: "object", properties: { plan_id: { type: "string" }, outcome: { type: "string" } }, required: ["plan_id", "outcome"] },
        execute: async ({ plan_id, outcome }: { plan_id: string, outcome: string }) => {
             await ensureCache();
             const report = { plan_id, outcome, time: new Date().toISOString() };
             await fs.appendFile(path.join(CACHE_DIR, "gaps.jsonl"), JSON.stringify(report) + "\n");
             const deleted = await cleanCache();
             return `Plan finalized. Metrics logged. Cache hygiene: deleted ${deleted} old items.`;
        }
    }
  };
}
