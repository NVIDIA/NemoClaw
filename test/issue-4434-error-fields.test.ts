// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyIssue4434AcceptanceFields,
  ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS,
  type Issue4434AcceptanceFields,
} from "./e2e/support/issue-4434-tui-capture.ts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DEPENDENCY_REVIEW = path.join(
  REPO_ROOT,
  "docs/security/openclaw-2026.6.10-dependency-review.md",
);
const LIVE_VITEST_GUARD = path.join(
  REPO_ROOT,
  "test/e2e/live/issue-4434-tui-unreachable-inference.test.ts",
);

const CURRENT_REVIEWED_OPENCLAW_VERSION = "2026.6.10";
const PATCHED_OPENCLAW_2026_6_10_ISSUE_4434_TUI_ERROR_OUTPUT = [
  "run error: LLM request timed out.",
  "Cause: timed out while reaching the upstream API.",
  "Reporting layer: gateway proxy / upstream API.",
  "Recovery hint: check sandbox egress and provider reachability, then retry.",
  "1m 04s | error",
].join("\n");

const UPSTREAM_OPENCLAW_2026_6_10_ISSUE_4434_TUI_ERROR_OUTPUT = [
  "run error: LLM request timed out.",
  "1m 04s | error",
].join("\n");

type Issue4434AcceptanceField = keyof Issue4434AcceptanceFields;

function readDockerfileOpenClawVersion(): string {
  return fs.readFileSync(DOCKERFILE, "utf-8").match(/^ARG OPENCLAW_VERSION=([^\s]+)/m)?.[1] ?? "";
}

function detectIssue4434AcceptanceFields(
  output: string,
): Record<Issue4434AcceptanceField, boolean> {
  return classifyIssue4434AcceptanceFields(output);
}

function missingIssue4434AcceptanceFields(output: string): Issue4434AcceptanceField[] {
  const present = detectIssue4434AcceptanceFields(output);
  return (Object.keys(ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS) as Issue4434AcceptanceField[]).filter(
    (name) => !present[name],
  );
}

describe("full OpenClaw TUI error guard (#4434)", () => {
  it("requires the reviewed patched output to include all full-acceptance fields", () => {
    expect(readDockerfileOpenClawVersion()).toBe(CURRENT_REVIEWED_OPENCLAW_VERSION);
    expect(
      detectIssue4434AcceptanceFields(PATCHED_OPENCLAW_2026_6_10_ISSUE_4434_TUI_ERROR_OUTPUT),
    ).toEqual({
      httpStatusOrCause: true,
      reportingLayer: true,
      recoveryHint: true,
    });
    expect(
      missingIssue4434AcceptanceFields(PATCHED_OPENCLAW_2026_6_10_ISSUE_4434_TUI_ERROR_OUTPUT),
    ).toEqual([]);
    expect(
      missingIssue4434AcceptanceFields(UPSTREAM_OPENCLAW_2026_6_10_ISSUE_4434_TUI_ERROR_OUTPUT),
    ).toEqual(["httpStatusOrCause", "reportingLayer", "recoveryHint"]);
  });

  it("keeps the dependency review and live guards tied to the full-field requirement", () => {
    const review = fs.readFileSync(DEPENDENCY_REVIEW, "utf-8");
    const vitestGuard = fs.readFileSync(LIVE_VITEST_GUARD, "utf-8");
    expect(review).toContain("test/issue-4434-error-fields.test.ts");
    expect(review).toContain("scripts/patch-openclaw-issue-4434-diagnostics.ts");
    expect(review).toContain("Issue #4434 full live acceptance");
    expect(review).toContain("The #4434 compatibility-shim disposition is explicitly accepted");
    expect(review).not.toContain("`PRA-5`");
    expect(review).toContain("3/3 fields are present in the NemoClaw-patched runtime output");
    expect(review).toContain(
      "3/3 fields are missing in the upstream-shaped `openclaw@2026.6.10` output",
    );
    expect(vitestGuard).toContain("../support/issue-4434-tui-capture.ts");
    expect(vitestGuard).toContain("finalErrorBlock");
    expect(vitestGuard).toContain("full #4434 diagnostic fields");
    expect(vitestGuard).not.toContain("tighten both live guards");
  });
});
