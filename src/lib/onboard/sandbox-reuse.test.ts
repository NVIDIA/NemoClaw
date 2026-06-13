// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyReusedSandboxDashboardState } from "../../../dist/lib/onboard/sandbox-reuse";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

describe("applyReusedSandboxDashboardState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates dashboard URL, Hermes forwarding, reuse metadata, and gateway registry fields", () => {
    const updateSandbox = vi.fn();
    const env: NodeJS.ProcessEnv = {};
    const sandboxGpuConfig: SandboxGpuConfig = {
      hostGpuDetected: true,
      hostGpuPlatform: "linux",
      sandboxGpuEnabled: true,
      mode: "auto",
      sandboxGpuDevice: null,
      errors: [],
      sandboxGpuProof: null,
    };
    const hermesDashboardState = {
      enabled: true,
      config: {
        enabled: true,
        port: 9123,
        internalPort: 19123,
        tuiEnabled: true,
      },
    };
    const hermesDashboardForwarding = {
      resolveStateForPort: vi.fn(() => hermesDashboardState),
      ensureForState: vi.fn(),
    };
    const ensureDashboardForward = vi.fn(() => 18790);
    const updateReusedSandboxMetadata = vi.fn();

    const result = applyReusedSandboxDashboardState({
      sandboxName: "reuse-me",
      chatUiUrl: "http://127.0.0.1:18789",
      env,
      agent: null,
      model: "test-model",
      provider: "openai-compatible",
      selectionVerified: false,
      sandboxGpuConfig,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      ensureDashboardForward,
      hermesDashboardForwarding,
      updateSandbox,
      updateReusedSandboxMetadata,
    });

    expect(ensureDashboardForward).toHaveBeenCalledWith("reuse-me", "http://127.0.0.1:18789");
    expect(env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
    expect(hermesDashboardForwarding.resolveStateForPort).toHaveBeenCalledWith(18790);
    expect(hermesDashboardForwarding.ensureForState).toHaveBeenCalledWith(
      hermesDashboardState,
      "reuse-me",
    );
    expect(updateReusedSandboxMetadata).toHaveBeenCalledWith(
      "reuse-me",
      null,
      "test-model",
      "openai-compatible",
      18790,
      false,
      sandboxGpuConfig,
    );
    expect(updateSandbox).toHaveBeenCalledWith("reuse-me", {
      hermesDashboardEnabled: true,
      hermesDashboardPort: 9123,
      hermesDashboardInternalPort: 19123,
      hermesDashboardTui: true,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });
    expect(result).toEqual({
      chatUiUrl: "http://127.0.0.1:18790",
      dashboardPort: 18790,
      hermesDashboardState,
    });
  });

  it("clears Hermes dashboard registry fields when the reused sandbox has it disabled", () => {
    const updateSandbox = vi.fn();
    const sandboxGpuConfig: SandboxGpuConfig = {
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      mode: "auto",
      sandboxGpuDevice: null,
      errors: [],
    };
    const hermesDashboardState = { enabled: false, config: null };
    const result = applyReusedSandboxDashboardState({
      sandboxName: "reuse-me",
      chatUiUrl: "http://127.0.0.1:18789",
      env: {},
      agent: null,
      model: "test-model",
      provider: "openai-compatible",
      selectionVerified: true,
      sandboxGpuConfig,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      ensureDashboardForward: vi.fn(() => 18789),
      hermesDashboardForwarding: {
        resolveStateForPort: vi.fn(() => hermesDashboardState),
        ensureForState: vi.fn(),
      },
      updateSandbox,
      updateReusedSandboxMetadata: vi.fn(),
    });

    expect(updateSandbox).toHaveBeenCalledWith("reuse-me", {
      hermesDashboardEnabled: undefined,
      hermesDashboardPort: undefined,
      hermesDashboardInternalPort: undefined,
      hermesDashboardTui: undefined,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(result.hermesDashboardState).toBe(hermesDashboardState);
  });
});
