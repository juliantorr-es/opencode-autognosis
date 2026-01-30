import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ROOT = process.cwd();
const LOG_DIR = path.join(PROJECT_ROOT, ".opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "autognosis.log");

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  // Ignore error if we can't create directory (e.g. read-only fs)
}

export class Logger {
  private static formatMessage(module: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    let dataStr = "";
    if (data) {
      try {
        dataStr = typeof data === "string" ? data : JSON.stringify(data);
      } catch {
        dataStr = "[Circular/Unserializable]";
      }
    }
    return `[${timestamp}] [${module}] ${message} ${dataStr}\n`;
  }

  static log(module: string, message: string, data?: unknown) {
    const line = this.formatMessage(module, message, data);
    
    try {
      // Append to log file synchronously to ensure write
      fs.appendFileSync(LOG_FILE, line);
    } catch (e) {
      // Fallback: strictly avoid console.log/error to prevent TUI breakage.
      // We essentially swallow the log if file write fails.
    }
  }
}
