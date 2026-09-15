/**
 * Push an exact clean NemoClaw candidate branch and return bounded GitHub commit-verification evidence.
 */
export default async function publish_nemoclaw_pr_branch(input: {
  workdir: string;
  repository?: string;
  remote?: string;
  baseBranch?: string;
  expectedHeadSha: string;
  pullNumber?: Integer;
  expectedPullHeadSha?: string;
  requireClean?: boolean;
  apply?: true;
}): Promise<{
  apply: boolean;
  mutated: boolean;
  pushed: boolean;
  repository: string;
  remote: string;
  baseBranch: string;
  branch: string;
  headSha: string;
  commits: { sha: string; verified: boolean; reason: string | null }[];
  allVerified: boolean;
  blocker: string | null;
  remoteState: "not-checked" | "expected-commit" | "unchanged" | "unknown";
}> {
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const repo = input.repository ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    baseBranch = input.baseBranch ?? "main";
  if (
    typeof input.workdir !== "string" ||
    !input.workdir.trim() ||
    !/^[0-9a-f]{40}$/.test(input.expectedHeadSha)
  )
    throw new Error("workdir and expectedHeadSha are required");
  if (input.expectedPullHeadSha !== undefined && !/^[0-9a-f]{40}$/.test(input.expectedPullHeadSha))
    throw new Error("expectedPullHeadSha must be a full commit SHA");
  if (
    input.pullNumber !== undefined &&
    (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
  )
    throw new Error("pullNumber must be a positive integer");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[A-Za-z0-9_.-]+$/.test(remote) ||
    remote.startsWith("-") ||
    !/^[A-Za-z0-9_./-]+$/.test(baseBranch) ||
    baseBranch.startsWith("-")
  )
    throw new Error("repository, remote, or baseBranch is invalid");
  const run = async (command, description, allow = false) => {
    const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: 120000 });
    if (r.kind !== "foreground") throw new Error(description + " did not finish");
    if (r.exitCode !== 0 && !allow) {
      const diagnostic = await tools.project_diagnostic_text({
        lines: r.stderr.text.split(/\r?\n/),
        maxLines: 20,
        maxCharacters: 4000,
      });
      throw new Error(diagnostic.text || description + " failed");
    }
    return r;
  };
  const checkout = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
  });
  const head = checkout.head;
  if (head !== input.expectedHeadSha)
    throw new Error("Local commit does not match expectedHeadSha");
  if (input.requireClean !== false && !checkout.clean)
    throw new Error("Publication candidate has uncommitted changes");
  const branch = checkout.branch ?? "";
  if (!branch || branch === baseBranch) throw new Error("Publication requires a feature branch");
  const repositoryDetails = await tools.run_github_cli({
    workdir: input.workdir,
    args: ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    timeoutMs: 120000,
  });
  const defaultBranch = repositoryDetails.stdout.trim();
  if (!defaultBranch || branch === defaultBranch)
    throw new Error("Publication requires a branch other than the repository default branch");
  const pushUrls = (
    await run("git remote get-url --push --all " + q(remote), "Read publication push URLs")
  ).stdout.text
    .split(/\r?\n/)
    .filter(Boolean);
  if (!pushUrls.length) throw new Error("Publication remote has no push URL");
  for (const pushUrl of pushUrls) {
    const httpsMatch = pushUrl.match(/^https:\/\/github[.]com\/([^/]+)\/([^/]+?)(?:[.]git)?$/);
    const sshMatch = pushUrl.match(
      /^(?:git@github[.]com:|ssh:\/\/git@github[.]com\/)([^/]+)\/([^/]+?)(?:[.]git)?$/,
    );
    const remoteRepo = httpsMatch ?? sshMatch;
    if (!remoteRepo || `${remoteRepo[1]}/${remoteRepo[2]}`.toLowerCase() !== repo.toLowerCase())
      throw new Error("Every publication push URL must match the declared GitHub repository");
  }
  const existing = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,headRefName,headRepository,headRepositoryOwner",
      "--limit",
      "2",
    ],
    timeoutMs: 120000,
  });
  const prs = JSON.parse(existing.stdout || "[]");
  if (prs.length > 1) throw new Error("Multiple open pull requests exist for this branch");
  if (prs.length === 1) {
    const pull = prs[0];
    const pullRepo =
      pull?.headRepository?.nameWithOwner ??
      (pull?.headRepository?.name && pull?.headRepositoryOwner?.login
        ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}`
        : "");
    if (pull?.headRefName !== branch || pullRepo.toLowerCase() !== repo.toLowerCase())
      throw new Error("The open pull request source does not match this branch and repository");
    if (input.pullNumber !== undefined && pull?.number !== input.pullNumber)
      throw new Error("The requested open pull request does not match this branch");
  }
  if (prs.length === 0 && input.pullNumber !== undefined)
    throw new Error("The requested open pull request does not match this branch");
  const commitCount = Number(
    (
      await run(
        "git rev-list --count --max-count=101 " +
          q(remote + "/" + baseBranch + ".." + input.expectedHeadSha),
        "Count publication commits",
      )
    ).stdout.text.trim(),
  );
  if (!Number.isSafeInteger(commitCount) || commitCount < 1)
    throw new Error("No commits are ahead of the trusted base");
  if (commitCount > 100) throw new Error("Publication exceeds the 100-commit verification bound");
  const commits = (
    await run(
      "git rev-list --reverse " + q(remote + "/" + baseBranch + ".." + input.expectedHeadSha),
      "List publication commits",
    )
  ).stdout.text
    .split(/\r?\n/)
    .filter(Boolean);
  if (commits.length !== commitCount)
    throw new Error("Publication commit count changed during validation");
  if (input.apply !== true)
    return {
      apply: false,
      mutated: false,
      pushed: false,
      repository: repo,
      remote,
      baseBranch,
      branch,
      headSha: head,
      commits: commits.map((sha) => ({
        sha,
        verified: false,
        reason: "not checked before publication",
      })),
      allVerified: false,
      blocker: null,
      remoteState: "not-checked",
    };
  const beforePush = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
  });
  if (
    beforePush.head !== input.expectedHeadSha ||
    (input.requireClean !== false && !beforePush.clean) ||
    beforePush.branch !== branch
  )
    throw new Error("Publication candidate changed after validation");
  if (input.pullNumber !== undefined) {
    const latest = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "view",
        String(input.pullNumber),
        "--repo",
        repo,
        "--json",
        "state,headRefOid,headRefName,headRepository,headRepositoryOwner",
      ],
      timeoutMs: 120000,
    });
    const pull = JSON.parse(latest.stdout || "{}");
    const pullRepo =
      pull?.headRepository?.nameWithOwner ??
      (pull?.headRepository?.name && pull?.headRepositoryOwner?.login
        ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}`
        : "");
    if (
      pull.state !== "OPEN" ||
      pull.headRefName !== branch ||
      pullRepo.toLowerCase() !== repo.toLowerCase() ||
      (input.expectedPullHeadSha !== undefined && pull.headRefOid !== input.expectedPullHeadSha)
    )
      throw new Error("Pull request identity changed before publication");
  }
  const remoteBeforeRead = await run(
    "git ls-remote --heads " + q(remote) + " " + q("refs/heads/" + branch),
    "Read publication branch before push",
    true,
  );
  const remoteBeforeReadOk = remoteBeforeRead.exitCode === 0;
  const remoteBefore = remoteBeforeReadOk
    ? remoteBeforeRead.stdout.text.trim().split(/\s+/u)[0]
    : "";
  let pushError = null;
  try {
    await run(
      "git push --set-upstream " +
        q(remote) +
        " " +
        q(input.expectedHeadSha + ":refs/heads/" + branch),
      "Push pull request candidate branch",
    );
  } catch (error) {
    pushError = error;
  }
  const remoteRead = await run(
    "git ls-remote --heads " + q(remote) + " " + q("refs/heads/" + branch),
    "Reconcile publication branch",
    true,
  );
  const remoteReadOk = remoteRead.exitCode === 0;
  const remoteSha = remoteReadOk ? remoteRead.stdout.text.trim().split(/\s+/u)[0] : "";
  const remoteState =
    remoteSha === input.expectedHeadSha
      ? "expected-commit"
      : remoteBeforeReadOk && remoteReadOk && remoteSha === remoteBefore
        ? "unchanged"
        : "unknown";
  if (remoteState !== "expected-commit") {
    const detail = await tools.project_diagnostic_text({
      lines: [String(pushError?.message ?? "Push did not publish the expected commit")],
      maxLines: 5,
      maxCharacters: 1000,
    });
    return {
      apply: true,
      mutated: false,
      pushed: false,
      repository: repo,
      remote,
      baseBranch,
      branch,
      headSha: head,
      commits: [],
      allVerified: false,
      blocker: detail.text || "Publication result is uncertain",
      remoteState,
    };
  }
  const changedRemote = remoteBeforeReadOk && remoteBefore !== input.expectedHeadSha;
  const verified = [];
  let verificationError = null;
  for (const sha of commits) {
    try {
      const r = await tools.run_github_cli({
        workdir: input.workdir,
        args: [
          "api",
          "repos/" + repo + "/commits/" + sha,
          "--jq",
          '[.commit.verification.verified, (.commit.verification.reason // "")] | @tsv',
        ],
        timeoutMs: 120000,
      });
      const [ok, reason] = r.stdout.trim().split("\t");
      verified.push({ sha, verified: ok === "true", reason: reason || null });
    } catch (error) {
      const detail = await tools.project_diagnostic_text({
        lines: [String(error?.message ?? error)],
        maxLines: 5,
        maxCharacters: 1000,
        maxLineCharacters: 500,
      });
      verificationError = detail.text || "GitHub commit verification read failed";
      break;
    }
  }
  const allVerified =
    !verificationError && verified.length === commits.length && verified.every((c) => c.verified);
  return {
    apply: true,
    mutated: changedRemote,
    pushed: changedRemote,
    repository: repo,
    remote,
    baseBranch,
    branch,
    headSha: head,
    commits: verified,
    allVerified,
    remoteState,
    blocker: allVerified
      ? null
      : verificationError
        ? "Commit verification is incomplete: " + verificationError
        : "One or more published commits are not verified.",
  };
}
