import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hexToString, isHex, type Hex } from "viem";
import { dappRegistryAbi, loadDevnetJson } from "@vibefi/shared";
import { decodeEventLog } from "viem";
import { config, publicClient } from "./config";
import { isToolOutputEnabled, logger } from "./logger";

const startTime = Date.now();

export function logSection(title: string) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info("=== %s [+%ss] ===", title, elapsed);
}

export function runCmd(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; stream?: boolean } = {}
) {
  const capture = options.capture ?? true;
  const stream = options.stream ?? isToolOutputEnabled();
  logger.debug(
    "Run command: %s %s%s",
    command,
    args.join(" "),
    options.cwd ? ` (cwd=${options.cwd})` : ""
  );

  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : stream ? "inherit" : "ignore",
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (stream) {
          process.stdout.write(chunk);
        }
      });
      child.stderr?.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (stream) {
          process.stderr.write(chunk);
        }
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && capture && !stream) {
        logger.warn(
          "Command failed (exit=%d): %s %s",
          result.code,
          command,
          args.join(" ")
        );
        const stdoutTrimmed = stdout.trim();
        const stderrTrimmed = stderr.trim();
        if (stdoutTrimmed) {
          logger.warn("Command stdout:");
          process.stdout.write(`${stdoutTrimmed}\n`);
        }
        if (stderrTrimmed) {
          logger.warn("Command stderr:");
          process.stderr.write(`${stderrTrimmed}\n`);
        }
      }
      resolve(result);
    });
  });
}

export function runCli(
  args: string[],
  options: { noRpc?: boolean } = {}
) {
  logger.debug("Run vibefi CLI: %s", args.join(" "));
  const { cliDir, rpcUrl, devnetJsonPath } = config();
  const fullArgs = ["run", "src/index.ts", ...args];
  if (!options.noRpc) {
    fullArgs.push("--rpc", rpcUrl, "--devnet", devnetJsonPath);
  }
  fullArgs.push("--json");
  return runCmd("bun", fullArgs, { cwd: cliDir, capture: true });
}

export function parseCliJson<T>(stdout: string, context: string): T {
  const regex = /^[\[\{]/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    try {
      return JSON.parse(stdout.slice(match.index)) as T;
    } catch {
      // keep trying later matches
    }
  }
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error(`${context}: failed to parse JSON output`);
  }
}

export async function runCliJson<T>(
  args: string[],
  context: string,
  options?: { noRpc?: boolean }
): Promise<T> {
  const result = await runCli(args, options);
  if (result.code !== 0) {
    const stderr = result.stderr?.trim() || "";
    const firstLine = stderr.split("\n")[0] || "unknown error";
    throw new Error(`${context} failed (exit=${result.code}): ${firstLine}`);
  }
  return parseCliJson<T>(result.stdout || "", context);
}

export function copyDirRecursive(sourceDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(source, dest);
      continue;
    }
    fs.copyFileSync(source, dest);
  }
}

export function decodeRootCid(rawRootCid: unknown): string {
  if (typeof rawRootCid !== "string") return "";
  if (!isHex(rawRootCid)) return rawRootCid;
  try {
    return hexToString(rawRootCid as Hex).replace(/\0+$/g, "");
  } catch {
    return rawRootCid;
  }
}

export function extractPublishedDappIdFromExecuteReceipt(
  receipt: { logs?: Array<{ address: string; data: Hex; topics: readonly Hex[] }> },
  dappRegistryAddress: string,
  expectedRootCid: string
): bigint | null {
  const registry = dappRegistryAddress.toLowerCase();
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== registry) continue;
    try {
      const decoded = decodeEventLog({
        abi: dappRegistryAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName?: string; args?: { dappId?: bigint; rootCid?: Hex } };
      if (decoded.eventName !== "DappPublished") continue;
      const emittedRootCid = decodeRootCid(decoded.args?.rootCid);
      if (emittedRootCid !== expectedRootCid) continue;
      if (typeof decoded.args?.dappId === "bigint") {
        return decoded.args.dappId;
      }
    } catch {
      // ignore decode failures for unrelated logs
    }
  }
  return null;
}

export async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await probe()) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  logger.warn("%s not ready after %sms timeout", label, timeoutMs);
  return false;
}

export async function ensureContractsDeployed(): Promise<boolean> {
  const devnet = loadDevnetJson(config().devnetJsonPath);
  if (!devnet) return false;
  const code = await publicClient().getBytecode({ address: devnet.vfiGovernor as Hex });
  return (code ?? "0x") !== "0x";
}
