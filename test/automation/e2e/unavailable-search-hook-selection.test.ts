// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

it.each([
  "agents/openclaw/manifest.yaml",
  "nemoclaw-blueprint/blueprint.yaml",
  "nemoclaw/package.json",
  "nemoclaw/src/index.ts",
  "nemoclaw/src/denied-search-state.ts",
  "nemoclaw/src/runtime-context.ts",
  "nemoclaw/src/search-config.ts",
])("selects installed unavailable-search acceptance when %s changes", (file) => {
  const plan = buildE2eWorkflowPlan({}, { changedFiles: [file] });
  expect(plan.coverageMatrix.map((row) => row.id)).toContain(
    "common-egress-agent-openclaw-balanced-weather",
  );
});
