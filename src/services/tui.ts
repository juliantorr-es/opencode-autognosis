interface TUITask {
  type: 'progress' | 'success' | 'error';
  title: string;
  message: string;
  progress?: number;
  execute: () => Promise<void>;
}

export class TUIService {
  private client: any;
  private lastUpdate: number = 0;
  private readonly THROTTLE_MS = 800; // Increased cooldown for higher stability
  private queue: TUITask[] = [];
  private isProcessing: boolean = false;
  private readonly MAX_QUEUE_SIZE = 50;

  setClient(client: any) {
    this.client = client;
  }

  stop() {
    this.queue = [];
    this.client = null;
  }

  /**
   * Enqueue a TUI update with intelligent squashing and capacity limits.
   */
  private async enqueue(task: TUITask) {
    if (!this.client || !this.client.tui) return;

    // 1. Capacity Guard: Prevent memory bloat if TUI is stuck
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      // If we are at capacity, drop the oldest progress update to make room
      const firstProgressIndex = this.queue.findIndex(t => t.type === 'progress');
      if (firstProgressIndex !== -1) {
        this.queue.splice(firstProgressIndex, 1);
      } else {
        // If no progress to drop, just don't add more (protects success/error)
        return;
      }
    }

    // 2. Squash Logic: If there is already a pending progress update for this same title,
    // replace it with the latest one instead of queuing multiple.
    if (task.type === 'progress') {
      const existingIndex = this.queue.findIndex(t => t.type === 'progress' && t.title === task.title);
      if (existingIndex !== -1) {
        this.queue[existingIndex] = task;
        return;
      }
    }

    this.queue.push(task);
    this.processQueue().catch(() => {});
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      if (!this.client || !this.client.tui) {
          this.queue = [];
          break;
      }

      const task = this.queue.shift();
      if (!task) continue;

      const now = Date.now();
      const wait = Math.max(0, this.THROTTLE_MS - (now - this.lastUpdate));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      try {
        // Final safety check: Give the TUI state machine time to settle
        await new Promise(r => setTimeout(r, 100));
        await task.execute();
        this.lastUpdate = Date.now();
      } catch (e: any) {
        const msg = e.message || String(e);
        if (msg.includes("destroyed") || msg.includes("invalid channel") || msg.includes("closed")) {
            this.queue = [];
            this.client = null; // Invalidate stale client
            break;
        }
      }
    }

    this.isProcessing = false;
  }

  async showProgress(title: string, progress: number, message: string) {
    await this.enqueue({
      type: 'progress',
      title,
      message,
      progress,
      execute: async () => {
        if (this.client?.tui) {
          await this.client.tui.showToast({
            id: `progress-${title.replace(/[^a-zA-Z0-9]/g, '-')}`,
            data: {
              id: `progress-${title.replace(/[^a-zA-Z0-9]/g, '-')}`,
              title: `[${progress}%] ${title}`,
              message,
              variant: "info"
            }
          });
        }
      }
    });
  }

  async showSuccess(title: string, message: string) {
    await this.enqueue({
      type: 'success',
      title,
      message,
      execute: async () => {
        if (this.client?.tui) {
          await this.client.tui.showToast({
            id: `success-${Date.now()}`,
            data: { 
              id: `success-${Date.now()}`,
              title, 
              message, 
              variant: "success" 
            }
          });
        }
      }
    });
  }

  async showError(title: string, message: string) {
    await this.enqueue({
      type: 'error',
      title,
      message,
      execute: async () => {
        if (this.client?.tui) {
          await this.client.tui.showToast({
            id: `error-${Date.now()}`,
            data: { 
              id: `error-${Date.now()}`,
              title, 
              message, 
              variant: "error" 
            }
          });
        }
      }
    });
  }
}

export const tui = new TUIService();
