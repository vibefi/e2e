import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWalletClient, decodeEventLog, hexToString, http, isHex, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { dappRegistryAbi, getPublicClient, governorAbi, loadDevnetJson, type DevnetJson } from "@vibefi/shared";

type AnvilClient = ReturnType<typeof getPublicClient> & {
  request(args: { method: "anvil_mine"; params: [number] }): Promise<void>;
  request(args: { method: "evm_increaseTime"; params: [string] }): Promise<void>;
};

const monorepoDir = process.env.MONOREPO_DIR;
if (!monorepoDir) {
  throw new Error("MONOREPO_DIR is required (absolute path to the monorepo)");
}

const contractsDir = path.join(monorepoDir, "contracts");
const cliDir = path.join(monorepoDir, "cli");
const studioDir = path.join(monorepoDir, "studio");
const dappExamplesDir = path.join(monorepoDir, "dapp-examples");
const zfiSourceDir = path.join(dappExamplesDir, "zfi", "dapp");
const dappInstallTargets = [
  { key: "uniswap-v2", dir: path.join(dappExamplesDir, "uniswap-v2") },
  { key: "aave-v3", dir: path.join(dappExamplesDir, "aave-v3") },
  { key: "safe-admin", dir: path.join(dappExamplesDir, "safe-admin") },
  { key: "zfi", dir: zfiSourceDir }
];
const dapps = [
  { key: "studio", dir: studioDir, name: "Studio", description: "VibeFi governance studio" },
  { key: "uniswap-v2", dir: path.join(dappExamplesDir, "uniswap-v2"), name: "Uniswap V2", description: "Uniswap V2 example" },
  { key: "aave-v3", dir: path.join(dappExamplesDir, "aave-v3"), name: "Aave V3", description: "Aave V3 example" },
  { key: "safe-admin", dir: path.join(dappExamplesDir, "safe-admin"), name: "Safe Admin", description: "Safe admin example" },
  { key: "zfi", dir: zfiSourceDir, name: "zFi", description: "zFi static dapp" }
];
const devnetJsonPath = path.join(contractsDir, ".devnet", "devnet.json");
const ZFI_MAINNET_ADDRESSES = {
  zQuoter: "0x806f7b66e31b6f61bfda9d1431d07865c3164ba5",
  zRouter: "0x000000000000FB114709235f1ccBFfb925F600e4",
  weins: "0x0000000000696760E15f265e828DB644A0c242EB",
  subdomainRegistrar: "0x0000000000DD72Ef1DF17f527E719AEE5ef71E64",
  basePortal: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e",
  summoner: "0x0000000000330B8df9E3bc5E553074DA58eE9138",
  viewHelper: "0x00000000006631040967E58e3430e4B77921a2db",
  tribute: "0x000000000066524fcf78Dc1E41E9D525d9ea73D0",
  daico: "0x000000000033e92DB97B4B3beCD2c255126C60aC",
  renderer: "0x000000000011C799980827F52d3137b4abD6E654",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  v4Router: "0x00000000000044a361Ae3cAc094c9D1b14Eece97",
  zammHooked: "0x000000000000040470635EB91b7CE4D132D616eD",
  zammHookless: "0x00000000000008882D72EfA6cCE4B6a40b24C860",
  rocketDepositPool: "0xCE15294273CFb9D9b628F4D61636623decDF4fdC",
  zorgDao: "0x5E58BA0e06ED0F5558f83bE732a4b899a674053E",
  zorgToken: "0x0000000000009710cd229bf635c4500029651ee8",
  zorgDaoToken: "0x00a6bA94BBb5474725515De88fE04F854f2dCb12",
  zorgPayToken: "0xe9b1cfea55baa219e34301f2f31b9fd0921664ed",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  steth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  reth: "0xae78736Cd615f374D3085123A210448E74Fc6393",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  bold: "0x6440f144b7e50D6a8439336510312d2F54beB01D",
  lusd: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
  pnkstr: "0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF",
  pnkstrHook: "0xfAaad5B731F52cDc9746F2414c823eca9B06E844",
  implementationMoloch: "0x643A45B599D81be3f3A68F37EB3De55fF10673C1",
  implementationShares: "0x71E9b38d301b5A58cb998C1295045FE276Acf600",
  implementationBadges: "0x47C175Ce83B6B931ccBedD5ce95e701984eD96d5",
  implementationLoot: "0x6f1f2aF76a3aDD953277e9F369242697C87bc6A5"
} as const;

const anvilPort = process.env.ANVIL_PORT ?? "8546";
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
const ipfsApi = process.env.IPFS_API ?? "http://127.0.0.1:5001";
const ipfsGateway = process.env.IPFS_GATEWAY ?? "http://127.0.0.1:8080";
const forkUrl = process.env.MAINNET_RPC_URL ?? "";

const publicClient = getPublicClient(rpcUrl) as AnvilClient;

const startTime = Date.now();
function logSection(title: string) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== ${title} [+${elapsed}s] ===`);
}

function runCmd(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; stream?: boolean } = {}
) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    if (options.capture) {
      child.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (options.stream !== false) {
          process.stdout.write(chunk);
        }
      });
      child.stderr?.on("data", (data) => {
        if (options.stream !== false) {
          process.stderr.write(data.toString());
        }
      });
    }

    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function runCli(
  args: string[],
  options: { noRpc?: boolean } = {}
) {
  const fullArgs = ["run", "src/index.ts", ...args];
  if (!options.noRpc) {
    fullArgs.push("--rpc", rpcUrl, "--devnet", devnetJsonPath);
  }
  fullArgs.push("--json");
  return runCmd("bun", fullArgs, { cwd: cliDir, capture: true });
}

function parseCliJson<T>(stdout: string, context: string): T {
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

function pickInstallCommand(baseDir: string): { command: string; args: string[] } | null {
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

function copyDirRecursive(sourceDir: string, destDir: string) {
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

function createStudioPackagingDir(devnet: DevnetJson): string {
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
      dappRegistry: devnet.dappRegistry
    }
  };
  fs.writeFileSync(vibefiJsonPath, `${JSON.stringify(vibefiJson, null, 2)}\n`);
  return tempDir;
}

function createZfiPackagingDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibefi-zfi-e2e-"));
  copyDirRecursive(zfiSourceDir, tempDir);
  const vibefiJsonPath = path.join(tempDir, "vibefi.json");
  const vibefiJson = {
    addresses: {
      mainnet: ZFI_MAINNET_ADDRESSES
    }
  };
  fs.writeFileSync(vibefiJsonPath, `${JSON.stringify(vibefiJson, null, 2)}\n`);
  return tempDir;
}

function decodeRootCid(rawRootCid: unknown): string {
  if (typeof rawRootCid !== "string") return "";
  if (!isHex(rawRootCid)) return rawRootCid;
  try {
    return hexToString(rawRootCid as Hex).replace(/\0+$/g, "");
  } catch {
    return rawRootCid;
  }
}

function extractPublishedDappIdFromExecuteReceipt(
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
        topics: log.topics as [Hex, ...Hex[]]
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

async function setStudioDappIdInDevnetJson(studioDappId: bigint) {
  const result = await runCmd(
    "bun",
    [
      path.join(contractsDir, "script", "set-devnet-studio-dapp-id.mjs"),
      "--file",
      devnetJsonPath,
      "--studio-dapp-id",
      studioDappId.toString()
    ],
    { cwd: contractsDir, capture: true }
  );
  if (result.code !== 0) {
    throw new Error("failed to update studioDappId in devnet.json");
  }
}

async function waitFor(
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
  console.log(`${label} not ready after ${timeoutMs}ms timeout`);
  return false;
}

async function ensureContractsDeployed() {
  const devnet = loadDevnetJson(devnetJsonPath);
  if (!devnet) return false;
  const code = await publicClient.getBytecode({ address: devnet.vfiGovernor as Hex });
  return (code ?? "0x") !== "0x";
}

async function main() {
  logSection("Prepare dapp examples");
  console.log("Ensuring nested dapp submodules are initialized...");
  const submoduleResult = await runCmd("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: dappExamplesDir,
    capture: true
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
      console.log(`[${target.key}] No package.json found, skipping dependency install.`);
      continue;
    }
    console.log(
      `[${target.key}] Running: ${installCommand.command} ${installCommand.args.join(" ")}`
    );
    const installResult = await runCmd(installCommand.command, installCommand.args, {
      cwd: target.dir,
      capture: true
    });
    if (installResult.code !== 0) {
      throw new Error(`dependency install failed for ${target.key}`);
    }
  }

  logSection("Start IPFS");
  await runCmd("docker", ["compose", "-f", path.join(process.cwd(), "docker-compose.ipfs.yml"), "up", "-d"], {
    capture: true
  });

  logSection("Start devnet");
  console.log(`Checking if anvil is already running on :${anvilPort}...`);
  const alreadyRunning = await waitFor("RPC", () => publicClient.getChainId().then(() => true), 2000);
  if (alreadyRunning) {
    console.log(`Anvil already running on :${anvilPort}, killing...`);
    await runCmd(
      "bash",
      ["-c", `lsof -t -i:${anvilPort} -a -c anvil | xargs kill -SIGTERM 2>/dev/null || true`],
      { capture: true, stream: false }
    );
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    console.log("No existing anvil found.");
  }

  console.log("Removing stale devnet.json...");
  fs.rmSync(devnetJsonPath, { force: true });

  let optionalForkingMessage = forkUrl ? ` with fork from ${forkUrl}` : "";
  console.log(`Starting local-devnet.sh${optionalForkingMessage}...`);
  spawn("./script/local-devnet.sh", [], {
    cwd: contractsDir,
    env: { ...process.env, ANVIL_PORT: anvilPort, MAINNET_RPC_URL: forkUrl },
    stdio: "inherit"
  }).unref();

  console.log(`Waiting for RPC at ${rpcUrl}...`);
  const rpcReady = await waitFor("RPC", async () => {
    const chainId = await publicClient.getChainId();
    console.log(`RPC responded with chainId=${chainId}`);
    return true;
  }, 30000);
  if (!rpcReady) {
    throw new Error(`RPC not ready at ${rpcUrl}`);
  }
  console.log("RPC is ready.");

  logSection("Check IPFS");
  console.log(`Checking IPFS at ${ipfsApi}...`);
  const ipfsReady = await waitFor("IPFS", async () => {
    const res = await fetch(new URL("/api/v0/version", ipfsApi).toString(), { method: "POST" });
    return res.ok;
  }, 8000);
  if (!ipfsReady) {
    throw new Error(`IPFS not ready at ${ipfsApi}.`);
  }
  console.log("IPFS is ready.");

  logSection("Wait for contracts");
  console.log("Waiting for VibeFi contracts to be deployed...");
  const deployTimeout = 120000;
  const deployStart = Date.now();
  let lastLog = 0;
  while (Date.now() - deployStart < deployTimeout) {
    if (await ensureContractsDeployed()) {
      console.log("Contracts deployed successfully.");
      break;
    }
    const elapsed = Date.now() - deployStart;
    if (elapsed - lastLog > 5000) {
      console.log(`Still waiting for contracts... (${Math.round(elapsed / 1000)}s elapsed)`);
      lastLog = elapsed;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await ensureContractsDeployed())) {
    throw new Error("Contracts not deployed after waiting for background devnet.");
  }

  const mnemonic = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";
  const devAccount = mnemonicToAccount(mnemonic);
  const walletClient = createWalletClient({
    account: devAccount,
    transport: http(rpcUrl)
  });

  logSection("Send sanity tx via viem");
  console.log("Sending sanity transaction...");
  const sanityTxHash = await walletClient.sendTransaction({
    chain: null,
    to: devAccount.address,
    value: 0n
  });
  console.log(`Sanity tx hash: ${sanityTxHash}`);
  await publicClient.waitForTransactionReceipt({ hash: sanityTxHash });
  console.log("Sanity tx confirmed.");

  logSection("CLI status");
  console.log("Running: vibefi status...");
  let result = await runCli(["status"]);
  if (result.code !== 0) throw new Error("status failed");

  logSection("List proposals");
  console.log("Running: vibefi proposals:list...");
  result = await runCli(["proposals:list"]);
  if (result.code !== 0) throw new Error("proposals:list failed");

  const devnet = loadDevnetJson(devnetJsonPath) as DevnetJson;
  let studioDappId: bigint | null = null;
  const cleanupDirs: string[] = [];

  for (const dapp of dapps) {
    const packagePath = dapp.key === "studio"
      ? createStudioPackagingDir(devnet)
      : dapp.key === "zfi"
        ? createZfiPackagingDir()
        : dapp.dir;
    if (dapp.key === "studio" || dapp.key === "zfi") {
      cleanupDirs.push(packagePath);
    }
    logSection(`Package dapp: ${dapp.name}`);
    console.log(`Running: vibefi package (${packagePath})...`);
    result = await runCli(
      ["package", "--path", packagePath, "--name", dapp.name, "--dapp-version", "0.0.1", "--description", dapp.description],
      { noRpc: true }
    );
    if (result.code !== 0) throw new Error(`package failed for ${dapp.name}`);
    const packageJson = parseCliJson<{ rootCid?: string }>(result.stdout || "", `package (${dapp.name})`);
    if (!packageJson.rootCid) throw new Error(`Missing rootCid from package for ${dapp.name}`);

    logSection(`Propose dapp: ${dapp.name}`);
    const proposalDescription = `E2E proposal ${dapp.name} ${Date.now()}`;
    console.log(`Running: vibefi dapp:propose (rootCid=${packageJson.rootCid})...`);
    result = await runCli([
      "dapp:propose",
      "--root-cid", packageJson.rootCid,
      "--name", dapp.name,
      "--dapp-version", "0.0.1",
      "--description", dapp.description,
      "--proposal-description", proposalDescription
    ]);
    if (result.code !== 0) throw new Error(`dapp:propose failed for ${dapp.name}`);
    const proposeJson = parseCliJson<{ txHash?: string }>(result.stdout || "", `dapp:propose (${dapp.name})`);
    if (!proposeJson.txHash) throw new Error(`Missing txHash from dapp:propose for ${dapp.name}`);

    logSection(`Mine block: ${dapp.name}`);
    console.log("Mining 1 block...");
    await publicClient.request({ method: "anvil_mine", params: [1] });
    console.log("Block mined.");

    logSection(`Fetch proposal id: ${dapp.name}`);
    console.log(`Waiting for tx receipt: ${proposeJson.txHash}...`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: proposeJson.txHash as Hex,
      timeout: 15000
    });
    console.log("Receipt received.");
    const governorAddress = devnet.vfiGovernor.toLowerCase();
    const proposalLog = (receipt.logs ?? []).find((log) => log.address.toLowerCase() === governorAddress);
    if (!proposalLog) throw new Error(`ProposalCreated log not found in receipt for ${dapp.name}`);
    const decoded = decodeEventLog({
      abi: governorAbi,
      data: proposalLog.data as Hex,
      topics: proposalLog.topics as [Hex, ...Hex[]]
    });
    const proposalId = ((decoded as unknown as { args: { proposalId: bigint } }).args).proposalId.toString();
    console.log(`Using proposalId=${proposalId}`);

    logSection(`Cast vote: ${dapp.name}`);
    console.log(`Running: vibefi vote:cast ${proposalId} --support for...`);
    result = await runCli(["vote:cast", proposalId, "--support", "for"]);
    if (result.code !== 0) throw new Error(`vote:cast failed for ${dapp.name}`);
    console.log("Vote cast.");

    logSection(`Mine blocks for voting period: ${dapp.name}`);
    console.log("Mining 25 blocks for voting period...");
    await publicClient.request({ method: "anvil_mine", params: [25] });
    console.log("Blocks mined.");

    logSection(`Vote status: ${dapp.name}`);
    console.log(`Running: vibefi vote:status ${proposalId}...`);
    result = await runCli(["vote:status", proposalId]);
    if (result.code !== 0) throw new Error(`vote:status failed for ${dapp.name}`);

    logSection(`Queue proposal: ${dapp.name}`);
    console.log(`Running: vibefi proposals:queue ${proposalId}...`);
    result = await runCli(["proposals:queue", proposalId]);
    if (result.code !== 0) throw new Error(`proposals:queue failed for ${dapp.name}`);
    const queueJson = parseCliJson<{ txHash?: string }>(result.stdout || "", `proposals:queue (${dapp.name})`);
    if (!queueJson.txHash) throw new Error(`Missing txHash from proposals:queue for ${dapp.name}`);

    logSection(`Advance time past timelock delay: ${dapp.name}`);
    console.log("Increasing time by 2s and mining 1 block...");
    await publicClient.request({ method: "evm_increaseTime", params: ["0x2"] });
    await publicClient.request({ method: "anvil_mine", params: [1] });
    console.log("Block mined.");

    logSection(`Execute proposal: ${dapp.name}`);
    console.log(`Running: vibefi proposals:execute ${proposalId}...`);
    result = await runCli(["proposals:execute", proposalId]);
    if (result.code !== 0) throw new Error(`proposals:execute failed for ${dapp.name}`);
    const executeJson = parseCliJson<{ txHash?: string }>(result.stdout || "", `proposals:execute (${dapp.name})`);
    if (!executeJson.txHash) throw new Error(`Missing txHash from proposals:execute for ${dapp.name}`);
    const executeReceipt = await publicClient.waitForTransactionReceipt({
      hash: executeJson.txHash as Hex,
      timeout: 15000
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
      await setStudioDappIdInDevnetJson(maybeStudioDappId);
      studioDappId = maybeStudioDappId;
      console.log(`Stored studioDappId=${studioDappId.toString()} in ${devnetJsonPath}`);
    }

    logSection(`Fetch dapp bundle: ${dapp.name}`);
    console.log(`Running: vibefi dapp:fetch --root-cid ${packageJson.rootCid}...`);
    result = await runCli(
      [
        "dapp:fetch",
        "--root-cid", packageJson.rootCid,
        "--out", path.join(cliDir, ".vibefi", "cache", packageJson.rootCid),
        "--ipfs-api", ipfsApi,
        "--ipfs-gateway", ipfsGateway
      ],
      { noRpc: true }
    );
    if (result.code !== 0) throw new Error(`dapp:fetch failed for ${dapp.name}`);
    console.log(`Dapp bundle for ${dapp.name} fetched and verified.`);
  }

  logSection("Dapp list");
  console.log("Running: vibefi dapp:list...");
  result = await runCli(["dapp:list"]);
  if (result.code !== 0) throw new Error("dapp:list failed");
  const dappList = parseCliJson<Array<{
    dappId?: string;
    name?: string;
    status?: string;
    rootCid?: string;
  }>>(result.stdout || "", "dapp:list");
  console.log(`Found ${dappList.length} dapp(s) in registry.`);
  if (dappList.length < dapps.length) throw new Error(`Expected at least ${dapps.length} dapps, found ${dappList.length}`);
  if (studioDappId === null) {
    throw new Error("Studio dappId was not captured");
  }
  const studioEntry = dappList.find((entry) => entry.dappId === studioDappId?.toString());
  if (!studioEntry) {
    throw new Error(`Studio dappId ${studioDappId.toString()} not found in dapp:list output`);
  }
  if (studioEntry.status !== "Published") {
    throw new Error(`Studio dappId ${studioDappId.toString()} status is ${studioEntry.status}`);
  }
  if (!studioEntry.rootCid) {
    throw new Error(`Studio dappId ${studioDappId.toString()} is missing rootCid`);
  }
  const updatedDevnet = loadDevnetJson(devnetJsonPath) as DevnetJson;
  if (!updatedDevnet.studioDappId || updatedDevnet.studioDappId !== Number(studioDappId)) {
    throw new Error(`devnet.json studioDappId was not persisted correctly`);
  }

  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nAnvil left running on :${anvilPort}`);
  console.log("E2E test completed successfully.");
}

main().catch((err) => {
  console.error("E2E test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
