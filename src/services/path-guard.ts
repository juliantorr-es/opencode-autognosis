import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = process.cwd();
const FORBIDDEN_NAMES = [".git", ".opencode", ".env", "node_modules"];

/**
 * PathGuard Module
 * Enforces canonical repo boundaries and blocks access to sensitive roots.
 */
export class PathGuard {
    private static forbiddenAbsoluteRoots: string[] = FORBIDDEN_NAMES.map(n => path.join(REPO_ROOT, n));

    /**
     * Resolves and validates a path. Throws if unauthorized.
     */
    public static validate(inputPath: string): string {
        const resolved = path.resolve(REPO_ROOT, inputPath);
        
        // 1. Symlink-safe resolution
        let canonical: string;
        try {
            canonical = fs.realpathSync(resolved);
        } catch (e) {
            // If file doesn't exist, check parent directory
            const parent = path.dirname(resolved);
            canonical = path.join(fs.realpathSync(parent), path.basename(resolved));
        }

        // 2. Invariant: Must be inside REPO_ROOT
        if (!canonical.startsWith(REPO_ROOT)) {
            throw new Error(`KRNL_PATH_001: Access denied. Path is outside repository root: ${canonical}`);
        }

        // 3. Invariant: Must not be a forbidden internal root
        for (const root of this.forbiddenAbsoluteRoots) {
            if (canonical === root || canonical.startsWith(root + path.sep)) {
                throw new Error(`KRNL_PATH_002: Access denied. Path is a protected kernel root: ${canonical}`);
            }
        }

        return canonical;
    }
}
