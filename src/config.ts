import path from "node:path";
import { getPublicClient } from "@vibefi/shared";

export type AnvilClient = ReturnType<typeof getPublicClient> & {
  request(args: { method: "anvil_mine"; params: [number] }): Promise<void>;
  request(args: { method: "evm_increaseTime"; params: [string] }): Promise<void>;
};

export interface DappEntry {
  key: string;
  dir: string;
  name: string;
  description: string;
}

export interface InstallTarget {
  key: string;
  dir: string;
}

export interface E2eConfig {
  monorepoDir: string;
  contractsDir: string;
  cliDir: string;
  studioDir: string;
  dappExamplesDir: string;
  zfiSourceDir: string;
  devnetJsonPath: string;
  anvilPort: string;
  rpcUrl: string;
  ipfsApi: string;
  ipfsGateway: string;
  forkUrl: string;
  chainId: string;
  useSepolia: boolean;
  useGovAgent: boolean;
  verbosity: E2eVerbosity;
  streamToolOutput: boolean;
  publicClient: AnvilClient;
  dapps: DappEntry[];
  dappInstallTargets: InstallTarget[];
}

export type E2eVerbosity = "quiet" | "normal" | "verbose";

function parseVerbosity(argv: string[]): E2eVerbosity {
  const quietFlag = argv.includes("--quiet") || argv.includes("-q");
  const verboseFlag = argv.includes("--verbose") || argv.includes("-v");
  const verbosityOptionPrefix = "--verbosity=";
  let verbosityOption: E2eVerbosity | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verbosity") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --verbosity (expected quiet|normal|verbose)");
      }
      if (value !== "quiet" && value !== "normal" && value !== "verbose") {
        throw new Error(`Invalid --verbosity value: ${value}`);
      }
      verbosityOption = value;
      index += 1;
      continue;
    }
    if (arg.startsWith(verbosityOptionPrefix)) {
      const value = arg.slice(verbosityOptionPrefix.length);
      if (value !== "quiet" && value !== "normal" && value !== "verbose") {
        throw new Error(`Invalid --verbosity value: ${value}`);
      }
      verbosityOption = value;
    }
  }

  if (verbosityOption && (quietFlag || verboseFlag)) {
    throw new Error("Use either --verbosity or --quiet/--verbose flags, not both");
  }
  if (quietFlag && verboseFlag) {
    throw new Error("Use either --quiet or --verbose, not both");
  }
  if (verbosityOption) {
    return verbosityOption;
  }
  if (quietFlag) {
    return "quiet";
  }
  if (verboseFlag) {
    return "verbose";
  }
  return "normal";
}

export function buildConfig(argv: string[]): E2eConfig {
  const monorepoDir = process.env.MONOREPO_DIR;
  if (!monorepoDir) {
    throw new Error("MONOREPO_DIR is required (absolute path to the monorepo)");
  }

  const contractsDir = path.join(monorepoDir, "contracts");
  const cliDir = path.join(monorepoDir, "cli");
  const studioDir = path.join(monorepoDir, "studio");
  const dappExamplesDir = path.join(monorepoDir, "dapp-examples");
  const zfiSourceDir = path.join(dappExamplesDir, "zfi", "dapp");

  const useSepolia = argv.includes("--sepolia");
  const useGovAgent = argv.includes("--gov-agent");
  const verbosity = parseVerbosity(argv);
  const streamToolOutput =
    argv.includes("--tool-output") || argv.includes("--show-tool-output");

  const anvilPort = process.env.ANVIL_PORT ?? "8546";
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  const ipfsApi = process.env.IPFS_API ?? "http://127.0.0.1:5001";
  const ipfsGateway = process.env.IPFS_GATEWAY ?? "http://127.0.0.1:8080";
  const mainnetForkUrl = process.env.MAINNET_RPC_URL ?? "";
  const sepoliaForkUrl = process.env.SEPOLIA_RPC_URL ?? "";
  const forkUrl = useSepolia ? sepoliaForkUrl : mainnetForkUrl;
  const chainId = useSepolia ? "11155111" : "1";

  const publicClient = getPublicClient(rpcUrl) as AnvilClient;

  const dappInstallTargets: InstallTarget[] = [
    { key: "uniswap-v2", dir: path.join(dappExamplesDir, "uniswap-v2") },
    { key: "aave-v3", dir: path.join(dappExamplesDir, "aave-v3") },
    { key: "safe-admin", dir: path.join(dappExamplesDir, "safe-admin") },
    { key: "zfi", dir: zfiSourceDir },
  ];

  const dapps: DappEntry[] = [
    { key: "studio", dir: studioDir, name: "Studio", description: "VibeFi governance studio" },
    { key: "uniswap-v2", dir: path.join(dappExamplesDir, "uniswap-v2"), name: "Uniswap V2", description: "Uniswap V2 example" },
    { key: "aave-v3", dir: path.join(dappExamplesDir, "aave-v3"), name: "Aave V3", description: "Aave V3 example" },
    { key: "safe-admin", dir: path.join(dappExamplesDir, "safe-admin"), name: "Safe Admin", description: "Safe admin example" },
    { key: "zfi", dir: zfiSourceDir, name: "zFi", description: "zFi static dapp" },
  ];

  return {
    monorepoDir,
    contractsDir,
    cliDir,
    studioDir,
    dappExamplesDir,
    zfiSourceDir,
    devnetJsonPath: path.join(contractsDir, ".devnet", "devnet.json"),
    anvilPort,
    rpcUrl,
    ipfsApi,
    ipfsGateway,
    forkUrl,
    chainId,
    useSepolia,
    useGovAgent,
    verbosity,
    streamToolOutput,
    publicClient,
    dapps,
    dappInstallTargets,
  };
}
