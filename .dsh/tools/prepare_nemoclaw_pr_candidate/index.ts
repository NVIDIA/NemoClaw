// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const preflight = await tools.inspect_nemoclaw_pr_candidate({
  workdir: input.workdir,
  ...(input.repository ? { repository: input.repository } : {}),
  ...(input.remote ? { remote: input.remote } : {}),
  ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
  refreshBase: input.refreshBase ?? false,
});
const validation = await tools.infer_validation_for_changed_files({
  workdir: input.workdir,
  baseRef: (input.remote ?? "origin") + "/" + (input.baseBranch ?? "main"),
});
const blockers = [...preflight.blockers],
  warnings = [...preflight.warnings];
let rendered = null;
if (input.body) {
  rendered = await tools.render_nemoclaw_pr_body({
    ...input.body,
    workdir: input.workdir,
    baseRef: (input.remote ?? "origin") + "/" + (input.baseBranch ?? "main"),
  });
  blockers.push(...rendered.blockers);
  warnings.push(...rendered.warnings);
} else
  warnings.push({
    code: "body-input-required",
    message: "Typed PR body evidence is required before publication.",
  });
return {
  preflight,
  validation,
  body: rendered?.body ?? null,
  templateSha: rendered?.templateSha ?? null,
  readyToPublish: blockers.length === 0 && Boolean(rendered),
  blockers,
  warnings,
};
