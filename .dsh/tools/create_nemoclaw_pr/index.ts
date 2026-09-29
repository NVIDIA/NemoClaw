/**
 * Preview or create a NemoClaw pull request with exact-commit, DCO, verification, permission, and existing-PR guards.
 */
export default async function create_nemoclaw_pr(input: {
  title: string;
  body: string;
  headBranch?: string;
  baseBranch?: string;
  repo?: string;
  remote?: string;
  draft?: boolean;
  assignee?: "@me" | false;
  workdir: string;
  apply: boolean;
  expectedHeadSha: string;
  hookBypassReceipt?: {
    schemaVersion: 1;
    candidateSha: string;
    canonicalBaseSha: string;
    workflowRevisionSha: string;
    workflowPath: string;
    workflowBlobSha: string;
    workflowJob: string;
    draftOnly: true;
    expectedRemoteSha: null;
  };
}): Promise<{
  ok: boolean;
  apply: boolean;
  mutated: boolean;
  step?: string;
  repo: string;
  remote: string;
  baseBranch: string;
  headBranch: string;
  title?: string;
  draft: boolean;
  assignee: string | null;
  commitCount: Integer;
  verificationPending: boolean;
  url?: string;
  unverified: { sha: string; reason: string | null }[];
  blocker?: string | null;
  remoteState?: "not-checked" | "expected-commit" | "unchanged" | "unknown";
}> {
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const fallbackMarker = "<!-- nemoclaw-guarded-fallback-publication-evidence -->";
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    baseBranch = input.baseBranch ?? "main";
  if (
    typeof input.workdir !== "string" ||
    !input.workdir.trim() ||
    !/^[0-9a-f]{40}$/.test(input.expectedHeadSha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[A-Za-z0-9_.-]+$/.test(remote) ||
    baseBranch.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(baseBranch)
  )
    throw new Error("workdir and expectedHeadSha are required");
  if (
    typeof input.title !== "string" ||
    !/^(feat|fix|docs|chore|refactor|test|ci|perf)(\([a-z0-9-]+\))?: .{1,200}$/.test(input.title)
  )
    throw new Error("title must use the allowed Conventional Commits format");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100000)
    throw new Error("body is invalid");
  if (input.hookBypassReceipt !== undefined && input.draft !== true)
    throw new Error("Hook-free initial publication must create a draft pull request");
  const fallbackMarkerCount = input.body.split(fallbackMarker).length - 1;
  const verificationHeading = input.body.indexOf("## Verification");
  const reviewHeading = input.body.indexOf("## Review notes");
  const firstFallbackMarker = input.body.indexOf(fallbackMarker);
  const secondFallbackMarker = input.body.indexOf(fallbackMarker, firstFallbackMarker + 1);
  if (
    input.hookBypassReceipt !== undefined &&
    (fallbackMarkerCount !== 2 ||
      verificationHeading < 0 ||
      reviewHeading <= verificationHeading ||
      firstFallbackMarker <= verificationHeading ||
      firstFallbackMarker >= reviewHeading ||
      secondFallbackMarker <= reviewHeading ||
      input.body.includes("Local validation skipped because"))
  )
    throw new Error("Guarded initial publication requires exactly two unclaimed evidence markers");
  if (input.hookBypassReceipt === undefined && fallbackMarkerCount !== 0)
    throw new Error("Fallback evidence markers require guarded initial publication");
  if (
    !/^Signed-off-by:\s+.+\s+<[^<>\s]+@[^<>\s]+>\s*$/im.test(input.body) ||
    input.body.includes("Your Name <your-email@example.com>")
  )
    throw new Error("PR body must include a completed Signed-off-by declaration");
  const checkout = await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeStatus: false,
    }),
    head = checkout.head,
    branch = checkout.branch ?? "";
  if (!branch || branch.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(branch))
    throw new Error("Could not resolve a valid current branch; HEAD may be detached");
  if (head !== input.expectedHeadSha)
    throw new Error("Local commit does not match expectedHeadSha");
  if (input.headBranch && input.headBranch !== branch)
    throw new Error("Current branch does not match headBranch");
  const trailerResult = await tools.bash({
    command:
      "git log --format=" +
      q("%H%x09%(trailers:key=Signed-off-by,valueonly,separator=%x1f)") +
      " " +
      q(remote + "/" + baseBranch + "..HEAD"),
    workdir: input.workdir,
    description: "Read commit sign-off trailers",
    timeoutMs: 60000,
  });
  if (trailerResult.kind !== "foreground" || trailerResult.exitCode !== 0) {
    const diagnostic = await tools.project_diagnostic_text({
      lines:
        trailerResult.kind === "foreground"
          ? trailerResult.stderr.text.split(/\r?\n/)
          : ["Git log did not finish"],
      maxLines: 20,
      maxCharacters: 4000,
    });
    throw new Error(diagnostic.text || "Could not read commit sign-off trailers");
  }
  const trailerRows = trailerResult.stdout.text.split(/\r?\n/).filter(Boolean);
  if (
    !trailerRows.length ||
    trailerRows.some((row) => {
      const separator = row.indexOf("\t");
      return separator < 1 || row.slice(separator + 1).trim().length === 0;
    })
  )
    throw new Error("Every candidate commit must contain a Signed-off-by trailer");
  let assignee = null;
  let expectedAssigneeLogin = null;
  if (input.assignee !== false) {
    const permission = (
      await tools.run_github_cli({
        workdir: input.workdir,
        args: ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"],
      })
    ).stdout.trim();
    if (["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(permission)) {
      assignee = "@me";
      expectedAssigneeLogin = (
        await tools.run_github_cli({
          workdir: input.workdir,
          args: ["api", "user", "--jq", ".login"],
        })
      ).stdout.trim();
      if (!expectedAssigneeLogin) throw new Error("Could not resolve the prepared assignee");
    } else if (input.assignee === "@me")
      throw new Error("Repository permission does not allow self-assignment");
  }
  const publication = await tools.publish_nemoclaw_pr_branch({
    workdir: input.workdir,
    repository: repo,
    remote,
    baseBranch,
    expectedHeadSha: input.expectedHeadSha,
    ...(input.hookBypassReceipt !== undefined
      ? { hookBypassReceipt: input.hookBypassReceipt }
      : {}),
    ...(input.apply === true ? { apply: true } : {}),
  });
  const commitCount = publication.commits.length;
  if (input.apply !== true)
    return {
      ok: true,
      apply: false,
      mutated: false,
      repo,
      remote,
      baseBranch,
      headBranch: branch,
      title: input.title,
      draft: input.draft === true,
      assignee,
      commitCount,
      verificationPending: true,
      unverified: [],
    };
  if (publication.remoteState !== "expected-commit")
    return {
      ok: false,
      apply: true,
      mutated: publication.mutated,
      step: "publication",
      repo,
      remote,
      baseBranch,
      headBranch: branch,
      draft: input.draft === true,
      assignee,
      commitCount: publication.commits.length,
      verificationPending: false,
      unverified: [],
      blocker: publication.blocker,
      remoteState: publication.remoteState,
    };
  if (!publication.allVerified)
    return {
      ok: false,
      apply: true,
      mutated: publication.mutated,
      step: "verification",
      repo,
      remote,
      baseBranch,
      headBranch: branch,
      title: input.title,
      draft: input.draft === true,
      assignee,
      commitCount,
      verificationPending: false,
      unverified: publication.commits
        .filter((c) => !c.verified)
        .map((c) => ({ sha: c.sha, reason: c.reason })),
    };
  let preparedBody = input.body;
  if (input.hookBypassReceipt !== undefined) {
    const fallback = publication.guardedFallbackEvidence;
    if (
      fallback?.publicationValidated !== true ||
      fallback.candidateSha !== input.expectedHeadSha ||
      fallback.receipt.candidateSha !== input.expectedHeadSha ||
      fallback.receipt.canonicalBaseSha !== input.hookBypassReceipt.canonicalBaseSha ||
      fallback.receipt.workflowRevisionSha !== input.hookBypassReceipt.workflowRevisionSha ||
      fallback.receipt.workflowPath !== input.hookBypassReceipt.workflowPath ||
      fallback.receipt.workflowBlobSha !== input.hookBypassReceipt.workflowBlobSha ||
      fallback.receipt.workflowJob !== input.hookBypassReceipt.workflowJob ||
      fallback.receipt.draftOnly !== true ||
      fallback.receipt.expectedRemoteSha !== null ||
      fallback.disclosure.length === 0 ||
      /[\r\n]/.test(fallback.disclosure)
    )
      throw new Error("Publisher did not return exact guarded fallback evidence");
    preparedBody = input.body.replaceAll(fallbackMarker, fallback.disclosure);
  }
  const current = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: false,
  });
  if (current.head !== input.expectedHeadSha)
    throw new Error("Candidate commit changed after publication");
  const createArgs = [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    input.title,
    "--body",
    preparedBody,
  ];
  if (input.draft) createArgs.push("--draft");
  if (assignee) createArgs.push("--assignee", "@me");
  const listPreparedPulls = async () => {
    const lookup = await tools.run_github_cli({
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
        "url,isDraft,title,body,assignees,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner",
        "--limit",
        "2",
      ],
    });
    return JSON.parse(lookup.stdout || "[]");
  };
  const exactPreparedPull = (pulls) => {
    if (pulls.length !== 1) return null;
    const pull = pulls[0];
    const pullRepo =
      pull?.headRepository?.nameWithOwner ??
      (pull?.headRepository?.name && pull?.headRepositoryOwner?.login
        ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}`
        : "");
    const observedAssignees = Array.isArray(pull?.assignees)
      ? pull.assignees
          .map((entry) => entry?.login)
          .filter(Boolean)
          .sort()
      : [];
    const expectedAssignees = expectedAssigneeLogin ? [expectedAssigneeLogin] : [];
    return pull?.isDraft === (input.draft === true) &&
      pull?.title === input.title &&
      pull?.body === preparedBody &&
      JSON.stringify(observedAssignees) === JSON.stringify(expectedAssignees) &&
      pull?.headRefName === branch &&
      pull?.headRefOid === input.expectedHeadSha &&
      pull?.baseRefName === baseBranch &&
      pullRepo.toLowerCase() === repo.toLowerCase() &&
      typeof pull?.url === "string"
      ? pull
      : null;
  };
  const completed = (pull, mutated) => ({
    ok: true,
    apply: true,
    mutated,
    repo,
    remote,
    baseBranch,
    headBranch: branch,
    title: input.title,
    draft: input.draft === true,
    assignee,
    commitCount,
    verificationPending: false,
    url: pull.url,
    unverified: [],
  });
  if (publication.recoveredPullUrl) {
    const recoveredPull = exactPreparedPull(await listPreparedPulls());
    if (!recoveredPull || recoveredPull.url !== publication.recoveredPullUrl)
      throw new Error("Recovered pull request does not match every prepared publication field");
    return completed(recoveredPull, publication.mutated);
  }
  const readRemoteBranch = async (description) => {
    const result = await tools.bash({
      command: "git ls-remote --heads " + q(remote) + " " + q("refs/heads/" + branch),
      workdir: input.workdir,
      description,
      timeoutMs: 120000,
    });
    if (result.kind !== "foreground" || result.exitCode !== 0)
      throw new Error("Could not read the publication branch before pull request creation");
    return result.stdout.text.trim().split(/\s+/u)[0];
  };
  const requireUnchangedCreationState = async (description) => {
    const remoteSha = await readRemoteBranch(description);
    const pulls = await listPreparedPulls();
    if (remoteSha !== input.expectedHeadSha || pulls.length !== 0)
      throw new Error("Pull request creation state changed before the guarded write");
  };
  const create = () =>
    tools.run_github_cli({
      workdir: input.workdir,
      args: createArgs,
      acceptedExitCodes: [0, 1],
      timeoutMs: 120000,
      apply: true,
    });
  await requireUnchangedCreationState("Read publication branch before pull request creation");
  let created = await create();
  let pulls = await listPreparedPulls();
  let pull = exactPreparedPull(pulls);
  if (!pull && created.code !== 0 && pulls.length === 0) {
    const remoteSha = await readRemoteBranch(
      "Re-read publication branch before pull request retry",
    );
    const freshPulls = await listPreparedPulls();
    const freshPull = exactPreparedPull(freshPulls);
    if (remoteSha === input.expectedHeadSha && freshPull) return completed(freshPull, true);
    if (remoteSha !== input.expectedHeadSha || freshPulls.length !== 0)
      throw new Error("Pull request creation state changed before the guarded write");
    created = await create();
    pulls = await listPreparedPulls();
    pull = exactPreparedPull(pulls);
  }
  if (!pull) {
    if (created.code === 0)
      throw new Error(
        "Pull request creation reported success, but the observed pull request does not match the prepared publication",
      );
    if (pulls.length > 0)
      throw new Error(
        "Pull request creation failed; the observed pull request does not match the prepared draft publication",
      );
    const diagnostic = await tools.project_diagnostic_text({
      lines: created.stderr.split(/\r?\n/),
      maxLines: 20,
      maxCharacters: 4000,
    });
    throw new Error(
      "Pull request creation failed after one guarded retry; no pull request exists for the branch.\n" +
        diagnostic.text,
    );
  }
  if (created.code === 0 && created.stdout.trim() && created.stdout.trim() !== pull.url)
    throw new Error("Pull request creation response does not match the observed pull request");
  return completed(pull, true);
}
