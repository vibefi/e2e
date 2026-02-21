import "dotenv/config";
import fs from "node:fs";
import { buildConfig } from "./config";
import { prepareDappExamples, startInfrastructure, runSanityChecks } from "./setup";
import { publishAllDapps } from "./dapp-publish";
import { verifyRegistry } from "./verify";
import { testGovernanceAgent } from "./gov-agent";

async function main() {
  const config = buildConfig(process.argv.slice(2));

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

  console.log(`\nAnvil left running on :${config.anvilPort}`);
  console.log("E2E test completed successfully.");
}

main().catch((err) => {
  console.error("E2E test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
