import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { config, publicClient } from "./config";
import { processes } from "./processes";
import { logSection, runCmd, runCli, waitFor, ensureContractsDeployed } from "./utils";
import { expect } from "bun:test";
import { isToolOutputEnabled, logger } from "./logger";
import { assertCommandSuccess } from "./assertions";

export async function startInfrastructure() {
  const { useSepolia, chainId, forkUrl, anvilPort, rpcUrl, ipfsApi, contractsDir, devnetJsonPath } = config();
  const client = publicClient();

  logSection("Configuration");
  const mode = useSepolia ? "Sepolia fork" : (forkUrl ? "Mainnet fork" : "Local (unforked)");
  logger.info("Mode: %s", mode);
  logger.info("Anvil chainId: %s", chainId);
  if (forkUrl) {
    logger.info("Fork RPC configured: %s", useSepolia ? "SEPOLIA" : "MAINNET");
  } else {
    logger.info("Fork RPC not configured. Running unforked local anvil.");
  }
  if (useSepolia && !forkUrl) {
    throw new Error("Missing Sepolia RPC URL. Set SEPOLIA_RPC_URL, or run without --sepolia.");
  }

  logSection("Start IPFS");
  await runCmd("docker", ["compose", "-f", path.join(process.cwd(), "docker-compose.ipfs.yml"), "up", "-d"], {
    capture: true,
  });

  logSection("Start devnet");
  logger.debug("Checking if anvil is already running on :%s...", anvilPort);
  const alreadyRunning = await waitFor("RPC", () => client.getChainId().then(() => true), 2000);
  if (alreadyRunning) {
    logger.info("Anvil already running on :%s, killing...", anvilPort);
    await runCmd(
      "bash",
      ["-c", `lsof -t -i:${anvilPort} -a -c anvil | xargs kill -SIGTERM 2>/dev/null || true`],
      { capture: true, stream: false }
    );
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    logger.debug("No existing anvil found.");
  }

  logger.debug("Removing stale devnet.json...");
  fs.rmSync(devnetJsonPath, { force: true });

  const optionalForkingMessage = forkUrl ? ` with fork from ${forkUrl}` : "";
  logger.info("Starting local-devnet.sh%s...", optionalForkingMessage);
  const devnetProcess = processes().spawnBackground("./script/local-devnet.sh", [], {
    cwd: contractsDir,
    env: { ...process.env, ANVIL_PORT: anvilPort, CHAIN_ID: chainId, MAINNET_RPC_URL: forkUrl },
    stdio: isToolOutputEnabled() ? "inherit" : "ignore",
    detached: true,
  });
  let devnetExited = false;
  let devnetExitCode: number | null = null;
  let devnetExitSignal: NodeJS.Signals | null = null;
  devnetProcess.on("exit", (code, signal) => {
    devnetExited = true;
    devnetExitCode = code;
    devnetExitSignal = signal;
    logger.warn(
      "local-devnet.sh exited (code=%s signal=%s)",
      code ?? "null",
      signal ?? "null"
    );
  });

  logger.info("Waiting for RPC at %s...", rpcUrl);
  const rpcReady = await waitFor("RPC", async () => {
    const id = await client.getChainId();
    logger.debug("RPC responded with chainId=%s", id);
    return true;
  }, 30000);
  if (!rpcReady) {
    throw new Error(`RPC not ready at ${rpcUrl}`);
  }
  logger.info("RPC is ready.");

  logSection("Check IPFS");
  logger.info("Checking IPFS at %s...", ipfsApi);
  const ipfsReady = await waitFor("IPFS", async () => {
    const res = await fetch(new URL("/api/v0/version", ipfsApi).toString(), { method: "POST" });
    return res.ok;
  }, 8000);
  if (!ipfsReady) {
    throw new Error(`IPFS not ready at ${ipfsApi}.`);
  }
  logger.info("IPFS is ready.");

  logSection("Wait for contracts");
  logger.info("Waiting for VibeFi contracts to be deployed...");
  const deployTimeout = 120000;
  const deployStart = Date.now();
  let lastLog = 0;
  while (Date.now() - deployStart < deployTimeout) {
    if (devnetExited) {
      throw new Error(
        `local-devnet.sh exited before contracts were detected (code=${devnetExitCode ?? "null"}, signal=${devnetExitSignal ?? "null"})`
      );
    }
    if (await ensureContractsDeployed()) {
      logger.info("Contracts deployed successfully.");
      break;
    }
    const elapsed = Date.now() - deployStart;
    if (elapsed - lastLog > 10000) {
      const devnetJsonPresent = fs.existsSync(devnetJsonPath);
      logger.info(
        "Still waiting for contracts (%ss elapsed, devnet.json=%s, local-devnet=%s)",
        Math.round(elapsed / 1000),
        devnetJsonPresent ? "present" : "missing",
        devnetExited ? "exited" : "running"
      );
      lastLog = elapsed;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await ensureContractsDeployed())) {
    const devnetJsonPresent = fs.existsSync(devnetJsonPath);
    throw new Error(
      `Contracts not deployed after waiting for background devnet (devnet.json=${devnetJsonPresent ? "present" : "missing"}, local-devnet=${devnetExited ? "exited" : "running"})`
    );
  }
}

export async function runSanityChecks() {
  const { rpcUrl } = config();
  const client = publicClient();
  const mnemonic = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";
  const devAccount = mnemonicToAccount(mnemonic);
  const walletClient = createWalletClient({
    account: devAccount,
    transport: http(rpcUrl),
  });

  logSection("Send sanity tx via viem");
  logger.info("Sending sanity transaction...");
  const sanityTxHash = await walletClient.sendTransaction({
    chain: null,
    to: devAccount.address,
    value: 0n,
  });
  logger.debug("Sanity tx hash: %s", sanityTxHash);
  await client.waitForTransactionReceipt({ hash: sanityTxHash });
  logger.info("Sanity tx confirmed.");

  logSection("CLI status");
  logger.debug("Running: vibefi status...");
  let result = await runCli(["status"]);
  assertCommandSuccess(result, "vibefi status");

  logSection("List proposals");
  logger.debug("Running: vibefi proposals:list...");
  result = await runCli(["proposals:list"]);
  assertCommandSuccess(result, "vibefi proposals:list");
}
