// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateToolDisclosureDockerfileContract } from "../../../src/lib/onboard/dockerfile-tool-disclosure-contract.ts";
import { MANAGED_IMAGE_REPOSITORIES } from "../../../src/lib/onboard/managed-image/contract.ts";
import {
  BAKED_STALE_CONTEXT_WINDOW,
  BAKED_STALE_MAX_TOKENS,
  stageNonRootCustomOpenClawImageDockerfile,
} from "../live/openclaw-inference-switch-helpers.ts";

describe("OpenClaw custom-image inference fixture", () => {
  it("layers stale model limits onto the exact selected image and restores a non-root final user", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-image-fixture-"));
    try {
      const expectedImage = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"1".repeat(64)}`;
      const dockerfilePath = stageNonRootCustomOpenClawImageDockerfile(home, expectedImage);
      const dockerfile = fs.readFileSync(dockerfilePath, "utf8");

      expect(dockerfile).toContain(`FROM ${expectedImage}`);
      expect(dockerfile).toContain(`model.contextWindow = ${BAKED_STALE_CONTEXT_WINDOW};`);
      expect(dockerfile).toContain(`model.maxTokens = ${BAKED_STALE_MAX_TOKENS};`);
      expect(dockerfile.trimEnd().endsWith("USER sandbox")).toBe(true);
      expect(() =>
        validateToolDisclosureDockerfileContract(dockerfile, "progressive"),
      ).not.toThrow();
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });
});
