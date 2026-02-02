import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "./logger.js";

const PROJECT_ROOT = process.cwd();
const KEY_PATH = path.join(PROJECT_ROOT, ".opencode", "kernel.key");

/**
 * Kernel Signer Module
 * Handles HMAC-SHA256 signing and verification for canonical artifacts.
 */
export class KernelSigner {
    private static key: Buffer | null = null;

    private static initialize() {
        if (this.key) return;
        
        if (!fs.existsSync(path.dirname(KEY_PATH))) {
            fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
        }

        if (!fs.existsSync(KEY_PATH)) {
            const newKey = crypto.randomBytes(32);
            fs.writeFileSync(KEY_PATH, newKey, { mode: 0o600 });
            Logger.log("Kernel", "Generated new HMAC signing key.");
        }

        this.key = fs.readFileSync(KEY_PATH);
    }

    public static sign(artifact: any): string {
        this.initialize();
        
        // KERNEL INVARIANT: Only sign kernel-controlled fields to prevent forgery of agent blobs
        const canonicalFields = {
            id: artifact.id,
            schema_version: artifact.schema_version || "2.1.0",
            agent_id: artifact.provenance?.agent_id || artifact.author?.agent_id,
            timestamp: artifact.metadata?.created_at || artifact.created_at,
            content_hash: artifact.metadata?.hash || artifact.hash
        };

        const hmac = crypto.createHmac("sha256", this.key!);
        hmac.update(JSON.stringify(canonicalFields));
        return hmac.digest("hex");
    }

    public static verify(artifact: any): boolean {
        this.initialize();
        if (!artifact.kernel_sig) return false;
        
        const expected = this.sign(artifact);
        return crypto.timingSafeEqual(Buffer.from(artifact.kernel_sig), Buffer.from(expected));
    }
}
