/**
 * Plan or apply a guarded stacked-branch restack with validation and pushes.
 */
export default async function restack_pr_chain(input: {
  workdir: string;
  branches: string[];
  base?: string;
  remote?: string;
  validateEach?: boolean;
  apply?: true;
}): Promise<{
  applied: boolean;
  mode: "dry-run" | "apply";
  ok: boolean;
  failureStep: "sync" | "validation" | "cleanliness" | "push" | null;
  cleanBefore: boolean;
  plan: string[];
  notes: string[];
  results: {
    branch: string;
    base: string;
    synchronized: boolean;
    validationPassed: boolean | null;
    cleanAfterValidation: boolean | null;
    pushed: boolean;
    pushExitCode: Integer | null;
    pushDiagnostic: string;
    pushDiagnosticTruncated: boolean;
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
  if (
    !Array.isArray(input.branches) ||
    input.branches.length < 1 ||
    input.branches.length > 20 ||
    new Set(input.branches).size !== input.branches.length
  )
    throw new Error("branches must contain 1-20 unique names");
  const remote = input.remote ?? "origin",
    base = input.base ?? "main";
  if (
    typeof remote !== "string" ||
    !remote ||
    remote.length > 255 ||
    remote.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(remote)
  )
    throw new Error("Invalid Git remote");
  for (const [label, branch] of [
    ["base", base],
    ...input.branches.map((branch) => ["head", branch]),
  ]) {
    if (typeof branch !== "string" || !branch || branch.length > 255 || branch.startsWith("-"))
      throw new Error("Invalid " + label + " branch");
    const checked = await tools.bash({
      command: "git check-ref-format --branch " + quote(branch),
      workdir: input.workdir,
      description: "Validate restack branch name",
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
  const initial = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: true,
  });
  const cleanBefore = initial.clean === true;
  if (!cleanBefore)
    throw new Error(
      "Working tree has uncommitted changes; commit or stash them before restacking.",
    );
  let parent = base;
  const plan = [];
  for (const branch of input.branches) {
    plan.push("synchronize " + branch + " from " + remote + "/" + parent);
    if (input.validateEach !== false)
      plan.push("run focused non-writing validation against " + remote + "/" + parent);
    plan.push("git push " + remote + " HEAD:refs/heads/" + branch);
    parent = branch;
  }
  if (input.apply !== true)
    return {
      applied: false,
      mode: "dry-run",
      ok: true,
      failureStep: null,
      cleanBefore,
      plan,
      notes: [
        "No fetch, checkout, reset, merge, validation, or push was performed.",
        "Applied execution stops on the first synchronization, validation, cleanliness, or push failure.",
      ],
      results: [],
    };
  const results = [];
  let currentBase = base;
  for (const branch of input.branches) {
    const sync = await tools.sync_stacked_pr_branch({
      workdir: input.workdir,
      headBranch: branch,
      baseBranch: currentBase,
      remote,
      resetToRemote: true,
      requireClean: true,
      apply: true,
    });
    const item = {
      branch,
      base: currentBase,
      synchronized: sync.ok,
      validationPassed: null,
      cleanAfterValidation: null,
      pushed: false,
      pushExitCode: null,
      pushDiagnostic: "",
      pushDiagnosticTruncated: false,
    };
    results.push(item);
    if (!sync.ok)
      return {
        applied: true,
        mode: "apply",
        ok: false,
        failureStep: "sync",
        cleanBefore,
        plan,
        notes: ["Stopped at the first synchronization failure."],
        results,
      };
    if (input.validateEach !== false) {
      const validation = await tools.run_nemoclaw_focused_repair_validation({
        workdir: input.workdir,
        baseRef: remote + "/" + currentBase,
        formatWrite: false,
        dryRun: false,
      });
      item.validationPassed = validation.ok;
      if (!validation.ok)
        return {
          applied: true,
          mode: "apply",
          ok: false,
          failureStep: "validation",
          cleanBefore,
          plan,
          notes: ["Stopped at the first validation failure."],
          results,
        };
    }
    const postValidation = await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
      includeStatus: true,
    });
    item.cleanAfterValidation = postValidation.clean === true;
    if (!item.cleanAfterValidation)
      return {
        applied: true,
        mode: "apply",
        ok: false,
        failureStep: "cleanliness",
        cleanBefore,
        plan,
        notes: ["Validation changed tracked or untracked files; no push was attempted."],
        results,
      };
    const push = await tools.bash({
      command: "git push " + quote(remote) + " " + quote("HEAD:refs/heads/" + branch),
      workdir: input.workdir,
      description: "Push restacked branch",
      timeoutMs: 120000,
    });
    if (push.kind !== "foreground") throw new Error("Git push did not finish");
    item.pushExitCode = push.exitCode ?? -1;
    const pushDiagnostic = await project(
      [push.stdout.text, push.stderr.text].filter(Boolean).join("\n"),
      4000,
    );
    item.pushDiagnostic = pushDiagnostic.text;
    item.pushDiagnosticTruncated =
      push.stdout.truncated || push.stderr.truncated || pushDiagnostic.truncated;
    if (push.exitCode !== 0)
      return {
        applied: true,
        mode: "apply",
        ok: false,
        failureStep: "push",
        cleanBefore,
        plan,
        notes: ["Git push failed; stop and resolve GitHub access before continuing."],
        results,
      };
    item.pushed = true;
    currentBase = branch;
  }
  return {
    applied: true,
    mode: "apply",
    ok: true,
    failureStep: null,
    cleanBefore,
    plan,
    notes: [],
    results,
  };
}
