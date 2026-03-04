import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { initConfig, config } from "./config";
import { configureLogger, logger } from "./logger";
import { proposeDapp } from "./governance";
import { packageDapp } from "./packaging";
import { ensureContractsDeployed, logSection } from "./utils";
import { startInfrastructure } from "./setup";

type SupportedBundle = "red_team_vapp" | "malicious_uniswapv2";

interface BundleMetadata {
  name: string;
  version: string;
  description: string;
}

const BUNDLES: Record<SupportedBundle, BundleMetadata> = {
  red_team_vapp: {
    name: "Red Team vApp",
    version: "0.0.1",
    description: "Red-team security test bundle",
  },
  malicious_uniswapv2: {
    name: "Malicious Uniswap V2",
    version: "0.0.1",
    description: "Malicious Uniswap-style security test bundle",
  },
};

async function main() {
  const args = process.argv.slice(2);
  initConfig(args);
  const { verbosity, streamToolOutput, monorepoDir } = config();
  configureLogger({ verbosity, streamToolOutput });

  const bundleKey = parseBundleArg(args);
  const bundle = BUNDLES[bundleKey];
  const bundleDir = path.join(
    monorepoDir,
    "gov-agent",
    "testdata",
    "bundles",
    bundleKey
  );

  if (!fs.existsSync(bundleDir)) {
    throw new Error(`bundle directory not found: ${bundleDir}`);
  }

  logSection(`Publish test bundle: ${bundleKey}`);
  logger.info("Bundle path: %s", bundleDir);

  const deployed = await detectDeployedContracts();
  if (!deployed) {
    logger.info("Contracts not detected. Starting infrastructure...");
    await startInfrastructure();
  } else {
    logger.info("Contracts already deployed. Reusing running infrastructure.");
  }

  const { rootCid } = await packageDapp({
    packagePath: bundleDir,
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    cliContext: `package (${bundleKey})`,
  });

  logSection("Propose bundle");
  const { proposalId } = await proposeDapp({
    rootCid,
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    proposalDescription: `Security test proposal ${bundleKey} ${Date.now()}`,
  });

  logger.info("Created proposal %s for bundle %s", proposalId, bundleKey);
  logger.info("Root CID: %s", rootCid);

  // Keep output machine-friendly for quick copy into other tools.
  console.log(
    JSON.stringify(
      {
        bundle: bundleKey,
        proposalId,
        rootCid,
      },
      null,
      2
    )
  );
}

function parseBundleArg(args: string[]): SupportedBundle {
  if (args.length !== 1 || args[0].startsWith("-")) {
    throw new Error(
      `Invalid usage. Expected: bun run publish:test-bundle <bundle>. Valid bundles: ${Object.keys(
        BUNDLES
      ).join(", ")}`
    );
  }

  const candidate = args[0];
  if (candidate in BUNDLES) {
    return candidate as SupportedBundle;
  }

  throw new Error(
    `Invalid bundle "${candidate}". Valid bundles: ${Object.keys(BUNDLES).join(", ")}`
  );
}

async function detectDeployedContracts(): Promise<boolean> {
  try {
    return await ensureContractsDeployed();
  } catch (err) {
    logger.warn(
      "Could not determine deployment state (%s). Will start infrastructure.",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

main().catch((err) => {
  logger.error("%s", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
