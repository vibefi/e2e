import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { config, publicClient } from "./config";
import { processes } from "./processes";
import { logSection, runCmd, runCli, pickInstallCommand, waitFor, ensureContractsDeployed } from "./utils";
import { expect } from "bun:test";
import { isToolOutputEnabled, logger } from "./logger";

export async function prepareDappExamples() {
  const { dappExamplesDir, zfiSourceDir, dappInstallTargets } = config();

  logSection("Prepare dapp examples");
  logger.debug("Ensuring nested dapp submodules are initialized...");
  const submoduleResult = await runCmd("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: dappExamplesDir,
    capture: true,
  });
  if (submoduleResult.code !== 0) {
    throw new Error("failed to initialize nested submodules under dapp-examples");
  }
  if (!fs.existsSync(zfiSourceDir)) {
    throw new Error(`zFi submodule dapp directory missing: ${zfiSourceDir}`);
  }

  logSection("Install dapp dependencies");
  for (const target of dappInstallTargets) {
    if (!fs.existsSync(target.dir)) {
      throw new Error(`Missing dapp directory for ${target.key}: ${target.dir}`);
    }
    const installCommand = pickInstallCommand(target.dir);
    if (!installCommand) {
      logger.debug("[%s] No package.json found, skipping dependency install.", target.key);
      continue;
    }
    logger.debug(
      "[%s] Installing dependencies via: %s %s",
      target.key,
      installCommand.command,
      installCommand.args.join(" ")
    );
    const installResult = await runCmd(installCommand.command, installCommand.args, {
      cwd: target.dir,
      capture: true,
    });
    if (installResult.code !== 0) {
      throw new Error(`dependency install failed for ${target.key}`);
    }
  }
}

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
  processes().spawnBackground("./script/local-devnet.sh", [], {
    cwd: contractsDir,
    env: { ...process.env, ANVIL_PORT: anvilPort, CHAIN_ID: chainId, MAINNET_RPC_URL: forkUrl },
    stdio: isToolOutputEnabled() ? "inherit" : "ignore",
    detached: true,
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
    if (await ensureContractsDeployed()) {
      logger.info("Contracts deployed successfully.");
      break;
    }
    const elapsed = Date.now() - deployStart;
    if (elapsed - lastLog > 5000) {
      logger.debug("Still waiting for contracts... (%ss elapsed)", Math.round(elapsed / 1000));
      lastLog = elapsed;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await ensureContractsDeployed())) {
    throw new Error("Contracts not deployed after waiting for background devnet.");
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
  expect(result.code).toBe(0);

  logSection("List proposals");
  logger.debug("Running: vibefi proposals:list...");
  result = await runCli(["proposals:list"]);
  expect(result.code).toBe(0);
}
