// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { patchStagedDockerfile } from "../../dockerfile-patch";
import { clearCompatibleEndpointReasoning } from "../../reasoning-mode";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

describe("compatible endpoint reasoning mode", () => {
  it("records reasoning state during provider selection", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
    }));
    const { deps } = createDeps({ setupNim });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps),
      env: { NEMOCLAW_REASONING: "true" },
    });

    expect(result).toMatchObject({
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
      provider: "compatible-endpoint",
    });
  });

  it("clears stale resumed state before writing a non-compatible artifact", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "true");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reasoning-resume-"));
    const dockerfilePath = path.join(tempDir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "ARG NEMOCLAW_REASONING=false\n");
    const session = createSession({
      provider: "nvidia-prod",
      model: "nvidia/test",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
    });
    session.steps.provider_selection.status = "complete";
    const setupInference = vi.fn(async () => {
      expect(process.env.NEMOCLAW_REASONING).toBeUndefined();
      patchStagedDockerfile(
        dockerfilePath,
        "nvidia/test",
        "https://chat.example",
        "build-1",
        "nvidia-prod",
      );
      return { ok: true as const };
    });
    const { deps } = createDeps({
      clearCompatibleEndpointReasoning,
      setupInference,
      isInferenceRouteReady: vi.fn(() => false),
    });

    try {
      const result = await handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      });

      expect(setupInference).toHaveBeenCalledOnce();
      expect(result.compatibleEndpointReasoning).toBeNull();
      expect(fs.readFileSync(dockerfilePath, "utf-8")).toContain("ARG NEMOCLAW_REASONING=false");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
