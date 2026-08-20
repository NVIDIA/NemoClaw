// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
  throw new Error("pullNumber must be positive");
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
const before = await tools.bash({
  command: "git status --porcelain=v1",
  workdir: input.workdir,
  description: "Check handoff working tree",
  timeoutMs: 30000,
});
if (before.kind !== "foreground" || before.exitCode !== 0)
  throw new Error("Could not inspect handoff working tree");
if (before.stdout.text.trim())
  throw new Error(
    "Working tree has uncommitted changes; commit or stash them before handoff.\n" +
      before.stdout.text,
  );
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
  const status = await tools.bash({
    command: "git status --short --branch",
    workdir: input.workdir,
    description: "Read failed handoff status",
    timeoutMs: 30000,
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
      status: status.kind === "foreground" ? status.stdout.text : "",
    }),
  };
}
const after = await tools.bash({
  command: "git status --porcelain=v1",
  workdir: input.workdir,
  description: "Check post-validation cleanliness",
  timeoutMs: 30000,
});
if (after.kind !== "foreground" || after.exitCode !== 0)
  throw new Error("Could not inspect post-validation working tree");
if (after.stdout.text.trim())
  throw new Error(
    "Validation changed tracked or untracked files; review and commit them before handoff.\n" +
      after.stdout.text,
  );
const view = await tools.bash({
  command:
    "gh pr view " +
    input.pullNumber +
    " --repo " +
    quote(repo) +
    " --json headRefName,headRefOid,url,title,state",
  workdir: input.workdir,
  description: "Inspect human review pull request",
  timeoutMs: 30000,
});
if (view.kind !== "foreground" || view.exitCode !== 0)
  throw new Error(
    view.kind === "foreground"
      ? view.stderr.text || "Could not read pull request"
      : "Pull request read did not finish",
  );
const pr = JSON.parse(view.stdout.text);
if (pr.state !== "OPEN") throw new Error("PR #" + input.pullNumber + " is not open");
if (!/^[0-9a-f]{40}$/.test(String(pr.headRefOid ?? "")))
  throw new Error("Pull request returned an invalid commit SHA");
const headResult = await tools.bash({
  command: "git rev-parse HEAD",
  workdir: input.workdir,
  description: "Resolve handoff checkout commit",
  timeoutMs: 10000,
});
if (headResult.kind !== "foreground" || headResult.exitCode !== 0)
  throw new Error("Could not resolve local HEAD");
const localHead = headResult.stdout.text.trim();
if (!/^[0-9a-f]{40,64}$/.test(localHead)) throw new Error("Local HEAD is invalid");
let push = null;
if (input.push !== false) {
  const pushed = await tools.bash({
    command: "git push " + quote("origin") + " " + quote("HEAD:refs/heads/" + pr.headRefName),
    workdir: input.workdir,
    description: "Push human review branch",
    timeoutMs: 120000,
  });
  if (pushed.kind !== "foreground") throw new Error("Git push did not finish");
  push = {
    code: pushed.exitCode,
    stdout: pushed.stdout.text.slice(-2000),
    stderr: pushed.stderr.text.slice(-4000),
    truncated: pushed.stdout.truncated || pushed.stderr.truncated,
  };
  if (pushed.exitCode !== 0)
    throw new Error(
      "Git push failed; stop and resolve GitHub access before continuing.\n" + pushed.stderr.text,
    );
} else if (localHead !== pr.headRefOid)
  throw new Error("push:false requires the local commit to match the PR commit");
const receipt = await tools.refresh_pr_body_evidence({
  number: input.pullNumber,
  repo,
  workdir: input.workdir,
  expectedHeadSha: localHead,
  docsReceipt: { result: input.docsResult, evidence: input.docsEvidence, agent: input.docsAgent },
  ...(input.validationLine ? { targetedValidationLine: input.validationLine } : {}),
  ...(input.broadGatePassed !== undefined
    ? { broadGate: { passed: input.broadGatePassed, evidence: input.broadGateEvidence } }
    : {}),
  apply: true,
});
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
  const marked = await tools.bash({
    command: "gh pr ready " + input.pullNumber + " --repo " + quote(repo),
    workdir: input.workdir,
    description: "Mark pull request ready",
    timeoutMs: 30000,
  });
  if (marked.kind !== "foreground") throw new Error("Mark-ready command did not finish");
  ready = {
    code: marked.exitCode,
    stdout: marked.stdout.text.slice(-2000),
    stderr: marked.stderr.text.slice(-4000),
  };
  if (
    marked.exitCode !== 0 &&
    !/already.*ready/i.test(marked.stdout.text + "\n" + marked.stderr.text)
  )
    throw new Error("Could not mark the PR ready for review.\n" + marked.stderr.text);
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
