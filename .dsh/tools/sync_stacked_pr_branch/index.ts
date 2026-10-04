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
  mode: "dry-run" | "apply";
  ok: boolean;
  step: "preview" | "fetch" | "checkout" | "reset" | "merge" | "complete";
  cleanBefore: boolean;
  cleanAfter: boolean | null;
  plan: string[];
  notes: string[];
  operations: {
    name: "fetch" | "checkout" | "reset" | "merge";
    exitCode: Integer;
    diagnostic: string;
    truncated: boolean;
  }[];
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const project = async (text, maxCharacters) =>
    tools.project_diagnostic_text({
      lines: [text],
      clipMode: "tail",
      maxCharacters,
      maxLineCharacters: 4000000,
    });
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
    if (checked.kind !== "foreground") throw new Error("Git branch validation did not finish");
    if (checked.exitCode !== 0) {
      const diagnostic = await project(
        [checked.stdout.text, checked.stderr.text].filter(Boolean).join("\n"),
        2000,
      );
      throw new Error(
        "Invalid " + label + " branch" + (diagnostic.text ? ": " + diagnostic.text : ""),
      );
    }
  }
  const statusBefore = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: true,
  });
  const cleanBefore = statusBefore.clean === true;
  if ((input.resetToRemote === true || input.requireClean !== false) && !cleanBefore)
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
      ok: true,
      step: "preview",
      cleanBefore,
      cleanAfter: null,
      plan,
      notes: ["No fetch, checkout, reset, or merge was performed."],
      operations: [],
    };
  const run = async (name, command, description, timeoutMs) => {
    const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
    if (result.kind !== "foreground") throw new Error(description + " did not finish");
    const diagnostic = await project(
      [result.stdout.text, result.stderr.text].filter(Boolean).join("\n"),
      name === "merge" ? 8000 : 4000,
    );
    return {
      name,
      exitCode: result.exitCode ?? -1,
      diagnostic: diagnostic.text,
      truncated: result.stdout.truncated || result.stderr.truncated || diagnostic.truncated,
    };
  };
  const operations = [];
  const finish = async (operation, failureNote) => {
    operations.push(operation);
    if (operation.exitCode === 0) return null;
    const checkout = await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
      includeStatus: true,
    });
    return {
      applied: true,
      mode: "apply",
      ok: false,
      step: operation.name,
      cleanBefore,
      cleanAfter: checkout.clean === true,
      plan,
      notes: [failureNote],
      operations,
    };
  };
  const fetch = await run(
    "fetch",
    "git fetch " + quote(remote) + " " + quote(input.headBranch) + " " + quote(input.baseBranch),
    "Fetch stacked branches",
    60000,
  );
  const fetchFailure = await finish(fetch, "Stopped at fetch failure.");
  if (fetchFailure) return fetchFailure;
  const checkout = await run(
    "checkout",
    "git checkout " + quote(input.headBranch),
    "Check out stacked branch",
    30000,
  );
  const checkoutFailure = await finish(checkout, "Stopped at checkout failure.");
  if (checkoutFailure) return checkoutFailure;
  if (input.resetToRemote === true) {
    const reset = await run(
      "reset",
      "git reset --hard " + quote(remote + "/" + input.headBranch),
      "Reset stacked branch to remote",
      30000,
    );
    const resetFailure = await finish(reset, "Stopped at reset failure.");
    if (resetFailure) return resetFailure;
  }
  const merge = await run(
    "merge",
    "git merge --no-edit -- " + quote(remote + "/" + input.baseBranch),
    "Merge stacked branch base",
    120000,
  );
  const mergeFailure = await finish(merge, "Merge failed; conflicts remain for manual resolution.");
  if (mergeFailure) return mergeFailure;
  const finalStatus = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: true,
  });
  return {
    applied: true,
    mode: "apply",
    ok: true,
    step: "complete",
    cleanBefore,
    cleanAfter: finalStatus.clean === true,
    plan,
    notes: [],
    operations,
  };
}
