import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeEventLog, type Hex } from "viem";
import { governorAbi, loadDevnetJson, type DevnetJson } from "@vibefi/shared";
import type { E2eConfig } from "./config";
import {
  logSection,
  runCmd,
  runCli,
  parseCliJson,
  copyDirRecursive,
  extractPublishedDappIdFromExecuteReceipt,
} from "./utils";

function createStudioPackagingDir(config: E2eConfig, devnet: DevnetJson): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibefi-studio-e2e-"));
  const requiredDirs = ["src", "assets", "abis"];
  const requiredFiles = ["index.html", "package.json", "vibefi.json"];

  for (const dirEntry of requiredDirs) {
    const source = path.join(config.studioDir, dirEntry);
    const dest = path.join(tempDir, dirEntry);
    if (fs.existsSync(source)) {
      copyDirRecursive(source, dest);
      continue;
    }
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const fileEntry of requiredFiles) {
    const source = path.join(config.studioDir, fileEntry);
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

async function setStudioDappIdInDevnetJson(config: E2eConfig, studioDappId: bigint) {
  const result = await runCmd(
    "bun",
    [
      path.join(config.contractsDir, "script", "set-devnet-studio-dapp-id.mjs"),
      "--file",
      config.devnetJsonPath,
      "--studio-dapp-id",
      studioDappId.toString(),
    ],
    { cwd: config.contractsDir, capture: true }
  );
  if (result.code !== 0) {
    throw new Error("failed to update studioDappId in devnet.json");
  }
}

export async function publishAllDapps(
  config: E2eConfig
): Promise<{ studioDappId: bigint; cleanupDirs: string[] }> {
  const devnet = loadDevnetJson(config.devnetJsonPath) as DevnetJson;
  if (!devnet.testNetwork) {
    throw new Error(`Expected ${config.devnetJsonPath} to set testNetwork=true`);
  }

  let studioDappId: bigint | null = null;
  const cleanupDirs: string[] = [];

  for (const dapp of config.dapps) {
    const packagePath =
      dapp.key === "studio" ? createStudioPackagingDir(config, devnet) : dapp.dir;
    if (dapp.key === "studio") {
      cleanupDirs.push(packagePath);
    }

    logSection(`Package dapp: ${dapp.name}`);
    console.log(`Running: vibefi package (${packagePath})...`);
    let result = await runCli(
      config,
      [
        "package",
        "--path",
        packagePath,
        "--name",
        dapp.name,
        "--dapp-version",
        "0.0.1",
        "--description",
        dapp.description,
      ],
      { noRpc: true }
    );
    if (result.code !== 0) throw new Error(`package failed for ${dapp.name}`);
    const packageJson = parseCliJson<{ rootCid?: string }>(
      result.stdout || "",
      `package (${dapp.name})`
    );
    if (!packageJson.rootCid)
      throw new Error(`Missing rootCid from package for ${dapp.name}`);

    logSection(`Propose dapp: ${dapp.name}`);
    const proposalDescription = `E2E proposal ${dapp.name} ${Date.now()}`;
    console.log(`Running: vibefi dapp:propose (rootCid=${packageJson.rootCid})...`);
    result = await runCli(config, [
      "dapp:propose",
      "--root-cid",
      packageJson.rootCid,
      "--name",
      dapp.name,
      "--dapp-version",
      "0.0.1",
      "--description",
      dapp.description,
      "--proposal-description",
      proposalDescription,
    ]);
    if (result.code !== 0) throw new Error(`dapp:propose failed for ${dapp.name}`);
    const proposeJson = parseCliJson<{ txHash?: string }>(
      result.stdout || "",
      `dapp:propose (${dapp.name})`
    );
    if (!proposeJson.txHash)
      throw new Error(`Missing txHash from dapp:propose for ${dapp.name}`);

    logSection(`Mine block: ${dapp.name}`);
    console.log("Mining 1 block...");
    await config.publicClient.request({ method: "anvil_mine", params: [1] });
    console.log("Block mined.");

    logSection(`Fetch proposal id: ${dapp.name}`);
    console.log(`Waiting for tx receipt: ${proposeJson.txHash}...`);
    const receipt = await config.publicClient.waitForTransactionReceipt({
      hash: proposeJson.txHash as Hex,
      timeout: 15000,
    });
    console.log("Receipt received.");
    const governorAddress = devnet.vfiGovernor.toLowerCase();
    const proposalLog = (receipt.logs ?? []).find(
      (log) => log.address.toLowerCase() === governorAddress
    );
    if (!proposalLog)
      throw new Error(`ProposalCreated log not found in receipt for ${dapp.name}`);
    const decoded = decodeEventLog({
      abi: governorAbi,
      data: proposalLog.data as Hex,
      topics: proposalLog.topics as [Hex, ...Hex[]],
    });
    const proposalId = (
      (decoded as unknown as { args: { proposalId: bigint } }).args
    ).proposalId.toString();
    console.log(`Using proposalId=${proposalId}`);

    logSection(`Cast vote: ${dapp.name}`);
    console.log(`Running: vibefi vote:cast ${proposalId} --support for...`);
    result = await runCli(config, ["vote:cast", proposalId, "--support", "for"]);
    if (result.code !== 0) throw new Error(`vote:cast failed for ${dapp.name}`);
    console.log("Vote cast.");

    logSection(`Mine blocks for voting period: ${dapp.name}`);
    console.log("Mining 25 blocks for voting period...");
    await config.publicClient.request({ method: "anvil_mine", params: [25] });
    console.log("Blocks mined.");

    logSection(`Vote status: ${dapp.name}`);
    console.log(`Running: vibefi vote:status ${proposalId}...`);
    result = await runCli(config, ["vote:status", proposalId]);
    if (result.code !== 0) throw new Error(`vote:status failed for ${dapp.name}`);

    logSection(`Queue proposal: ${dapp.name}`);
    console.log(`Running: vibefi proposals:queue ${proposalId}...`);
    result = await runCli(config, ["proposals:queue", proposalId]);
    if (result.code !== 0) throw new Error(`proposals:queue failed for ${dapp.name}`);
    const queueJson = parseCliJson<{ txHash?: string }>(
      result.stdout || "",
      `proposals:queue (${dapp.name})`
    );
    if (!queueJson.txHash)
      throw new Error(`Missing txHash from proposals:queue for ${dapp.name}`);

    logSection(`Advance time past timelock delay: ${dapp.name}`);
    console.log("Increasing time by 2s and mining 1 block...");
    await config.publicClient.request({ method: "evm_increaseTime", params: ["0x2"] });
    await config.publicClient.request({ method: "anvil_mine", params: [1] });
    console.log("Block mined.");

    logSection(`Execute proposal: ${dapp.name}`);
    console.log(`Running: vibefi proposals:execute ${proposalId}...`);
    result = await runCli(config, ["proposals:execute", proposalId]);
    if (result.code !== 0) throw new Error(`proposals:execute failed for ${dapp.name}`);
    const executeJson = parseCliJson<{ txHash?: string }>(
      result.stdout || "",
      `proposals:execute (${dapp.name})`
    );
    if (!executeJson.txHash)
      throw new Error(`Missing txHash from proposals:execute for ${dapp.name}`);
    const executeReceipt = await config.publicClient.waitForTransactionReceipt({
      hash: executeJson.txHash as Hex,
      timeout: 15000,
    });
    if (dapp.key === "studio") {
      const maybeStudioDappId = extractPublishedDappIdFromExecuteReceipt(
        executeReceipt,
        devnet.dappRegistry,
        packageJson.rootCid
      );
      if (maybeStudioDappId === null) {
        throw new Error("Failed to detect Studio dappId from execute receipt");
      }
      await setStudioDappIdInDevnetJson(config, maybeStudioDappId);
      studioDappId = maybeStudioDappId;
      console.log(
        `Stored studioDappId=${studioDappId.toString()} in ${config.devnetJsonPath}`
      );
    }

    logSection(`Fetch dapp bundle: ${dapp.name}`);
    console.log(`Running: vibefi dapp:fetch --root-cid ${packageJson.rootCid}...`);
    result = await runCli(
      config,
      [
        "dapp:fetch",
        "--root-cid",
        packageJson.rootCid,
        "--out",
        path.join(config.cliDir, ".vibefi", "cache", packageJson.rootCid),
        "--ipfs-api",
        config.ipfsApi,
        "--ipfs-gateway",
        config.ipfsGateway,
      ],
      { noRpc: true }
    );
    if (result.code !== 0) throw new Error(`dapp:fetch failed for ${dapp.name}`);
    console.log(`Dapp bundle for ${dapp.name} fetched and verified.`);
  }

  if (studioDappId === null) {
    throw new Error("Studio dappId was not captured");
  }

  return { studioDappId, cleanupDirs };
}
