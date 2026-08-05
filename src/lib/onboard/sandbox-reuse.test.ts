// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";
import { applyReusedSandboxDashboardState, createSandboxReuseHelpers } from "./sandbox-reuse";

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

  it("skips dashboard forwarding while preserving reuse metadata for terminal agents", () => {
    const updateSandbox = vi.fn();
    const env: NodeJS.ProcessEnv = { CHAT_UI_URL: "https://chat.example.test:19000" };
    const sandboxGpuConfig: SandboxGpuConfig = {
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      mode: "auto",
      sandboxGpuDevice: null,
      errors: [],
    };
    const ensureDashboardForward = vi.fn(() => {
      throw new Error("dashboard forward should not be restored");
    });
    const hermesDashboardForwarding = {
      resolveStateForPort: vi.fn(),
      ensureForState: vi.fn(),
    };
    const updateReusedSandboxMetadata = vi.fn();

    const result = applyReusedSandboxDashboardState({
      sandboxName: "terminal-box",
      chatUiUrl: "",
      env,
      agent: { name: "langchain-deepagents-code" } as any,
      model: "test-model",
      provider: "nvidia-prod",
      selectionVerified: true,
      sandboxGpuConfig,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      manageDashboard: false,
      ensureDashboardForward,
      hermesDashboardForwarding,
      updateSandbox,
      updateReusedSandboxMetadata,
    });

    expect(ensureDashboardForward).not.toHaveBeenCalled();
    expect(hermesDashboardForwarding.resolveStateForPort).not.toHaveBeenCalled();
    expect(hermesDashboardForwarding.ensureForState).not.toHaveBeenCalled();
    expect(env.CHAT_UI_URL).toBe("https://chat.example.test:19000");
    expect(updateReusedSandboxMetadata).toHaveBeenCalledWith(
      "terminal-box",
      { name: "langchain-deepagents-code" },
      "test-model",
      "nvidia-prod",
      0,
      true,
      sandboxGpuConfig,
    );
    expect(updateSandbox).toHaveBeenCalledWith("terminal-box", {
      hermesDashboardEnabled: undefined,
      hermesDashboardPort: undefined,
      hermesDashboardInternalPort: undefined,
      hermesDashboardTui: undefined,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(result).toEqual({
      chatUiUrl: "",
      dashboardPort: 0,
      hermesDashboardState: { enabled: false, config: null },
    });
  });
});

describe("createSandboxReuseHelpers", () => {
  it("observes state and a stable OpenShell identity together for recreate recovery", () => {
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      args[1] === "get"
        ? "Name: alpha\n\u001b[32mId: openshell-source-id\u001b[0m\nState: Ready\n"
        : "alpha Ready\n",
    );
    const getSandboxStateFromOutputs = vi.fn(() => "ready");
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell,
      getSandboxStateFromOutputs,
    });

    expect(helpers.getSandboxRecreateObservation("alpha")).toEqual({
      state: "ready",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
    });
    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(1, ["sandbox", "get", "alpha"], {
      ignoreError: true,
    });
    expect(getSandboxStateFromOutputs).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining("Id: openshell-source-id"),
      "alpha Ready\n",
    );
  });

  it("observes a resumed replacement on the gateway its journal records (#7734)", () => {
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      args[1] === "get" ? "Name: alpha\nId: openshell-source-id\nState: Ready\n" : "alpha Ready\n",
    );
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell,
      getSandboxStateFromOutputs: vi.fn(() => "ready"),
      getGatewayName: () => "nemoclaw",
    });

    helpers.getSandboxRecreateObservation("alpha", "nemoclaw-9090");

    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "get", "-g", "nemoclaw-9090", "alpha"],
      { ignoreError: true },
    );
    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "list", "-g", "nemoclaw-9090"],
      { ignoreError: true },
    );
  });

  it("preserves an unknown reuse state but rejects it for recreate recovery", () => {
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      getSandboxStateFromOutputs: vi.fn(() => "unknown"),
    });

    expect(helpers.getSandboxReuseState("alpha")).toBe("unknown");
    expect(() => helpers.getSandboxRecreateObservation("alpha")).toThrow(/state 'unknown'/);
  });
});
