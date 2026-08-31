/**
 * Plan or apply a signed commit, conditional push, and pull request evidence refresh with latest-PR-commit checks.
 */
export default async function commit_push_refresh_pr(input: {
  workdir: string;
  pullNumber: Integer;
  message: string;
  files?: string[];
  all?: boolean;
  repository?: string;
  remote?: string;
  branch?: string;
  push?: boolean;
  refreshBody?: boolean;
  docsResult?: "blocked" | "docs-updated" | "no-docs-needed";
  docsEvidence?: string;
  docsAgent?: string;
  targetedValidationLine?: string;
  broadGatePassed?: boolean;
  broadGateEvidence?: string;
  monitor?: boolean;
  apply?: boolean;
}): Promise<{
  applied: boolean;
  mode: "dry-run" | "read-only" | "apply" | "blocked";
  plan: string[];
  notes: string[];
  resultJson: string;
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const repo = input.repository ?? "NVIDIA/NemoClaw";
  const remote = input.remote ?? "origin";
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
    throw new Error("pullNumber must be a positive integer");
  if (
    typeof input.message !== "string" ||
    !/^(feat|fix|docs|chore|refactor|test|ci|perf|merge)(\([^)]+\))?!?: .+/u.test(
      input.message.trim(),
    )
  )
    throw new Error("A Conventional Commit message is required");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("repository must be owner/name");
  if (!/^[A-Za-z0-9_.-]+$/.test(remote) || remote.startsWith("-"))
    throw new Error("remote is invalid");
  if (input.all === true && input.files?.length)
    throw new Error("Pass files or all:true, not both");
  if (!input.all && (!Array.isArray(input.files) || input.files.length === 0))
    throw new Error("Pass files or all:true so commit contents are explicit");
  if (
    (input.files?.length ?? 0) > 200 ||
    input.files?.some((file) => typeof file !== "string" || !file || file.includes("\0"))
  )
    throw new Error("files must contain 1 to 200 valid paths");
  if (
    input.docsResult !== undefined &&
    !["blocked", "docs-updated", "no-docs-needed"].includes(input.docsResult)
  )
    throw new Error("docsResult is invalid");
  const willPush = input.push !== false;
  const willRefresh = input.refreshBody !== false;
  if (willRefresh && !willPush)
    throw new Error("Evidence cannot be updated for an unpushed commit; pass refreshBody:false");
  if (willRefresh && (!input.docsResult || !input.docsEvidence?.trim() || !input.docsAgent?.trim()))
    throw new Error("Updating PR evidence requires a documentation writer receipt");
  if ((input.broadGatePassed === undefined) !== (input.broadGateEvidence === undefined))
    throw new Error("broadGatePassed and broadGateEvidence must be provided together");
  const diagnostic = async (lines, sourceTruncated = false) =>
    (
      await tools.project_diagnostic_text({
        lines,
        maxLines: 20,
        maxCharacters: 4000,
        sourceTruncated,
      })
    ).text;
  const run = async (command, description, timeoutMs = 60000) => {
    const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
    if (result.kind !== "foreground")
      throw new Error(description + " did not finish in the foreground");
    if (result.exitCode !== 0) {
      const detail = await diagnostic(
        (result.stderr.text || result.stdout.text).split(/\r?\n/),
        result.stderr.truncated || result.stdout.truncated,
      );
      throw new Error(detail || description + " failed");
    }
    if (result.stdout.truncated) throw new Error(description + " exceeded its bounded output");
    return result.stdout.text;
  };
  const github = async (options) => {
    try {
      return await tools.run_github_cli(options);
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
      throw new Error(detail || "GitHub operation failed");
    }
  };
  const prRead = await github({
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
  });
  const pr = JSON.parse(prRead.stdout);
  if (pr.state !== "OPEN") throw new Error("PR #" + input.pullNumber + " is not open");
  const branch = input.branch ?? pr.headRefName;
  if (typeof branch !== "string" || !branch || branch.startsWith("-"))
    throw new Error("Could not resolve a valid PR source branch");
  const branchCheck = await tools.bash({
    command: "git check-ref-format --branch " + quote(branch),
    workdir: input.workdir,
    description: "Validate pull request branch name",
    timeoutMs: 30000,
  });
  if (branchCheck.kind !== "foreground" || branchCheck.exitCode !== 0)
    throw new Error("Could not resolve a valid PR source branch");
  if (branch !== pr.headRefName)
    throw new Error("branch must match the PR source branch " + pr.headRefName);
  const localHeadBefore = (
    await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
      includeStatus: false,
    })
  ).head;
  if (localHeadBefore !== pr.headRefOid)
    throw new Error(
      "Local commit " +
        localHeadBefore +
        " differs from PR commit " +
        pr.headRefOid +
        "; do not commit",
    );
  const nulNames = async (cached) =>
    (
      await run(
        "git diff " + (cached ? "--cached " : "") + "--name-only -z",
        cached ? "Read staged paths" : "Read changed paths",
      )
    )
      .split("\0")
      .filter(Boolean);
  const requested = new Set(input.files ?? []);
  const stagedBefore = await nulNames(true);
  const indexTreeBefore = (await run("git write-tree", "Record index state")).trim();
  if (!input.all) {
    const unexpected = stagedBefore.filter((file) => !requested.has(file));
    if (unexpected.length)
      throw new Error(
        "Index already contains " + unexpected.length + " file(s) outside the requested commit",
      );
  }
  const plan = [
    input.all ? "git add -A" : "git add -- <" + input.files.length + " explicit files>",
    "reject unexpected pre-staged and post-stage files",
    "verify local HEAD equals the current PR head",
    "create a Signed-off-by commit with the supplied Conventional Commit message",
    ...(willPush
      ? [
          "push HEAD to the exact PR source branch",
          "verify the PR head equals the new local commit with at most five reads",
        ]
      : []),
    ...(willRefresh ? ["refresh PR body evidence only after exact remote-head verification"] : []),
    ...(input.monitor === true ? ["monitor current checks and review findings"] : []),
  ];
  if (input.apply !== true) {
    return {
      applied: false,
      mode: "dry-run",
      plan,
      notes: [
        "Read-only guards passed. No index, commit, push, cache, or GitHub write was performed.",
      ],
      resultJson: JSON.stringify({
        pullNumber: input.pullNumber,
        localHead: localHeadBefore,
        stagedFileCount: stagedBefore.length,
        requestedFileCount: requested.size,
        willPush,
        willRefresh,
      }),
    };
  }
  await run(
    input.all ? "git add -A" : "git add -- " + input.files.map(quote).join(" "),
    "Stage selected commit files",
  );
  const stagedFiles = await nulNames(true);
  if (!stagedFiles.length) throw new Error("No staged changes after git add; nothing to commit");
  if (!input.all) {
    const unexpected = stagedFiles.filter((file) => !requested.has(file));
    if (unexpected.length) {
      await run("git read-tree " + quote(indexTreeBefore), "Restore index after rejected staging");
      throw new Error(
        "Refusing to commit " + unexpected.length + " file(s) outside the requested set",
      );
    }
  }
  await run("git commit -s -m " + quote(input.message.trim()), "Create signed-off commit", 120000);
  const localHead = (
    await tools.read_git_checkout({
      workdir: input.workdir,
      includeRoot: false,
      includeBranch: false,
      includeStatus: false,
    })
  ).head;
  let pushResult = null;
  let receipt = null;
  let readiness = null;
  let monitored = null;
  if (willPush) {
    try {
      const beforePushRead = await github({
        workdir: input.workdir,
        args: [
          "pr",
          "view",
          String(input.pullNumber),
          "--repo",
          repo,
          "--json",
          "headRefOid,headRefName,state",
        ],
      });
      const beforePush = JSON.parse(beforePushRead.stdout);
      if (
        beforePush.state !== "OPEN" ||
        beforePush.headRefOid !== localHeadBefore ||
        beforePush.headRefName !== branch
      )
        throw new Error("PR identity changed after commit; do not push or update evidence");
      pushResult = await tools.publish_nemoclaw_pr_branch({
        workdir: input.workdir,
        repository: repo,
        remote,
        baseBranch: pr.baseRefName,
        expectedHeadSha: localHead,
        pullNumber: input.pullNumber,
        expectedPullHeadSha: localHeadBefore,
        requireClean: false,
        apply: true,
      });
      if (pushResult.remoteState !== "expected-commit")
        return {
          applied: true,
          mode: "blocked",
          plan,
          notes: ["Publication did not establish the expected remote commit."],
          resultJson: JSON.stringify({
            ok: false,
            step: "publication",
            pullNumber: input.pullNumber,
            headSha: pushResult.headSha,
            remoteState: pushResult.remoteState,
            blocker: pushResult.blocker,
            recovery:
              "Reconcile the recorded PR branch and local commit without writing. Retry publication only if the expected commit is absent. Refresh evidence only after the PR commit and verification match the local commit.",
          }),
        };
      if (!pushResult.allVerified)
        return {
          applied: true,
          mode: "blocked",
          plan,
          notes: ["Stopped after publication because GitHub did not verify every commit."],
          resultJson: JSON.stringify({
            ok: false,
            step: "commit-verification",
            pullNumber: input.pullNumber,
            headSha: pushResult.headSha,
            commits: pushResult.commits,
            blocker: pushResult.blocker,
            recovery: pushResult.commits.some(
              (commit) => !commit.verified && commit.reason !== null,
            )
              ? "GitHub reports an unverified published commit. Replace that commit before continuing."
              : "Re-read verification for the published commit without creating or pushing another commit. Continue only after every commit is verified.",
          }),
        };
      let remoteHead = "";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let viewed;
        try {
          viewed = await tools.read_nemoclaw_pr({
            workdir: input.workdir,
            number: input.pullNumber,
            repository: repo,
          });
        } catch (error) {
          const detail = await diagnostic([String(error?.message ?? error)]);
          throw new Error(detail || "Could not read pull request");
        }
        remoteHead = viewed.state === "OPEN" ? (viewed.headRefOid ?? "") : "";
        if (remoteHead === localHead) break;
        if (attempt < 4) await run("sleep 1", "Wait for pull request commit");
      }
      if (remoteHead !== localHead)
        throw new Error(
          "PR commit did not update to pushed commit " + localHead + "; do not update evidence",
        );
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
      let currentPr = null;
      try {
        currentPr = await tools.read_nemoclaw_pr({
          workdir: input.workdir,
          number: input.pullNumber,
          repository: repo,
        });
      } catch {
        // Recovery remains read-only until the PR can be read again.
      }
      const identityChanged =
        currentPr !== null && (currentPr.state !== "OPEN" || currentPr.headRefOid !== localHead);
      return {
        applied: true,
        mode: "blocked",
        plan,
        notes: ["The commit exists locally, but publication did not complete."],
        resultJson: JSON.stringify({
          ok: false,
          step: "publication",
          pullNumber: input.pullNumber,
          localHead,
          published: Boolean(pushResult?.pushed),
          currentPrCommit: currentPr?.headRefOid ?? null,
          blocker: detail || "Publication failed",
          recovery: identityChanged
            ? "Stop writing and reconcile the changed PR state. Create a new repair only if that state still requires it."
            : currentPr
              ? "Publish localHead to the recorded PR branch without creating another commit."
              : "Re-read and reconcile the PR state before any publication retry.",
        }),
      };
    }
  }
  if (willRefresh)
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
        targetedValidationLine: input.targetedValidationLine,
        broadGate:
          input.broadGatePassed === undefined
            ? undefined
            : { passed: input.broadGatePassed, evidence: input.broadGateEvidence },
        apply: true,
      });
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
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
          published: true,
          blocker: detail || "Evidence refresh failed",
          recovery: unchanged
            ? "Refresh PR evidence for publishedCommit without creating or pushing another commit."
            : current
              ? "Stop because the PR commit changed."
              : "Re-read and reconcile the PR commit before refreshing evidence.",
        }),
      };
    }
  if (willPush)
    readiness = await tools.summarize_pr_readiness({
      number: input.pullNumber,
      repo,
      workdir: input.workdir,
      includeComments: false,
    });
  if (willPush && input.monitor === true)
    monitored = await tools.monitor_pr_until_actionable({
      pullNumber: input.pullNumber,
      repository: repo,
      workdir: input.workdir,
      expectedHeadSha: localHead,
      timeoutMs: 300000,
      intervalMs: 20000,
      settleCheckPrefixes: ["Specialist /", "CodeRabbit"],
    });
  const finalCheckout = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: false,
  });
  return {
    applied: true,
    mode: "apply",
    plan,
    notes: [],
    resultJson: JSON.stringify({
      ok: true,
      pullNumber: input.pullNumber,
      localHead,
      finalHead: finalCheckout.head,
      stagedFileCount: stagedFiles.length,
      pushed: willPush && pushResult !== null,
      evidenceRefreshed: receipt !== null,
      readinessChecked: readiness !== null,
      monitored:
        monitored === null
          ? null
          : {
              done: monitored.done,
              actionable: monitored.actionable,
              timedOut: monitored.timedOut,
              stale: monitored.stale,
              pendingChecks: monitored.pendingChecks,
              failedChecks: monitored.failedChecks,
              reviewContext: monitored.reviewContext,
              discussionComments: monitored.discussionComments,
              findings: monitored.findings,
            },
    }),
  };
}
