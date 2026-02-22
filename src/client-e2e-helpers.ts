import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { invariant, assertCommandSuccess } from "./assertions";
import { logger } from "./logger";
import { runCmd, waitFor } from "./utils";
import { ClientAutomation, type WebviewInfo } from "./client-automation";

let cachedClientBinary: string | null = null;

export async function getClientAutomation(): Promise<ClientAutomation | null> {
    const { useClient, monorepoDir, devnetJsonPath } = config();
    if (!useClient) {
        logger.info("Skipping client automation (use --client to enable)");
        return null;
    }

    const clientDir = path.join(monorepoDir, "client");

    if (!cachedClientBinary) {
        logger.info("Building client (cargo build --features automation)...");
        const buildResult = await runCmd("cargo", ["build", "--features", "automation"], {
            cwd: clientDir,
            capture: true,
        });
        assertCommandSuccess(buildResult, "cargo build client");

        const clientBinary = path.join(clientDir, "target", "debug", "vibefi");
        invariant(
            fs.existsSync(clientBinary),
            `Client binary not found at ${clientBinary}`
        );
        cachedClientBinary = clientBinary;
    }

    return new ClientAutomation({
        clientBinary: cachedClientBinary,
        args: ["--config", devnetJsonPath, "--automation"],
        cwd: clientDir,
    });
}

export async function waitForLauncherWebview(
    automation: ClientAutomation
): Promise<WebviewInfo> {
    await automation.waitForReady(15_000);
    logger.info("Client is ready");

    const webviews = await automation.listWebviews();
    logger.info("Webviews: %o", webviews.map((w) => `${w.id} (${w.kind})`));
    const launcher = webviews.find((w) => w.kind === "Launcher");
    invariant(launcher, "Launcher webview not found");
    return launcher;
}

export async function waitForDappListPopulated(
    automation: ClientAutomation,
    launcherId: string
): Promise<void> {
    let dappCount = 0;
    const populated = await waitFor(
        "dapp list populated",
        async () => {
            try {
                const count = await automation.evalJs(
                    launcherId,
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
}

export async function launchDappFromLauncher(
    automation: ClientAutomation,
    dappName: string
): Promise<WebviewInfo> {
    const launcher = await waitForLauncherWebview(automation);
    await waitForDappListPopulated(automation, launcher.id);

    const selected = await automation.evalJs(
        launcher.id,
        `const rows = document.querySelectorAll('tr.dapp-row');
         for (const row of rows) {
           if ((row.textContent || '').includes(${JSON.stringify(dappName)})) {
             row.querySelector('input[type="radio"]')?.click();
             return true;
           }
         }
         return false;`
    );
    invariant(selected, `Could not find ${dappName} in dapp list`);
    logger.info("Selected %s", dappName);

    await automation.evalJs(
        launcher.id,
        `document.querySelector('button.primary').click(); return true;`
    );
    logger.info("Clicked launch for %s", dappName);

    const launched = await automation.waitForWebview(
        (wv) => wv.kind === "Standard",
        60_000
    );
    logger.info(
        "Dapp launched in webview %s (%s)",
        launched.id,
        launched.label
    );
    return launched;
}

export async function waitForWebviewText(
    automation: ClientAutomation,
    webviewId: string,
    expectedTexts: string[],
    label: string,
    timeoutMs = 60_000
): Promise<void> {
    const ready = await waitFor(
        `${label} DOM content`,
        async () => {
            try {
                const text = await automation.evalJs(
                    webviewId,
                    "return document.body?.innerText || ''"
                );
                return typeof text === "string" &&
                    expectedTexts.every((needle) => text.includes(needle));
            } catch {
                return false;
            }
        },
        timeoutMs
    );
    invariant(
        ready,
        `${label} DOM missing expected text: ${expectedTexts.join(", ")}`
    );
    logger.info("%s DOM verified (%s)", label, expectedTexts.join(", "));
}

export async function waitForWebviewKindText(
    automation: ClientAutomation,
    kind: string,
    expectedTexts: string[],
    label: string,
    timeoutMs = 60_000
): Promise<WebviewInfo> {
    let matchedWebview: WebviewInfo | null = null;
    const ready = await waitFor(
        `${label} ${kind} webview DOM content`,
        async () => {
            try {
                const webviews = await automation.listWebviews();
                const target = webviews.find((w) => w.kind === kind);
                if (!target) return false;
                matchedWebview = target;
                const text = await automation.evalJs(
                    target.id,
                    "return document.body?.innerText || ''"
                );
                return typeof text === "string" &&
                    expectedTexts.every((needle) => text.includes(needle));
            } catch {
                return false;
            }
        },
        timeoutMs
    );
    if (!ready || !matchedWebview) {
        throw new Error(
            `${label} ${kind} webview DOM missing expected text: ${expectedTexts.join(", ")}`
        );
    }
    const resolvedWebview = matchedWebview as WebviewInfo;
    logger.info(
        "%s DOM verified in %s webview %s (%s)",
        label,
        kind,
        resolvedWebview.id,
        expectedTexts.join(", ")
    );
    return resolvedWebview;
}

export async function automateWalletConnectFlow(
    automation: ClientAutomation,
    launchedId: string
): Promise<string> {
    const webviewsBeforeConnect = await automation.listWebviews();
    const webviewIdsBeforeConnect = new Set(
        webviewsBeforeConnect.map((wv) => wv.id)
    );
    const walletSelectorPromise = automation.waitForWebview(
        (wv) => wv.kind === "WalletSelector",
        30_000
    );
    const clickedConnect = await automation.evalJs(
        launchedId,
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

    return walletConnectUri;
}
