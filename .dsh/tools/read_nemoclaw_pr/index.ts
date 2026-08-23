/**
 * Read one canonical NemoClaw pull request identity and status snapshot.
 */
export default async function read_nemoclaw_pr(input: {
  workdir: string;
  number: Integer;
  repository?: string;
}): Promise<{
  number: Integer;
  url: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
}> {
  if (!Number.isInteger(input.number) || input.number < 1)
    throw new Error("number must be a positive integer");
  const repository = input.repository ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error("repository must be owner/name");
  const result = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "view",
      String(input.number),
      "--repo",
      repository,
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision",
    ],
  });
  const value = JSON.parse(result.stdout);
  const [owner, name] = repository.split("/");
  const expectedUrl = "https://github.com/" + owner + "/" + name + "/pull/" + input.number;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isInteger(value.number) ||
    value.number !== input.number ||
    value.url !== expectedUrl ||
    !new Set(["OPEN", "CLOSED", "MERGED"]).has(value.state) ||
    typeof value.isDraft !== "boolean" ||
    !/^[0-9a-f]{40,64}$/u.test(value.headRefOid) ||
    typeof value.baseRefName !== "string" ||
    value.baseRefName.length < 1 ||
    value.baseRefName.length > 255 ||
    !new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).has(value.mergeable) ||
    typeof value.mergeStateStatus !== "string" ||
    value.mergeStateStatus.length > 64 ||
    (value.reviewDecision !== null &&
      (typeof value.reviewDecision !== "string" || value.reviewDecision.length > 64))
  )
    throw new Error("GitHub pull request response did not match the canonical snapshot contract");
  return {
    number: value.number,
    url: value.url,
    state: value.state,
    isDraft: value.isDraft,
    headRefOid: value.headRefOid,
    baseRefName: value.baseRefName,
    mergeable: value.mergeable,
    mergeStateStatus: value.mergeStateStatus,
    reviewDecision: value.reviewDecision,
  };
}
