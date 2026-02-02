import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Logger } from "./logger.js";

/**
 * Atomic write: Write to temp file -> fsync -> rename
 * Ensures artifacts are never partially written or corrupted on crash.
 */
export async function safeWriteArtifact(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(tempPath, content, "utf-8");
        
        // Ensure data is flushed to disk
        const fileHandle = await fs.open(tempPath, "r+");
        await fileHandle.sync();
        await fileHandle.close();

        // Atomic rename
        await fs.rename(tempPath, filePath);
    } catch (error) {
        Logger.log("FS-Utils", `Failed to write artifact: ${filePath}`, error);
        // Clean up temp file if it exists
        try { await fs.unlink(tempPath); } catch {}
        throw error;
    }
}
