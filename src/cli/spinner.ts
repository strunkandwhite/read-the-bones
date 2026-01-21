/**
 * Simple CLI spinner for showing progress.
 */
export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private current = 0;
  private interval: NodeJS.Timeout | null = null;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    process.stdout.write(`${this.frames[0]} ${this.message}`);
    this.interval = setInterval(() => {
      this.current = (this.current + 1) % this.frames.length;
      process.stdout.write(`\r${this.frames[this.current]} ${this.message}`);
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write("\r" + " ".repeat(this.message.length + 3) + "\r");
    }
  }

  /**
   * Update the spinner message while running.
   * Useful for showing elapsed time during long operations.
   */
  updateMessage(message: string): void {
    const oldLen = this.message.length;
    this.message = message;
    // Clear extra chars if new message is shorter
    const padding = Math.max(0, oldLen - message.length);
    if (this.interval) {
      process.stdout.write(
        `\r${this.frames[this.current]} ${this.message}${" ".repeat(padding)}`
      );
    }
  }
}
