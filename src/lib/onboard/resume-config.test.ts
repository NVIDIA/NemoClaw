// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../state/onboard-session";
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

  it("reports an explicit tool-disclosure mismatch against recorded resume state", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "demo",
          provider: "nvidia-prod",
          model: "test-model",
          toolDisclosure: "progressive",
        },
        { toolDisclosure: "direct" },
      ),
    ).toContainEqual({
      field: "tool disclosure",
      requested: "direct",
      recorded: "progressive",
    });
  });

  it("fails closed for a corrupt persisted tool-disclosure value", () => {
    const corrupt = normalizeSession({
      version: 1,
      toolDisclosure: "everything",
    } as never);

    expect(getResumeConfigConflicts(corrupt, {})).toContainEqual({
      field: "tool disclosure",
      requested: null,
      recorded: "invalid",
    });
  });

  it("allows explicit observability changes to reach sandbox drift reconciliation", () => {
    const session = {
      sandboxName: "demo",
      provider: "nvidia-prod",
      model: "test-model",
      observabilityEnabled: true,
    };

    expect(getResumeConfigConflicts(session, {})).toEqual([]);
    expect(getResumeConfigConflicts(session, { observabilityEnabled: false })).toEqual([]);
  });
});
