// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw",
  remote = input.remote ?? "origin",
  branch = input.branch ?? "main",
  bump = input.bump ?? "patch",
  dryRun = input.dryRun ?? true;
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
  !/^[A-Za-z0-9_.-]+$/.test(remote) ||
  !/^[A-Za-z0-9_./-]+$/.test(branch)
)
  throw new Error("repo, remote, or branch is invalid");
const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
if (!dryRun) {
  const f = await tools.bash({
    command: "git fetch --prune " + q(remote) + " " + q(branch),
    workdir: input.workdir,
    description: "Refresh release candidate reference",
    timeoutMs: 120000,
  });
  if (f.kind !== "foreground" || (f.exitCode ?? -1) !== 0)
    return {
      stage: "fetch-failed",
      dryRun,
      error: f.kind === "foreground" ? f.stderr.text.slice(0, 2000) : "unexpected result",
    };
}
const auth = await tools.bash({
  command: "gh auth status",
  workdir: input.workdir,
  description: "Check GitHub authentication status",
  timeoutMs: 30000,
});
if (auth.kind !== "foreground" || (auth.exitCode ?? -1) !== 0)
  return {
    stage: "github-auth-failed",
    dryRun,
    error: auth.kind === "foreground" ? auth.stderr.text.slice(0, 2000) : "unexpected result",
  };
const ref = remote + "/" + branch,
  r = await tools.bash({
    command:
      "git rev-parse " + q(ref) + " && git describe --tags --abbrev=0 --match 'v[0-9]*' " + q(ref),
    workdir: input.workdir,
    description: "Inspect release candidate version",
    timeoutMs: 30000,
  });
if (r.kind !== "foreground" || (r.exitCode ?? -1) !== 0)
  return {
    stage: "version-unavailable",
    dryRun,
    error: r.kind === "foreground" ? r.stderr.text.slice(0, 2000) : "unexpected result",
  };
const [candidateSha, previousTag] = r.stdout.text.trim().split(/\r?\n/),
  m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(previousTag ?? "");
if (!m) return { stage: "version-unavailable", dryRun, candidateSha, previousTag };
let [major, minor, patch] = m.slice(1).map(Number);
if (bump === "major") {
  major++;
  minor = 0;
  patch = 0;
} else if (bump === "minor") {
  minor++;
  patch = 0;
} else patch++;
const nextTag = "v" + major + "." + minor + "." + patch,
  limit = Math.max(1, Math.min(100, input.runLimit ?? 100));
const d = await tools.bash({
  command:
    "git show -s --format=%s " +
    q(candidateSha) +
    "; git grep -n " +
    q("^## " + nextTag.replaceAll(".", "\\.")) +
    " " +
    q(ref) +
    " -- 'docs/changelog/*.mdx' || true; gh run list --repo " +
    q(repo) +
    " --workflow e2e.yaml --branch " +
    q(branch) +
    " --limit " +
    limit +
    " --json databaseId,name,status,conclusion,url,headSha",
  workdir: input.workdir,
  description: "Inspect release changelog and runs",
  timeoutMs: 60000,
});
return {
  stage: "complete",
  dryRun,
  repo,
  remote,
  branch,
  bump,
  candidateSha,
  previousTag,
  nextTag,
  details: d.kind === "foreground" ? d.stdout.text : "",
  warning: dryRun ? "Remote refs were not refreshed in dry-run mode." : null,
};
