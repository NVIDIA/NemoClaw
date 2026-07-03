// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { getResumeConfigConflicts } from "./resume-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authoritative rebuild resume config", () => {
  it("ignores a hosted credential alias rehydrated after ambient env isolation", () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "legacy-hosted-source-key");
    vi.stubEnv("NEMOCLAW_PROVIDER", "");
    vi.stubEnv("NEMOCLAW_MODEL", "");
    vi.stubEnv("COMPATIBLE_API_KEY", "");

    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "mcp-rebuild",
          provider: "compatible-endpoint",
          model: "mock/mcp-bridge",
        },
        { nonInteractive: true, authoritativeResumeConfig: true },
      ),
    ).toEqual([]);
    expect(process.env.NEMOCLAW_PROVIDER).toBe("");
    expect(process.env.NEMOCLAW_MODEL).toBe("");
    expect(process.env.COMPATIBLE_API_KEY).toBe("");
  });
});
