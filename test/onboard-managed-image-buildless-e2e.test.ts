// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect } from "vitest";

import { test } from "./e2e/fixtures/workflow-e2e-test.ts";
import { runManagedImageBuildlessE2e } from "./helpers/managed-image-buildless-e2e";

describe("managed image buildless onboarding orchestration contract", () => {
  test("renders every shipped agent's immutable launch without entering Dockerfile orchestration (#7744)", {
    timeout: 240_000,
    meta: {
      e2ePhases: [
        "validate managed-image fail-closed documentation",
        "validate mocked all-agent buildless orchestration boundaries",
        "release managed onboarding fixtures",
      ],
    },
  }, ({ progress }) => {
    progress.phase("validate managed-image fail-closed documentation");
    const commands = readFileSync(
      path.join(import.meta.dirname, "..", "docs", "reference", "commands.mdx"),
      "utf8",
    );
    expect(commands).toContain(
      "If registry or catalog availability prevents resolution, the ordinary `prefer-managed` path builds the shipped, reviewed repository Dockerfile instead; it never selects an unpinned `:latest` image.",
    );
    expect(commands).toContain(
      "Available catalog evidence that is incomplete, mixed, mutable, wrong-platform, or identity-inconsistent fails closed before sandbox creation.",
    );

    progress.phase("validate mocked all-agent buildless orchestration boundaries");
    runManagedImageBuildlessE2e();
    progress.phase("release managed onboarding fixtures");
  });
});
