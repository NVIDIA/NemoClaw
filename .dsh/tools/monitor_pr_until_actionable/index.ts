// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

if (
  !Number.isSafeInteger(input.pullNumber) ||
  input.pullNumber < 1 ||
  !/^[0-9a-f]{40}$/.test(input.expectedHeadSha)
)
  throw new Error("pullNumber and expectedHeadSha are required");
const repo = input.repository ?? "NVIDIA/NemoClaw",
  timeout = input.timeoutMs ?? 600000,
  interval = input.intervalMs ?? 60000;
if (timeout < 30000 || timeout > 1800000 || interval < 10000 || interval > 120000)
  throw new Error("Invalid monitor bounds");
const validateIds = (values, name) => {
  for (const value of values ?? [])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(name + " must contain positive integer IDs");
  return new Set(values ?? []);
};
const ignoredChecks = new Set(input.ignoreChecks ?? []),
  ignoredReviews = validateIds(input.ignoreReviewIds, "ignoreReviewIds"),
  ignoredComments = validateIds(input.ignoreCommentIds, "ignoreCommentIds"),
  deadline = Date.now() + timeout,
  snapshots = [];
let observedChecks = false,
  lastPendingChecks = [],
  lastFailedChecks = [],
  lastFindings = [];
while (Date.now() <= deadline) {
  const cycle = await tools.collect_nemoclaw_pr_review_cycle({
    workdir: input.workdir,
    repo,
    number: input.pullNumber,
    limit: 100,
  });
  if (cycle.truncated)
    throw new Error("Review-cycle collection was truncated; completeness is not established");
  const pull = cycle.summary.pull,
    head = pull.headRefOid;
  if (head !== input.expectedHeadSha)
    return {
      done: false,
      actionable: true,
      timedOut: false,
      stale: true,
      expectedHeadSha: input.expectedHeadSha,
      currentHeadSha: head,
      pendingChecks: [],
      failedChecks: [],
      findings: [],
      snapshots,
    };
  const checks = cycle.summary.checks ?? [];
  if (checks.length) observedChecks = true;
  const pendingChecks = checks
    .filter(
      (c) =>
        ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "EXPECTED"].includes(
          String(c.state).toUpperCase(),
        ) && !ignoredChecks.has(c.name),
    )
    .map((c) => ({ name: c.name, state: c.state, link: c.link }));
  const failedChecks = checks
    .filter(
      (c) =>
        ["FAILURE", "FAIL", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(
          String(c.state).toUpperCase(),
        ) && !ignoredChecks.has(c.name),
    )
    .map((c) => ({ name: c.name, state: c.state, link: c.link }));
  const findings = cycle.items.filter(
    (x) =>
      (x.type === "review" &&
        x.state === "CHANGES_REQUESTED" &&
        !ignoredReviews.has(Number(x.id))) ||
      (x.type === "inline-comment" && !ignoredComments.has(Number(x.id))),
  );
  lastPendingChecks = pendingChecks;
  lastFailedChecks = failedChecks;
  lastFindings = findings;
  snapshots.push({
    headSha: head,
    checkCount: checks.length,
    pendingCount: pendingChecks.length,
    failedCount: failedChecks.length,
    findingCount: findings.length,
  });
  if (failedChecks.length || findings.length || (observedChecks && !pendingChecks.length))
    return {
      done: observedChecks && !pendingChecks.length,
      actionable: Boolean(failedChecks.length || findings.length),
      timedOut: false,
      stale: false,
      expectedHeadSha: input.expectedHeadSha,
      currentHeadSha: head,
      pendingChecks,
      failedChecks,
      findings,
      snapshots,
    };
  await new Promise((resolve) => setTimeout(resolve, interval));
}
return {
  done: false,
  actionable: false,
  timedOut: true,
  stale: false,
  expectedHeadSha: input.expectedHeadSha,
  currentHeadSha: input.expectedHeadSha,
  pendingChecks: lastPendingChecks,
  failedChecks: lastFailedChecks,
  findings: lastFindings,
  snapshots,
};
