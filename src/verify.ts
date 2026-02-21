import { loadDevnetJson, type DevnetJson } from "@vibefi/shared";
import type { E2eConfig } from "./config";
import { logSection, runCli, parseCliJson } from "./utils";
import { logger } from "./logger";

export async function verifyRegistry(
  config: E2eConfig,
  expectedCount: number,
  studioDappId: bigint
) {
  logSection("Dapp list");
  logger.debug("Running: vibefi dapp:list...");
  const result = await runCli(config, ["dapp:list"]);
  if (result.code !== 0) throw new Error("dapp:list failed");
  const dappList = parseCliJson<
    Array<{
      dappId?: string;
      name?: string;
      status?: string;
      rootCid?: string;
    }>
  >(result.stdout || "", "dapp:list");
  logger.info("Found %s dapp(s) in registry.", dappList.length);
  if (dappList.length < expectedCount)
    throw new Error(
      `Expected at least ${expectedCount} dapps, found ${dappList.length}`
    );

  const studioEntry = dappList.find(
    (entry) => entry.dappId === studioDappId.toString()
  );
  if (!studioEntry) {
    throw new Error(
      `Studio dappId ${studioDappId.toString()} not found in dapp:list output`
    );
  }
  if (studioEntry.status !== "Published") {
    throw new Error(
      `Studio dappId ${studioDappId.toString()} status is ${studioEntry.status}`
    );
  }
  if (!studioEntry.rootCid) {
    throw new Error(
      `Studio dappId ${studioDappId.toString()} is missing rootCid`
    );
  }

  const updatedDevnet = loadDevnetJson(config.devnetJsonPath) as DevnetJson;
  if (!updatedDevnet.testNetwork) {
    throw new Error(
      `Updated ${config.devnetJsonPath} is missing testNetwork=true`
    );
  }
  if (
    !updatedDevnet.studioDappId ||
    updatedDevnet.studioDappId !== Number(studioDappId)
  ) {
    throw new Error("devnet.json studioDappId was not persisted correctly");
  }
}
