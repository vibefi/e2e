import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const monorepoDir = process.env.MONOREPO_DIR;
if (!monorepoDir) {
  throw new Error("MONOREPO_DIR is required (absolute path to the monorepo)");
}

const contractsDir = path.join(monorepoDir, "contracts");
const cliDir = path.join(monorepoDir, "cli");
const dappExampleDir = path.join(monorepoDir, "dapp-examples", "uniswap-v2-example");
const devnetJson = path.join(contractsDir, ".devnet", "devnet.json");

const anvilPort = process.env.ANVIL_PORT ?? "8546";
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
const ipfsApi = process.env.IPFS_API ?? "http://127.0.0.1:5001";
const ipfsGateway = process.env.IPFS_GATEWAY ?? "http://127.0.0.1:8080";
const forkUrl = process.env.MAINNET_FORK_URL ?? "";

const publicClient = createPublicClient({ transport: http(rpcUrl) });

type DevnetConfig = {
  vfiGovernor: string;
};

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

async function waitForRpc(timeoutMs: number) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      attempts++;
      const chainId = await publicClient.getChainId();
      console.log(`RPC responded with chainId=${chainId} after ${attempts} attempts`);
      return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`RPC not ready after ${attempts} attempts (${timeoutMs}ms timeout)`);
  return false;
}

async function waitForIpfs(timeoutMs: number) {
  const start = Date.now();
  const url = new URL("/api/v0/version", ipfsApi);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url.toString(), { method: "POST" });
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function getCode(address: string): Promise<string> {
  return publicClient.getBytecode({ address: address as Hex }).then((code) => code ?? "0x");
}

async function ensureContractsDeployed() {
  if (!fs.existsSync(devnetJson)) return false;
  const devnet = JSON.parse(fs.readFileSync(devnetJson, "utf-8")) as DevnetConfig;
  const code = await getCode(devnet.vfiGovernor);
  return code !== "0x";
}

async function main() {
  logSection("Start IPFS");
  await runCmd("docker", ["compose", "-f", path.join(process.cwd(), "docker-compose.ipfs.yml"), "up", "-d"], {
    capture: true
  });

  logSection("Start devnet");
  console.log(`Checking if anvil is already running on :${anvilPort}...`);
  if (await waitForRpc(2000)) {
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
  fs.rmSync(devnetJson, { force: true });

  console.log("Starting local-devnet.sh (forking mainnet if configured)...");
  spawn("./script/local-devnet.sh", [], {
    cwd: contractsDir,
    env: { ...process.env, ANVIL_PORT: anvilPort, FORK_URL: forkUrl },
    stdio: "inherit"
  }).unref();

  console.log(`Waiting for RPC at ${rpcUrl}...`);
  const rpcReady = await waitForRpc(30000);
  if (!rpcReady) {
    throw new Error(`RPC not ready at ${rpcUrl}`);
  }
  console.log("RPC is ready.");

  logSection("Check IPFS");
  console.log(`Checking IPFS at ${ipfsApi}...`);
  const ipfsReady = await waitForIpfs(8000);
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
    to: devAccount.address,
    value: 0n
  });
  console.log(`Sanity tx hash: ${sanityTxHash}`);
  await publicClient.waitForTransactionReceipt({ hash: sanityTxHash });
  console.log("Sanity tx confirmed.");

  logSection("CLI status");
  console.log("Running: vibefi status...");
  let result = await runCmd(
    "bun",
    ["run", "src/index.ts", "status", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("status failed");

  logSection("List proposals");
  console.log("Running: vibefi proposals:list...");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:list", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:list failed");

  logSection("Package dapp");
  console.log(`Running: vibefi package (${dappExampleDir})...`);
  result = await runCmd(
    "bun",
    [
      "run",
      "src/index.ts",
      "package",
      "--path",
      dappExampleDir,
      "--name",
      "Uniswap V2",
      "--dapp-version",
      "0.0.1",
      "--description",
      "Uniswap V2 example",
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("package failed");
  const packageJson = JSON.parse(result.stdout || "{}") as { rootCid?: string };
  if (!packageJson.rootCid) throw new Error("Missing rootCid from package");

  logSection("Propose dapp");
  const proposalDescription = `E2E proposal ${Date.now()}`;
  console.log(`Running: vibefi dapp:propose (rootCid=${packageJson.rootCid})...`);
  result = await runCmd(
    "bun",
    [
      "run",
      "src/index.ts",
      "dapp:propose",
      "--rpc",
      rpcUrl,
      "--devnet",
      devnetJson,
      "--root-cid",
      packageJson.rootCid,
      "--name",
      "Uniswap V2",
      "--dapp-version",
      "0.0.1",
      "--description",
      "Uniswap V2 example",
      "--proposal-description",
      proposalDescription,
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:propose failed");
  const proposeJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!proposeJson.txHash) throw new Error("Missing txHash from dapp:propose");

  logSection("Mine block");
  console.log("Mining 1 block...");
  await publicClient.request({ method: "anvil_mine", params: [1] });
  console.log("Block mined.");

  logSection("Fetch proposal id");
  console.log("Reading devnet config...");
  const devnet = JSON.parse(fs.readFileSync(devnetJson, "utf-8")) as DevnetConfig;
  console.log(`Waiting for tx receipt: ${proposeJson.txHash}...`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: proposeJson.txHash as Hex,
    timeout: 15000
  });
  console.log("Receipt received.");
  const governorAddress = devnet.vfiGovernor.toLowerCase();
  const proposalLog = (receipt.logs ?? []).find((log) => log.address.toLowerCase() === governorAddress);
  if (!proposalLog) throw new Error("ProposalCreated log not found in receipt");
  const governorAbi = JSON.parse(
    fs.readFileSync(path.join(cliDir, "src", "abis", "VfiGovernor.json"), "utf-8")
  );
  const decoded = decodeEventLog({
    abi: governorAbi,
    data: proposalLog.data as Hex,
    topics: proposalLog.topics as Hex[]
  });
  const proposalId = (decoded.args as { proposalId: bigint }).proposalId.toString();
  console.log(`Using proposalId=${proposalId}`);

  logSection("Cast vote");
  console.log(`Running: vibefi vote:cast ${proposalId} --support for...`);
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "vote:cast", proposalId, "--support", "for", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("vote:cast failed");
  console.log("Vote cast.");

  logSection("Mine blocks for voting period");
  console.log("Mining 25 blocks for voting period...");
  await publicClient.request({ method: "anvil_mine", params: [25] });
  console.log("Blocks mined.");

  logSection("Vote status");
  console.log(`Running: vibefi vote:status ${proposalId}...`);
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "vote:status", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("vote:status failed");

  logSection("Queue proposal");
  console.log(`Running: vibefi proposals:queue ${proposalId}...`);
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:queue", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:queue failed");
  const queueJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!queueJson.txHash) throw new Error("Missing txHash from proposals:queue");

  logSection("Mine block for timelock");
  console.log("Mining 1 block for timelock...");
  await publicClient.request({ method: "anvil_mine", params: [1] });
  console.log("Block mined.");

  logSection("Execute proposal");
  console.log(`Running: vibefi proposals:execute ${proposalId}...`);
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:execute", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:execute failed");
  const executeJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!executeJson.txHash) throw new Error("Missing txHash from proposals:execute");

  logSection("Dapp list");
  console.log("Running: vibefi dapp:list...");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "dapp:list", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:list failed");
  const dappList = JSON.parse(result.stdout || "[]") as Array<{ rootCid?: string }>;
  const latest = dappList[dappList.length - 1];
  if (!latest?.rootCid) throw new Error("Missing rootCid from dapp:list");
  console.log(`Found ${dappList.length} dapp(s). Latest rootCid: ${latest.rootCid}`);

  logSection("Fetch dapp bundle");
  console.log(`Running: vibefi dapp:fetch --root-cid ${latest.rootCid}...`);
  result = await runCmd(
    "bun",
    [
      "run",
      "src/index.ts",
      "dapp:fetch",
      "--root-cid",
      latest.rootCid,
      "--out",
      path.join(cliDir, ".vibefi", "cache", latest.rootCid),
      "--ipfs-api",
      ipfsApi,
      "--ipfs-gateway",
      ipfsGateway,
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:fetch failed");
  console.log("Dapp bundle fetched and verified.");

  console.log(`\nAnvil left running on :${anvilPort}`);
  console.log("E2E test completed successfully.");
}

main().catch((err) => {
  console.error("E2E test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
