import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { invariant, assertCommandSuccess } from "./assertions";
import { logger } from "./logger";
import { runCmd, waitFor } from "./utils";
import { ClientAutomation, type WebviewInfo } from "./client-automation";

export interface LauncherDappRow {
    index: number;
    dappId: string;
    name: string;
    version: string;
    rootCid: string;
    status: "Published" | "Unavailable";
}

export interface CodeProposeResult {
    projectPath: string;
    filePath: string;
    marker: string;
    rootCid: string;
}

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
    await automation.waitForReady(45_000);
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

export async function readLauncherDappRows(
    automation: ClientAutomation,
    launcherId: string
): Promise<LauncherDappRow[]> {
    const rows = await automation.evalJs(
        launcherId,
        `return Array.from(document.querySelectorAll('tr.dapp-row')).map((row, index) => {
           const cells = Array.from(row.querySelectorAll('td'));
           const nameCellText = (cells[1]?.textContent || '').replace(/\\s+/g, ' ').trim();
           const dappIdMatch = nameCellText.match(/#(\\d+)/);
           const name = nameCellText.replace(/#\\d+.*/, '').replace(/Paused\\s*$/i, '').trim();
           const status = row.classList.contains('unavailable') ? 'Unavailable' : 'Published';
           return {
             index,
             dappId: dappIdMatch ? dappIdMatch[1] : '',
             name,
             version: (cells[2]?.textContent || '').trim(),
             rootCid: (cells[3]?.textContent || '').trim(),
             status
           };
         });`
    );
    return Array.isArray(rows) ? (rows as LauncherDappRow[]) : [];
}

export async function findLauncherDappRowByName(
    automation: ClientAutomation,
    dappName: string
): Promise<{ launcher: WebviewInfo; row: LauncherDappRow }> {
    const launcher = await waitForLauncherWebview(automation);
    await waitForDappListPopulated(automation, launcher.id);
    const rows = await readLauncherDappRows(automation, launcher.id);
    const row = rows.find((candidate) => candidate.name === dappName);
    invariant(row, `Could not find ${dappName} in launcher dapp table`);
    return { launcher, row };
}

export async function clickForkInTabBar(
    automation: ClientAutomation,
    dappName: string
): Promise<void> {
    const tabBar = (await automation.listWebviews()).find((wv) => wv.kind === "TabBar");
    invariant(tabBar, "Tab bar webview not found");

    const clicked = await automation.evalJs(
        tabBar.id,
        `const tabs = Array.from(document.querySelectorAll('#tabs .tab'));
         const target = tabs.find((tab) => {
           const label = (tab.querySelector('.tab-label')?.textContent || tab.textContent || '').trim();
           return label.includes(${JSON.stringify(dappName)}) && !!tab.querySelector('button.tab-fork');
         });
         if (!target) return false;
         const button = target.querySelector('button.tab-fork');
         if (!button || button.disabled) return false;
         button.click();
         return true;`
    );
    invariant(clicked, `Could not click Fork for ${dappName} in tab bar`);
    logger.info("Clicked Fork for %s in tab bar", dappName);
}

export async function clickTabInTabBar(
    automation: ClientAutomation,
    tabLabel: string
): Promise<void> {
    const tabBar = (await automation.listWebviews()).find((wv) => wv.kind === "TabBar");
    invariant(tabBar, "Tab bar webview not found");

    const clicked = await waitFor(
        `tab bar switch to ${tabLabel}`,
        async () => {
            try {
                const didClick = await automation.evalJs(
                    tabBar.id,
                    `const tabs = Array.from(document.querySelectorAll('#tabs .tab'));
                     const target = tabs.find((tab) => {
                       const label = (tab.querySelector('.tab-label')?.textContent || tab.textContent || '').trim();
                       return label.includes(${JSON.stringify(tabLabel)}) && !tab.classList.contains('disabled');
                     });
                     if (!target) return false;
                     target.click();
                     return true;`
                );
                return didClick === true;
            } catch {
                return false;
            }
        },
        30_000
    );
    invariant(clicked, `Could not switch to ${tabLabel} tab in tab bar`);
    logger.info("Clicked %s tab in tab bar", tabLabel);
}

export async function closeTabInTabBar(
    automation: ClientAutomation,
    tabLabel: string
): Promise<void> {
    const tabBar = (await automation.listWebviews()).find((wv) => wv.kind === "TabBar");
    invariant(tabBar, "Tab bar webview not found");

    const closed = await waitFor(
        `tab bar close ${tabLabel}`,
        async () => {
            try {
                const didClose = await automation.evalJs(
                    tabBar.id,
                    `const tabs = Array.from(document.querySelectorAll('#tabs .tab'));
                     const target = tabs.find((tab) => {
                       const label = (tab.querySelector('.tab-label')?.textContent || tab.textContent || '').trim();
                       return label.includes(${JSON.stringify(tabLabel)});
                     });
                     if (!target) return true;
                     const closeBtn = target.querySelector('.tab-close');
                     if (!closeBtn) return false;
                     closeBtn.click();
                     return true;`
                );
                return didClose === true;
            } catch {
                return false;
            }
        },
        15_000
    );
    invariant(closed, `Could not close ${tabLabel} tab in tab bar`);
    logger.info("Closed %s tab in tab bar", tabLabel);
}

export async function forkEditAndProposeFromCode(
    automation: ClientAutomation,
    opts: { dappName: string; uploadEndpoint: string }
): Promise<CodeProposeResult> {
    await clickForkInTabBar(automation, opts.dappName);
    const codeWebview = await waitForWebviewKindText(
        automation,
        "Code",
        ["VibeFi Code"],
        "Code",
        120_000
    );

    const result = await automation.evalJs(
        codeWebview.id,
        `const ipc = window.__VibefiIpcClient;
         if (!ipc) throw new Error("missing __VibefiIpcClient in Code webview");

         // Use local IPFS for deterministic E2E uploads.
         await ipc.request("vibefi-code", "code_setUploadConfig", [{
           provider: "localNode",
           localNode: { endpoint: ${JSON.stringify(opts.uploadEndpoint)} }
         }]);

         const opened = await ipc.request("vibefi-code", "code_openProject", [{}]);
         const projectPath = (opened && typeof opened === "object" && typeof opened.projectPath === "string")
           ? opened.projectPath.trim()
           : "";
         if (!projectPath) throw new Error("code_openProject did not return projectPath");

         const listResult = await ipc.request("vibefi-code", "code_listFiles", [{ projectPath }]);
         const flatten = (entries, out = []) => {
           if (!Array.isArray(entries)) return out;
           for (const entry of entries) {
             if (!entry || typeof entry !== "object") continue;
             const path = typeof entry.path === "string" ? entry.path : "";
             const isDir = entry.isDir === true;
             if (path && !isDir) out.push(path);
             if (isDir) flatten(entry.children, out);
           }
           return out;
         };
         const filePaths = flatten(listResult?.files);
         const preferred = ["index.html", "src/App.tsx", "src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.js"];
         let targetFile = preferred.find((candidate) => filePaths.includes(candidate)) || "";
         if (!targetFile) {
           targetFile = filePaths.find((candidate) =>
             /\\.(html|tsx|ts|jsx|js|css|json)$/i.test(candidate)
           ) || "";
         }
         if (!targetFile) throw new Error("No editable file found in forked project");

         const readResult = await ipc.request("vibefi-code", "code_readFile", [{ projectPath, filePath: targetFile }]);
         const original = (readResult && typeof readResult === "object" && typeof readResult.content === "string")
           ? readResult.content
           : "";
         const stamp = "e2e-" + Date.now().toString();
         const marker = targetFile.endsWith(".html") ? ("<!-- " + stamp + " -->") : ("// " + stamp);
         const nextContent = original.endsWith("\\n")
           ? (original + marker + "\\n")
           : (original + "\\n" + marker + "\\n");

         await ipc.request("vibefi-code", "code_writeFile", [{
           projectPath,
           filePath: targetFile,
           content: nextContent
         }]);

         const waitForProposeButton = async () => {
           const timeoutAt = Date.now() + 120000;
           while (Date.now() < timeoutAt) {
             const candidates = Array.from(document.querySelectorAll('button'));
             const button = candidates.find((el) =>
               (el.textContent || '').trim() === 'Propose Upgrade'
             );
             if (button && !button.disabled) {
               return button;
             }
             await new Promise((resolve) => setTimeout(resolve, 200));
           }
           throw new Error("Propose Upgrade button was not ready");
         };

         const waitForPublishResult = () =>
           new Promise((resolve, reject) => {
             const timeout = setTimeout(() => {
               window.removeEventListener("vibefi:code-provider-event", onEvent);
               reject(new Error("Timed out waiting for publish result event"));
             }, 300000);

             const onEvent = (event) => {
               const custom = event;
               const payload = custom?.detail;
               if (!payload || typeof payload !== "object") return;
               const kind = payload.event;
               if (kind === "codePublishComplete") {
                 clearTimeout(timeout);
                 window.removeEventListener("vibefi:code-provider-event", onEvent);
                 const value = payload.value && typeof payload.value === "object" ? payload.value : {};
                 const rootCid = typeof value.rootCid === "string" ? value.rootCid.trim() : "";
                 if (!rootCid) {
                   reject(new Error("Publish complete event missing rootCid"));
                   return;
                 }
                 resolve({ ok: true, rootCid });
                 return;
               }
               if (kind === "codePublishError") {
                 clearTimeout(timeout);
                 window.removeEventListener("vibefi:code-provider-event", onEvent);
                 const value = payload.value && typeof payload.value === "object" ? payload.value : {};
                 const message =
                   typeof value.message === "string" && value.message.trim()
                     ? value.message.trim()
                     : "Unknown publish failure";
                 reject(new Error(message));
               }
             };
             window.addEventListener("vibefi:code-provider-event", onEvent);
           });

         const resultPromise = waitForPublishResult();
         const proposeButton = await waitForProposeButton();
         proposeButton.click();
         const proposeResult = await resultPromise;
         const rootCid = proposeResult && typeof proposeResult === "object" && typeof proposeResult.rootCid === "string"
           ? proposeResult.rootCid.trim()
           : "";
         if (!rootCid) throw new Error("Publish result did not include rootCid");

         // code_openProject may auto-start Code Anvil and temporarily switch
         // global RPC routing. Stop it so Launcher reads from the devnet RPC.
         try {
           await ipc.request("vibefi-code", "code_stopAnvil", [{}]);
         } catch (_) {
           // Non-fatal in E2E; continue even if there was no running anvil.
         }

         return {
           projectPath,
           filePath: targetFile,
           marker,
           rootCid
         };`,
        300_000
    );

    const typedResult = result as CodeProposeResult;
    invariant(typedResult.rootCid, "Code propose flow returned empty rootCid");
    logger.info(
        "Code propose complete (project=%s file=%s rootCid=%s)",
        typedResult.projectPath,
        typedResult.filePath,
        typedResult.rootCid
    );
    return typedResult;
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

export async function connectWalletViaLocalSigner(
    automation: ClientAutomation,
    webviewId: string,
    label: string
): Promise<void> {
    const clickedConnect = await waitFor(
        `${label} connect wallet button clickable`,
        async () => {
            try {
                const clicked = await automation.evalJs(
                    webviewId,
                    `const button = Array.from(document.querySelectorAll('button'))
                       .find((el) => (el.textContent || '').trim() === 'Connect Wallet');
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
    invariant(clickedConnect, `Could not click Connect Wallet button in ${label}`);
    logger.info("Clicked Connect Wallet in %s", label);

    let selectorId = "";
    const selectorOpened = await waitFor(
        `${label} wallet selector open`,
        async () => {
            const webviews = await automation.listWebviews();
            const selector = webviews.find((wv) => wv.kind === "WalletSelector");
            if (!selector) return false;
            selectorId = selector.id;
            return true;
        },
        30_000
    );
    if (!selectorOpened) {
        logger.info("%s wallet selector did not open; checking direct account connection", label);
        let connectedAccount = "";
        const connected = await waitFor(
            `${label} provider account available after Connect Wallet click`,
            async () => {
                try {
                    const account = await automation.evalJs(
                        webviewId,
                        `try {
                           const accounts = await window.ethereum.request({ method: 'eth_accounts', params: [] });
                           return Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
                         } catch (_) {
                           return '';
                         }`
                    );
                    if (typeof account === "string" && account.trim().length > 0) {
                        connectedAccount = account.trim();
                        return true;
                    }
                    return false;
                } catch {
                    return false;
                }
            },
            30_000
        );
        invariant(
            connected,
            `Wallet did not connect in ${label} after clicking Connect Wallet`
        );
        logger.info("%s wallet connected with account %s", label, connectedAccount);
        return;
    }

    const selectorRendered = await waitFor(
        `${label} wallet selector rendered`,
        async () => {
            try {
                const text = await automation.evalJs(
                    selectorId,
                    "return document.body?.innerText || ''"
                );
                return typeof text === "string" && text.includes("Connect Wallet");
            } catch {
                return false;
            }
        },
        30_000
    );
    invariant(selectorRendered, `${label} wallet selector UI did not render`);

    await clickTabInTabBar(automation, "Connect Wallet");

    let connectedAccount = "";
    let clickedLocalSigner = false;
    let submittedLocalKey = false;
    const connected = await waitFor(
        `${label} provider account available after wallet selector flow`,
        async () => {
            const account = await automation.evalJs(
                webviewId,
                `try {
                   const accounts = await window.ethereum.request({ method: 'eth_accounts', params: [] });
                   return Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
                 } catch (_) {
                   return '';
                 }`
            );
            if (typeof account === "string" && account.trim().length > 0) {
                connectedAccount = account.trim();
                return true;
            }

            try {
                const webviews = await automation.listWebviews();
                const selector = webviews.find((wv) => wv.kind === "WalletSelector");
                if (!selector) return false;
                selectorId = selector.id;

                const action = await automation.evalJs(
                    selectorId,
                    `const text = document.body?.innerText || '';
                     const options = Array.from(document.querySelectorAll('.option, .surface-card, button, [role="button"]'));
                     const local = options.find((el) => (el.textContent || '').includes('Local Signer'));
                     let clickedLocal = false;
                     if (local) {
                       local.click();
                       clickedLocal = true;
                     }

                    const input = document.querySelector('input.key-input');
                     const connect = Array.from(document.querySelectorAll('button'))
                       .find((el) => (el.textContent || '').trim() === 'Connect');
                     let submittedKey = false;
                     if (input && connect && !connect.disabled) {
                       input.focus();
                       const nativeSetter = Object.getOwnPropertyDescriptor(
                         HTMLInputElement.prototype,
                         'value'
                       )?.set;
                       const nextValue = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
                       nativeSetter?.call(input, '');
                       input.dispatchEvent(new Event('input', { bubbles: true }));
                       for (const ch of nextValue) {
                         input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
                         nativeSetter?.call(input, (input.value || '') + ch);
                         input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
                         input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
                       }
                       connect.click();
                       submittedKey = true;
                     }

                     return { clickedLocal, submittedKey, text };`
                );
                if (action && typeof action === "object") {
                    const typed = action as { clickedLocal?: boolean; submittedKey?: boolean };
                    clickedLocalSigner = clickedLocalSigner || typed.clickedLocal === true;
                    submittedLocalKey = submittedLocalKey || typed.submittedKey === true;
                }
                return false;
            } catch {
                return false;
            }
        },
        60_000
    );
    if (!connected) {
        const webviews = await automation.listWebviews();
        const selector = webviews.find((wv) => wv.kind === "WalletSelector");
        let selectorDebug: { text?: string; buttons?: string[] } = {};
        if (selector) {
            selectorDebug = await automation.evalJs(
                selector.id,
                `const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
                 const buttons = Array.from(document.querySelectorAll('button, .option, .surface-card, [role="button"]'))
                   .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
                   .filter(Boolean)
                   .slice(0, 20);
                 return { text, buttons };`
            ) as { text?: string; buttons?: string[] };
        }
        throw new Error(
            `Wallet did not connect in ${label} after selector flow. clickedLocal=${clickedLocalSigner} submittedKey=${submittedLocalKey} selectorText=${JSON.stringify(selectorDebug.text ?? "")} selectorButtons=${JSON.stringify(selectorDebug.buttons ?? [])}`
        );
    }
    if (clickedLocalSigner) {
        logger.info("Clicked Local Signer in wallet selector for %s", label);
    }
    if (submittedLocalKey) {
        logger.info("%s Local Signer key was submitted", label);
    }
    logger.info("%s wallet connected with account %s", label, connectedAccount);

    const selectorClosed = await waitFor(
        `${label} wallet selector closed`,
        async () => {
            const webviews = await automation.listWebviews();
            return !webviews.some((wv) => wv.kind === "WalletSelector");
        },
        30_000
    );
    if (!selectorClosed) {
        await closeTabInTabBar(automation, "Connect Wallet");
    }
}
