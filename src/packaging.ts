import { logSection, runCliJson } from "./utils";
import { logger } from "./logger";

export async function packageDapp(opts: {
  packagePath: string;
  name: string;
  version: string;
  description: string;
  cliContext?: string;
}): Promise<{ rootCid: string }> {
  const context = opts.cliContext ?? `package (${opts.name})`;

  logSection(`Package dapp: ${opts.name}`);
  logger.debug("Running: vibefi package (%s)...", opts.packagePath);
  const packageJson = await runCliJson<{ rootCid?: string }>(
    [
      "package",
      "--path",
      opts.packagePath,
      "--name",
      opts.name,
      "--dapp-version",
      opts.version,
      "--description",
      opts.description,
    ],
    context,
    { noRpc: true }
  );

  if (!packageJson.rootCid) {
    throw new Error(
      `Missing rootCid from package output for ${opts.name} (path: ${opts.packagePath}, context: ${context})`
    );
  }

  return { rootCid: packageJson.rootCid };
}
