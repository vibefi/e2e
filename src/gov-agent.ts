import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeEventLog, type Hex } from "viem";
import { governorAbi } from "@vibefi/shared";
import type { E2eConfig } from "./config";
import { logSection, runCmd, runCli, parseCliJson } from "./utils";

const VOTER1_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const KEYSTORE_PASSWORD = "e2e-test-password";

export async function testGovernanceAgent(config: E2eConfig) {
  logSection("Governance agent test");

  // 1. Validate OPENAI_API_KEY
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required for --gov-agent. Set it in your environment."
    );
  }

  const tmpKeystoreDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibefi-gov-keystore-")
  );
  const tmpDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibefi-gov-data-")
  );
  const govAgentDir = path.join(config.monorepoDir, "gov-agent");

  try {
    // 2. Create temp keystore for voter1
    logSection("Create voter1 keystore");
    console.log("Importing voter1 private key into temp keystore...");
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
    if (importResult.code !== 0) {
      throw new Error("cast wallet import failed for voter1 keystore");
    }
    const keystorePath = path.join(tmpKeystoreDir, "gov-e2e-voter");
    console.log(`Keystore created at ${keystorePath}`);

    // 3. Package test dapp (uniswap-v2 with version 0.0.2)
    logSection("Package gov-agent test dapp");
    const uniswapDir = path.join(config.dappExamplesDir, "uniswap-v2");
    console.log("Running: vibefi package (uniswap-v2 v0.0.2)...");
    let result = await runCli(
      config,
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
      { noRpc: true }
    );
    if (result.code !== 0) throw new Error("package failed for gov-agent test dapp");
    const packageJson = parseCliJson<{ rootCid?: string }>(
      result.stdout || "",
      "package (gov-agent)"
    );
    if (!packageJson.rootCid)
      throw new Error("Missing rootCid from package for gov-agent test dapp");

    // 4. Propose via CLI
    logSection("Propose gov-agent test dapp");
    const proposalDescription = `Gov-agent E2E proposal ${Date.now()}`;
    console.log(`Running: vibefi dapp:propose (rootCid=${packageJson.rootCid})...`);
    result = await runCli(config, [
      "dapp:propose",
      "--root-cid",
      packageJson.rootCid,
      "--name",
      "Uniswap V2",
      "--dapp-version",
      "0.0.2",
      "--description",
      "Gov agent e2e test dapp",
      "--proposal-description",
      proposalDescription,
    ]);
    if (result.code !== 0) throw new Error("dapp:propose failed for gov-agent test dapp");
    const proposeJson = parseCliJson<{ txHash?: string }>(
      result.stdout || "",
      "dapp:propose (gov-agent)"
    );
    if (!proposeJson.txHash)
      throw new Error("Missing txHash from dapp:propose for gov-agent test dapp");

    // Extract proposalId from receipt
    const receipt = await config.publicClient.waitForTransactionReceipt({
      hash: proposeJson.txHash as Hex,
      timeout: 15000,
    });
    const governorAddress = (
      await import("@vibefi/shared").then((m) =>
        m.loadDevnetJson(config.devnetJsonPath)
      )
    )?.vfiGovernor.toLowerCase();
    const proposalLog = (receipt.logs ?? []).find(
      (log) => log.address.toLowerCase() === governorAddress
    );
    if (!proposalLog)
      throw new Error("ProposalCreated log not found in gov-agent propose receipt");
    const decoded = decodeEventLog({
      abi: governorAbi,
      data: proposalLog.data as Hex,
      topics: proposalLog.topics as [Hex, ...Hex[]],
    });
    const proposalId = (
      (decoded as unknown as { args: { proposalId: bigint } }).args
    ).proposalId.toString();
    console.log(`Gov-agent test proposalId=${proposalId}`);
    const proposalCreatedBlock = receipt.blockNumber;
    if (proposalCreatedBlock === null || proposalCreatedBlock === undefined) {
      throw new Error("Proposal receipt missing blockNumber");
    }

    // 5. Mine 2 blocks past voting delay
    logSection("Mine past voting delay");
    console.log("Mining 2 blocks...");
    await config.publicClient.request({ method: "anvil_mine", params: [2] });
    console.log("Blocks mined.");

    // 6. Start scanning from the proposal's creation block so ProposalCreated is in range.
    const fromBlock = proposalCreatedBlock;
    console.log(
      `Using fromBlock=${fromBlock} (proposal creation block) for GOV_AGENT_FROM_BLOCK`
    );

    // 7. Capture pre-vote status
    logSection("Pre-vote status");
    console.log(`Running: vibefi vote:status ${proposalId}...`);
    result = await runCli(config, ["vote:status", proposalId]);
    if (result.code !== 0) throw new Error("vote:status failed (pre-vote)");
    const preVoteStatus = parseCliJson<{
      forVotes?: string;
      againstVotes?: string;
      abstainVotes?: string;
    }>(result.stdout || "", "vote:status (pre-vote)");
    console.log(
      `Pre-vote: for=${preVoteStatus.forVotes ?? "0"} against=${preVoteStatus.againstVotes ?? "0"} abstain=${preVoteStatus.abstainVotes ?? "0"}`
    );

    // 8. Run gov-agent
    logSection("Run governance agent");
    console.log("Running: cargo run -- run --once --auto-vote ...");
    const agentResult = await runCmd(
      "cargo",
      [
        "run",
        "--",
        "run",
        "--once",
        "--auto-vote",
        "--rpc-url",
        `ws://127.0.0.1:${config.anvilPort}`,
      ],
      {
        cwd: govAgentDir,
        capture: true,
        env: {
          GOV_AGENT_FROM_BLOCK: fromBlock.toString(),
          GOV_AGENT_DEVNET_JSON: config.devnetJsonPath,
          GOV_AGENT_KEYSTORE_PATH: keystorePath,
          GOV_AGENT_KEYSTORE_PASSWORD: KEYSTORE_PASSWORD,
          GOV_AGENT_DATA_DIR: tmpDataDir,
          GOV_AGENT_DECISION_PROFILE: "balanced",
          GOV_AGENT_MIN_VOTE_BLOCKS_REMAINING: "1",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
        },
      }
    );
    if (agentResult.code !== 0) {
      throw new Error(`gov-agent exited with code ${agentResult.code}`);
    }
    console.log("Gov-agent completed.");

    // 9. Verify vote was cast (compare pre/post vote:status)
    logSection("Post-vote status");
    console.log(`Running: vibefi vote:status ${proposalId}...`);
    result = await runCli(config, ["vote:status", proposalId]);
    if (result.code !== 0) throw new Error("vote:status failed (post-vote)");
    const postVoteStatus = parseCliJson<{
      forVotes?: string;
      againstVotes?: string;
      abstainVotes?: string;
    }>(result.stdout || "", "vote:status (post-vote)");
    console.log(
      `Post-vote: for=${postVoteStatus.forVotes ?? "0"} against=${postVoteStatus.againstVotes ?? "0"} abstain=${postVoteStatus.abstainVotes ?? "0"}`
    );

    const preTotal =
      BigInt(preVoteStatus.forVotes ?? "0") +
      BigInt(preVoteStatus.againstVotes ?? "0") +
      BigInt(preVoteStatus.abstainVotes ?? "0");
    const postTotal =
      BigInt(postVoteStatus.forVotes ?? "0") +
      BigInt(postVoteStatus.againstVotes ?? "0") +
      BigInt(postVoteStatus.abstainVotes ?? "0");
    if (postTotal <= preTotal) {
      throw new Error(
        `Vote totals did not increase: pre=${preTotal} post=${postTotal}`
      );
    }
    console.log("Vote was cast successfully.");

    // 10. Verify state file
    logSection("Verify gov-agent state file");
    const stateFilePath = path.join(tmpDataDir, "state.json");
    if (!fs.existsSync(stateFilePath)) {
      throw new Error(`State file not found at ${stateFilePath}`);
    }
    const stateRaw = fs.readFileSync(stateFilePath, "utf-8");
    type StoredProposal = {
      review?: { score?: number; llm_summary?: string | null };
      decision?: { vote?: string };
      vote_execution?: { submitted?: boolean; tx_hash?: string | null } | null;
    };
    const state = JSON.parse(stateRaw) as {
      last_scanned_block?: number;
      proposals?: Record<string, StoredProposal>;
    };
    const proposals = state.proposals;
    if (!proposals || typeof proposals !== "object") {
      throw new Error("State file is missing proposals map");
    }
    const entry = proposals[proposalId];
    if (!entry) {
      const available = Object.keys(proposals);
      throw new Error(
        `State file is missing proposal entry for ${proposalId}; available keys=${available.join(",")}`
      );
    }
    if (entry.review?.score === undefined) {
      throw new Error("State file entry is missing review.score");
    }
    if (!entry.decision?.vote) {
      throw new Error("State file entry is missing decision.vote");
    }
    if (entry.vote_execution?.submitted !== true) {
      throw new Error("State file entry vote_execution.submitted is not true");
    }
    if (!entry.vote_execution?.tx_hash) {
      throw new Error("State file entry is missing vote_execution.tx_hash");
    }
    if (entry.review?.llm_summary === undefined || entry.review.llm_summary === null) {
      throw new Error(
        "State file entry has null/missing review.llm_summary (LLM did not run)"
      );
    }
    console.log(
      `State file verified: score=${entry.review.score}, vote=${entry.decision.vote}, tx=${entry.vote_execution.tx_hash}`
    );

    // 11. DEV votes For (safety net for proposal passage)
    logSection("DEV safety vote");
    console.log(`Running: vibefi vote:cast ${proposalId} --support for (DEV)...`);
    result = await runCli(config, ["vote:cast", proposalId, "--support", "for"]);
    if (result.code !== 0) throw new Error("DEV safety vote:cast failed");
    console.log("DEV safety vote cast.");

    // 12. Mine 25 blocks → queue → timelock → execute
    logSection("Complete governance cycle for gov-agent dapp");
    console.log("Mining 25 blocks for voting period...");
    await config.publicClient.request({ method: "anvil_mine", params: [25] });
    console.log("Blocks mined.");

    console.log(`Running: vibefi proposals:queue ${proposalId}...`);
    result = await runCli(config, ["proposals:queue", proposalId]);
    if (result.code !== 0) throw new Error("proposals:queue failed for gov-agent dapp");

    console.log("Advancing time past timelock delay...");
    await config.publicClient.request({
      method: "evm_increaseTime",
      params: ["0x2"],
    });
    await config.publicClient.request({ method: "anvil_mine", params: [1] });

    console.log(`Running: vibefi proposals:execute ${proposalId}...`);
    result = await runCli(config, ["proposals:execute", proposalId]);
    if (result.code !== 0)
      throw new Error("proposals:execute failed for gov-agent dapp");

    // 13. Verify dapp published via dapp:list
    logSection("Verify gov-agent dapp published");
    console.log("Running: vibefi dapp:list...");
    result = await runCli(config, ["dapp:list"]);
    if (result.code !== 0) throw new Error("dapp:list failed");
    const dappList = parseCliJson<
      Array<{ dappId?: string; name?: string; status?: string }>
    >(result.stdout || "", "dapp:list (gov-agent)");

    // We expect 6 dapps now (5 original + 1 gov-agent test dapp)
    console.log(`Found ${dappList.length} dapp(s) in registry.`);
    if (dappList.length < 6) {
      throw new Error(
        `Expected at least 6 dapps after gov-agent test, found ${dappList.length}`
      );
    }
    const published = dappList.filter((d) => d.status === "Published");
    console.log(`${published.length} dapp(s) with Published status.`);
    if (published.length < 6) {
      throw new Error(
        `Expected at least 6 Published dapps, found ${published.length}`
      );
    }
    console.log("Gov-agent test dapp published successfully.");
  } finally {
    // 14. Cleanup temp dirs
    fs.rmSync(tmpKeystoreDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
}
