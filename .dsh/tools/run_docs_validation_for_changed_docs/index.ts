// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const baseRef = input.baseRef ?? "origin/main",
  dryRun = input.dryRun ?? true;
if (baseRef.startsWith("-") || !/^[A-Za-z0-9_./-]{1,200}$/.test(baseRef))
  throw new Error("baseRef is invalid");
const inferred = await tools.infer_validation_for_changed_files({
  workdir: input.workdir,
  baseRef,
});
const changed = inferred.files,
  docsChanged = changed.filter(
    (f) => /^(docs|fern)\//.test(f) || ["docs/index.yml", "fern/fern.config.json"].includes(f),
  );
const planned = [];
if (docsChanged.some((f) => f.endsWith(".mdx") || f === "docs/index.yml"))
  planned.push("npm run docs:sync-agent-variants");
if (input.runDocs !== false && docsChanged.length) planned.push("npm run docs");
const steps = [];
if (!dryRun)
  for (const command of planned) {
    const r = await tools.bash({
      command,
      workdir: input.workdir,
      description: "Validate changed documentation",
      timeoutMs: command === "npm run docs" ? 300000 : 180000,
    });
    if (r.kind !== "foreground") throw new Error("Unexpected background result");
    steps.push({
      name: command,
      code: r.exitCode ?? -1,
      stdoutTail: r.stdout.text.slice(-6000),
      stderrTail: r.stderr.text.slice(-6000),
      truncated: r.stdout.truncated || r.stderr.truncated,
    });
    if ((r.exitCode ?? -1) !== 0) break;
  }
const s = await tools.bash({
  command: "git status --short --branch",
  workdir: input.workdir,
  description: "Inspect documentation worktree status",
  timeoutMs: 30000,
});
return {
  ok: steps.every((x) => x.code === 0),
  dryRun,
  baseRef,
  changed,
  docsChanged,
  planned,
  steps,
  status: s.kind === "foreground" ? s.stdout.text : "",
};
