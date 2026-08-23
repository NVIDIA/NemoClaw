/**
 * Inspect release prerequisites without dispatching a release workflow. Git fetch runs only with apply: true.
 */
export default async function run_nemoclaw_release_preflight(input: {
  workdir: string;
  repo?: string;
  remote?: string;
  branch?: string;
  bump?: "patch" | "minor" | "major";
  runLimit?: Integer;
  apply?: boolean;
}): Promise<{
  stage:
    | "fetch-failed"
    | "github-auth-failed"
    | "version-unavailable"
    | "github-runs-failed"
    | "complete";
  apply: boolean;
  error?: string;
  repo?: string;
  remote?: string;
  branch?: string;
  bump?: "patch" | "minor" | "major";
  candidateSha?: string;
  previousTag?: string;
  nextTag?: string;
  candidateSubject?: string;
  changelogMatches?: string;
  runs?: {
    databaseId: Integer;
    name: string;
    status: string;
    conclusion: string | null;
    headSha: string;
  }[];
  warning?: string | null;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    branch = input.branch ?? "main",
    bump = input.bump ?? "patch",
    apply = input.apply ?? false;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    remote.startsWith("-") ||
    !/^[A-Za-z0-9_.-]+$/.test(remote) ||
    branch.startsWith("-") ||
    !/^[A-Za-z0-9_./-]+$/.test(branch)
  )
    throw new Error("repo, remote, or branch is invalid");
  if (
    input.runLimit !== undefined &&
    (!Number.isInteger(input.runLimit) || input.runLimit < 1 || input.runLimit > 100)
  )
    throw new Error("runLimit must be an integer from 1 through 100");
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const diagnostic = async (text, sourceTruncated = false, maxLines = 20) =>
    (
      await tools.project_diagnostic_text({
        lines: text.split(/\r?\n/),
        clipMode: "head",
        maxLines,
        maxCharacters: 6000,
        maxLineCharacters: 1000,
        sourceTruncated,
      })
    ).text;
  const branchCheck = await tools.bash({
    command: "git check-ref-format --branch " + q(branch),
    workdir: input.workdir,
    description: "Validate release branch name",
    timeoutMs: 10000,
  });
  if (branchCheck.kind !== "foreground" || branchCheck.exitCode !== 0)
    throw new Error("branch is not a valid Git branch name");
  if (apply) {
    const fetched = await tools.bash({
      command:
        "git fetch --prune " +
        q(remote) +
        " " +
        q("refs/heads/" + branch + ":refs/remotes/" + remote + "/" + branch),
      workdir: input.workdir,
      description: "Refresh release candidate reference",
      timeoutMs: 120000,
    });
    if (fetched.kind !== "foreground" || (fetched.exitCode ?? -1) !== 0)
      return {
        stage: "fetch-failed",
        apply,
        error:
          fetched.kind === "foreground"
            ? await diagnostic(fetched.stderr.text, fetched.stderr.truncated)
            : "unexpected result",
      };
  }
  const acceptedExitCodes = Array.from({ length: 16 }, (_, code) => code);
  const auth = await tools.run_github_cli({
    workdir: input.workdir,
    args: ["auth", "status"],
    acceptedExitCodes,
    timeoutMs: 30000,
  });
  if (auth.code !== 0)
    return { stage: "github-auth-failed", apply, error: await diagnostic(auth.stderr) };
  const ref = remote + "/" + branch;
  const version = await tools.bash({
    command:
      "git rev-parse --verify " +
      q(ref + "^{commit}") +
      " && git describe --tags --abbrev=0 --match 'v[0-9]*' " +
      q(ref),
    workdir: input.workdir,
    description: "Inspect release candidate version",
    timeoutMs: 30000,
  });
  if (version.kind !== "foreground" || (version.exitCode ?? -1) !== 0)
    return {
      stage: "version-unavailable",
      apply,
      error:
        version.kind === "foreground"
          ? await diagnostic(version.stderr.text, version.stderr.truncated)
          : "unexpected result",
    };
  const [candidateSha, previousTag] = version.stdout.text.trim().split(/\r?\n/),
    match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(previousTag ?? "");
  if (!match) return { stage: "version-unavailable", apply, candidateSha, previousTag };
  let [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") {
    major++;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor++;
    patch = 0;
  } else patch++;
  const nextTag = "v" + major + "." + minor + "." + patch,
    limit = Math.max(1, Math.min(100, input.runLimit ?? 100));
  const [subjectResult, changelogResult, runResult] = await Promise.all([
    tools.bash({
      command: "git show -s --format=%s " + q(candidateSha),
      workdir: input.workdir,
      description: "Inspect release candidate subject",
      timeoutMs: 30000,
    }),
    tools.bash({
      command:
        "set -o pipefail; status=0; git grep -n " +
        q("^## " + nextTag.replaceAll(".", "\\.")) +
        " " +
        q(ref) +
        " -- 'docs/changelog/*.mdx' | sed -n '1,101p' || status=$?; " +
        'if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"',
      workdir: input.workdir,
      description: "Inspect bounded release changelog matches",
      timeoutMs: 60000,
    }),
    tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        "e2e.yaml",
        "--branch",
        branch,
        "--limit",
        String(limit),
        "--json",
        "databaseId,name,status,conclusion,headSha",
      ],
      acceptedExitCodes,
      timeoutMs: 60000,
    }),
  ]);
  if (subjectResult.kind !== "foreground" || subjectResult.exitCode !== 0)
    return {
      stage: "version-unavailable",
      apply,
      candidateSha,
      previousTag,
      error:
        subjectResult.kind === "foreground"
          ? await diagnostic(subjectResult.stderr.text, subjectResult.stderr.truncated)
          : "unexpected result",
    };
  if (changelogResult.kind !== "foreground" || changelogResult.exitCode !== 0)
    return {
      stage: "version-unavailable",
      apply,
      candidateSha,
      previousTag,
      error:
        changelogResult.kind === "foreground"
          ? await diagnostic(changelogResult.stderr.text, changelogResult.stderr.truncated)
          : "unexpected result",
    };
  if (runResult.code !== 0)
    return { stage: "github-runs-failed", apply, error: await diagnostic(runResult.stderr) };
  let parsedRuns;
  try {
    parsedRuns = JSON.parse(runResult.stdout);
    if (!Array.isArray(parsedRuns)) throw new Error("GitHub run response is not an array");
  } catch (error) {
    return { stage: "github-runs-failed", apply, error: await diagnostic(String(error)) };
  }
  const runs = parsedRuns.slice(0, limit).map((run) => ({
    databaseId: Number.isInteger(run.databaseId) ? run.databaseId : 0,
    name: typeof run.name === "string" ? run.name : "",
    status: typeof run.status === "string" ? run.status : "",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    headSha: typeof run.headSha === "string" ? run.headSha : "",
  }));
  return {
    stage: "complete",
    apply,
    repo,
    remote,
    branch,
    bump,
    candidateSha,
    previousTag,
    nextTag,
    candidateSubject: await diagnostic(
      subjectResult.kind === "foreground" ? subjectResult.stdout.text : "",
      subjectResult.kind === "foreground" && subjectResult.stdout.truncated,
      1,
    ),
    changelogMatches: await diagnostic(
      changelogResult.kind === "foreground" ? changelogResult.stdout.text : "",
      changelogResult.kind === "foreground" && changelogResult.stdout.truncated,
      100,
    ),
    runs,
    warning: apply ? null : "Remote refs were not refreshed because apply was false.",
  };
}
