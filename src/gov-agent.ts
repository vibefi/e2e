import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDevnetJson } from "@vibefi/shared";
import { config, publicClient } from "./config";
import { proposeDapp, castVote, queueAndExecute } from "./governance";
import { logSection, runCmd, runCli, runCliJson, parseCliJson } from "./utils";
import { expect } from "bun:test";
import { logger } from "./logger";
import { assertCommandSuccess } from "./assertions";

// SECURITY: Test-only key from Hardhat/Foundry defaults. Never use in production or with real funds.
const VOTER1_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
// SECURITY: Test-only keystore password for E2E tests. Never use in production or with real funds.
const KEYSTORE_PASSWORD = "e2e-test-password";

export async function testGovernanceAgent() {
  logSection("Governance agent test");

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required for --gov-agent. Set it in your environment."
    );
  }

  const { monorepoDir, dappExamplesDir, anvilPort, devnetJsonPath } = config();
  const tmpKeystoreDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibefi-gov-keystore-")
  );
  const tmpDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibefi-gov-data-")
  );
  const govAgentDir = path.join(monorepoDir, "gov-agent");

  try {
    // --- create temp keystore for voter1 ---
    logSection("Create voter1 keystore");
    logger.debug("Importing voter1 private key into temp keystore...");
    const importResult = await runCmd(
      "cast",
      [
        "wallet",
        "import",
        "gov-e2e-voter",
        "--private-key",
        VOTER1_PRIVATE_KEY,
        "--unsafe-password",
        KEYSTORE_PASSWORD,
        "--keystore-dir",
        tmpKeystoreDir,
      ],
      { capture: true }
    );
    assertCommandSuccess(importResult, "cast wallet import (gov-agent)");
    const keystorePath = path.join(tmpKeystoreDir, "gov-e2e-voter");
    logger.debug("Keystore created at %s", keystorePath);

    // --- package test dapp (uniswap-v2 v0.0.2) ---
    logSection("Package gov-agent test dapp");
    const uniswapDir = path.join(dappExamplesDir, "uniswap-v2");
    logger.debug("Running: vibefi package (uniswap-v2 v0.0.2)...");
    const packageJson = await runCliJson<{ rootCid?: string }>(
      [
        "package",
        "--path",
        uniswapDir,
        "--name",
        "Uniswap V2",
        "--dapp-version",
        "0.0.2",
        "--description",
        "Gov agent e2e test dapp",
      ],
      "package (gov-agent)",
      { noRpc: true }
    );
    expect(packageJson.rootCid).toBeDefined();

    const { proposalId, receipt: proposeReceipt } = await proposeDapp({
      rootCid: packageJson.rootCid!,
      name: "Uniswap V2",
      version: "0.0.2",
      description: "Gov agent e2e test dapp",
      proposalDescription: `Gov-agent E2E proposal ${Date.now()}`,
    });

    const proposalCreatedBlock = proposeReceipt.blockNumber;
    expect(proposalCreatedBlock).toBeDefined();
    expect(proposalCreatedBlock).not.toBeNull();

    // --- mine past voting delay ---
    logSection("Mine past voting delay");
    logger.debug("Mining 2 blocks...");
    await publicClient().request({ method: "anvil_mine", params: [2] });
    logger.debug("Blocks mined.");

    const fromBlock = proposalCreatedBlock;
    logger.info(
      "Using fromBlock=%s (proposal creation block) for GOV_AGENT_FROM_BLOCK",
      fromBlock
    );

    // --- capture pre-vote status ---
    logSection("Pre-vote status");
    logger.debug("Running: vibefi vote:status %s...", proposalId);
    const preVoteStatus = await runCliJson<{
      forVotes?: string;
      againstVotes?: string;
      abstainVotes?: string;
    }>(["vote:status", proposalId], "vote:status (pre-vote)");
    logger.debug(
      "Pre-vote: for=%s against=%s abstain=%s",
      preVoteStatus.forVotes ?? "0",
      preVoteStatus.againstVotes ?? "0",
      preVoteStatus.abstainVotes ?? "0"
    );

    // --- run gov-agent ---
    logSection("Run governance agent");
    logger.debug("Running: cargo run -- run --once --auto-vote ...");
    const agentResult = await runCmd(
      "cargo",
      [
        "run",
        "--",
        "run",
        "--once",
        "--auto-vote",
        "--rpc-url",
        `ws://127.0.0.1:${anvilPort}`,
      ],
      {
        cwd: govAgentDir,
        capture: true,
        env: {
          GOV_AGENT_FROM_BLOCK: fromBlock.toString(),
          GOV_AGENT_DEVNET_JSON: devnetJsonPath,
          GOV_AGENT_KEYSTORE_PATH: keystorePath,
          GOV_AGENT_KEYSTORE_PASSWORD: KEYSTORE_PASSWORD,
          GOV_AGENT_DATA_DIR: tmpDataDir,
          GOV_AGENT_DECISION_PROFILE: "balanced",
          GOV_AGENT_MIN_VOTE_BLOCKS_REMAINING: "1",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
        },
      }
    );
    assertCommandSuccess(agentResult, "cargo run gov-agent");
    logger.info("Gov-agent completed.");

    // --- verify vote was cast ---
    logSection("Post-vote status");
    logger.debug("Running: vibefi vote:status %s...", proposalId);
    const postVoteStatus = await runCliJson<{
      forVotes?: string;
      againstVotes?: string;
      abstainVotes?: string;
    }>(["vote:status", proposalId], "vote:status (post-vote)");
    logger.debug(
      "Post-vote: for=%s against=%s abstain=%s",
      postVoteStatus.forVotes ?? "0",
      postVoteStatus.againstVotes ?? "0",
      postVoteStatus.abstainVotes ?? "0"
    );

    const preTotal =
      BigInt(preVoteStatus.forVotes ?? "0") +
      BigInt(preVoteStatus.againstVotes ?? "0") +
      BigInt(preVoteStatus.abstainVotes ?? "0");
    const postTotal =
      BigInt(postVoteStatus.forVotes ?? "0") +
      BigInt(postVoteStatus.againstVotes ?? "0") +
      BigInt(postVoteStatus.abstainVotes ?? "0");
    expect(postTotal).toBeGreaterThan(preTotal);
    logger.info("Vote was cast successfully.");

    // --- verify state file ---
    logSection("Verify gov-agent state file");
    const stateFilePath = path.join(tmpDataDir, "state.json");
    expect(fs.existsSync(stateFilePath)).toBe(true);

    const stateRaw = fs.readFileSync(stateFilePath, "utf-8");
    type StoredProposal = {
      review?: { score?: number; llm_score?: number | null };
      decision?: { vote?: string };
      vote_execution?: { submitted?: boolean; tx_hash?: string | null } | null;
    };
    const state = JSON.parse(stateRaw) as {
      last_scanned_block?: number;
      proposals?: Record<string, StoredProposal>;
    };
    const proposals = state.proposals;
    expect(proposals).toBeDefined();
    expect(typeof proposals).toBe("object");

    const entry = proposals![proposalId];
    expect(entry).toBeDefined();

    expect(entry.review?.score).toBeDefined();
    expect(entry.review?.llm_score).toBeDefined();
    expect(entry.review?.llm_score).not.toBeNull();
    expect(entry.review?.llm_score).toBeGreaterThanOrEqual(0);
    expect(entry.review?.llm_score).toBeLessThanOrEqual(1);
    expect(entry.decision?.vote).toBeDefined();
    expect(entry.vote_execution?.submitted).toBe(true);
    expect(entry.vote_execution?.tx_hash).toBeDefined();
    logger.info(
      "State file verified: score=%s llm_score=%s vote=%s tx=%s",
      entry.review!.score,
      entry.review!.llm_score,
      entry.decision!.vote,
      entry.vote_execution!.tx_hash
    );

    // --- DEV safety vote + complete governance cycle ---
    logSection("DEV safety vote");
    logger.debug("Running: vibefi vote:cast %s --support for (DEV)...", proposalId);
    await castVote(proposalId);
    logger.debug("DEV safety vote cast.");

    logSection("Complete governance cycle for gov-agent dapp");
    await queueAndExecute(proposalId);

    // --- verify dapp published ---
    logSection("Verify gov-agent dapp published");
    logger.debug("Running: vibefi dapp:list...");
    const dappList = await runCliJson<
      Array<{ dappId?: string; name?: string; status?: string }>
    >(["dapp:list"], "dapp:list (gov-agent)");

    logger.info("Found %s dapp(s) in registry.", dappList.length);
    expect(dappList.length).toBeGreaterThanOrEqual(6);

    const published = dappList.filter((d) => d.status === "Published");
    logger.info("%s dapp(s) with Published status.", published.length);
    expect(published.length).toBeGreaterThanOrEqual(6);

    logger.info("Gov-agent test dapp published successfully.");
  } finally {
    fs.rmSync(tmpKeystoreDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
}
