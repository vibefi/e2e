import fs from "node:fs";
import path from "node:path";
import { Window as NativeWindow } from "node-screenshots";
import { invariant } from "./assertions";
import { config } from "./config";
import { ClientAutomation } from "./client-automation";
import { logger } from "./logger";

let screenshotRunDir: string | null = null;

function sanitizeScreenshotName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "screenshot"
  );
}

function getScreenshotRunDir(): string {
  if (screenshotRunDir) return screenshotRunDir;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  screenshotRunDir = path.join(
    config().monorepoDir,
    "e2e",
    "artifacts",
    "screenshots",
    stamp
  );
  fs.mkdirSync(screenshotRunDir, { recursive: true });
  return screenshotRunDir;
}

function clientPid(automation: ClientAutomation): number {
  const pid = automation.processId();
  invariant(typeof pid === "number" && pid > 0, "Client PID unavailable for screenshot capture");
  return pid;
}

function screenshotWindowTitleNeedle(): string {
  return (process.env.VIBEFI_E2E_WINDOW_TITLE ?? "vibefi").trim().toLowerCase();
}

function titleMatches(win: InstanceType<typeof NativeWindow>, needle: string): boolean {
  const title = win.title().toLowerCase();
  return title.includes(needle);
}

function selectClientWindowByTitle(automation: ClientAutomation): InstanceType<typeof NativeWindow> {
  const pid = clientPid(automation);
  const titleNeedle = screenshotWindowTitleNeedle();
  const allWindows = NativeWindow.all();
  const titleWindows = allWindows.filter((win) => titleMatches(win, titleNeedle));
  if (titleWindows.length === 0) {
    const sample = allWindows.slice(0, 10).map((win) => ({
      id: win.id(),
      pid: win.pid(),
      app: win.appName(),
      title: win.title(),
      minimized: win.isMinimized(),
      focused: win.isFocused(),
      bounds: [win.x(), win.y(), win.width(), win.height()],
    }));
    logger.warn(
      "No OS windows matched title substring %s for client PID %d (visible OS windows=%d). Window sample: %o",
      JSON.stringify(titleNeedle),
      pid,
      allWindows.length,
      sample
    );
  }
  invariant(
    titleWindows.length > 0,
    `No OS windows matched title substring ${JSON.stringify(titleNeedle)}`
  );

  const visibleWindows = titleWindows.filter(
    (win) => !win.isMinimized() && win.width() > 0 && win.height() > 0
  );
  const candidates = visibleWindows.length > 0 ? visibleWindows : titleWindows;

  const ranked = [...candidates].sort((a, b) => {
    const pidDelta = Number(b.pid() === pid) - Number(a.pid() === pid);
    if (pidDelta !== 0) return pidDelta;

    const focusDelta = Number(b.isFocused()) - Number(a.isFocused());
    if (focusDelta !== 0) return focusDelta;

    const areaDelta = b.width() * b.height() - a.width() * a.height();
    if (areaDelta !== 0) return areaDelta;

    // Prefer the top-most window if the z convention is increasing.
    const zDelta = b.z() - a.z();
    if (zDelta !== 0) return zDelta;

    return b.id() - a.id();
  });

  const selected = ranked[0];
  logger.info(
    "Selected client window for screenshot: targetPid=%d titleNeedle=%s id=%d pid=%d title=%s app=%s focused=%s minimized=%s bounds=%dx%d@%d,%d (titleMatches=%d visible=%d)",
    pid,
    JSON.stringify(titleNeedle),
    selected.id(),
    selected.pid(),
    JSON.stringify(selected.title()),
    JSON.stringify(selected.appName()),
    selected.isFocused() ? "yes" : "no",
    selected.isMinimized() ? "yes" : "no",
    selected.width(),
    selected.height(),
    selected.x(),
    selected.y(),
    titleWindows.length,
    visibleWindows.length
  );
  return selected;
}

export async function saveClientWindowScreenshot(
  automation: ClientAutomation,
  name: string
): Promise<string | null> {
  try {
    const window = selectClientWindowByTitle(automation);
    const image = await window.captureImage();
    const png = await image.toPng();

    const fileName = `${sanitizeScreenshotName(name)}.png`;
    const outPath = path.join(getScreenshotRunDir(), fileName);
    fs.writeFileSync(outPath, png);

    logger.info(
      "Saved client window screenshot %s (%dx%d) [windowId=%d pid=%d]",
      outPath,
      image.width,
      image.height,
      window.id(),
      window.pid()
    );
    return outPath;
  } catch (error) {
    logger.warn(
      "Client window screenshot failed for %s: %s",
      name,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
