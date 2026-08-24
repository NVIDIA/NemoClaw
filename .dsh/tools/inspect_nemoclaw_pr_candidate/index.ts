/**
 * Inspect branch, DCO, verification, permissions, changes, and publication blockers for one NemoClaw pull request candidate.
 */
export default async function inspect_nemoclaw_pr_candidate(input: {
  workdir: string;
  repository?: string;
  remote?: string;
  baseBranch?: string;
  refreshBase?: boolean;
  apply?: boolean;
}): Promise<{
  repository: string;
  remote: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  headSha: string;
  clean: boolean | null;
  commits: {
    sha: string;
    subject: string;
    signedOffBy: boolean;
    githubVerification: string;
    verificationReason: string | null;
  }[];
  changedFiles: string[];
  aheadCount: Integer;
  permissions: { viewerPermission: string; canAssignSelf: boolean };
  existingPullRequest: { number: Integer; state: string; url: string } | null;
  inferred: {
    issueNumbers: Integer[];
    typeOfChange: string;
    sensitivePaths: string[];
    dgxStationEvidenceRequired: boolean;
  };
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}> {
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const repo = input.repository ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    baseBranch = input.baseBranch ?? "main";
  if (
    typeof input.workdir !== "string" ||
    !input.workdir.trim() ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    remote.startsWith("-") ||
    !/^[A-Za-z0-9_.-]+$/.test(remote) ||
    baseBranch.startsWith("-") ||
    !/^[A-Za-z0-9_./-]+$/.test(baseBranch)
  )
    throw new Error("Invalid candidate input");
  if (input.refreshBase !== false && input.apply !== true)
    throw new Error("Refreshing the base reference requires apply: true");
  const run = async (command, description, allow = false) => {
    const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: 60000 });
    if (r.kind !== "foreground") throw new Error(description + " did not finish");
    if (r.stdout.truncated || r.stderr.truncated) {
      const diagnostic = await tools.project_diagnostic_text({
        lines: (r.stderr.text || r.stdout.text).split(/\r?\n/),
        maxLines: 20,
        maxCharacters: 4000,
        sourceTruncated: true,
      });
      throw new Error(
        description +
          " exceeded the bounded command output" +
          (diagnostic.text ? ".\n" + diagnostic.text : ""),
      );
    }
    if (r.exitCode !== 0 && !allow) {
      const diagnostic = await tools.project_diagnostic_text({
        lines: (r.stderr.text || r.stdout.text).split(/\r?\n/),
        maxLines: 20,
        maxCharacters: 4000,
      });
      throw new Error(diagnostic.text || description + " failed");
    }
    return r;
  };
  if (input.refreshBase !== false)
    await run(
      "git fetch --prune " + q(remote) + " " + q(baseBranch),
      "Refresh trusted pull request base",
    );
  const checkout = await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
    }),
    branch = checkout.branch ?? "",
    headSha = checkout.head,
    baseSha = (
      await run("git rev-parse " + q(remote + "/" + baseBranch), "Read trusted base commit")
    ).stdout.text.trim(),
    range = remote + "/" + baseBranch + "..HEAD";
  const log = (
      await run(
        "git log --reverse --format=" +
          q("%H%x09%s%x09%(trailers:key=Signed-off-by,valueonly,separator=%x1f)") +
          " " +
          q(range),
        "Read candidate commits",
      )
    ).stdout.text
      .split(/\r?\n/)
      .filter(Boolean),
    commits = [];
  for (const row of log) {
    const [sha, subject, signedOffByTrailer = ""] = row.split("\t");
    const vr = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repo + "/commits/" + sha,
        "--jq",
        '[.commit.verification.verified, (.commit.verification.reason // "")] | @tsv',
      ],
      acceptedExitCodes: [0, 1],
    });
    let githubVerification = "not-pushed",
      verificationReason = null;
    if (vr.code === 0) {
      const [ok, reason] = vr.stdout.trim().split("\t");
      githubVerification = ok === "true" ? "verified" : "unverified";
      verificationReason = reason || null;
    } else if (!/404|Not Found|422|No commit found for SHA/i.test(vr.stderr + vr.stdout))
      throw new Error("GitHub verification read failed; stop and restore access");
    commits.push({
      sha,
      subject,
      signedOffBy: signedOffByTrailer.trim().length > 0,
      githubVerification,
      verificationReason,
    });
  }
  const changedFiles = (
    await run(
      "git diff --name-only " + q(remote + "/" + baseBranch + "...HEAD"),
      "List candidate files",
    )
  ).stdout.text
    .split(/\r?\n/)
    .filter(Boolean);
  const permission = (
    await tools.run_github_cli({
      workdir: input.workdir,
      args: ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"],
    })
  ).stdout.trim();
  let existing = [];
  if (branch) {
    const existingResult = await tools.run_github_cli({
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
        "number,url,state",
        "--limit",
        "2",
      ],
    });
    existing = JSON.parse(existingResult.stdout || "[]");
  }
  const docs = changedFiles.filter((f) => /^(docs|fern)\//.test(f)),
    codeFiles = changedFiles.filter((f) => !/^(docs|fern)\//.test(f)),
    sensitivePaths = changedFiles.filter((f) =>
      /^(src\/lib\/(security|policy|credentials|preflight|onboard|inference|runner|sandbox|messaging)|nemoclaw\/src\/(blueprint|onboard)|nemoclaw-blueprint\/)/.test(
        f,
      ),
    ),
    issues = new Set();
  for (const text of [branch, ...commits.map((c) => c.subject)])
    for (const m of text.matchAll(/#([1-9][0-9]*)\b/g)) issues.add(Number(m[1]));
  const blockers = [],
    warnings = [];
  if (!branch)
    blockers.push({ code: "detached-head", message: "The candidate checkout is detached." });
  if (branch === baseBranch)
    blockers.push({ code: "base-branch", message: "The candidate is on the base branch." });
  if (!checkout.clean)
    blockers.push({
      code: "dirty-worktree",
      message: "The candidate worktree has uncommitted changes.",
    });
  if (!commits.length)
    blockers.push({
      code: "no-commits",
      message: "The candidate has no commits ahead of the trusted base.",
    });
  if (commits.some((c) => !c.signedOffBy))
    blockers.push({
      code: "missing-sign-off",
      message: "One or more candidate commits lack a Signed-off-by trailer.",
    });
  if (commits.some((c) => c.githubVerification === "unverified"))
    blockers.push({
      code: "unverified-commit",
      message: "GitHub reports one or more commits as unverified.",
    });
  if (commits.some((c) => c.githubVerification === "not-pushed"))
    warnings.push({
      code: "verification-pending",
      message: "Push is required before GitHub verification can be checked.",
    });
  if (existing.length)
    blockers.push({
      code: "existing-pr",
      message: "An open pull request already uses this branch.",
    });
  return {
    repository: repo,
    remote,
    baseBranch,
    baseSha,
    branch,
    headSha,
    clean: checkout.clean,
    commits,
    changedFiles,
    aheadCount: commits.length,
    permissions: {
      viewerPermission: permission,
      canAssignSelf: ["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(permission),
    },
    existingPullRequest: existing[0] ?? null,
    inferred: {
      issueNumbers: [...issues],
      typeOfChange: codeFiles.length
        ? docs.length
          ? "code-with-docs"
          : "code"
        : docs.length
          ? "docs-prose"
          : "code",
      sensitivePaths,
      dgxStationEvidenceRequired: changedFiles.includes("scripts/prepare-dgx-station-host.sh"),
    },
    blockers,
    warnings,
  };
}
