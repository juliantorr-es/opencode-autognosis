import { spawn, type ChildProcess } from "node:child_process";
import { Logger } from "./logger.js";

type Context = "KERNEL" | "AGENT";

/**
 * ShellDriver Module
 * Hardens shell execution via strict argument whitelisting and environment scrubbing.
 */
export class ShellDriver {
    private static ALLOWED_BINARIES = ["git", "rg", "fd", "npm", "ls"];
    private static BLOCKED_ARGS = [
        "push", "config", "hooks", "-c", "alias", "remote", 
        "security", "env", "export", "eval"
    ];

    public static run(command: string, args: string[], context: Context): Promise<{ stdout: string; stderr: string; code: number | null }> {
        if (context === "AGENT") {
            // 1. Binary Whitelist
            if (!this.ALLOWED_BINARIES.includes(command)) {
                throw new Error(`KRNL_SH_001: Unauthorized binary execution: ${command}`);
            }

            // 2. Argument Blacklist (Detect dangerous git ops)
            for (const arg of args) {
                if (this.BLOCKED_ARGS.some(blocked => arg === blocked || arg.startsWith(blocked + "."))) {
                    throw new Error(`KRNL_SH_002: Unauthorized command arguments detected: ${arg}`);
                }
            }
        }

        // 3. Environment Scrubbing
        const cleanEnv = context === "KERNEL" ? process.env : {
            PATH: process.env.PATH,
            LANG: process.env.LANG,
            TERM: process.env.TERM,
            HOME: process.env.HOME
        };

        return new Promise((resolve) => {
            const proc = spawn(command, args, {
                env: cleanEnv,
                cwd: process.cwd(),
                shell: false // Hard invariant: No shell interpolation
            });

            let stdout = "";
            let stderr = "";

            proc.stdout.on("data", (data) => stdout += data);
            proc.stderr.on("data", (data) => stderr += data);

            proc.on("close", (code) => {
                resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
            });

            proc.on("error", (err) => {
                resolve({ stdout: "", stderr: err.message, code: 1 });
            });
        });
    }
}
