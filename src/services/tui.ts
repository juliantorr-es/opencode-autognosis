export class TUIService {
  private client: any;
  private lastUpdate: number = 0;
  private readonly THROTTLE_MS = 800; // Increased cooldown for higher stability
  private queue: Array<() => Promise<void>> = [];
  private isProcessing: boolean = false;

  setClient(client: any) {
    this.client = client;
  }

  /**
   * Enqueue a TUI update to ensure sequential, throttled execution.
   */
  private async enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    // Don't await the queue processing to keep the tool execution fast
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
        await task();
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
    if (!this.client || !this.client.tui) return;

    this.enqueue(async () => {
      if (this.client?.tui) {
        await this.client.tui.showToast({
          body: {
            title: `[${progress}%] ${title}`,
            message,
            variant: "info"
          }
        });
      }
    });
  }

  async showSuccess(title: string, message: string) {
    if (!this.client || !this.client.tui) return;
    this.enqueue(async () => {
      if (this.client?.tui) {
        await this.client.tui.showToast({
          body: { title, message, variant: "success" }
        });
      }
    });
  }

  async showError(title: string, message: string) {
    if (!this.client || !this.client.tui) return;
    this.enqueue(async () => {
      if (this.client?.tui) {
        await this.client.tui.showToast({
          body: { title, message, variant: "error" }
        });
      }
    });
  }
}

export const tui = new TUIService();
