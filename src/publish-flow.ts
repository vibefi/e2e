import { proposeDapp } from "./governance";
import { runCliJson } from "./utils";

export interface PublishProposalInput {
  packagePath: string;
  name: string;
  version: string;
  description: string;
  proposalDescription: string;
  packageContext: string;
}

export async function packageAndProposeDapp({
  packagePath,
  name,
  version,
  description,
  proposalDescription,
  packageContext,
}: PublishProposalInput): Promise<{ rootCid: string; proposalId: string }> {
  const packageJson = await runCliJson<{ rootCid?: string }>(
    [
      "package",
      "--path",
      packagePath,
      "--name",
      name,
      "--dapp-version",
      version,
      "--description",
      description,
    ],
    packageContext,
    { noRpc: true }
  );

  if (!packageJson.rootCid) {
    throw new Error(
      `Missing rootCid from package output for ${name} (path: ${packagePath}, context: ${packageContext})`
    );
  }

  const { proposalId } = await proposeDapp({
    rootCid: packageJson.rootCid,
    name,
    version,
    description,
    proposalDescription,
  });

  return { rootCid: packageJson.rootCid, proposalId };
}
