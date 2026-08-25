// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect } from "vitest";

import { test } from "../e2e/fixtures/workflow-e2e-test.ts";
import { runManagedImageBuildlessE2e } from "../helpers/managed-image-buildless-e2e";

function expectManagedOnlyGuide(relativePath: string): void {
  const guide = readFileSync(path.join(import.meta.dirname, "../..", "docs", relativePath), "utf8");
  expect(guide).toContain(
    "stock onboarding stops before sandbox creation and does not build a shipped Dockerfile",
  );
  expect(guide).toContain("--from <Dockerfile>");
  expect(guide).not.toContain("builds the shipped repository Dockerfile instead");
  expect(guide).not.toContain("ordinary `prefer-managed` path");
}

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
      path.join(import.meta.dirname, "../..", "docs", "reference", "commands.mdx"),
      "utf8",
    );
    expect(commands).toContain(
      "If registry or catalog availability prevents resolution, stock onboarding stops before sandbox creation and does not build a shipped Dockerfile.",
    );
    expect(commands).toContain(
      "Catalog evidence that is incomplete, mixed, mutable, wrong-platform, or identity-inconsistent also fails closed before sandbox creation.",
    );
    expectManagedOnlyGuide("deployment/sandbox-hardening.mdx");
    expectManagedOnlyGuide("reference/architecture.mdx");
    expectManagedOnlyGuide("get-started/quickstart.mdx");
    expectManagedOnlyGuide("get-started/quickstart-hermes.mdx");
    expectManagedOnlyGuide("get-started/quickstart-langchain-deepagents-code.mdx");

    progress.phase("validate mocked all-agent buildless orchestration boundaries");
    runManagedImageBuildlessE2e();
    progress.phase("release managed onboarding fixtures");
  });
});
