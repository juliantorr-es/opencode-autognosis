import { tool } from "@opencode-ai/plugin";
import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as crypto from "node:crypto";
import { Logger } from "./services/logger.js";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.cwd();
const OPENCODE_DIR = path.join(PROJECT_ROOT, ".opencode");
const WORKTREE_DIR = path.join(OPENCODE_DIR, "worktrees");

// Internal logging
function log(message: string, data?: unknown) {
    Logger.log("GitWorktree", message, data);
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
        return { stdout: "", stderr: error instanceof Error ? error.message : `${error}`, error };
    }
}

async function ensureWorktreeDir() {
    await fs.mkdir(WORKTREE_DIR, { recursive: true });
}

async function getGitState() {
    const { stdout: head } = await runCmd("git rev-parse HEAD");
    const { stdout: branch } = await runCmd("git rev-parse --abbrev-ref HEAD");
    const { stdout: status } = await runCmd("git status --porcelain");
    const { stdout: remotes } = await runCmd("git remote");
    
    return {
        head,
        branch,
        isDirty: status.length > 0,
        statusLines: status.split('\n').filter(Boolean),
        remotes: remotes.split('\n').filter(Boolean),
        isMainBranch: branch === "main" || branch === "master"
    };
}

async function discoverWorktrees() {
    await ensureWorktreeDir();
    try {
        const worktrees = await fs.readdir(WORKTREE_DIR);
        const results = [];
        
        for (const worktree of worktrees) {
            const worktreePath = path.join(WORKTREE_DIR, worktree);
            const stat = await fs.stat(worktreePath);
            if (stat.isDirectory()) {
                const gitDir = path.join(worktreePath, ".git");
                if (fsSync.existsSync(gitDir)) {
                    const { stdout: branch } = await runCmd("git rev-parse --abbrev-ref HEAD", worktreePath);
                    const { stdout: head } = await runCmd("git rev-parse HEAD", worktreePath);
                    const { stdout: status } = await runCmd("git status --porcelain", worktreePath);
                    
                    results.push({
                        name: worktree,
                        path: worktreePath,
                        branch,
                        head,
                        isDirty: status.length > 0,
                        statusLines: status.split('\n').filter(Boolean)
                    });
                }
            }
        }
        
        return results;
    } catch (error) {
        return [];
    }
}

// =============================================================================
// AGENT CONTRACT INTEGRATION
// =============================================================================

const AGENT_USAGE_POLICY = `
AGENT USAGE POLICY:
- Use git.preflight before any repository operations
- Create checkpoints with git.checkpoint_create for clean session starts
- Work in integration branches, never directly on main/master
- Validate all patches before application
- Clean up worktrees after completion to avoid resource leaks
`.trim();

const WORKFLOW_PATTERNS = `
STANDARD WORKFLOW:
1. git.preflight -> Validate repository state
2. git.checkpoint_create -> Create clean starting point
3. Work in feature/integration branch
4. git.validate_patch -> Verify changes before commit
5. Clean up worktrees and finalize
`.trim();

// =============================================================================
// GIT WORKTREE MANAGEMENT TOOLS
// =============================================================================

export function gitWorktreeTools(): { [key: string]: any } {
    return {
        git_preflight: tool({
            description: `Validate repository state and check prerequisites for Git operations. ${AGENT_USAGE_POLICY} Returns comprehensive repository status including branch state, cleanliness, and available worktrees.`,
            args: {
                strict: tool.schema.boolean().optional().default(false).describe("Enable strict validation mode")
            },
            async execute({ strict }) {
                log("Tool call: git_preflight", { strict });
                
                try {
                    const state = await getGitState();
                    const worktrees = await discoverWorktrees();
                    
                    const issues = [];
                    const warnings = [];
                    
                    // Check for dirty working directory
                    if (state.isDirty) {
                        if (strict) {
                            issues.push("Working directory is dirty - commit or stash changes");
                        } else {
                            warnings.push("Working directory is dirty");
                        }
                    }
                    
                    // Check for main branch
                    if (state.isMainBranch && state.isDirty) {
                        issues.push("Never work directly on main/master branch with uncommitted changes");
                    }
                    
                    // Check for worktree conflicts
                    const conflictingWorktrees = worktrees.filter(w => w.branch === state.branch);
                    if (conflictingWorktrees.length > 0) {
                        warnings.push(`Branch '${state.branch}' is checked out in ${conflictingWorktrees.length} worktree(s)`);
                    }
                    
                    // Check for git availability
                    const { error: gitError } = await runCmd("git --version");
                    if (gitError) {
                        issues.push("Git is not available or not in PATH");
                    }
                    
                    const result = {
                        status: issues.length > 0 ? "FAILED" : warnings.length > 0 ? "WARNING" : "OK",
                        repository: {
                            head: state.head,
                            branch: state.branch,
                            isDirty: state.isDirty,
                            isMainBranch: state.isMainBranch,
                            statusLines: state.statusLines,
                            remotes: state.remotes
                        },
                        worktrees: {
                            discovered: worktrees,
                            count: worktrees.length
                        },
                        validation: {
                            issues,
                            warnings,
                            strict
                        },
                        workflow: WORKFLOW_PATTERNS
                    };
                    
                    return JSON.stringify(result, null, 2);
                } catch (error) {
                    return JSON.stringify({
                        status: "ERROR",
                        message: error instanceof Error ? error.message : `${error}`,
                        workflow: WORKFLOW_PATTERNS
                    }, null, 2);
                }
            }
        }),

        git_checkpoint_create: tool({
            description: `Create a clean checkpoint for starting a new work session. ${AGENT_USAGE_POLICY} Creates a deterministic integration branch and optional worktree for isolated work.`,
            args: {
                branch_name: tool.schema.string().optional().describe("Custom branch name (auto-generated if not provided)"),
                create_worktree: tool.schema.boolean().optional().default(true).describe("Create isolated worktree for the branch"),
                message: tool.schema.string().optional().default("Agent checkpoint").describe("Checkpoint commit message")
            },
            async execute({ branch_name, create_worktree, message }) {
                log("Tool call: git_checkpoint_create", { branch_name, create_worktree, message });
                
                try {
                    const state = await getGitState();
                    
                    // Generate branch name if not provided
                    const targetBranch = branch_name || `agent-integration-${Date.now()}`;
                    
                    // Ensure we're on a clean state
                    if (state.isDirty) {
                        return JSON.stringify({
                            status: "ERROR",
                            message: "Cannot create checkpoint from dirty working directory. Commit or stash changes first.",
                            current_state: state
                        }, null, 2);
                    }
                    
                    // Create and checkout new branch
                    const { error: branchError } = await runCmd(`git checkout -b ${targetBranch}`);
                    if (branchError) {
                        return JSON.stringify({
                            status: "ERROR",
                            message: `Failed to create branch: ${branchError instanceof Error ? branchError.message : `${branchError}`}`,
                            current_state: state
                        }, null, 2);
                    }
                    
                    // Create initial commit if needed
                    const { stdout: gitLog } = await runCmd("git log --oneline -1");
                    if (!gitLog || gitLog.includes("Initial commit")) {
                        await runCmd(`git commit --allow-empty -m "${message}"`);
                    }
                    
                    let worktreePath = null;
                    if (create_worktree) {
                        await ensureWorktreeDir();
                        worktreePath = path.join(WORKTREE_DIR, targetBranch.replace(/[^a-zA-Z0-9-_]/g, '-'));
                        
                        // Remove existing worktree if it exists
                        if (fsSync.existsSync(worktreePath)) {
                            const { error: removeError } = await runCmd(`git worktree remove ${worktreePath}`);
                            if (removeError) {
                                log("Warning: Failed to remove existing worktree", removeError);
                            }
                        }
                        
                        // Create new worktree
                        const { error: worktreeError } = await runCmd(`git worktree add ${worktreePath} ${targetBranch}`);
                        if (worktreeError) {
                            return JSON.stringify({
                                status: "WARNING",
                                message: `Branch created but worktree failed: ${worktreeError instanceof Error ? worktreeError.message : `${worktreeError}`}`,
                                checkpoint: {
                                    branch: targetBranch,
                                    head: state.head,
                                    created_at: new Date().toISOString()
                                }
                            }, null, 2);
                        }
                    }
                    
                    const result = {
                        status: "SUCCESS",
                        checkpoint: {
                            branch: targetBranch,
                            head: state.head,
                            created_at: new Date().toISOString(),
                            message
                        },
                        worktree: worktreePath ? {
                            path: worktreePath,
                            branch: targetBranch
                        } : null,
                        next_steps: [
                            `Work in branch: ${targetBranch}`,
                            worktreePath ? `Use worktree: ${worktreePath}` : "Work in main repository",
                            "Validate patches before applying",
                            "Clean up worktree when done"
                        ]
                    };
                    
                    return JSON.stringify(result, null, 2);
                } catch (error) {
                    return JSON.stringify({
                        status: "ERROR",
                        message: error instanceof Error ? error.message : `${error}`
                    }, null, 2);
                }
            }
        }),

        git_worktree_status: tool({
            description: "Discover and report status of all worktrees. Returns detailed information about active worktrees, their branches, and cleanliness.",
            args: {
                include_clean: tool.schema.boolean().optional().default(false).describe("Include clean worktrees in results")
            },
            async execute({ include_clean }) {
                log("Tool call: git_worktree_status", { include_clean });
                
                try {
                    const worktrees = await discoverWorktrees();
                    const state = await getGitState();
                    
                    let filteredWorktrees = worktrees;
                    if (!include_clean) {
                        filteredWorktrees = worktrees.filter(w => w.isDirty || w.branch === state.branch);
                    }
                    
                    const result = {
                        status: "OK",
                        current_repository: {
                            branch: state.branch,
                            head: state.head,
                            isDirty: state.isDirty
                        },
                        worktrees: {
                            total: worktrees.length,
                            filtered: filteredWorktrees.length,
                            active: filteredWorktrees.map(w => ({
                                name: w.name,
                                path: w.path,
                                branch: w.branch,
                                head: w.head,
                                isDirty: w.isDirty,
                                status_summary: `${w.isDirty ? 'DIRTY' : 'CLEAN'} - ${w.branch}`
                            }))
                        },
                        recommendations: [
                            "Clean up unused worktrees to free resources",
                            "Avoid multiple worktrees on the same branch",
                            "Use git.checkpoint_create for new clean workspaces"
                        ]
                    };
                    
                    return JSON.stringify(result, null, 2);
                } catch (error) {
                    return JSON.stringify({
                        status: "ERROR",
                        message: error instanceof Error ? error.message : `${error}`
                    }, null, 2);
                }
            }
        }),

        git_worktree_cleanup: tool({
            description: `Clean up worktrees to free resources. ${AGENT_USAGE_POLICY} Removes specified worktrees after ensuring no uncommitted changes will be lost.`,
            args: {
                worktree_names: tool.schema.array(tool.schema.string()).optional().describe("Specific worktree names to clean up (cleans all if not specified)"),
                force: tool.schema.boolean().optional().default(false).describe("Force cleanup even with uncommitted changes (not recommended)")
            },
            async execute({ worktree_names, force }) {
                log("Tool call: git_worktree_cleanup", { worktree_names, force });
                
                try {
                    const worktrees = await discoverWorktrees();
                    let targetWorktrees = worktrees;
                    
                    if (worktree_names && worktree_names.length > 0) {
                        targetWorktrees = worktrees.filter(w => worktree_names.includes(w.name));
                        if (targetWorktrees.length === 0) {
                            return JSON.stringify({
                                status: "WARNING",
                                message: "No matching worktrees found",
                                requested: worktree_names,
                                available: worktrees.map(w => w.name)
                            }, null, 2);
                        }
                    }
                    
                    const cleanupResults = [];
                    const warnings = [];
                    
                    for (const worktree of targetWorktrees) {
                        if (worktree.isDirty && !force) {
                            warnings.push(`Skipping dirty worktree: ${worktree.name} (${worktree.branch})`);
                            continue;
                        }
                        
                        try {
                            // Remove worktree
                            const { error: removeError } = await runCmd(`git worktree remove ${worktree.path}`);
                            if (removeError) {
                                warnings.push(`Failed to remove ${worktree.name}: ${removeError instanceof Error ? removeError.message : `${removeError}`}`);
                                continue;
                            }
                            
                            // Remove directory if it still exists
                            if (fsSync.existsSync(worktree.path)) {
                                await fs.rm(worktree.path, { recursive: true, force: true });
                            }
                            
                            cleanupResults.push({
                                name: worktree.name,
                                path: worktree.path,
                                branch: worktree.branch,
                                status: "REMOVED"
                            });
                        } catch (error) {
                            warnings.push(`Error cleaning up ${worktree.name}: ${error instanceof Error ? error.message : `${error}`}`);
                        }
                    }
                    
                    const result = {
                        status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
                        cleaned_up: cleanupResults,
                        warnings,
                        summary: {
                            processed: targetWorktrees.length,
                            removed: cleanupResults.length,
                            warnings: warnings.length
                        }
                    };
                    
                    return JSON.stringify(result, null, 2);
                } catch (error) {
                    return JSON.stringify({
                        status: "ERROR",
                        message: error instanceof Error ? error.message : `${error}`
                    }, null, 2);
                }
            }
        })
    };
}