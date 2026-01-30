import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "./logger.js";

const execAsync = promisify(exec);

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export class OllamaService {
  
  async isInstalled(): Promise<boolean> {
    try {
      await execAsync("which ollama");
      return true;
    } catch {
      return false;
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${OLLAMA_BASE_URL}/api/version`, { signal: controller.signal });
      clearTimeout(timeoutId);
      return res.ok;
    } catch {
      return false;
    }
  }

  async install(): Promise<string> {
    const platform = process.platform;
    try {
      if (platform === "darwin") {
        // Try Homebrew first
        try {
          await execAsync("which brew");
          await execAsync("brew install ollama");
          return "Installed via Homebrew";
        } catch {
          // Fallback to script
          await execAsync("curl -fsSL https://ollama.com/install.sh | sh");
          return "Installed via official script";
        }
      } else if (platform === "linux") {
        await execAsync("curl -fsSL https://ollama.com/install.sh | sh");
        return "Installed via official script";
      } else {
        throw new Error("Automatic installation only supported on macOS and Linux. Please install Ollama manually.");
      }
    } catch (error: any) {
      throw new Error(`Installation failed: ${error.message}`);
    }
  }

  async startServer(): Promise<void> {
    if (await this.isRunning()) return;

    // Start in background
    const logFile = fs.openSync(path.join(process.cwd(), ".opencode", "ollama.log"), "a");
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: ["ignore", logFile, logFile]
    });
    child.unref();

    // Wait for it to come up
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 1000));
      if (await this.isRunning()) return;
      attempts++;
    }
    throw new Error("Ollama server failed to start within 10 seconds");
  }

  async pullModel(model: string = DEFAULT_EMBEDDING_MODEL): Promise<void> {
    // Check if exists
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      const data: any = await res.json();
      const models = data.models || [];
      if (models.some((m: any) => m.name.includes(model))) {
        return; // Already exists
      }
    } catch {}

    // Pull model (this blocks, usually handled via CLI)
    // We'll use the API to pull so we can await it
    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: "POST",
      body: JSON.stringify({ name: model }),
    });
    
    if (!res.ok) throw new Error(`Failed to pull model ${model}`);
    
    // Read stream to completion to ensure it's done
    const reader = res.body?.getReader();
    if (reader) {
        while (true) {
            const { done } = await reader.read();
            if (done) break;
        }
    }
  }

  async getEmbedding(text: string, model: string = DEFAULT_EMBEDDING_MODEL): Promise<number[]> {
    if (!text || !text.trim()) return [];

    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
        method: "POST",
        body: JSON.stringify({
          model,
          prompt: text
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama API error: ${res.status} ${errText}`);
      }

      const data: any = await res.json();
      return data.embedding;
    } catch (error) {
      Logger.log("Ollama", "Embedding failed", error);
      return [];
    }
  }
}

export const ollama = new OllamaService();
