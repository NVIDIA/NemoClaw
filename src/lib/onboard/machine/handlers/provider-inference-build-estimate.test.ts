// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("handleProviderInferenceState build estimate", () => {
  it("adds a build estimate for an explicit custom Dockerfile", async () => {
    const formatSandboxBuildEstimateNote = vi.fn(() => "custom build estimate");
    const formatOnboardConfigSummary = vi.fn(() => "custom summary");
    const { deps, calls } = createDeps({
      formatSandboxBuildEstimateNote,
      formatOnboardConfigSummary,
    });
    const session = createSession();
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      customDockerfileRequested: true,
    });

    expect(formatSandboxBuildEstimateNote).toHaveBeenCalledWith({ cpus: 8 }, "custom-dockerfile");
    expect(formatOnboardConfigSummary).toHaveBeenCalledWith(
      expect.objectContaining({ notes: ["custom build estimate"] }),
    );
  });
});
