// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { describe } from "vitest";

import { test } from "./e2e/fixtures/workflow-e2e-test.ts";
import { runManagedImageBuildlessE2e } from "./helpers/managed-image-buildless-e2e";

describe("managed image buildless onboarding", () => {
  test("launches every shipped agent by immutable image and startup profile without Dockerfile work (#7744)", {
    timeout: 180_000,
    meta: {
      e2ePhases: [
        "validate all-agent buildless managed-image orchestration",
        "release managed onboarding fixtures",
      ],
    },
  }, ({ progress }) => {
    progress.phase("validate all-agent buildless managed-image orchestration");
    runManagedImageBuildlessE2e();
    progress.phase("release managed onboarding fixtures");
  });
});
