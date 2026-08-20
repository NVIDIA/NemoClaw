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
  mode: "dry-run" | "read-only" | "apply" | "blocked";
  plan: string[];
  notes: string[];
  resultJson: string;
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
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
    if (checked.kind !== "foreground" || checked.exitCode !== 0)
      throw new Error("Invalid " + label + " branch " + branch);
  }
  const initial = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
  });
  if (!initial.clean)
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
      plan,
      notes: [
        "No fetch, checkout, reset, merge, validation, or push was performed.",
        "Applied execution stops on the first synchronization, validation, cleanliness, or push failure.",
      ],
      resultJson: JSON.stringify({ ok: true, dryRun: true }),
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
    let syncDetail = {};
    try {
      syncDetail = JSON.parse(sync.resultJson);
    } catch {
      syncDetail = { ok: false, reason: "Invalid synchronization result" };
    }
    const branchStatus = await tools.bash({
      command: "git status --short --branch",
      workdir: input.workdir,
      description: "Read restacked branch status",
      timeoutMs: 30000,
    });
    let validation = null;
    if (syncDetail.ok && input.validateEach !== false)
      validation = await tools.run_nemoclaw_focused_repair_validation({
        workdir: input.workdir,
        baseRef: remote + "/" + currentBase,
        formatWrite: false,
        dryRun: false,
      });
    const item = {
      branch,
      base: currentBase,
      sync,
      validation,
      status:
        branchStatus.kind === "foreground"
          ? (
              await tools.project_diagnostic_text({
                lines: [branchStatus.stdout.text],
                clipMode: "tail",
                maxCharacters: 4000,
                maxLineCharacters: 4000000,
              })
            ).text
          : "",
    };
    results.push(item);
    if (!syncDetail.ok || (validation && !validation.ok))
      return {
        applied: true,
        mode: "apply",
        plan,
        notes: ["Stopped at the first synchronization or validation failure."],
        resultJson: JSON.stringify({ ok: false, results }),
      };
    const clean = await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
    });
    if (!clean.clean) {
      item.postValidationStatusBase64 = clean.statusBase64;
      return {
        applied: true,
        mode: "apply",
        plan,
        notes: ["Validation changed tracked or untracked files; no push was attempted."],
        resultJson: JSON.stringify({
          ok: false,
          reason: "validation changed tracked or untracked files",
          results,
        }),
      };
    }
    const push = await tools.bash({
      command: "git push " + quote(remote) + " " + quote("HEAD:refs/heads/" + branch),
      workdir: input.workdir,
      description: "Push restacked branch",
      timeoutMs: 120000,
    });
    if (push.kind !== "foreground") throw new Error("Git push did not finish");
    const [pushStdout, pushStderr] = await Promise.all([
      tools.project_diagnostic_text({
        lines: [push.stdout.text],
        clipMode: "tail",
        maxCharacters: 2000,
        maxLineCharacters: 4000000,
      }),
      tools.project_diagnostic_text({
        lines: [push.stderr.text],
        clipMode: "tail",
        maxCharacters: 4000,
        maxLineCharacters: 4000000,
      }),
    ]);
    item.push = {
      code: push.exitCode,
      stdout: pushStdout.text,
      stderr: pushStderr.text,
      truncated:
        push.stdout.truncated ||
        push.stderr.truncated ||
        pushStdout.truncated ||
        pushStderr.truncated,
    };
    if (push.exitCode !== 0) {
      const pushError = await tools.project_diagnostic_text({
        lines: [push.stderr.text],
        clipMode: "tail",
        maxCharacters: 4000000,
        maxLineCharacters: 4000000,
      });
      throw new Error(
        "Git push failed; stop and resolve GitHub access before continuing.\n" + pushError.text,
      );
    }
    currentBase = branch;
  }
  return {
    applied: true,
    mode: "apply",
    plan,
    notes: [],
    resultJson: JSON.stringify({ ok: true, results }),
  };
}
