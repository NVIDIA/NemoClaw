/**
 * Plan or apply validation, push, evidence refresh, and the handoff from draft to human review.
 */
export default async function prepare_pr_for_human_review(input: {
  workdir: string;
  pullNumber: Integer;
  repository?: string;
  validation?: {
    files?: string[];
    testFiles?: string[];
    projects?: string[];
    baseRef?: string;
    typecheckCli?: boolean;
    typecheckPlugin?: boolean;
    repoChecks?: boolean;
    docs?: boolean;
    timeoutMs?: Integer;
  };
  docsResult: "blocked" | "docs-updated" | "no-docs-needed";
  docsEvidence: string;
  docsAgent: string;
  validationLine?: string;
  broadGatePassed?: boolean;
  broadGateEvidence?: string;
  markReady?: boolean;
  push?: boolean;
  apply?: true;
}): Promise<{
  applied: boolean;
  mode: "dry-run" | "read-only" | "apply" | "blocked";
  plan: string[];
  notes: string[];
  resultJson: string;
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
    throw new Error("pullNumber must be positive");
  if (!["blocked", "docs-updated", "no-docs-needed"].includes(input.docsResult))
    throw new Error("docsResult is invalid");
  const repo = input.repository ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("repository must be owner/name");
  for (const [label, value] of [
    ["docsEvidence", input.docsEvidence],
    ["docsAgent", input.docsAgent],
  ])
    if (typeof value !== "string" || !value.trim() || value.length > 4000 || /[\r\n]/.test(value))
      throw new Error(label + " must be a non-empty single line of at most 4000 characters");
  if (
    input.validationLine !== undefined &&
    (typeof input.validationLine !== "string" ||
      !input.validationLine.trim() ||
      input.validationLine.length > 4000 ||
      /[\r\n]/.test(input.validationLine))
  )
    throw new Error("validationLine must be a non-empty single line of at most 4000 characters");
  if (input.broadGatePassed !== undefined && input.broadGateEvidence === undefined)
    throw new Error("broadGateEvidence is required with broadGatePassed");
  if (
    input.broadGateEvidence !== undefined &&
    (typeof input.broadGateEvidence !== "string" ||
      !input.broadGateEvidence.trim() ||
      input.broadGateEvidence.length > 4000 ||
      /[\r\n]/.test(input.broadGateEvidence))
  )
    throw new Error("broadGateEvidence must be a non-empty single line of at most 4000 characters");
  const before = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
  });
  if (!before.clean)
    throw new Error("Working tree has uncommitted changes; commit or stash them before handoff.");
  const plan = [
    "run focused non-writing validation",
    "confirm validation left worktree clean",
    ...(input.push !== false
      ? ["push HEAD to exact PR source branch"]
      : ["confirm local HEAD equals PR head"]),
    "refresh exact-commit PR body evidence",
    ...(input.markReady
      ? [
          input.docsResult === "blocked"
            ? "leave draft because documentation review is blocked"
            : "mark PR ready for review",
        ]
      : []),
    "read final readiness summary",
  ];
  if (input.apply !== true)
    return {
      applied: false,
      mode: "dry-run",
      plan,
      notes: ["No validation, push, PR edit, or readiness write was performed."],
      resultJson: JSON.stringify({ ok: true, dryRun: true }),
    };
  const validationInput = {
    ...(input.validation ?? {}),
    workdir: input.workdir,
    formatWrite: false,
    dryRun: false,
  };
  const validation = await tools.run_nemoclaw_focused_repair_validation(validationInput);
  if (!validation.ok) {
    const failedState = await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
    });
    return {
      applied: true,
      mode: "apply",
      plan,
      notes: ["Stopped at validation failure."],
      resultJson: JSON.stringify({
        ok: false,
        step: "validation",
        validation,
        clean: failedState.clean,
      }),
    };
  }
  const after = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
  });
  if (after.statusFingerprint !== before.statusFingerprint)
    throw new Error(
      "Validation changed tracked or untracked files; review and commit them before handoff.",
    );
  const view = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "view",
      String(input.pullNumber),
      "--repo",
      repo,
      "--json",
      "headRefName,headRefOid,baseRefName,url,title,state",
    ],
    timeoutMs: 30000,
  });
  const pr = JSON.parse(view.stdout);
  if (pr.state !== "OPEN") throw new Error("PR #" + input.pullNumber + " is not open");
  if (!/^[0-9a-f]{40}$/.test(String(pr.headRefOid ?? "")))
    throw new Error("Pull request returned an invalid commit SHA");
  const localHead = after.head;
  if (!/^[0-9a-f]{40,64}$/.test(localHead)) throw new Error("Local HEAD is invalid");
  let push = null;
  if (input.push !== false) {
    push = await tools.publish_nemoclaw_pr_branch({
      workdir: input.workdir,
      repository: repo,
      remote: "origin",
      baseBranch: pr.baseRefName,
      expectedHeadSha: localHead,
      pullNumber: input.pullNumber,
      expectedPullHeadSha: pr.headRefOid,
      apply: true,
    });
    if (push.remoteState !== "expected-commit")
      return {
        applied: true,
        mode: "blocked",
        plan,
        notes: ["Publication did not establish the expected remote commit."],
        resultJson: JSON.stringify({
          ok: false,
          step: "publication",
          pullNumber: input.pullNumber,
          headSha: push.headSha,
          remoteState: push.remoteState,
          blocker: push.blocker,
          recovery:
            "Reconcile the recorded PR branch and local commit without writing. Retry publication only if the expected commit is absent. Refresh evidence only after the PR commit and verification match the local commit.",
        }),
      };
    if (!push.allVerified)
      return {
        applied: true,
        mode: "blocked",
        plan,
        notes: ["Stopped after publication because GitHub did not verify every commit."],
        resultJson: JSON.stringify({
          ok: false,
          step: "commit-verification",
          pullNumber: input.pullNumber,
          headSha: push.headSha,
          commits: push.commits,
          blocker: push.blocker,
          recovery: push.commits.some((commit) => !commit.verified && commit.reason !== null)
            ? "GitHub reports an unverified published commit. Replace that commit before continuing."
            : "Re-read verification for the published commit without creating or pushing another commit. Continue only after every commit is verified.",
        }),
      };
  } else if (localHead !== pr.headRefOid)
    throw new Error("push:false requires the local commit to match the PR commit");
  let receipt;
  try {
    receipt = await tools.refresh_pr_body_evidence({
      number: input.pullNumber,
      repo,
      workdir: input.workdir,
      expectedHeadSha: localHead,
      docsReceipt: {
        result: input.docsResult,
        evidence: input.docsEvidence,
        agent: input.docsAgent,
      },
      ...(input.validationLine ? { targetedValidationLine: input.validationLine } : {}),
      ...(input.broadGatePassed !== undefined
        ? { broadGate: { passed: input.broadGatePassed, evidence: input.broadGateEvidence } }
        : {}),
      apply: true,
    });
  } catch (error) {
    const detail = await tools.project_diagnostic_text({
      lines: [String(error?.message ?? error)],
      maxLines: 5,
      maxCharacters: 1000,
    });
    let current = null;
    try {
      current = await tools.read_nemoclaw_pr({
        workdir: input.workdir,
        number: input.pullNumber,
        repository: repo,
      });
    } catch {
      // Recovery remains read-only until the PR can be read again.
    }
    const unchanged = current?.state === "OPEN" && current.headRefOid === localHead;
    return {
      applied: true,
      mode: "blocked",
      plan,
      notes: ["Publication completed, but PR evidence refresh failed."],
      resultJson: JSON.stringify({
        ok: false,
        step: "evidence-refresh",
        pullNumber: input.pullNumber,
        publishedCommit: localHead,
        currentPrCommit: current?.headRefOid ?? null,
        published: input.push !== false,
        blocker: detail.text || "Evidence refresh failed",
        recovery: unchanged
          ? "Refresh PR evidence for publishedCommit without creating or pushing another commit."
          : current
            ? "Stop because the PR commit changed."
            : "Re-read and reconcile the PR commit before refreshing evidence.",
      }),
    };
  }
  let ready = null;
  if (input.markReady) {
    if (input.docsResult === "blocked") {
      const summary = await tools.summarize_pr_readiness({
        number: input.pullNumber,
        repo,
        workdir: input.workdir,
        includeComments: true,
      });
      return {
        applied: true,
        mode: "apply",
        plan,
        notes: ["Documentation writer review is blocked; the PR remains a draft."],
        resultJson: JSON.stringify({
          ok: false,
          step: "documentation-review",
          reason: "Documentation writer review is blocked; the PR remains a draft",
          validation,
          push,
          receipt,
          summary,
        }),
      };
    }
    const beforeReady = await tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: input.pullNumber,
      repository: repo,
    });
    if (beforeReady.state !== "OPEN" || beforeReady.headRefOid !== localHead)
      throw new Error("PR identity changed before mark-ready; no readiness write was performed");
    if (beforeReady.isDraft) {
      const marked = await tools.run_github_cli({
        workdir: input.workdir,
        args: ["pr", "ready", String(input.pullNumber), "--repo", repo],
        timeoutMs: 30000,
        apply: true,
      });
      const [readyStdout, readyStderr] = await Promise.all([
        tools.project_diagnostic_text({
          lines: [marked.stdout],
          clipMode: "tail",
          maxCharacters: 2000,
          maxLineCharacters: 500,
        }),
        tools.project_diagnostic_text({
          lines: [marked.stderr],
          clipMode: "tail",
          maxCharacters: 4000,
          maxLineCharacters: 500,
        }),
      ]);
      ready = { code: marked.code, stdout: readyStdout.text, stderr: readyStderr.text };
    } else ready = { code: 0, stdout: "Pull request was already ready for review.", stderr: "" };
    const afterReady = await tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: input.pullNumber,
      repository: repo,
    });
    if (afterReady.state !== "OPEN" || afterReady.headRefOid !== localHead || afterReady.isDraft)
      throw new Error(
        "PR readiness state did not match the exact expected commit after mark-ready",
      );
  }
  const summary = await tools.summarize_pr_readiness({
    number: input.pullNumber,
    repo,
    workdir: input.workdir,
    includeComments: true,
  });
  return {
    applied: true,
    mode: "apply",
    plan,
    notes: [],
    resultJson: JSON.stringify({
      ok: true,
      validation,
      pr,
      localHead,
      push,
      receipt,
      ready,
      summary,
    }),
  };
}
