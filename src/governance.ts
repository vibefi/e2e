import { decodeEventLog, type Hex } from "viem";
import { governorAbi, loadDevnetJson } from "@vibefi/shared";
import { config, publicClient } from "./config";
import { logSection, runCli, runCliJson, parseCliJson } from "./utils";
import { logger } from "./logger";

/**
 * Propose a dapp through the governor contract.
 * Mines 1 block, waits for the receipt, and decodes the ProposalCreated event.
 */
export async function proposeDapp(opts: {
  rootCid: string;
  name: string;
  version: string;
  description: string;
  proposalDescription: string;
}) {
  logSection(`Propose dapp: ${opts.name}`);
  logger.debug("Running: vibefi dapp:propose (rootCid=%s)...", opts.rootCid);
  const proposeJson = await runCliJson<{ txHash?: string }>([
    "dapp:propose",
    "--root-cid",
    opts.rootCid,
    "--name",
    opts.name,
    "--dapp-version",
    opts.version,
    "--description",
    opts.description,
    "--proposal-description",
    opts.proposalDescription,
  ], `dapp:propose (${opts.name})`);
  if (!proposeJson.txHash)
    throw new Error(`Missing txHash from dapp:propose for ${opts.name}`);

  const { proposalId, receipt } = await waitForProposalIdFromTxHash(
    proposeJson.txHash,
    opts.name
  );

  return { proposalId, receipt };
}

export async function proposeUpgradeDapp(opts: {
  dappId: string | bigint;
  rootCid: string;
  name: string;
  version: string;
  description: string;
  proposalDescription: string;
}) {
  const dappId =
    typeof opts.dappId === "bigint" ? opts.dappId.toString() : opts.dappId.trim();
  if (!dappId) throw new Error("dappId is required for dapp:upgrade");

  logSection(`Propose upgrade: ${opts.name}`);
  logger.debug(
    "Running: vibefi dapp:upgrade (dappId=%s rootCid=%s)...",
    dappId,
    opts.rootCid
  );
  const proposeJson = await runCliJson<{ txHash?: string }>([
    "dapp:upgrade",
    "--dapp-id",
    dappId,
    "--root-cid",
    opts.rootCid,
    "--name",
    opts.name,
    "--dapp-version",
    opts.version,
    "--description",
    opts.description,
    "--proposal-description",
    opts.proposalDescription,
  ], `dapp:upgrade (${opts.name})`);
  if (!proposeJson.txHash) {
    throw new Error(`Missing txHash from dapp:upgrade for ${opts.name}`);
  }

  const { proposalId, receipt } = await waitForProposalIdFromTxHash(
    proposeJson.txHash,
    `${opts.name} upgrade`
  );
  return { proposalId, receipt };
}

async function waitForProposalIdFromTxHash(
  txHash: string,
  label: string
): Promise<{ proposalId: string; receipt: Awaited<ReturnType<ReturnType<typeof publicClient>["waitForTransactionReceipt"]>> }> {
  logSection(`Mine block: ${label}`);
  logger.debug("Mining 1 block...");
  await publicClient().request({ method: "anvil_mine", params: [1] });
  logger.debug("Block mined.");

  logSection(`Fetch proposal id: ${label}`);
  logger.debug("Waiting for tx receipt: %s...", txHash);
  const receipt = await publicClient().waitForTransactionReceipt({
    hash: txHash as Hex,
    timeout: 15000,
  });
  logger.debug("Receipt received.");

  const devnet = loadDevnetJson(config().devnetJsonPath);
  const governorAddress = devnet!.vfiGovernor.toLowerCase();
  const proposalLog = (receipt.logs ?? []).find(
    (log) => log.address.toLowerCase() === governorAddress
  );
  if (!proposalLog) {
    throw new Error(`ProposalCreated log not found in receipt for ${label}`);
  }
  const decoded = decodeEventLog({
    abi: governorAbi,
    data: proposalLog.data as Hex,
    topics: proposalLog.topics as [Hex, ...Hex[]],
  });
  const proposalId = (
    (decoded as unknown as { args: { proposalId: bigint } }).args
  ).proposalId.toString();
  logger.info("Proposal id: %s", proposalId);

  return { proposalId, receipt };
}

/** Cast a vote on a proposal via the CLI. */
export async function castVote(
  proposalId: string,
  support: "for" | "against" | "abstain" = "for"
) {
  logger.debug("Running: vibefi vote:cast %s --support %s...", proposalId, support);
  const result = await runCli(["vote:cast", proposalId, "--support", support]);
  if (result.code !== 0) throw new Error(`vote:cast failed for proposal ${proposalId}`);
  logger.debug("Vote cast.");
}

/**
 * Complete a governance cycle after voting: mine past voting period,
 * queue the proposal, advance past the timelock delay, and execute.
 */
export async function queueAndExecute(proposalId: string) {
  logSection("Mine blocks for voting period");
  logger.debug("Mining 25 blocks for voting period...");
  await publicClient().request({ method: "anvil_mine", params: [25] });
  logger.debug("Blocks mined.");

  logSection("Queue proposal");
  logger.debug("Running: vibefi proposals:queue %s...", proposalId);
  const queueJson = await runCliJson<{ txHash?: string }>(
    ["proposals:queue", proposalId],
    "proposals:queue"
  );
  if (!queueJson.txHash) throw new Error("Missing txHash from proposals:queue");

  logSection("Advance time past timelock delay");
  logger.debug("Increasing time by 2s and mining 1 block...");
  await publicClient().request({ method: "evm_increaseTime", params: ["0x2"] });
  await publicClient().request({ method: "anvil_mine", params: [1] });
  logger.debug("Block mined.");

  logSection("Execute proposal");
  logger.debug("Running: vibefi proposals:execute %s...", proposalId);
  const executeJson = await runCliJson<{ txHash?: string }>(
    ["proposals:execute", proposalId],
    "proposals:execute"
  );
  if (!executeJson.txHash) throw new Error("Missing txHash from proposals:execute");
  const executeReceipt = await publicClient().waitForTransactionReceipt({
    hash: executeJson.txHash as Hex,
    timeout: 15000,
  });

  return { executeReceipt };
}
