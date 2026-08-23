// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { test } from "./e2e/fixtures/workflow-e2e-test.ts";
import { runManagedImageBuildlessE2e } from "./helpers/managed-image-buildless-e2e";

describe("managed image buildless onboarding orchestration contract", () => {
  it("documents unavailable managed-image evidence as fail closed (#7744)", () => {
    const commands = readFileSync(
      path.join(import.meta.dirname, "..", "docs", "reference", "commands.mdx"),
      "utf8",
    );

    expect(commands).toContain(
      "If the registry or required managed-image catalog evidence is unavailable, NemoClaw fails closed instead of selecting an unpinned image.",
    );
    expect(commands).not.toContain("falls back to the unpinned `:latest` tag");
  });

  test("renders every shipped agent's immutable launch without entering Dockerfile orchestration (#7744)", {
    timeout: 240_000,
    meta: {
      e2ePhases: [
        "validate mocked all-agent buildless orchestration boundaries",
        "release managed onboarding fixtures",
      ],
    },
  }, ({ progress }) => {
    progress.phase("validate mocked all-agent buildless orchestration boundaries");
    runManagedImageBuildlessE2e();
    progress.phase("release managed onboarding fixtures");
  });
});
