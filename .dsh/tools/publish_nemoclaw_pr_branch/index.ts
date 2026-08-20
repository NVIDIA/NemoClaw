/**
 * Push an exact clean NemoClaw candidate branch and return bounded GitHub commit-verification evidence.
 */
export default async function publish_nemoclaw_pr_branch(input: {
  workdir: string;
  repository?: string;
  remote?: string;
  baseBranch?: string;
  expectedHeadSha: string;
  apply?: true;
}): Promise<Open<{}>> {
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
  const run = async (command, description, allow = false) => {
    const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: 120000 });
    if (r.kind !== "foreground") throw new Error(description + " did not finish");
    if (r.exitCode !== 0 && !allow) throw new Error(r.stderr.text || description + " failed");
    return r;
  };
  const checkout = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
  });
  const head = checkout.head;
  if (head !== input.expectedHeadSha)
    throw new Error("Local commit does not match expectedHeadSha");
  if (!checkout.clean) throw new Error("Publication candidate has uncommitted changes");
  const branch = checkout.branch ?? "";
  if (!branch || branch === baseBranch) throw new Error("Publication requires a feature branch");
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
      "number,url",
      "--limit",
      "2",
    ],
    timeoutMs: 120000,
  });
  const prs = JSON.parse(existing.stdout || "[]");
  if (prs.length) throw new Error("An open pull request already exists for this branch");
  const commits = (
    await run(
      "git rev-list --reverse " + q(remote + "/" + baseBranch + "..HEAD"),
      "List publication commits",
    )
  ).stdout.text
    .split(/\r?\n/)
    .filter(Boolean);
  if (!commits.length) throw new Error("No commits are ahead of the trusted base");
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
    };
  await run(
    "git push --set-upstream " + q(remote) + " " + q("HEAD:refs/heads/" + branch),
    "Push pull request candidate branch",
  );
  const verified = [];
  for (const sha of commits) {
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
  }
  const allVerified = verified.every((c) => c.verified);
  return {
    apply: true,
    mutated: true,
    pushed: true,
    repository: repo,
    remote,
    baseBranch,
    branch,
    headSha: head,
    commits: verified,
    allVerified,
    blocker: allVerified ? null : "One or more published commits are not verified.",
  };
}
