import "dotenv/config";
import fs from "node:fs";
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { initConfig, config } from "./config";
import { startInfrastructure, runSanityChecks } from "./setup";
import { publishAllDapps } from "./dapp-publish";
import { verifyRegistry } from "./verify";
import { testGovernanceAgent } from "./gov-agent";
import { configureLogger, logger } from "./logger";
import { invariant } from "./assertions";
import { waitFor } from "./utils";
import {
    getClientAutomation,
    waitForLauncherWebview,
    waitForDappListPopulated,
    launchDappFromLauncher,
    waitForWebviewText,
    waitForWebviewKindText,
    saveWebviewScreenshot,
    automateWalletConnectFlow,
} from "./client-e2e-helpers";

describe("E2E Test Suite", () => {
    let cleanupDirs: string[] = [];

    async function withClientAutomationTest(
        fn: (automation: NonNullable<Awaited<ReturnType<typeof getClientAutomation>>>) => Promise<void>
    ): Promise<void> {
        const automation = await getClientAutomation();
        if (!automation) return;

        try {
            await fn(automation);
        } catch (error) {
            automation.dumpToolOutput("client e2e test failure");
            throw error;
        } finally {
            await automation.close();
        }
    }

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

    let studioDappId: bigint;

    it("should publish all dapps", async () => {
        const result = await publishAllDapps();
        studioDappId = result.studioDappId;
        cleanupDirs = result.cleanupDirs;

        expect(studioDappId).toBeDefined();
        expect(cleanupDirs).toBeInstanceOf(Array);
    });

    it("should verify the registry", async () => {
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
        await withClientAutomationTest(async (automation) => {
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

            const studioLoaded = await waitForWebviewKindText(
                automation,
                "Studio",
                ["Studio"],
                "Studio",
                60_000
            );
            await saveWebviewScreenshot(automation, studioLoaded.id, "studio-tab-loaded");
        });
    }, 300_000);

    const standardDapps = [
        { name: "Aave V3", texts: ["Aave V3", "Safety notes"] },
        { name: "Safe Admin", texts: ["Safe Admin", "Load Safe", "Connect Wallet"] }
    ];

    for (const dapp of standardDapps) {
        it(`should load the ${dapp.name} app in client`, async () => {
            await withClientAutomationTest(async (automation) => {
                const launched = await launchDappFromLauncher(automation, dapp.name);
                await waitForWebviewText(
                    automation,
                    launched.id,
                    dapp.texts,
                    dapp.name
                );
                await saveWebviewScreenshot(
                    automation,
                    launched.id,
                    `${dapp.name}-loaded`
                );
            });
        }, 300_000);
    }

    it("should automate client launcher for Uniswap V2 walletconnect flow", async () => {
        await withClientAutomationTest(async (automation) => {
            const launched = await launchDappFromLauncher(automation, "Uniswap V2");
            await waitForWebviewText(
                automation,
                launched.id,
                ["Uniswap V2", "Connect Wallet"],
                "Uniswap V2"
            );

            const { uri: walletConnectUri, walletSelectorId } =
                await automateWalletConnectFlow(automation, launched.id);
            logger.info(
                "WalletConnect pairing URI received in wallet selector window (%d chars)",
                walletConnectUri.length
            );
            await saveWebviewScreenshot(
                automation,
                walletSelectorId,
                "uniswap-walletconnect-uri"
            );
        });
    }, 300_000);
});
