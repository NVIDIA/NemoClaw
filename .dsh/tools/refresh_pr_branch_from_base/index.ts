// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const authPattern =
  /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]|SSO/i;
const runGh = async (args, description) => {
  const result = await tools.bash({
    command: "gh " + args.map(quote).join(" "),
    workdir: input.workdir,
    description,
    timeoutMs: 30000,
  });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  return { code: result.exitCode ?? -1, stdout: result.stdout.text, stderr: result.stderr.text };
};
const requireRead = (result, operation) => {
  if (result.code === 0) return;
  const detail = (result.stdout + "\n" + result.stderr).trim();
  if (authPattern.test(detail))
    throw new Error(
      `GitHub access failed while ${operation}; stop and restore repository access before continuing.\n${detail}`,
    );
  throw new Error(`GitHub did not complete ${operation}.\n${detail}`);
};
if (!Number.isSafeInteger(input.number) || input.number <= 0)
  throw new Error("number must be a positive integer");
const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
const view = async () => {
  const result = await runGh(
    [
      "pr",
      "view",
      String(input.number),
      "--repo",
      repo,
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefName,headRefName,mergeable,mergeStateStatus",
    ],
    "Read pull request branch state",
  );
  requireRead(result, `reading PR #${input.number}`);
  return JSON.parse(result.stdout);
};
const before = await view();
if (before.headRefOid !== input.expectedHeadSha)
  throw new Error(
    `PR #${input.number} commit changed: expected ${input.expectedHeadSha}, found ${before.headRefOid}`,
  );
const eligible =
  before.state === "OPEN" && before.isDraft !== true && before.mergeable !== "CONFLICTING";
const base = {
  apply: input.apply,
  mutated: false,
  repo,
  number: input.number,
  eligible,
  updated: false,
  wouldRequestBaseUpdate: eligible,
  reason: null,
  before,
  after: null,
  apiMessage: null,
  response: null,
};
if (!input.apply) return base;
if (before.state !== "OPEN")
  throw new Error(
    `PR #${input.number} is ${String(before.state).toLowerCase()}; base update requires an open PR`,
  );
if (before.isDraft === true)
  throw new Error(`PR #${input.number} is a draft; make the PR ready before updating its branch`);
if (before.mergeable === "CONFLICTING")
  return {
    ...base,
    reason:
      "GitHub reports merge conflicts; resolve them only after confirming the intended behavior",
  };
const update = await runGh(
  [
    "api",
    "--method",
    "PUT",
    `repos/${repo}/pulls/${input.number}/update-branch`,
    "-f",
    `expected_head_sha=${before.headRefOid}`,
  ],
  "Request pull request branch update",
);
if (update.code !== 0) {
  const detail = update.stdout + "\n" + update.stderr;
  if (authPattern.test(detail))
    throw new Error(
      `GitHub access failed while updating PR #${input.number}; stop and restore repository access before continuing.\n${update.stderr}`,
    );
  return {
    ...base,
    reason: "GitHub did not update the PR branch",
    response: {
      code: update.code,
      stdout: update.stdout.slice(-2000),
      stderr: update.stderr.slice(-2000),
    },
  };
}
let after = before;
for (let attempt = 0; attempt < 12; attempt++) {
  await tools.bash({
    command: "sleep 2.5",
    workdir: input.workdir,
    description: "Wait for GitHub branch update",
    timeoutMs: 5000,
  });
  after = await view();
  if (after.headRefOid !== before.headRefOid) break;
}
let apiMessage = null;
try {
  apiMessage = JSON.parse(update.stdout).message ?? null;
} catch {}
const updated = after.headRefOid !== before.headRefOid;
return { ...base, mutated: updated, updated, after, apiMessage };
