import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { E2eConfig } from "./config";
import { logSection, runCmd, runCli, pickInstallCommand, waitFor, ensureContractsDeployed } from "./utils";
import { isToolOutputEnabled, logger } from "./logger";

export async function prepareDappExamples(config: E2eConfig) {
  logSection("Prepare dapp examples");
  logger.debug("Ensuring nested dapp submodules are initialized...");
  const submoduleResult = await runCmd("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: config.dappExamplesDir,
    capture: true,
  });
  if (submoduleResult.code !== 0) {
    throw new Error("failed to initialize nested submodules under dapp-examples");
  }
  if (!fs.existsSync(config.zfiSourceDir)) {
    throw new Error(`zFi submodule dapp directory missing: ${config.zfiSourceDir}`);
  }

  logSection("Install dapp dependencies");
  for (const target of config.dappInstallTargets) {
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

export async function startInfrastructure(config: E2eConfig) {
  logSection("Configuration");
  logger.info("Mode: %s", config.useSepolia ? "Sepolia fork" : "Mainnet fork/local");
  logger.info("Anvil chainId: %s", config.chainId);
  if (config.forkUrl) {
    logger.info("Fork RPC configured: %s", config.useSepolia ? "SEPOLIA" : "MAINNET");
  } else {
    logger.info("Fork RPC not configured. Running unforked local anvil.");
  }
  if (config.useSepolia && !config.forkUrl) {
    throw new Error("Missing Sepolia RPC URL. Set SEPOLIA_RPC_URL, or run without --sepolia.");
  }

  logSection("Start IPFS");
  await runCmd("docker", ["compose", "-f", path.join(process.cwd(), "docker-compose.ipfs.yml"), "up", "-d"], {
    capture: true,
  });

  logSection("Start devnet");
  logger.debug("Checking if anvil is already running on :%s...", config.anvilPort);
  const alreadyRunning = await waitFor("RPC", () => config.publicClient.getChainId().then(() => true), 2000);
  if (alreadyRunning) {
    logger.info("Anvil already running on :%s, killing...", config.anvilPort);
    await runCmd(
      "bash",
      ["-c", `lsof -t -i:${config.anvilPort} -a -c anvil | xargs kill -SIGTERM 2>/dev/null || true`],
      { capture: true, stream: false }
    );
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    logger.debug("No existing anvil found.");
  }

  logger.debug("Removing stale devnet.json...");
  fs.rmSync(config.devnetJsonPath, { force: true });

  const optionalForkingMessage = config.forkUrl ? ` with fork from ${config.forkUrl}` : "";
  logger.info("Starting local-devnet.sh%s...", optionalForkingMessage);
  spawn("./script/local-devnet.sh", [], {
    cwd: config.contractsDir,
    env: { ...process.env, ANVIL_PORT: config.anvilPort, CHAIN_ID: config.chainId, MAINNET_RPC_URL: config.forkUrl },
    stdio: isToolOutputEnabled() ? "inherit" : "ignore",
  }).unref();

  logger.info("Waiting for RPC at %s...", config.rpcUrl);
  const rpcReady = await waitFor("RPC", async () => {
    const chainId = await config.publicClient.getChainId();
    logger.debug("RPC responded with chainId=%s", chainId);
    return true;
  }, 30000);
  if (!rpcReady) {
    throw new Error(`RPC not ready at ${config.rpcUrl}`);
  }
  logger.info("RPC is ready.");

  logSection("Check IPFS");
  logger.info("Checking IPFS at %s...", config.ipfsApi);
  const ipfsReady = await waitFor("IPFS", async () => {
    const res = await fetch(new URL("/api/v0/version", config.ipfsApi).toString(), { method: "POST" });
    return res.ok;
  }, 8000);
  if (!ipfsReady) {
    throw new Error(`IPFS not ready at ${config.ipfsApi}.`);
  }
  logger.info("IPFS is ready.");

  logSection("Wait for contracts");
  logger.info("Waiting for VibeFi contracts to be deployed...");
  const deployTimeout = 120000;
  const deployStart = Date.now();
  let lastLog = 0;
  while (Date.now() - deployStart < deployTimeout) {
    if (await ensureContractsDeployed(config)) {
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
  if (!(await ensureContractsDeployed(config))) {
    throw new Error("Contracts not deployed after waiting for background devnet.");
  }
}

export async function runSanityChecks(config: E2eConfig) {
  const mnemonic = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";
  const devAccount = mnemonicToAccount(mnemonic);
  const walletClient = createWalletClient({
    account: devAccount,
    transport: http(config.rpcUrl),
  });

  logSection("Send sanity tx via viem");
  logger.info("Sending sanity transaction...");
  const sanityTxHash = await walletClient.sendTransaction({
    chain: null,
    to: devAccount.address,
    value: 0n,
  });
  logger.debug("Sanity tx hash: %s", sanityTxHash);
  await config.publicClient.waitForTransactionReceipt({ hash: sanityTxHash });
  logger.info("Sanity tx confirmed.");

  logSection("CLI status");
  logger.debug("Running: vibefi status...");
  let result = await runCli(config, ["status"]);
  if (result.code !== 0) throw new Error("status failed");

  logSection("List proposals");
  logger.debug("Running: vibefi proposals:list...");
  result = await runCli(config, ["proposals:list"]);
  if (result.code !== 0) throw new Error("proposals:list failed");
}
