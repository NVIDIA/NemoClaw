// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const plan = [
  "verify clean worktree and exact HEAD",
  "resolve base commit and AGENTS.md blob",
  "bound changed files to 500 and diff to 1.5 MB",
  "run one foreground read-only subagent only with apply:true",
  "require PASS/BLOCKED and documentation receipt markers",
  "verify HEAD and worktree unchanged",
];
if (
  typeof input.workdir !== "string" ||
  !input.workdir.trim() ||
  input.workdir.length > 4096 ||
  input.workdir.includes("\0")
)
  throw new Error("workdir must contain 1 to 4096 characters");
if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a 40-character commit SHA");
if (typeof input.summary !== "string" || !input.summary.trim())
  throw new Error("summary is required");
if (typeof input.validationEvidence !== "string" || !input.validationEvidence.trim())
  throw new Error("validationEvidence is required");
if (input.summary.length > 12000 || input.validationEvidence.length > 30000)
  throw new Error("Review summary or validation evidence exceeds the bounded input");
if (input.prNumber !== undefined && (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1))
  throw new Error("prNumber must be a positive integer");
const timeoutMs = input.timeoutMs ?? 300000;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
  throw new Error("timeoutMs must be an integer from 1000 through 300000");
const baseRef = input.baseRef ?? "origin/main";
if (
  typeof baseRef !== "string" ||
  !baseRef.trim() ||
  baseRef.length > 4096 ||
  /[\0\r\n]/.test(baseRef)
)
  throw new Error("baseRef must be a non-empty single-line Git revision");
if (
  input.model !== undefined &&
  (typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 255 ||
    /[\0\r\n]/.test(input.model))
)
  throw new Error("model must be a non-empty single-line string");
const reviewIdentity = input.prNumber
  ? "PR #" + input.prNumber
  : input.expectedHeadSha.slice(0, 12);
if (input.apply !== true)
  return {
    applied: false,
    mode: "dry-run",
    plan,
    notes: ["No repository command or subagent was run."],
    resultJson: JSON.stringify({ expectedHeadSha: input.expectedHeadSha, baseRef, reviewIdentity }),
  };
const run = async (command, description, limit = 30000) => {
  const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: limit });
  if (r.kind !== "foreground") throw new Error(description + " did not finish");
  if (r.stdout.truncated || r.stderr.truncated)
    throw new Error(description + " exceeded the bounded command output");
  if (r.exitCode !== 0)
    throw new Error(
      description + " failed: " + (r.stderr.text || r.stdout.text).trim().slice(-4000),
    );
  return r.stdout.text;
};
const identity = await run(
  "{ git status --porcelain=v1 -z | base64 | tr -d '\n'; printf '\n'; git rev-parse --show-toplevel; git rev-parse HEAD; git rev-parse " +
    q(baseRef + "^{commit}") +
    "; git rev-parse " +
    q(input.expectedHeadSha + ":AGENTS.md") +
    "; }",
  "Verify documentation review identity",
);
const [status64 = "", rootPath, headSha, baseSha, agentsBlobSha] = identity
  .replace(/\n$/, "")
  .split("\n");
const status = Buffer.from(status64, "base64").toString("utf8");
if (headSha !== input.expectedHeadSha)
  throw new Error("HEAD changed: expected " + input.expectedHeadSha + ", found " + headSha);
const requireClean = input.requireClean ?? true;
if (requireClean && status)
  throw new Error("Documentation review requires a worktree with no uncommitted changes");
const names64 = await run(
  "git diff --name-only -z --diff-filter=ACDMRTUXB " +
    q(baseSha + "..." + headSha) +
    " -- | base64 | tr -d '\n'",
  "List documentation review files",
);
const changedFiles = Buffer.from(names64.trim(), "base64")
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
if (!changedFiles.length)
  throw new Error("No changed files exist between " + baseSha + " and " + headSha);
if (changedFiles.length > 500)
  throw new Error(
    "Review has " + changedFiles.length + " changed files; split it into bounded review units",
  );
const diffBytes = Number(
  (
    await run(
      "git diff --no-ext-diff --unified=80 " + q(baseSha + "..." + headSha) + " -- | wc -c",
      "Measure documentation review diff",
    )
  ).trim(),
);
if (!Number.isSafeInteger(diffBytes) || diffBytes > 1500000)
  throw new Error("Review diff is " + diffBytes + " bytes; split it into bounded review units");
const prompt = [
  "Act as the independent NemoClaw documentation-writer reviewer.",
  "Use checkout " +
    input.workdir +
    ". This is a review-only task. Do not edit files or perform Git or GitHub writes.",
  "Run git diff --no-ext-diff --unified=80 " +
    baseSha +
    "..." +
    headSha +
    " -- to inspect the bounded diff, then read relevant checked-out files.",
  "Requested model: " +
    (input.model ?? "runtime default") +
    ". Requested thinking level: " +
    (input.thinking ?? "runtime default") +
    ".",
  "Requested project trust: " +
    String(input.trustProject ?? true) +
    ". The subagent SDK does not expose model, thinking, timeout, trust, tool-list, or session controls; treat these values and the read-only restrictions as execution guidance.",
  "",
  "Read these repository files completely before reviewing:",
  "- AGENTS.md",
  "- WRITING.md",
  "- docs/AGENTS.md",
  "- docs/CONTRIBUTING.md",
  "- .agents/skills/_shared/documentation-writing-review.md",
  "- .agents/skills/_shared/controlled-words.md",
  "",
  "Review identity: " + reviewIdentity,
  "Reviewed commit: " + headSha,
  "Base commit: " + baseSha,
  "AGENTS.md blob: " + agentsBlobSha,
  "Summary: " + input.summary.trim(),
  "Validation evidence:",
  input.validationEvidence.trim(),
  "",
  "Changed files:",
  ...changedFiles.map((f) => "- " + f),
  "",
  "Review the exact Git diff and the checked-out files.",
  "Verify documentation impact, terminology, structure, voice, procedures, code-sample presentation, user-visible behavior, agent variants, and support claims.",
  "Verify claims against checked-in source and tests.",
  "Apply the writing guide's blocking threshold. Give each suggestion a proposed rewrite.",
  "",
  "Return these sections:",
  "1. A line containing exactly Verdict: PASS or Verdict: BLOCKED.",
  "2. Blocking findings with file and line evidence, or None.",
  "3. Suggestions with proposed rewrites, or None.",
  "4. Documentation Writer Review receipt with exactly one Result: docs-updated, Result: no-docs-needed, or Result: blocked; Evidence; Agent: DSH subagent; reviewed commit; and AGENTS.md blob.",
  "For docs-updated, list the changed documentation paths. For a documentation-only change, state whether the writing rules and documentation style were reviewed.",
  "Do not claim that a command passed unless the validation evidence states that it passed.",
].join("\n");
const review = await tools.subagent({
  description: "Review exact-commit documentation",
  prompt,
  run_in_background: false,
});
if (review.kind !== "foreground")
  throw new Error("Independent documentation review did not return a foreground result");
const after64 = await run(
  "{ git rev-parse HEAD; git status --porcelain=v1 -z | base64 | tr -d '\n'; printf '\n'; }",
  "Verify documentation review cleanup",
);
const [headAfter, statusAfter64 = ""] = after64.trim().split("\n", 2);
const statusAfter = Buffer.from(statusAfter64, "base64").toString("utf8");
if (headAfter !== headSha)
  throw new Error("HEAD changed during review from " + headSha + " to " + headAfter);
if (requireClean && statusAfter)
  throw new Error("The read-only documentation review changed the worktree");
const output = review.output
  .map((value) =>
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "text" in value
        ? String(value.text)
        : JSON.stringify(value),
  )
  .join("\n")
  .trim()
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const value = (label, choices) =>
  new RegExp(
    "(?:^|\\n)\\s*(?:[-*+]\\s*)?(?:\\d+[.)]\\s*)?(?:#{1,6}\\s*)?(?:\\*\\*|__|\\x60)?" +
      label +
      "(?:\\*\\*|__|\\x60)?\\s*:\\s*(?:\\*\\*|__|\\x60)?(" +
      choices +
      ")(?:\\*\\*|__|\\x60)?\\s*(?=$|\\n)",
    "imu",
  ).exec(output)?.[1];
const receiptResult = value("Result", "docs-updated|no-docs-needed|blocked");
const verdict = value("Verdict", "PASS|BLOCKED");
if (!receiptResult)
  throw new Error(
    "Independent reviewer did not return a recognized Documentation Writer Review result. Output tail:\n" +
      output.slice(-4000),
  );
if (!verdict)
  throw new Error(
    "Independent reviewer did not return PASS or BLOCKED. Output tail:\n" + output.slice(-4000),
  );
return {
  applied: true,
  mode: "read-only",
  plan,
  notes: [
    "The foreground subagent received exact commit identities and read-only instructions; HEAD and clean-tree identity were rechecked.",
  ],
  resultJson: JSON.stringify({
    dryRun: false,
    cwd: rootPath,
    reviewIdentity,
    reviewedHeadSha: headSha,
    baseSha,
    agentsBlobSha,
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, 50),
    changedFilesTruncated: changedFiles.length > 50,
    diffBytes,
    agent: "DSH subagent",
    verdict,
    receiptResult,
    output,
  }),
};
