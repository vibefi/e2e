import "dotenv/config";
import fs from "node:fs";
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { initConfig, config, publicClient } from "./config";
import { startInfrastructure, runSanityChecks } from "./setup";
import { publishAllDapps } from "./dapp-publish";
import { verifyRegistry } from "./verify";
import { runGovAgentAutoVoteForProposal, testGovernanceAgent } from "./gov-agent";
import { configureLogger, logger } from "./logger";
import { assertDefined, invariant } from "./assertions";
import { waitFor, decodeRootCid, runCliJson } from "./utils";
import { castVote, queueAndExecute } from "./governance";
import {
    getClientAutomation,
    findLauncherDappRowByName,
    waitForLauncherWebview,
    waitForDappListPopulated,
    launchDappFromLauncher,
    waitForWebviewText,
    waitForWebviewKindText,
    clickTabInTabBar,
    automateWalletConnectFlow,
    connectWalletViaLocalSigner,
    forkEditAndProposeFromCode,
    readLauncherDappRows,
    type LauncherDappRow,
} from "./client-e2e-helpers";

describe("E2E Test Suite", () => {
    let cleanupDirs: string[] = [];

    beforeAll(async () => {
        initConfig(process.argv.slice(2));
        const { verbosity, streamToolOutput } = config();
        configureLogger({ verbosity, streamToolOutput });

        logger.info(
            "Starting E2E run (verbosity=%s, toolOutput=%s)",
            verbosity,
            streamToolOutput ? "on" : "off"
        );

        await startInfrastructure();
    }, 120000); // 2 minute timeout for infrastructure start

    afterAll(() => {
        // Cleanup generated directories
        for (const dir of cleanupDirs) {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }

        const { anvilPort } = config();
        logger.info("Anvil left running on :%s", anvilPort);
    });

    it("should pass sanity checks", async () => {
        await runSanityChecks();
    });

    let studioDappId: bigint | null = null;

    it("should publish all dapps", async () => {
        const result = await publishAllDapps();
        studioDappId = result.studioDappId;
        cleanupDirs = result.cleanupDirs;

        expect(studioDappId).toBeDefined();
        expect(cleanupDirs).toBeInstanceOf(Array);
    });

    it("should verify the registry", async () => {
        assertDefined(
            studioDappId,
            "studioDappId not set (publish test may have failed or tests ran out of order)"
        );
        await verifyRegistry(5, studioDappId);
    });

    it("should test the governance agent", async () => {
        const { useGovAgent } = config();
        if (useGovAgent) {
            await testGovernanceAgent();
        } else {
            logger.info("Skipping governance agent test (useGovAgent is false)");
        }
    });

    it("should load the Studio tab in client", async () => {
        const automation = await getClientAutomation();
        if (!automation) return;

        try {
            const launcher = await waitForLauncherWebview(automation);
            await waitForDappListPopulated(automation, launcher.id);

            const initialWebviews = await automation.listWebviews();
            const initialStudio = initialWebviews.find((w) => w.kind === "Studio");
            invariant(initialStudio, "Studio webview not found");
            logger.info(
                "Studio tab found in webview %s (%s)",
                initialStudio.id,
                initialStudio.label
            );

            await waitForWebviewKindText(
                automation,
                "Studio",
                ["Studio"],
                "Studio",
                60_000
            );
        } finally {
            await automation.close();
        }
    }, 300_000);

    const standardDapps = [
        { name: "Aave V3", texts: ["Aave V3", "Safety notes"] },
        { name: "Safe Admin", texts: ["Safe Admin", "Load Safe", "Connect Wallet"] }
    ];

    for (const dapp of standardDapps) {
        it(`should load the ${dapp.name} app in client`, async () => {
            const automation = await getClientAutomation();
            if (!automation) return;

            try {
                const launched = await launchDappFromLauncher(automation, dapp.name);
                await waitForWebviewText(
                    automation,
                    launched.id,
                    dapp.texts,
                    dapp.name
                );
            } finally {
                await automation.close();
            }
        }, 300_000);
    }

    it("should automate client launcher for Uniswap V2 walletconnect flow", async () => {
        const automation = await getClientAutomation();
        if (!automation) return;

        try {
            const launched = await launchDappFromLauncher(automation, "Uniswap V2");
            await waitForWebviewText(
                automation,
                launched.id,
                ["Uniswap V2"],
                "Uniswap V2"
            );

            const walletConnectUri = await automateWalletConnectFlow(automation, launched.id);
            logger.info(
                "WalletConnect pairing URI received in wallet selector window (%d chars)",
                walletConnectUri.length
            );
        } finally {
            await automation.close();
        }
    }, 300_000);

    it("should fork/edit/propose from Code, govern with gov-agent, and show upgraded app after list refresh", async () => {
        const { useClient, useGovAgent, ipfsApi } = config();
        if (!useClient || !useGovAgent) {
            logger.info(
                "Skipping integrated client+gov-agent upgrade flow (requires --client --gov-agent)"
            );
            return;
        }

        if (studioDappId === null) {
            logger.info(
                "Baseline dapps are not published in this run; publishing now for isolated integrated test"
            );
            const publishResult = await publishAllDapps();
            studioDappId = publishResult.studioDappId;
            cleanupDirs = cleanupDirs.concat(publishResult.cleanupDirs);
        }

        const automation = await getClientAutomation();
        if (!automation) return;

        let originalDappId = "";
        let originalVersion = "";
        let proposedRootCid = "";
        let studioWebviewId = "";

        try {
            await waitForLauncherWebview(automation);

            await clickTabInTabBar(automation, "Studio");
            const studioWebview = await waitForWebviewKindText(
                automation,
                "Studio",
                ["Studio", "Connect Wallet"],
                "Studio",
                60_000
            );
            studioWebviewId = studioWebview.id;
            await connectWalletViaLocalSigner(automation, studioWebviewId, "Studio");

            const { row } = await findLauncherDappRowByName(automation, "Uniswap V2");
            originalDappId = row.dappId;
            originalVersion = row.version || "0.0.1";
            logger.info(
                "Launcher Uniswap row detected (dappId=%s version=%s rootCid=%s)",
                row.dappId,
                row.version,
                row.rootCid
            );

            const launched = await launchDappFromLauncher(automation, "Uniswap V2");
            await waitForWebviewText(
                automation,
                launched.id,
                ["Uniswap V2"],
                "Uniswap V2"
            );

            const codeResult = await forkEditAndProposeFromCode(automation, {
                dappName: "Uniswap V2",
                uploadEndpoint: ipfsApi,
            });
            proposedRootCid = codeResult.rootCid;

            logger.info(
                "Code flow complete (project=%s file=%s marker=%s rootCid=%s)",
                codeResult.projectPath,
                codeResult.filePath,
                codeResult.marker,
                codeResult.rootCid
            );

            invariant(originalDappId, "Missing dappId for upgrade flow");
            invariant(proposedRootCid, "Missing proposed rootCid from Code flow");

            const proposalsBeforeSubmit = await runCliJson<
                Array<{ proposalId?: string }>
            >(["proposals:list", "--limit", "200"], "proposals:list before Studio submit");
            const proposalIdsBefore = new Set(
                proposalsBeforeSubmit
                    .map((proposal) => proposal.proposalId?.trim() ?? "")
                    .filter((proposalId) => proposalId.length > 0)
            );
            const proposalCreatedFromBlock = await publicClient().getBlockNumber();

            await clickTabInTabBar(automation, "Studio");
            await waitForWebviewKindText(
                automation,
                "Studio",
                ["Actions", "Submit Upgrade Proposal"],
                "Studio",
                60_000
            );
            const upgradeFormPrefilled = await waitFor(
                "studio upgrade form prefilled",
                async () => {
                    try {
                        const prefilled = await automation.evalJs(
                            studioWebviewId,
                            `const submit = Array.from(document.querySelectorAll('button'))
                               .find((el) => (el.textContent || '').trim() === 'Submit Upgrade Proposal');
                             const card = submit?.closest('.studio-card') || submit?.parentElement;
                             if (!card) return false;
                             const inputs = Array.from(card.querySelectorAll('input'));
                             const dappId = (inputs[0]?.value || '').trim();
                             const rootCid = (inputs[1]?.value || '').trim();
                             const name = (inputs[2]?.value || '').trim();
                             const version = (inputs[3]?.value || '').trim();
                             const description = (inputs[4]?.value || '').trim();
                             const proposalDescription = (inputs[5]?.value || '').trim();
                             return Boolean(
                               dappId &&
                               rootCid &&
                               name &&
                               version &&
                               description &&
                               proposalDescription
                             );`
                        );
                        return prefilled === true;
                    } catch {
                        return false;
                    }
                },
                60_000
            );
            if (!upgradeFormPrefilled) {
                const prefillDebug = await automation.evalJs(
                    studioWebviewId,
                    `const submit = Array.from(document.querySelectorAll('button'))
                       .find((el) => (el.textContent || '').trim() === 'Submit Upgrade Proposal');
                     const card = submit?.closest('.studio-card') || submit?.parentElement;
                     const inputs = card ? Array.from(card.querySelectorAll('input')).map((i) => (i.value || '').trim()) : [];
                     return { inputs };`
                ) as { inputs?: string[] };
                throw new Error(
                    `Studio upgrade form was not prefilled. studioUpgradeInputs=${JSON.stringify(prefillDebug.inputs ?? [])}`
                );
            }
            logger.info("Studio upgrade proposal form is prefilled");

            const submittedStudioUpgrade = await waitFor(
                "studio submit upgrade proposal button clickable",
                async () => {
                    try {
                        const clicked = await automation.evalJs(
                            studioWebviewId,
                            `const button = Array.from(document.querySelectorAll('button'))
                               .find((el) => (el.textContent || '').trim() === 'Submit Upgrade Proposal');
                             if (!button || button.disabled) return false;
                             button.click();
                             return true;`
                        );
                        return clicked === true;
                    } catch {
                        return false;
                    }
                },
                60_000
            );
            invariant(submittedStudioUpgrade, "Could not click Studio Submit Upgrade Proposal button");
            logger.info("Clicked Studio Submit Upgrade Proposal button");

            let proposalId = "";
            const studioProposalCreated = await waitFor(
                "new proposal id after Studio submit",
                async () => {
                    try {
                        const proposalsAfterSubmit = await runCliJson<
                            Array<{ proposalId?: string }>
                        >(["proposals:list", "--limit", "250"], "proposals:list after Studio submit");
                        const created = proposalsAfterSubmit.find((proposal) => {
                            const proposalId = proposal.proposalId?.trim() ?? "";
                            return proposalId.length > 0 && !proposalIdsBefore.has(proposalId);
                        });
                        if (!created?.proposalId) return false;
                        proposalId = created.proposalId;
                        return true;
                    } catch {
                        return false;
                    }
                },
                60_000
            );
            if (!studioProposalCreated) {
                const studioFailure = await automation.evalJs(
                    studioWebviewId,
                    `const toast = document.querySelector('.studio-toast')?.textContent || '';
                     const card = Array.from(document.querySelectorAll('.studio-card, section, div'))
                       .find((el) => (el.textContent || '').includes('Propose Upgrade'));
                     const inputs = card ? Array.from(card.querySelectorAll('input')).map((i) => (i.value || '').trim()) : [];
                     return { toast: toast.trim(), inputs };`
                ) as { toast?: string; inputs?: string[] };
                throw new Error(
                    `No new proposal created after Studio submit. studioToast=${JSON.stringify(studioFailure.toast ?? "")} studioUpgradeInputs=${JSON.stringify(studioFailure.inputs ?? [])}`
                );
            }
            logger.info("Studio created upgrade proposal id %s", proposalId);

            await publicClient().request({ method: "anvil_mine", params: [2] });
            await runGovAgentAutoVoteForProposal({
                proposalId,
                fromBlock: proposalCreatedFromBlock,
            });

            // Safety vote to ensure proposal reaches quorum/majority regardless of LLM decision profile.
            await castVote(proposalId, "for");
            await queueAndExecute(proposalId);

            const dappListAfterExecute = await runCliJson<
                Array<{ dappId?: string; rootCid?: string; status?: string }>
            >(["dapp:list"], "dapp:list after execute");
            const upgradedRegistryRow = dappListAfterExecute.find(
                (entry) => entry.dappId === originalDappId
            );
            invariant(
                upgradedRegistryRow,
                `Registry missing dappId=${originalDappId} after execute`
            );
            const registryRootCid = decodeRootCid(upgradedRegistryRow.rootCid ?? "");
            invariant(
                registryRootCid === proposedRootCid,
                `Registry rootCid mismatch after execute for dappId=${originalDappId}: expected=${proposedRootCid} got=${registryRootCid}`
            );
            invariant(
                upgradedRegistryRow.status === "Published",
                `Registry status is not Published for dappId=${originalDappId}: ${upgradedRegistryRow.status ?? "unknown"}`
            );

            const launcher = await waitForLauncherWebview(automation);
            await waitForDappListPopulated(automation, launcher.id);

            let lastRowsSnapshot: LauncherDappRow[] = [];
            let lastLauncherLogTail = "";
            const updatedVisible = await waitFor(
                "launcher list contains upgraded Uniswap root CID",
                async () => {
                    await automation.evalJs(
                        launcher.id,
                        `const getRefreshButton = () =>
                           Array.from(document.querySelectorAll('button'))
                             .find((el) => (el.textContent || '').trim() === 'Refresh list');

                         const waitUntilReady = async (timeoutMs) => {
                           const deadline = Date.now() + timeoutMs;
                           while (Date.now() < deadline) {
                             const btn = getRefreshButton();
                             if (btn && !btn.disabled) return true;
                             await new Promise((resolve) => setTimeout(resolve, 100));
                           }
                           return false;
                         };

                         if (!(await waitUntilReady(15000))) return false;
                         const button = getRefreshButton();
                         if (!button) return false;
                         button.click();
                         return await waitUntilReady(15000);`
                    );
                    const rows = await readLauncherDappRows(automation, launcher.id);
                    lastRowsSnapshot = rows;
                    const matched = rows.find(
                        (row) =>
                            row.dappId === originalDappId &&
                            decodeRootCid(row.rootCid) === proposedRootCid &&
                            row.status === "Published"
                    );
                    if (!matched) {
                        const logTail = await automation.evalJs(
                            launcher.id,
                            `const text = document.querySelector('.log')?.textContent || '';
                             const lines = text.split('\\n').filter(Boolean);
                             return lines.slice(-8).join('\\n');`
                        );
                        lastLauncherLogTail = typeof logTail === "string" ? logTail : "";
                    }
                    return Boolean(matched);
                },
                120_000
            );
            invariant(
                updatedVisible,
                `Updated app not visible in refreshed launcher list (dappId=${originalDappId}, rootCid=${proposedRootCid}). rows=${JSON.stringify(lastRowsSnapshot)} logTail=${JSON.stringify(lastLauncherLogTail)}`
            );
        } finally {
            await automation.close();
        }
    }, 900_000);
});
