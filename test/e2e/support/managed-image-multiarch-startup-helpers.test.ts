// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  protectedManagedImageDispatchEnvironment,
  readRegularArtifact,
} from "../live/managed-image-multiarch-startup-helpers.ts";

const sha = "a".repeat(40);
let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-multiarch-helper-"));
  const artifacts = path.join(temporaryRoot, "artifacts");
  fs.mkdirSync(artifacts);
  vi.stubEnv("E2E_ARTIFACT_DIR", artifacts);
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("GITHUB_WORKSPACE", temporaryRoot);
  vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", sha);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA", sha);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT", "protected-123-1");
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT", path.join(artifacts, "contract.json"));
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_EVIDENCE", path.join(artifacts, "evidence.json"));
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM", "linux/amd64");
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA", sha);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("protected managed-image startup helpers", () => {
  it("parses exact protected dispatch identity", () => {
    expect(protectedManagedImageDispatchEnvironment()).toMatchObject({
      baseSha: sha,
      cohort: "protected-123-1",
      headSha: sha,
      platform: "linux/amd64",
      runAttempt: 1,
      runId: 123,
      workflowSha: sha,
    });
  });

  it("rejects identity values outside the canonical contract", () => {
    vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT", "other-123-1");
    expect(() => protectedManagedImageDispatchEnvironment()).toThrow(
      "protected managed-image dispatch identity is invalid",
    );
  });

  it("reads a bounded file through its opened descriptor and rejects a symlink", () => {
    const artifacts = path.join(temporaryRoot, "artifacts");
    const artifact = path.join(artifacts, "contract.json");
    const symlink = path.join(artifacts, "contract-link.json");
    fs.writeFileSync(artifact, '{"contractVersion":1}');
    fs.symlinkSync(artifact, symlink);

    expect(readRegularArtifact(artifact, artifacts).toString("utf8")).toBe('{"contractVersion":1}');
    expect(() => readRegularArtifact(symlink, artifacts)).toThrow();
  });
});
