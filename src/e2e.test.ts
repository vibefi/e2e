import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { initConfig, config } from "./config";
import { startInfrastructure, runSanityChecks } from "./setup";
import { publishAllDapps } from "./dapp-publish";
import { verifyRegistry } from "./verify";
import { testGovernanceAgent } from "./gov-agent";
import { configureLogger, logger } from "./logger";
import { invariant, assertCommandSuccess } from "./assertions";
import { runCmd, waitFor } from "./utils";
import { ClientAutomation } from "./client-automation";

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

    it("should automate client launcher", async () => {
        const { useClient, monorepoDir, devnetJsonPath } = config();
        if (!useClient) {
            logger.info("Skipping client automation (use --client to enable)");
            return;
        }

        const clientDir = path.join(monorepoDir, "client");

        // Build client binary
        logger.info("Building client (cargo build)...");
        const buildResult = await runCmd("cargo", ["build"], {
            cwd: clientDir,
            capture: true,
        });
        assertCommandSuccess(buildResult, "cargo build client");

        const clientBinary = path.join(clientDir, "target", "debug", "vibefi");
        invariant(
            fs.existsSync(clientBinary),
            `Client binary not found at ${clientBinary}`
        );

        const automation = new ClientAutomation({
            clientBinary,
            args: ["--config", devnetJsonPath, "--automation"],
            cwd: clientDir,
        });

        try {
            // Wait for client to be ready (window + initial webviews created)
            await automation.waitForReady(15_000);
            logger.info("Client is ready");

            // Discover webviews
            const webviews = await automation.listWebviews();
            logger.info("Webviews: %o", webviews.map((w) => `${w.id} (${w.kind})`));
            const launcher = webviews.find((w) => w.kind === "Launcher");
            invariant(launcher, "Launcher webview not found");

            // Wait for dapp list to populate
            let dappCount = 0;
            const populated = await waitFor(
                "dapp list populated",
                async () => {
                    try {
                        const count = await automation.evalJs(
                            launcher.id,
                            "return document.querySelectorAll('tr.dapp-row').length"
                        );
                        dappCount = count as number;
                        return dappCount > 0;
                    } catch {
                        return false;
                    }
                },
                30_000
            );
            invariant(populated, `Dapp list not populated (got ${dappCount} rows)`);
            logger.info("Dapp list populated with %d dapps", dappCount);

            // Select the Uniswap V2 dapp from the list
            const selected = await automation.evalJs(
                launcher.id,
                `const rows = document.querySelectorAll('tr.dapp-row');
                 for (const row of rows) {
                   if (row.textContent.includes('Uniswap V2')) {
                     row.querySelector('input[type="radio"]').click();
                     return true;
                   }
                 }
                 return false;`
            );
            invariant(selected, "Could not find Uniswap V2 in dapp list");
            logger.info("Selected Uniswap V2");

            // Click the launch button
            await automation.evalJs(
                launcher.id,
                `document.querySelector('button.primary').click(); return true;`
            );
            logger.info("Clicked launch");

            // Wait for a new Standard webview to appear (IPFS fetch + build)
            const launched = await automation.waitForWebview(
                (wv) => wv.kind === "Standard",
                60_000
            );
            logger.info(
                "Dapp launched in webview %s (%s)",
                launched.id,
                launched.label
            );

            // Wait for the launched dapp DOM to contain "Uniswap V2"
            const domReady = await waitFor(
                "Uniswap V2 DOM content",
                async () => {
                    try {
                        const text = await automation.evalJs(
                            launched.id,
                            "return document.body?.innerText || ''"
                        );
                        return typeof text === "string" &&
                            text.includes("Uniswap V2") &&
                            text.includes("Connect Wallet");
                    } catch {
                        return false;
                    }
                },
                60_000
            );
            invariant(domReady, "Uniswap V2 / Connect Wallet not found in launched dapp DOM");
            logger.info("Uniswap V2 DOM content verified (includes Connect Wallet)");

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
