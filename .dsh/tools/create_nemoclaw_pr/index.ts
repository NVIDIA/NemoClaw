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
}> {
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
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
  if (input.assignee !== false) {
    const permission = (
      await tools.run_github_cli({
        workdir: input.workdir,
        args: ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"],
      })
    ).stdout.trim();
    if (["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(permission)) assignee = "@me";
    else if (input.assignee === "@me")
      throw new Error("Repository permission does not allow self-assignment");
  }
  const publication = await tools.publish_nemoclaw_pr_branch({
    workdir: input.workdir,
    repository: repo,
    remote,
    baseBranch,
    expectedHeadSha: input.expectedHeadSha,
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
    input.body,
  ];
  if (input.draft) createArgs.push("--draft");
  if (assignee) createArgs.push("--assignee", "@me");
  const created = await tools.run_github_cli({
    workdir: input.workdir,
    args: createArgs,
    acceptedExitCodes: [0, 1],
    timeoutMs: 120000,
    apply: true,
  });
  if (created.code !== 0) {
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
        "url",
        "--limit",
        "1",
        "--jq",
        ".[0].url // empty",
      ],
    });
    if (lookup.stdout.trim())
      return {
        ok: true,
        apply: true,
        mutated: false,
        repo,
        remote,
        baseBranch,
        headBranch: branch,
        title: input.title,
        draft: input.draft === true,
        assignee,
        commitCount,
        verificationPending: false,
        url: lookup.stdout.trim(),
        unverified: [],
      };
    const diagnostic = await tools.project_diagnostic_text({
      lines: created.stderr.split(/\r?\n/),
      maxLines: 20,
      maxCharacters: 4000,
    });
    throw new Error(
      "Pull request creation failed; no pull request exists for the branch.\n" + diagnostic.text,
    );
  }
  return {
    ok: true,
    apply: true,
    mutated: true,
    repo,
    remote,
    baseBranch,
    headBranch: branch,
    title: input.title,
    draft: input.draft === true,
    assignee,
    commitCount,
    verificationPending: false,
    url: created.stdout.trim(),
    unverified: [],
  };
}
