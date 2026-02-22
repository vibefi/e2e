import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { isToolOutputEnabled, logger } from "./logger";

export interface AutomationOptions {
  clientBinary: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface WebviewInfo {
  id: string;
  kind: string;
  label: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AutomationMessage {
  type: string;
  id?: string;
  ok?: boolean;
  value?: unknown;
  error?: string;
  webviewId?: string;
  kind?: string;
  label?: string;
  message?: string;
}

export class ClientAutomation extends EventEmitter {
  private static readonly MAX_TOOL_STDERR_BYTES = 200_000;
  private proc: ChildProcess;
  private rl: Interface;
  private pending = new Map<string, PendingCommand>();
  private nextId = 0;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void>;
  private toolStderr = "";
  private toolStderrTruncated = false;
  private closingRequested = false;

  constructor(options: AutomationOptions) {
    super();

    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    logger.info(
      "Spawning client: %s %s",
      options.clientBinary,
      options.args.join(" ")
    );

    this.proc = spawn(options.clientBinary, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));
    this.proc.stderr?.on("data", (data) => {
      const chunk = data.toString();
      if (isToolOutputEnabled()) {
        process.stderr.write(chunk);
      }
      this.appendToolStderr(chunk);
    });

    this.proc.on("exit", (code, signal) => {
      logger.info("Client exited with code %s signal=%s", String(code), String(signal));
      const unexpectedExit =
        !this.closingRequested &&
        (code !== 0 || signal !== null);
      if (unexpectedExit) {
        this.dumpToolOutput(
          signal
            ? `client exited via signal ${signal}`
            : `client exited with code ${code}`
        );
      }
      for (const [, cmd] of this.pending) {
        clearTimeout(cmd.timer);
        cmd.reject(new Error(`client exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  private appendToolStderr(chunk: string) {
    this.toolStderr += chunk;
    if (this.toolStderr.length <= ClientAutomation.MAX_TOOL_STDERR_BYTES) {
      return;
    }
    this.toolStderrTruncated = true;
    this.toolStderr = this.toolStderr.slice(
      this.toolStderr.length - ClientAutomation.MAX_TOOL_STDERR_BYTES
    );
  }

  dumpToolOutput(reason = "client tool output"): void {
    if (isToolOutputEnabled()) return;
    const stderr = this.toolStderr.trim();
    if (!stderr) return;
    logger.warn("=== Buffered client stderr (%s) ===", reason);
    if (this.toolStderrTruncated) {
      logger.warn("[truncated to last %d bytes]", ClientAutomation.MAX_TOOL_STDERR_BYTES);
    }
    process.stderr.write(`${stderr}\n`);
    logger.warn("=== End buffered client stderr ===");
  }

  private handleLine(line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.warn("Unparseable automation line: %s", line);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.debug("Ignoring non-protocol automation JSON line: %s", line);
      return;
    }

    const msg = parsed as AutomationMessage;
    if (typeof msg.type !== "string") {
      logger.debug("Ignoring automation JSON without type: %s", line);
      return;
    }

    switch (msg.type) {
      case "ready":
        logger.debug("Client ready");
        this.readyResolve?.();
        this.readyResolve = null;
        this.emit("ready");
        break;

      case "result":
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id)!;
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.ok) {
            resolve(msg.value);
          } else {
            reject(new Error(msg.error ?? "unknown error"));
          }
        }
        break;

      case "webview_created":
        this.emit("webview_created", {
          id: msg.webviewId,
          kind: msg.kind,
          label: msg.label,
        } as WebviewInfo);
        break;

      case "error":
        logger.warn("Automation error: %s", msg.message);
        break;
    }
  }

  async waitForReady(timeoutMs = 15_000): Promise<void> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("client ready timeout")),
        timeoutMs
      )
    );
    await Promise.race([this.readyPromise, timeout]);
  }

  private sendCommand(cmd: Record<string, unknown>): string {
    const id = `cmd-${this.nextId++}`;
    const line = JSON.stringify({ id, ...cmd });
    this.proc.stdin!.write(line + "\n");
    return id;
  }

  evalJs(
    target: string,
    js: string,
    timeoutMs = 10_000
  ): Promise<unknown> {
    const id = this.sendCommand({ type: "eval", target, js });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`evalJs timeout (${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  listWebviews(timeoutMs = 5_000): Promise<WebviewInfo[]> {
    const id = this.sendCommand({ type: "list_webviews" });
    return new Promise<WebviewInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("listWebviews timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as WebviewInfo[]),
        reject,
        timer,
      });
    });
  }

  waitForWebview(
    predicate: (wv: WebviewInfo) => boolean,
    timeoutMs = 30_000
  ): Promise<WebviewInfo> {
    return new Promise<WebviewInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("webview_created", handler);
        reject(new Error("waitForWebview timeout"));
      }, timeoutMs);

      const handler = (wv: WebviewInfo) => {
        if (predicate(wv)) {
          clearTimeout(timer);
          this.removeListener("webview_created", handler);
          resolve(wv);
        }
      };

      this.on("webview_created", handler);
    });
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.closingRequested = true;
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 5_000);
      this.proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
