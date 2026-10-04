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
}): Promise<{
  dryRun: boolean;
  pr: {
    number: Integer;
    state: string;
    isDraft: boolean;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    headRepository: { nameWithOwner: string } | null;
    headRepositoryOwner: { login: string } | null;
    isCrossRepository: boolean;
    maintainerCanModify: boolean;
    title: string;
  };
  localBranch: string;
  warning: string;
  planned: string[];
  changed: boolean;
}> {
  if (!Number.isInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    localBranch = input.localBranch ?? "pr-" + input.number + "-repair",
    requireClean = input.requireClean !== false,
    dryRun = input.dryRun ?? true;
  if (!dryRun && input.apply !== true)
    throw new Error("In-place checkout requires dryRun:false and apply:true");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9_.-]+$/.test(remote))
    throw new Error("repo or remote is invalid");
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const branchCheck = await tools.bash({
    command: "git check-ref-format --branch " + q(localBranch),
    workdir: input.workdir,
    description: "Validate local repair branch name",
    timeoutMs: 10000,
  });
  if (branchCheck.kind !== "foreground" || branchCheck.exitCode !== 0)
    throw new Error("localBranch is not a valid Git branch name");
  const checkoutIdentity = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: true,
  });
  if (requireClean && !checkoutIdentity.clean)
    throw new Error(
      "Active checkout has uncommitted changes; use prepare_isolated_pr_worktree for concurrent work or clean this checkout first.",
    );
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
        "number,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,title",
      ],
    }),
    pr = JSON.parse(detailResult.stdout);
  if (
    pr.number !== canonical.number ||
    pr.state !== canonical.state ||
    pr.isDraft !== canonical.isDraft ||
    pr.headRefOid !== canonical.headRefOid ||
    pr.baseRefName !== canonical.baseRefName
  )
    throw new Error("Pull request changed between canonical and detailed snapshots; retry");
  const planned = [
    "fetch the pull request head from " + remote,
    "verify the fetched commit matches the inspected pull request head",
    "replace the active checkout with branch " + localBranch,
  ];
  if (dryRun)
    return {
      dryRun,
      pr,
      localBranch,
      warning:
        "This operation replaces the active checkout. Prefer prepare_isolated_pr_worktree for concurrent work.",
      planned,
      changed: false,
    };
  const fetch = await tools.bash({
    command: "git fetch " + q(remote) + " " + q("refs/pull/" + input.number + "/head"),
    workdir: input.workdir,
    description: "Fetch inspected pull request commit",
    timeoutMs: 120000,
  });
  if (fetch.kind !== "foreground" || fetch.exitCode !== 0) {
    const diagnostic = await tools.project_diagnostic_text({
      lines:
        fetch.kind === "foreground"
          ? fetch.stderr.text.split(/\r?\n/)
          : ["Git fetch did not finish"],
      maxLines: 20,
      maxCharacters: 4000,
    });
    throw new Error(diagnostic.text || "Could not fetch the pull request head");
  }
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
  if (checkout.kind !== "foreground" || checkout.exitCode !== 0) {
    const diagnostic = await tools.project_diagnostic_text({
      lines:
        checkout.kind === "foreground"
          ? checkout.stderr.text.split(/\r?\n/)
          : ["Git checkout did not finish"],
      maxLines: 20,
      maxCharacters: 4000,
    });
    throw new Error(diagnostic.text || "Could not replace the active checkout");
  }
  return {
    dryRun,
    pr,
    localBranch,
    warning: "The active checkout branch and files were replaced.",
    planned,
    changed: true,
  };
}
