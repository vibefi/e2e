import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDevnetJson, type DevnetJson } from "@vibefi/shared";
import { config } from "./config";
import { castVote, queueAndExecute } from "./governance";
import { packageAndProposeDapp } from "./publish-flow";
import {
  logSection,
  runCmd,
  runCli,
  copyDirRecursive,
  extractPublishedDappIdFromExecuteReceipt,
} from "./utils";
import { logger } from "./logger";

function createStudioPackagingDir(devnet: DevnetJson): string {
  const { studioDir } = config();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibefi-studio-e2e-"));
  const requiredDirs = ["src", "assets", "abis"];
  const requiredFiles = ["index.html", "package.json", "vibefi.json"];

  for (const dirEntry of requiredDirs) {
    const source = path.join(studioDir, dirEntry);
    const dest = path.join(tempDir, dirEntry);
    if (fs.existsSync(source)) {
      copyDirRecursive(source, dest);
      continue;
    }
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const fileEntry of requiredFiles) {
    const source = path.join(studioDir, fileEntry);
    if (!fs.existsSync(source)) {
      throw new Error(`Studio packaging is missing required file: ${source}`);
    }
    const dest = path.join(tempDir, fileEntry);
    fs.copyFileSync(source, dest);
  }
  const vibefiJsonPath = path.join(tempDir, "vibefi.json");
  const vibefiJson = JSON.parse(fs.readFileSync(vibefiJsonPath, "utf-8")) as {
    addresses?: Record<string, unknown>;
    capabilities?: unknown;
  };
  vibefiJson.addresses = {
    [String(devnet.chainId)]: {
      vfiToken: devnet.vfiToken,
      vfiGovernor: devnet.vfiGovernor,
      dappRegistry: devnet.dappRegistry,
    },
  };
  fs.writeFileSync(vibefiJsonPath, `${JSON.stringify(vibefiJson, null, 2)}\n`);
  return tempDir;
}

async function updateConfigForE2E(studioDappId: bigint) {
  const { contractsDir, devnetJsonPath } = config();
  const result = await runCmd(
    "bun",
    [
      path.join(contractsDir, "script", "updateConfigForE2E.mjs"),
      "--file",
      devnetJsonPath,
      "--studio-dapp-id",
      studioDappId.toString(),
      "--ipfs-helia-gateway",
      "http://127.0.0.1:8080",
    ],
    { cwd: contractsDir, capture: true }
  );
  if (result.code !== 0) {
    throw new Error("failed to update studioDappId in devnet.json");
  }
}

export async function publishAllDapps(): Promise<{ studioDappId: bigint; cleanupDirs: string[] }> {
  const { devnetJsonPath, dapps, cliDir, ipfsApi, ipfsGateway } = config();
  const devnet = loadDevnetJson(devnetJsonPath) as DevnetJson;
  if (!devnet.testNetwork) {
    throw new Error(`Expected ${devnetJsonPath} to set testNetwork=true`);
  }

  let studioDappId: bigint | null = null;
  const cleanupDirs: string[] = [];

  for (const dapp of dapps) {
    // --- package ---
    const packagePath =
      dapp.key === "studio" ? createStudioPackagingDir(devnet) : dapp.dir;
    if (dapp.key === "studio") {
      cleanupDirs.push(packagePath);
    }

    logSection(`Package dapp: ${dapp.name}`);
    logger.debug("Running: vibefi package (%s)...", packagePath);
    const { rootCid, proposalId } = await packageAndProposeDapp({
      packagePath,
      name: dapp.name,
      version: "0.0.1",
      description: dapp.description,
      proposalDescription: `E2E proposal ${dapp.name} ${Date.now()}`,
      packageContext: `package (${dapp.name})`,
    });

    // --- vote + queue + execute ---
    logSection(`Cast vote: ${dapp.name}`);
    await castVote(proposalId);

    const { executeReceipt } = await queueAndExecute(proposalId);

    // --- studio: extract dappId from DappPublished event ---
    if (dapp.key === "studio") {
      const maybeStudioDappId = extractPublishedDappIdFromExecuteReceipt(
        executeReceipt,
        devnet.dappRegistry,
        rootCid
      );
      if (maybeStudioDappId === null) {
        throw new Error("Failed to detect Studio dappId from execute receipt");
      }
      await updateConfigForE2E(maybeStudioDappId);
      studioDappId = maybeStudioDappId;
      logger.info(
        "Stored studioDappId=%s and set ipfsHeliaGateway in %s",
        studioDappId.toString(),
        devnetJsonPath
      );
    }

    // --- fetch bundle ---
    logSection(`Fetch dapp bundle: ${dapp.name}`);
    logger.debug("Running: vibefi dapp:fetch --root-cid %s...", rootCid);
    const fetchResult = await runCli(
      [
        "dapp:fetch",
        "--root-cid",
        rootCid,
        "--out",
        path.join(cliDir, ".vibefi", "cache", rootCid),
        "--ipfs-api",
        ipfsApi,
        "--ipfs-gateway",
        ipfsGateway,
      ],
      { noRpc: true }
    );
    if (fetchResult.code !== 0) throw new Error(`dapp:fetch failed for ${dapp.name}`);
    logger.info("Dapp bundle for %s fetched and verified.", dapp.name);
  }

  if (studioDappId === null) {
    throw new Error("Studio dappId was not captured");
  }

  return { studioDappId, cleanupDirs };
}
