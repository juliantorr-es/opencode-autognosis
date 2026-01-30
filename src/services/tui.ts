export class TUIService {
  private client: any;

  setClient(client: any) {
    this.client = client;
  }

  async showProgress(title: string, progress: number, message: string) {
    if (!this.client) return;

    try {
      await this.client.tui.showToast({
        body: {
          title: `[${progress}%] ${title}`,
          message,
          variant: "info"
        }
      });
    } catch (e) {
      // Ignore if TUI not available
    }
  }

  async showSuccess(title: string, message: string) {
    if (!this.client) return;
    try {
      await this.client.tui.showToast({
        body: { title, message, variant: "success" }
      });
    } catch (e) {}
  }

  async showError(title: string, message: string) {
    if (!this.client) return;
    try {
      await this.client.tui.showToast({
        body: { title, message, variant: "error" }
      });
    } catch (e) {}
  }
}

export const tui = new TUIService();
