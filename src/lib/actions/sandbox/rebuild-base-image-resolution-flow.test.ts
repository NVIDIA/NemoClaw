// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-test-harness";
import {
  SANDBOX_BASE_RESOLUTION_LABEL,
  type SandboxBaseImageResolutionMetadata,
} from "../../sandbox-base-image";

describe("rebuildSandbox base-image resolution flow", () => {
  installRebuildFlowTestHooks();

  it("passes the recorded Docker base-image hint and refresh env through ordinary preflight (#4680)", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH"]);
    process.env.NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH = "yes";
    const resolutionHint: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: "hermes-base-key",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      ref: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:resolved",
      digest: "sha256:resolved",
      source: "latest",
      imageId: "sha256:local-image",
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.39",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    };
    const labelsOutput = JSON.stringify({
      [SANDBOX_BASE_RESOLUTION_LABEL]: Buffer.from(JSON.stringify(resolutionHint)).toString(
        "base64url",
      ),
    });

    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          agent: "hermes",
          imageTag: "nemoclaw-hermes:recorded",
          nemoclawVersion: "0.1.0",
        },
        sandboxBaseImageLabelsOutput: labelsOutput,
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.ensureRebuildAgentBaseImageSpy).toHaveBeenCalledWith(
        "hermes",
        expect.any(Function),
        {
          resolutionHint,
          forceBaseImageRefresh: true,
        },
      );
    } finally {
      restoreEnv();
    }
  });
});
