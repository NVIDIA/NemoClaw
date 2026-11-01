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
  "scripts/generate-openclaw-config.mts",
  "scripts/nemoclaw-start.sh",
  "src/lib/openclaw/agent-json-provenance.ts",
])("selects unavailable-search and direct-fetch acceptance when %s changes", (changedFile) => {
  const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
  expect(plan.coverageMatrix.map((row) => row.id)).toEqual(
    expect.arrayContaining([
      "common-egress-agent-openclaw-balanced-weather",
      "common-egress-agent-openclaw-personal-public-fetch",
    ]),
  );
});
