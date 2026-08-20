/**
 * Inspect release prerequisites without dispatching a release workflow.
 */
export default async function run_nemoclaw_release_preflight(input: {
  workdir: string;
  repo?: string;
  remote?: string;
  branch?: string;
  bump?: "patch" | "minor" | "major";
  runLimit?: Integer;
  dryRun?: boolean;
}): Promise<Open<{}>> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    remote = input.remote ?? "origin",
    branch = input.branch ?? "main",
    bump = input.bump ?? "patch",
    dryRun = input.dryRun ?? true;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[A-Za-z0-9_.-]+$/.test(remote) ||
    !/^[A-Za-z0-9_./-]+$/.test(branch)
  )
    throw new Error("repo, remote, or branch is invalid");
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  if (!dryRun) {
    const f = await tools.bash({
      command: "git fetch --prune " + q(remote) + " " + q(branch),
      workdir: input.workdir,
      description: "Refresh release candidate reference",
      timeoutMs: 120000,
    });
    if (f.kind !== "foreground" || (f.exitCode ?? -1) !== 0) {
      const error =
        f.kind === "foreground"
          ? await tools.project_diagnostic_text({
              lines: [f.stderr.text],
              clipMode: "head",
              maxLines: 1,
              maxCharacters: 2000,
              maxLineCharacters: 4000000,
              sourceTruncated: f.stderr.truncated,
            })
          : null;
      return {
        stage: "fetch-failed",
        dryRun,
        error: error?.text ?? "unexpected result",
      };
    }
  }
  const acceptedExitCodes = Array.from({ length: 16 }, (_, code) => code);
  const auth = await tools.run_github_cli({
    workdir: input.workdir,
    args: ["auth", "status"],
    acceptedExitCodes,
    timeoutMs: 30000,
  });
  if (auth.code !== 0) {
    const error = await tools.project_diagnostic_text({
      lines: [auth.stderr],
      clipMode: "head",
      maxLines: 1,
      maxCharacters: 2000,
      maxLineCharacters: 4000000,
    });
    return {
      stage: "github-auth-failed",
      dryRun,
      error: error.text,
    };
  }
  const ref = remote + "/" + branch,
    r = await tools.bash({
      command:
        "git rev-parse " +
        q(ref) +
        " && git describe --tags --abbrev=0 --match 'v[0-9]*' " +
        q(ref),
      workdir: input.workdir,
      description: "Inspect release candidate version",
      timeoutMs: 30000,
    });
  if (r.kind !== "foreground" || (r.exitCode ?? -1) !== 0) {
    const error =
      r.kind === "foreground"
        ? await tools.project_diagnostic_text({
            lines: [r.stderr.text],
            clipMode: "head",
            maxLines: 1,
            maxCharacters: 2000,
            maxLineCharacters: 4000000,
            sourceTruncated: r.stderr.truncated,
          })
        : null;
    return {
      stage: "version-unavailable",
      dryRun,
      error: error?.text ?? "unexpected result",
    };
  }
  const [candidateSha, previousTag] = r.stdout.text.trim().split(/\r?\n/),
    m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(previousTag ?? "");
  if (!m) return { stage: "version-unavailable", dryRun, candidateSha, previousTag };
  let [major, minor, patch] = m.slice(1).map(Number);
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
  const d = await tools.bash({
    command:
      "git show -s --format=%s " +
      q(candidateSha) +
      "; git grep -n " +
      q("^## " + nextTag.replaceAll(".", "\\.")) +
      " " +
      q(ref) +
      " -- 'docs/changelog/*.mdx' || true",
    workdir: input.workdir,
    description: "Inspect release changelog details",
    timeoutMs: 60000,
  });
  const runs = await tools.run_github_cli({
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
      "databaseId,name,status,conclusion,url,headSha",
    ],
    acceptedExitCodes,
    timeoutMs: 60000,
  });
  return {
    stage: "complete",
    dryRun,
    repo,
    remote,
    branch,
    bump,
    candidateSha,
    previousTag,
    nextTag,
    details: (d.kind === "foreground" ? d.stdout.text : "") + runs.stdout,
    warning: dryRun ? "Remote refs were not refreshed in dry-run mode." : null,
  };
}
