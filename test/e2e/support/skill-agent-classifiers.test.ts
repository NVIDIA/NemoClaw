// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentSectionContainsToken,
  isAgentVerificationFailClosed,
  isExternalProviderValidationFailure,
  shouldSkipExternalAgentVerificationFailure,
  VERIFY_PHRASE,
} from "./skill-agent-classifiers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ADD_SKILL_SCRIPT = path.join(
  REPO_ROOT,
  "test/e2e/e2e-cloud-experimental/features/skill/add-sandbox-skill.sh",
);

describe("skill-agent live test local classifiers", () => {
  it("does not treat helper fail-closed output as a skippable provider flake", () => {
    const output = `--- agent stdout/stderr\nSsrFBlockedError\n${VERIFY_PHRASE}\n--- end ---`;

    expect(isAgentVerificationFailClosed(output)).toBe(true);
    expect(shouldSkipExternalAgentVerificationFailure(output, true)).toBe(false);
  });

  it("skips only timeout-like agent verification failures after fixture presence is proven", () => {
    const timeoutOutput = `--- agent stdout/stderr\nLLM idle timeout\n--- end ---`;

    expect(shouldSkipExternalAgentVerificationFailure(timeoutOutput, false)).toBe(false);
    expect(shouldSkipExternalAgentVerificationFailure(timeoutOutput, true)).toBe(true);
    expect(shouldSkipExternalAgentVerificationFailure("require is not defined", true)).toBe(false);
    expect(shouldSkipExternalAgentVerificationFailure("HTTP 429 rate limit", true)).toBe(true);
    expect(
      shouldSkipExternalAgentVerificationFailure("SsrFBlockedError plus request timed out", true),
    ).toBe(false);
  });

  it("skips only NVIDIA endpoint validation outages during onboarding", () => {
    expect(
      isExternalProviderValidationFailure(
        "NVIDIA Endpoints endpoint validation failed.\nChat Completions API validation returned HTTP 429",
      ),
    ).toBe(true);
    expect(isExternalProviderValidationFailure("local docker preflight timed out")).toBe(false);
    expect(
      isExternalProviderValidationFailure("NVIDIA Endpoints endpoint validation failed."),
    ).toBe(false);
  });

  it("matches the token only inside the delimited agent section", () => {
    expect(agentSectionContainsToken(`helper echoed ${VERIFY_PHRASE}`)).toBe(false);
    expect(
      agentSectionContainsToken(`--- agent stdout/stderr\n\`${VERIFY_PHRASE}\`\n--- end ---`),
    ).toBe(true);
  });

  it("rejects a helper skill ID that differs from SKILL.md before sandbox contact", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-helper-name-"));
    const skillFile = path.join(fixtureDir, "SKILL.md");
    fs.writeFileSync(skillFile, "---\nname: other-skill\n---\n# Other\n");
    try {
      const result = spawnSync("bash", [ADD_SKILL_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          SANDBOX_NAME: "test-sandbox",
          SKILL_FILE: skillFile,
          SKILL_ID: "expected-skill",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "SKILL_ID 'expected-skill' does not match SKILL.md name 'other-skill'",
      );
      expect(result.stderr).not.toContain("openshell not on PATH");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
