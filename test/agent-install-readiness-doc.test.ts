// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const readinessDoc = readFileSync(
  join(process.cwd(), "docs/resources/agent-install-readiness.mdx"),
  "utf8",
);

describe("agent install readiness docs", () => {
  it("keeps the #5051 validation matrix grounded in the accepted workflows", () => {
    for (const requiredText of [
      "Baseline Workflow",
      "Improved Workflow",
      "Skills already available",
      "Skills missing",
      "Stale skills",
      "privileged or destructive setup actions",
      "nemoclaw <sandbox-name> status",
      "NemoClaw is ready",
    ]) {
      expect(readinessDoc).toContain(requiredText);
    }
  });
});
