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
