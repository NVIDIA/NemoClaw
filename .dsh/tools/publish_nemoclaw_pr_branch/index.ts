/**
 * Push an exact clean NemoClaw candidate branch and return bounded GitHub commit-verification evidence. Hook-free publication requires a candidate- and base-bound fallback receipt.
 */
export default async function publish_nemoclaw_pr_branch(input: {
  workdir: string;
  repository?: string;
  remote?: string;
  baseBranch?: string;
  expectedHeadSha: string;
  pullNumber?: Integer;
  expectedPullHeadSha?: string;
  hookBypassReceipt?: {
    schemaVersion: 1;
    candidateSha: string;
    canonicalBaseSha: string;
    workflowPath: string;
    workflowBlobSha: string;
    workflowJob: string;
    workflowSource: "canonical-base";
    effectivePermissions: "read-only";
    candidateLocalActions: false;
    candidateCredentialInputs: false;
    draftOnly: true;
    expectedRemoteSha: string | null;
  };
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
  const bypass = input.hookBypassReceipt;
  if (bypass !== undefined) {
    if (
      typeof bypass !== "object" ||
      bypass === null ||
      bypass.schemaVersion !== 1 ||
      bypass.candidateSha !== input.expectedHeadSha ||
      !/^[0-9a-f]{40}$/.test(bypass.canonicalBaseSha) ||
      !/^\.github\/workflows\/[A-Za-z0-9._/-]+[.]ya?ml$/.test(bypass.workflowPath) ||
      bypass.workflowPath.includes("..") ||
      !/^[0-9a-f]{40}$/.test(bypass.workflowBlobSha) ||
      typeof bypass.workflowJob !== "string" ||
      !bypass.workflowJob.trim() ||
      bypass.workflowJob.length > 200 ||
      bypass.workflowSource !== "canonical-base" ||
      bypass.effectivePermissions !== "read-only" ||
      bypass.candidateLocalActions !== false ||
      bypass.candidateCredentialInputs !== false ||
      bypass.draftOnly !== true ||
      (bypass.expectedRemoteSha !== null && !/^[0-9a-f]{40}$/.test(bypass.expectedRemoteSha))
    )
      throw new Error("hookBypassReceipt is not a valid trusted fallback record");
    if (
      input.expectedPullHeadSha !== undefined &&
      bypass.expectedRemoteSha !== input.expectedPullHeadSha
    )
      throw new Error("The guarded remote expectation must match the pull request commit");
  }
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
  if (bypass !== undefined) {
    const canonicalBase = await tools.run_github_cli({
      workdir: input.workdir,
      args: ["api", "repos/" + repo + "/git/ref/heads/" + baseBranch, "--jq", ".object.sha"],
      timeoutMs: 120000,
    });
    if (canonicalBase.stdout.trim() !== bypass.canonicalBaseSha)
      throw new Error("The guarded fallback base is no longer canonical");
    const workflowBlob = (
      await run(
        "git rev-parse " + q(bypass.canonicalBaseSha + ":" + bypass.workflowPath),
        "Verify guarded fallback workflow",
      )
    ).stdout.text.trim();
    if (workflowBlob !== bypass.workflowBlobSha)
      throw new Error("The guarded fallback workflow does not match its base-bound receipt");
  }
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
      "number,url,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner",
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
    if (
      bypass !== undefined &&
      (pull?.isDraft !== true || pull?.headRefOid !== bypass.expectedRemoteSha)
    )
      throw new Error("Guarded hook-free updates require the expected draft pull request");
  }
  if (prs.length === 0 && input.pullNumber !== undefined)
    throw new Error("The requested open pull request does not match this branch");
  if (bypass !== undefined && prs.length === 0 && bypass.expectedRemoteSha !== null)
    throw new Error("Initial guarded publication requires an absent remote branch");
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
        "state,isDraft,headRefOid,headRefName,headRepository,headRepositoryOwner",
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
      (bypass !== undefined && pull.isDraft !== true) ||
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
  if (bypass !== undefined) {
    if (!remoteBeforeReadOk)
      throw new Error("Could not verify the publication branch before guarded publication");
    const expectedRemote = bypass.expectedRemoteSha ?? "";
    if (remoteBefore !== expectedRemote)
      throw new Error("Publication branch changed before guarded publication");
    if (bypass.expectedRemoteSha !== null) {
      const ancestor = await run(
        "git merge-base --is-ancestor " +
          q(bypass.expectedRemoteSha) +
          " " +
          q(input.expectedHeadSha),
        "Verify guarded publication ancestry",
        true,
      );
      if (ancestor.exitCode !== 0)
        throw new Error("The expected remote commit is not an ancestor of the candidate");
    }
  }
  let pushError = null;
  try {
    await run(
      "git push " +
        (bypass !== undefined
          ? "--no-verify " +
            q("--force-with-lease=refs/heads/" + branch + ":" + (bypass.expectedRemoteSha ?? "")) +
            " "
          : "") +
        "--set-upstream " +
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
