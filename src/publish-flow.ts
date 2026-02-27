import { proposeDapp } from "./governance";
import { runCliJson } from "./utils";

export interface PublishProposalInput {
  packagePath: string;
  name: string;
  version: string;
  description: string;
  proposalDescription: string;
  cliContext?: string;
}

export async function packageAndProposeDapp({
  packagePath,
  name,
  version,
  description,
  proposalDescription,
  cliContext,
}: PublishProposalInput): Promise<{ rootCid: string; proposalId: string }> {
  const context = cliContext ?? `package (${name})`;
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
    context,
    { noRpc: true }
  );

  if (!packageJson.rootCid) {
    throw new Error(
      `Missing rootCid from package output for ${name} (path: ${packagePath}, context: ${context})`
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
