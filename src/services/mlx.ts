import {
  exec
} from "node:child_process";
import {
  promisify
} from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "./logger.js";

const execAsync = promisify(exec);

export const DEFAULT_MLX_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

export class MLXService {
  private isAvailable: boolean | null = null;

  async checkAvailability(): Promise<boolean> {
    if (this.isAvailable !== null) return this.isAvailable;
    try {
      await execAsync('python3 -c "import mlx.core; import sentence_transformers"');
      this.isAvailable = true;
    } catch {
      this.isAvailable = false;
    }
    return this.isAvailable;
  }

  async setup(): Promise<string> {
    try {
      Logger.log("MLX", "Setting up MLX dependencies...");
      await execAsync("pip3 install mlx sentence-transformers huggingface_hub");
      this.isAvailable = true;
      return "MLX and sentence-transformers installed successfully.";
    } catch (error: any) {
      throw new Error(`MLX setup failed: ${error.message}`);
    }
  }

  async getEmbedding(text: string, model: string = DEFAULT_MLX_MODEL): Promise<number[]> {
    if (!text || !text.trim()) return [];

    // Escape text for python string
    const escapedText = text.replace(/"/g, '\\"').replace(/\n/g, ' ');
    
    // MLX optimized sentence-transformers execution
    const pyScript = "\nimport mlx.core as mx\nfrom sentence_transformers import SentenceTransformer\nimport json\nimport sys\n\ntry:\n    model = SentenceTransformer(\"${model}\")\n    # Move to GPU if available (MLX default)\n    embeddings = model.encode([\"${escapedText}\"])\n    print(json.dumps(embeddings[0].tolist()))\nexcept Exception as e:\n    print(json.dumps({\"error\": str(e)}))\n    sys.exit(1)\n";

    try {
      const { stdout } = await execAsync(`python3 -c '${pyScript}'`);
      const result = JSON.parse(stdout);
      if (result.error) throw new Error(result.error);
      return result;
    } catch (error: any) {
      Logger.log("MLX", "Embedding failed", error);
      return [];
    }
  }
}

export const mlxService = new MLXService();
