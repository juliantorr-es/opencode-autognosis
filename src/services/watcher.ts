import chokidar, { FSWatcher } from "chokidar";
import * as path from "node:path";
import { indexFile } from "../performance-optimization.js";
import { Logger } from "./logger.js";

const PROJECT_ROOT = process.cwd();

export class CodeWatcher {
  private watcher: FSWatcher | null = null;

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
      ignoreInitial: true
    });

    this.watcher
      .on("add", (filePath: string) => this.handleFileChange("added", filePath))
      .on("change", (filePath: string) => this.handleFileChange("changed", filePath))
      .on("unlink", (filePath: string) => this.handleFileDelete(filePath));
  }

  public stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private async handleFileChange(event: string, filePath: string) {
    const ext = path.extname(filePath);
    const supportedExts = [".ts", ".js", ".tsx", ".jsx", ".cpp", ".c", ".h", ".hpp", ".swift", ".py", ".go", ".rs"];
    
    if (supportedExts.includes(ext)) {
      Logger.log("Watcher", `File ${event}: ${filePath}`);
      try {
        await indexFile(filePath);
      } catch (e) {
        Logger.log("Watcher", `Failed to index ${filePath}`, e);
      }
    }
  }

  private handleFileDelete(filePath: string) {
    Logger.log("Watcher", `File deleted: ${filePath}`);
  }
}

export const codeWatcher = new CodeWatcher();
