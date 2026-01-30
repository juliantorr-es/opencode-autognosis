export class TUIService {
  private client: any;
  private lastUpdate: number = 0;
  private readonly THROTTLE_MS = 500; // Minimum time between toasts
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
    this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) continue;

      const now = Date.now();
      const wait = Math.max(0, this.THROTTLE_MS - (now - this.lastUpdate));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      try {
        // Final safety check: Give the TUI a few ms to breathe before the call
        await new Promise(r => setTimeout(r, 50));
        await task();
        this.lastUpdate = Date.now();
      } catch (e: any) {
        // Silence "destroyed" errors as they are expected during session teardown
        if (e.message?.includes("destroyed") || e.message?.includes("invalid channel")) {
            // Drop remaining queue if channel is dead
            this.queue = [];
            break;
        }
      }
    }

    this.isProcessing = false;
  }

  async showProgress(title: string, progress: number, message: string) {
    if (!this.client || !this.client.tui) return;

    this.enqueue(async () => {
      await this.client.tui.showToast({
        body: {
          title: `[${progress}%] ${title}`,
          message,
          variant: "info"
        }
      });
    });
  }

  async showSuccess(title: string, message: string) {
    if (!this.client || !this.client.tui) return;
    this.enqueue(async () => {
      await this.client.tui.showToast({
        body: { title, message, variant: "success" }
      });
    });
  }

  async showError(title: string, message: string) {
    if (!this.client || !this.client.tui) return;
    this.enqueue(async () => {
      await this.client.tui.showToast({
        body: { title, message, variant: "error" }
      });
    });
  }
}

export const tui = new TUIService();