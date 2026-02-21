import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hexToString, isHex, type Hex } from "viem";
import { dappRegistryAbi, loadDevnetJson } from "@vibefi/shared";
import { decodeEventLog } from "viem";
import type { E2eConfig } from "./config";
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
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function runCli(
  config: E2eConfig,
  args: string[],
  options: { noRpc?: boolean } = {}
) {
  logger.debug("Run vibefi CLI: %s", args.join(" "));
  const fullArgs = ["run", "src/index.ts", ...args];
  if (!options.noRpc) {
    fullArgs.push("--rpc", config.rpcUrl, "--devnet", config.devnetJsonPath);
  }
  fullArgs.push("--json");
  return runCmd("bun", fullArgs, { cwd: config.cliDir, capture: true });
}

export function parseCliJson<T>(stdout: string, context: string): T {
  const trimmed = stdout.trim();
  const candidates: string[] = [trimmed];
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const isJsonStart = char === "{" || char === "[";
    const startsAtLineBoundary = i === 0 || trimmed[i - 1] === "\n";
    if (isJsonStart && startsAtLineBoundary) {
      candidates.push(trimmed.slice(i));
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep trying
    }
  }
  throw new Error(`${context}: failed to parse JSON output`);
}

export function pickInstallCommand(baseDir: string): { command: string; args: string[] } | null {
  const packageJsonPath = path.join(baseDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;
  if (fs.existsSync(path.join(baseDir, "bun.lock")) || fs.existsSync(path.join(baseDir, "bun.lockb"))) {
    return { command: "bun", args: ["install"] };
  }
  if (fs.existsSync(path.join(baseDir, "package-lock.json"))) {
    return { command: "npm", args: ["ci"] };
  }
  if (fs.existsSync(path.join(baseDir, "pnpm-lock.yaml"))) {
    return { command: "pnpm", args: ["install", "--frozen-lockfile"] };
  }
  if (fs.existsSync(path.join(baseDir, "yarn.lock"))) {
    return { command: "yarn", args: ["install", "--frozen-lockfile"] };
  }
  return { command: "bun", args: ["install"] };
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

export async function ensureContractsDeployed(config: E2eConfig): Promise<boolean> {
  const devnet = loadDevnetJson(config.devnetJsonPath);
  if (!devnet) return false;
  const code = await config.publicClient.getBytecode({ address: devnet.vfiGovernor as Hex });
  return (code ?? "0x") !== "0x";
}
