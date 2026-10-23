// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

it.each(["src/lib/openclaw/agent-json-provenance.ts", "scripts/generate-openclaw-config.mts"])(
  "selects the unavailable-search proof when %s changes",
  (changedFile) => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    expect(plan.coverageMatrix.map((row) => row.id)).toContain(
      "common-egress-agent-openclaw-balanced-weather",
    );
  },
);
