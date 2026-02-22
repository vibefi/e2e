import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { logger } from "./logger";

class ProcessManager {
  private tracked: ChildProcess[] = [];
  private cleanupRegistered = false;

  /** Spawn a long-lived background process. Tracked for cleanup on exit. */
  spawnBackground(
    command: string,
    args: string[],
    options: SpawnOptions = {}
  ): ChildProcess {
    this.ensureCleanupHandler();
    logger.debug("Spawn background: %s %s", command, args.join(" "));
    const child = spawn(command, args, options) as ChildProcess;
    child.unref();
    this.tracked.push(child);
    child.on("exit", () => {
      this.tracked = this.tracked.filter((c) => c !== child);
    });
    return child;
  }

  /** Kill all tracked background processes. */
  cleanup() {
    for (const child of this.tracked) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    this.tracked = [];
  }

  private ensureCleanupHandler() {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    process.on("SIGINT", () => {
      this.cleanup();
      process.exit(1);
    });
    process.on("SIGTERM", () => {
      this.cleanup();
      process.exit(1);
    });
  }
}

let _instance: ProcessManager | null = null;

export function processes(): ProcessManager {
  if (!_instance) {
    _instance = new ProcessManager();
  }
  return _instance;
}
