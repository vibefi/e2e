import "dotenv/config";
import fs from "node:fs";
import { buildConfig } from "./config";
import { prepareDappExamples, startInfrastructure, runSanityChecks } from "./setup";
import { publishAllDapps } from "./dapp-publish";
import { verifyRegistry } from "./verify";
import { testGovernanceAgent } from "./gov-agent";
import { configureLogger, logger } from "./logger";

async function main() {
  const config = buildConfig(process.argv.slice(2));
  configureLogger({
    verbosity: config.verbosity,
    streamToolOutput: config.streamToolOutput,
  });
  logger.info(
    "Starting E2E run (verbosity=%s, toolOutput=%s)",
    config.verbosity,
    config.streamToolOutput ? "on" : "off"
  );

  await prepareDappExamples(config);
  await startInfrastructure(config);
  await runSanityChecks(config);

  const { studioDappId, cleanupDirs } = await publishAllDapps(config);
  await verifyRegistry(config, 5, studioDappId);

  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (config.useGovAgent) {
    await testGovernanceAgent(config);
  }

  logger.info("Anvil left running on :%s", config.anvilPort);
  logger.info("E2E test completed successfully.");
}

main().catch((err) => {
  logger.error("E2E test failed: %s", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    logger.debug("%s", err.stack);
  }
  process.exitCode = 1;
});
