/**
 * Replace the active checkout with a pull request repair branch. Prefer prepare_isolated_pr_worktree for concurrent work.
 */
export default async function checkout_pr_for_local_repair(input: {
  workdir: string;
  number: Integer;
  repo?: string;
  remote?: string;
  localBranch?: string;
  requireClean?: boolean;
  dryRun?: boolean;
  apply?: true;
}): Promise<Open<{}>> {
  if (!Number.isInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    localBranch = input.localBranch ?? "pr-" + input.number + "-repair",
    requireClean = input.requireClean !== false,
    dryRun = input.dryRun ?? true;
  if (!dryRun && input.apply !== true)
    throw new Error("In-place checkout requires dryRun:false and apply:true");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[A-Za-z0-9_.-]+$/.test(remote) ||
    !/^[A-Za-z0-9_./-]+$/.test(localBranch)
  )
    throw new Error("repo, remote, or localBranch is invalid");
  const [checkoutIdentity, before] = await Promise.all([
    tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
      includeStatus: true,
    }),
    tools.bash({
      command: "git status --short --branch",
      workdir: input.workdir,
      description: "Read active checkout diagnostic",
      timeoutMs: 30000,
    }),
  ]);
  if (before.kind !== "foreground" || before.exitCode !== 0)
    throw new Error("Could not inspect active checkout");
  const uncommitted = before.stdout.text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("##"));
  if (requireClean && !checkoutIdentity.clean)
    throw new Error(
      "Active checkout has uncommitted changes; use prepare_isolated_pr_worktree for concurrent work or clean this checkout first.\n" +
        uncommitted.join("\n"),
    );
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const canonical = await tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: input.number,
      repository: repo,
    }),
    detailResult = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "view",
        String(input.number),
        "--repo",
        repo,
        "--json",
        "number,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,title,url",
      ],
    }),
    pr = JSON.parse(detailResult.stdout);
  if (
    pr.number !== canonical.number ||
    pr.url !== canonical.url ||
    pr.state !== canonical.state ||
    pr.isDraft !== canonical.isDraft ||
    pr.headRefOid !== canonical.headRefOid ||
    pr.baseRefName !== canonical.baseRefName
  )
    throw new Error("Pull request changed between canonical and detailed snapshots; retry");
  if (dryRun)
    return {
      dryRun,
      pr,
      localBranch,
      before: before.stdout.text,
      warning:
        "This operation replaces the active checkout. Prefer prepare_isolated_pr_worktree for concurrent work.",
      planned: [
        "git fetch " + remote + " refs/pull/" + input.number + "/head",
        "verify FETCH_HEAD equals " + pr.headRefOid,
        "git checkout -B " + localBranch + " " + pr.headRefOid,
      ],
    };
  const fetch = await tools.bash({
    command: "git fetch " + q(remote) + " " + q("refs/pull/" + input.number + "/head"),
    workdir: input.workdir,
    description: "Fetch inspected pull request commit",
    timeoutMs: 120000,
  });
  if (fetch.kind !== "foreground" || fetch.exitCode !== 0)
    throw new Error(fetch.kind === "foreground" ? fetch.stderr.text : "Unexpected result");
  const resolved = await tools.bash({
    command: "git rev-parse FETCH_HEAD",
    workdir: input.workdir,
    description: "Verify fetched pull request commit",
    timeoutMs: 10000,
  });
  if (
    resolved.kind !== "foreground" ||
    resolved.exitCode !== 0 ||
    resolved.stdout.text.trim() !== pr.headRefOid
  )
    throw new Error("Latest PR commit changed during preparation; retry with a fresh snapshot");
  const checkout = await tools.bash({
    command: "git checkout -B " + q(localBranch) + " " + q(pr.headRefOid),
    workdir: input.workdir,
    description: "Replace active checkout with pull request",
    timeoutMs: 120000,
  });
  if (checkout.kind !== "foreground" || checkout.exitCode !== 0)
    throw new Error(checkout.kind === "foreground" ? checkout.stderr.text : "Unexpected result");
  return {
    dryRun,
    pr,
    localBranch,
    before: before.stdout.text,
    checkout: checkout.stdout.text,
    warning: "The active checkout branch and files were replaced.",
  };
}
