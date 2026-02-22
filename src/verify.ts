import { loadDevnetJson, type DevnetJson } from "@vibefi/shared";
import { config } from "./config";
import { logSection, runCli, runCliJson, parseCliJson } from "./utils";
import { expect } from "bun:test";
import { logger } from "./logger";

export async function verifyRegistry(
  expectedCount: number,
  studioDappId: bigint
) {
  const { devnetJsonPath } = config();

  logSection("Dapp list");
  logger.debug("Running: vibefi dapp:list...");
  const dappList = await runCliJson<
    Array<{
      dappId?: string;
      name?: string;
      status?: string;
      rootCid?: string;
    }>
  >(["dapp:list"], "dapp:list");
  logger.info("Found %s dapp(s) in registry.", dappList.length);
  expect(dappList.length).toBeGreaterThanOrEqual(expectedCount);

  const studioEntry = dappList.find(
    (entry) => entry.dappId === studioDappId.toString()
  );
  expect(studioEntry).toBeDefined();
  expect(studioEntry!.status).toBe("Published");
  expect(studioEntry!.rootCid).toBeDefined();

  const updatedDevnet = loadDevnetJson(devnetJsonPath) as DevnetJson;
  expect(updatedDevnet.testNetwork).toBe(true);
  expect(updatedDevnet.studioDappId).toBeDefined();
  expect(updatedDevnet.studioDappId).toBe(Number(studioDappId));
}
