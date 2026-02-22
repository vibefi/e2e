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

    it("should load the Aave V3 app in client", async () => {
        const automation = await getClientAutomation();
        if (!automation) return;

        try {
            const launched = await launchDappFromLauncher(automation, "Aave V3");
            await waitForWebviewText(
                automation,
                launched.id,
                ["Aave V3", "Safety notes"],
                "Aave V3"
            );
        } finally {
            await automation.close();
        }
    }, 300_000);

    it("should load the Safe Admin app in client", async () => {
        const automation = await getClientAutomation();
        if (!automation) return;

        try {
            const launched = await launchDappFromLauncher(automation, "Safe Admin");
            await waitForWebviewText(
                automation,
                launched.id,
                ["Safe Admin", "Load Safe", "Connect Wallet"],
                "Safe Admin"
            );
        } finally {
            await automation.close();
        }
    }, 300_000);

    it("should automate client launcher for Uniswap V2 walletconnect flow", async () => {
        const automation = await getClientAutomation();
        if (!automation) return;

        try {
            const launched = await launchDappFromLauncher(automation, "Uniswap V2");
            await waitForWebviewText(
                automation,
                launched.id,
                ["Uniswap V2", "Connect Wallet"],
                "Uniswap V2"
            );

            // Click the dapp's Connect Wallet button and wait for the wallet selector tab
            const webviewsBeforeConnect = await automation.listWebviews();
            const webviewIdsBeforeConnect = new Set(
                webviewsBeforeConnect.map((wv) => wv.id)
            );
            const walletSelectorPromise = automation.waitForWebview(
                (wv) => wv.kind === "WalletSelector",
                30_000
            );
            const clickedConnect = await automation.evalJs(
                launched.id,
                `const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                 const connectEl = candidates.find((el) => (el.textContent || '').includes('Connect Wallet'));
                 if (!connectEl) return false;
                 connectEl.click();
                 return true;`
            );
            invariant(clickedConnect, "Could not click Connect Wallet button in Uniswap V2 dapp");
            logger.info("Clicked Connect Wallet in launched dapp");

            const walletSelector = await walletSelectorPromise;
            invariant(walletSelector.kind === "WalletSelector", "Wallet selector webview did not open");
            logger.info(
                "Wallet selector opened in webview %s (%s)",
                walletSelector.id,
                walletSelector.label
            );

            const webviewsAfterConnect = await automation.listWebviews();
            const spawnedWebviews = webviewsAfterConnect.filter(
                (wv) => !webviewIdsBeforeConnect.has(wv.id)
            );
            invariant(
                spawnedWebviews.some((wv) => wv.id === walletSelector.id),
                "Connect Wallet did not spawn a new wallet selector webview"
            );
            logger.info(
                "New webview spawned after Connect Wallet click: %s",
                walletSelector.id
            );

            // Wait for wallet selector UI to render, then choose WalletConnect
            const walletSelectorReady = await waitFor(
                "wallet selector DOM content",
                async () => {
                    try {
                        const text = await automation.evalJs(
                            walletSelector.id,
                            "return document.body?.innerText || ''"
                        );
                        return typeof text === "string" &&
                            text.includes("Connect Wallet") &&
                            text.includes("WalletConnect");
                    } catch {
                        return false;
                    }
                },
                30_000
            );
            invariant(walletSelectorReady, "Wallet selector UI did not render");
            logger.info("Wallet selector UI rendered");

            const clickedWalletConnect = await automation.evalJs(
                walletSelector.id,
                `const options = Array.from(document.querySelectorAll('.option.surface-card'));
                 const wcOption = options.find((el) => (el.textContent || '').includes('WalletConnect'));
                 if (!wcOption) return false;
                 wcOption.click();
                 return true;`
            );
            invariant(clickedWalletConnect, "Could not click WalletConnect option");
            logger.info("Clicked WalletConnect option");

            // WalletConnect pairing URI should be surfaced in the wallet selector window
            let walletConnectUri = "";
            const walletConnectUriReady = await waitFor(
                "WalletConnect pairing URI",
                async () => {
                    try {
                        const uri = await automation.evalJs(
                            walletSelector.id,
                            "return document.querySelector('#uri')?.value || ''",
                            15_000
                        );
                        if (typeof uri === "string" && uri.startsWith("wc:")) {
                            walletConnectUri = uri;
                            return true;
                        }
                        return false;
                    } catch {
                        return false;
                    }
                },
                60_000
            );
            invariant(
                walletConnectUriReady,
                "WalletConnect pairing URI was not returned in wallet selector window"
            );
            logger.info(
                "WalletConnect pairing URI received in wallet selector window (%d chars)",
                walletConnectUri.length
            );
        } finally {
            await automation.close();
        }
    }, 300_000);
});
