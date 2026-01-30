import chokidar, { FSWatcher } from "chokidar";
import * as path from "node:path";
import { indexFile } from "../performance-optimization.js";
import { Logger } from "./logger.js";

const PROJECT_ROOT = process.cwd();

export class CodeWatcher {
  private watcher: FSWatcher | null = null;
  private queue: string[] = [];
  private isProcessing: boolean = false;

  public start() {
    if (this.watcher) return;

    Logger.log("Watcher", "Starting live codebase watcher...");

    this.watcher = chokidar.watch(PROJECT_ROOT, {
      ignored: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.opencode/**"
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
          stabilityThreshold: 2000,
          pollInterval: 100
      }
    });

    this.watcher
      .on("add", (filePath: string) => this.enqueue(filePath))
      .on("change", (filePath: string) => this.enqueue(filePath))
      .on("unlink", (filePath: string) => this.handleFileDelete(filePath));
  }

  public stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private enqueue(filePath: string) {
    const ext = path.extname(filePath);
    const supportedExts = [".ts", ".js", ".tsx", ".jsx", ".cpp", ".c", ".h", ".hpp", ".swift", ".py", ".go", ".rs"];
    
    if (supportedExts.includes(ext) && !this.queue.includes(filePath)) {
      this.queue.push(filePath);
      this.processQueue();
    }
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    while (this.queue.length > 0) {
      const filePath = this.queue.shift();
      if (!filePath) continue;

      Logger.log("Watcher", `Indexing changed file: ${filePath}`);
      try {
        await indexFile(filePath);
      } catch (e) {
        Logger.log("Watcher", `Failed to index ${filePath}`, e);
      }
      
      // Small cooldown to let the system breathe
      await new Promise(r => setTimeout(r, 100));
    }
    this.isProcessing = false;
  }

  private handleFileDelete(filePath: string) {
    Logger.log("Watcher", `File deleted: ${filePath}`);
    // Optionally clean up index for deleted files
  }
}

export const codeWatcher = new CodeWatcher();