/**
 * Plan or apply guarded synchronization of one stacked pull request branch.
 */
export default async function sync_stacked_pr_branch(input: {
  workdir: string;
  headBranch: string;
  baseBranch: string;
  remote?: string;
  resetToRemote?: boolean;
  requireClean?: boolean;
  apply?: true;
}): Promise<{
  applied: boolean;
  mode: "dry-run" | "read-only" | "apply" | "blocked";
  plan: string[];
  notes: string[];
  resultJson: string;
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const remote = input.remote ?? "origin";
  if (
    typeof remote !== "string" ||
    !remote ||
    remote.length > 255 ||
    remote.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(remote)
  )
    throw new Error("Invalid Git remote");
  for (const [label, branch] of [
    ["head", input.headBranch],
    ["base", input.baseBranch],
  ]) {
    if (typeof branch !== "string" || !branch || branch.length > 255 || branch.startsWith("-"))
      throw new Error("Invalid " + label + " branch");
    const checked = await tools.bash({
      command: "git check-ref-format --branch " + quote(branch),
      workdir: input.workdir,
      description: "Validate stacked branch name",
      timeoutMs: 30000,
    });
    if (checked.kind !== "foreground" || checked.exitCode !== 0)
      throw new Error(
        "Invalid " +
          label +
          " branch " +
          branch +
          (checked.kind === "foreground" ? ": " + checked.stderr.text : ""),
      );
  }
  const statusBefore = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
  });
  if ((input.resetToRemote === true || input.requireClean !== false) && !statusBefore.clean)
    throw new Error(
      "Working tree has uncommitted changes; commit or stash them before synchronizing the branch.",
    );
  const plan = [
    "git fetch " + quote(remote) + " " + quote(input.headBranch) + " " + quote(input.baseBranch),
    "git checkout " + quote(input.headBranch),
    ...(input.resetToRemote === true
      ? ["git reset --hard " + quote(remote + "/" + input.headBranch)]
      : []),
    "git merge --no-edit -- " + quote(remote + "/" + input.baseBranch),
  ];
  if (input.apply !== true)
    return {
      applied: false,
      mode: "dry-run",
      plan,
      notes: ["No fetch, checkout, reset, or merge was performed."],
      resultJson: JSON.stringify({
        ok: true,
        dryRun: true,
        statusBeforeBase64: statusBefore.statusBase64,
      }),
    };
  const project = async (text, maxCharacters) =>
    (
      await tools.project_diagnostic_text({
        lines: [text],
        clipMode: "tail",
        maxCharacters,
        maxLineCharacters: 4000000,
      })
    ).text;
  const run = async (command, description, timeoutMs) => {
    const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
    if (result.kind !== "foreground") throw new Error(description + " did not finish");
    return result;
  };
  const fetch = await run(
    "git fetch " + quote(remote) + " " + quote(input.headBranch) + " " + quote(input.baseBranch),
    "Fetch stacked branches",
    60000,
  );
  if (fetch.exitCode !== 0)
    return {
      applied: true,
      mode: "apply",
      plan,
      notes: ["Stopped at fetch failure."],
      resultJson: JSON.stringify({
        ok: false,
        step: "fetch",
        fetch: {
          code: fetch.exitCode,
          stdout: await project(fetch.stdout.text, 2000),
          stderr: await project(fetch.stderr.text, 4000),
          truncated: fetch.stdout.truncated || fetch.stderr.truncated,
        },
      }),
    };
  const checkout = await run(
    "git checkout " + quote(input.headBranch),
    "Check out stacked branch",
    30000,
  );
  if (checkout.exitCode !== 0)
    return {
      applied: true,
      mode: "apply",
      plan,
      notes: ["Stopped at checkout failure."],
      resultJson: JSON.stringify({
        ok: false,
        step: "checkout",
        checkout: {
          code: checkout.exitCode,
          stdout: await project(checkout.stdout.text, 2000),
          stderr: await project(checkout.stderr.text, 4000),
          truncated: checkout.stdout.truncated || checkout.stderr.truncated,
        },
      }),
    };
  let reset = null;
  if (input.resetToRemote === true) {
    reset = await run(
      "git reset --hard " + quote(remote + "/" + input.headBranch),
      "Reset stacked branch to remote",
      30000,
    );
    if (reset.exitCode !== 0)
      return {
        applied: true,
        mode: "apply",
        plan,
        notes: ["Stopped at reset failure."],
        resultJson: JSON.stringify({
          ok: false,
          step: "reset",
          reset: {
            code: reset.exitCode,
            stdout: await project(reset.stdout.text, 2000),
            stderr: await project(reset.stderr.text, 4000),
            truncated: reset.stdout.truncated || reset.stderr.truncated,
          },
        }),
      };
  }
  const merge = await run(
    "git merge --no-edit -- " + quote(remote + "/" + input.baseBranch),
    "Merge stacked branch base",
    120000,
  );
  const finalStatus = await run("git status --short --branch", "Read stacked branch status", 30000);
  const log = await run("git log -5 --oneline --decorate", "Read stacked branch history", 30000);
  const detail = {
    ok: merge.exitCode === 0,
    fetch: { code: fetch.exitCode, stderr: await project(fetch.stderr.text, 2000) },
    checkout: {
      code: checkout.exitCode,
      stdout: await project(checkout.stdout.text, 2000),
      stderr: await project(checkout.stderr.text, 2000),
    },
    reset: reset
      ? {
          code: reset.exitCode,
          stdout: await project(reset.stdout.text, 2000),
          stderr: await project(reset.stderr.text, 2000),
        }
      : null,
    merge: {
      code: merge.exitCode,
      stdout: await project(merge.stdout.text, 8000),
      stderr: await project(merge.stderr.text, 4000),
      truncated: merge.stdout.truncated || merge.stderr.truncated,
    },
    status: await project(finalStatus.stdout.text, 4000),
    log: await project(log.stdout.text, 4000),
  };
  return {
    applied: true,
    mode: "apply",
    plan,
    notes: merge.exitCode === 0 ? [] : ["Merge failed; conflicts remain for manual resolution."],
    resultJson: JSON.stringify(detail),
  };
}
