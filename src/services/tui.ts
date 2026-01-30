export class TUIService {
  private client: any;

  setClient(client: any) {
    this.client = client;
  }

  async showProgress(title: string, progress: number, message: string) {
    if (!this.client || !this.client.tui) return;

    try {
      await this.client.tui.showToast({
        body: {
          title: `[${progress}%] ${title}`,
          message,
          variant: "info"
        }
      });
    } catch (e: any) {
      // Ignore "edit buff is destroyed" or similar Neovim/PTY cleanup errors
      if (e.message?.includes("destroyed") || e.message?.includes("invalid channel")) {
          return;
      }
      // Log other TUI errors silently
    }
  }

  async showSuccess(title: string, message: string) {
    if (!this.client || !this.client.tui) return;
    try {
      await this.client.tui.showToast({
        body: { title, message, variant: "success" }
      });
    } catch (e: any) {
        if (e.message?.includes("destroyed") || e.message?.includes("invalid channel")) return;
    }
  }

  async showError(title: string, message: string) {
    if (!this.client || !this.client.tui) return;
    try {
      await this.client.tui.showToast({
        body: { title, message, variant: "error" }
      });
    } catch (e: any) {
        if (e.message?.includes("destroyed") || e.message?.includes("invalid channel")) return;
    }
  }
}

export const tui = new TUIService();
