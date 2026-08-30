// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitUntil } from "../core/wait";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import { SANDBOX_RECREATE_PROBE_TIMEOUT_MS } from "./sandbox-recreate-probe";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";
import {
  applyReusedSandboxDashboardState,
  createSandboxReuseHelpers,
  restoreReusedSandboxDashboardState,
  type SandboxReuseDeps,
} from "./sandbox-reuse";

type SandboxCaptureResult = ReturnType<SandboxReuseDeps["captureOpenshell"]>;

function successfulCapture(stdout: string): SandboxCaptureResult {
  return { status: 0, output: stdout, stdout, stderr: "" };
}

function failedCapture(
  stderr: string,
  overrides: Partial<SandboxCaptureResult> = {},
): SandboxCaptureResult {
  return { status: 1, output: stderr, stdout: "", stderr, ...overrides };
}

describe("applyReusedSandboxDashboardState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
      undefined,
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

  it("passes the receipt check into dashboard forwarding after release (#9833)", async () => {
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Sandbox identity changed before the dashboard entry");
      });
    const ensureDashboardForward = vi.fn(
      (
        _sandboxName: string,
        _chatUiUrl: string,
        options?: { revalidateSandboxIdentity?: (operation: string) => void },
      ) => {
        options?.revalidateSandboxIdentity?.("start the dashboard forward");
        return 18790;
      },
    );
    const env: NodeJS.ProcessEnv = {};
    const ensureForState = vi.fn();
    const updateReusedSandboxMetadata = vi.fn();
    const updateSandbox = vi.fn();

    await expect(
      restoreReusedSandboxDashboardState({
        sandboxName: "reuse-me",
        chatUiUrl: "http://127.0.0.1:18789",
        env,
        agent: null,
        model: "test-model",
        provider: "openai-compatible",
        selectionVerified: true,
        sandboxGpuConfig: {
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          mode: "auto",
          sandboxGpuDevice: null,
          errors: [],
        },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        releaseDashboardPort: vi.fn(async () => undefined),
        ensureDashboardForward,
        hermesDashboardForwarding: {
          resolveStateForPort: vi.fn(() => ({ enabled: false, config: null })),
          ensureForState,
        },
        updateSandbox,
        updateReusedSandboxMetadata,
        revalidateSandboxIdentity,
      }),
    ).rejects.toThrow(/Sandbox identity changed before/u);

    expect(ensureDashboardForward).toHaveBeenCalledOnce();
    expect(env.CHAT_UI_URL).toBeUndefined();
    expect(ensureForState).not.toHaveBeenCalled();
    expect(updateReusedSandboxMetadata).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after Hermes forwarding before reuse metadata (#9833)", () => {
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Sandbox identity changed before the dashboard entry");
      });
    const ensureForState = vi.fn();
    const updateReusedSandboxMetadata = vi.fn();
    const updateSandbox = vi.fn();

    expect(() =>
      applyReusedSandboxDashboardState({
        sandboxName: "reuse-me",
        chatUiUrl: "http://127.0.0.1:18789",
        env: {},
        agent: null,
        model: "test-model",
        provider: "openai-compatible",
        selectionVerified: true,
        sandboxGpuConfig: {
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          mode: "auto",
          sandboxGpuDevice: null,
          errors: [],
        },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        ensureDashboardForward: vi.fn(() => 18790),
        hermesDashboardForwarding: {
          resolveStateForPort: vi.fn(() => ({ enabled: false, config: null })),
          ensureForState,
        },
        updateSandbox,
        updateReusedSandboxMetadata,
        revalidateSandboxIdentity,
      }),
    ).toThrow(/Sandbox identity changed before/u);

    expect(ensureForState).toHaveBeenCalledOnce();
    expect(updateReusedSandboxMetadata).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });
});

describe("createSandboxReuseHelpers", () => {
  it("observes state and a stable OpenShell identity together for recreate recovery", () => {
    const getOutput = "Name: alpha\n\u001b[32mId: openshell-source-id\u001b[0m\nState: Ready\n";
    const runCaptureOpenshell = vi.fn(() => "alpha Ready\n");
    const captureOpenshell = vi.fn(() => successfulCapture(getOutput));
    const getSandboxStateFromOutputs = vi.fn(() => "ready");
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell,
      captureOpenshell,
      getSandboxStateFromOutputs,
    });

    expect(helpers.getSandboxRecreateObservation("alpha")).toEqual({
      state: "ready",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
    });
    expect(captureOpenshell).toHaveBeenCalledWith(["sandbox", "get", "alpha"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], {
      ignoreError: true,
    });
    expect(getSandboxStateFromOutputs).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining("Id: openshell-source-id"),
      "alpha Ready\n",
    );
  });

  it("observes a resumed replacement on the gateway its journal records (#7734)", () => {
    const captureOpenshell = vi.fn(() =>
      successfulCapture("Name: alpha\nId: openshell-source-id\nState: Ready\n"),
    );
    const runCaptureOpenshell = vi.fn(() => "alpha Ready\n");
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell,
      captureOpenshell,
      getSandboxStateFromOutputs: vi.fn(() => "ready"),
      getGatewayName: () => "nemoclaw",
    });

    helpers.getSandboxRecreateObservation("alpha", "nemoclaw-9090");

    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-9090", "alpha"],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
      },
    );
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["sandbox", "list", "-g", "nemoclaw-9090"], {
      ignoreError: true,
    });
  });

  it("preserves an unknown reuse state but rejects it for recreate recovery", () => {
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      captureOpenshell: vi.fn(() => successfulCapture("Name: alpha\nId: source-id\n")),
      getSandboxStateFromOutputs: vi.fn(() => "unknown"),
    });

    expect(helpers.getSandboxReuseState("alpha")).toBe("unknown");
    expect(() => helpers.getSandboxRecreateObservation("alpha")).toThrow(/state 'unknown'/);
  });

  it("does not treat a gateway lookup failure as recreate source absence", () => {
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      captureOpenshell: vi.fn(() =>
        failedCapture('status: NotFound, message: "gateway not found"'),
      ),
      getSandboxStateFromOutputs: vi.fn(() => "missing"),
    });

    expect(() => helpers.getSandboxRecreateObservation("alpha", "nemoclaw-9090")).toThrow(
      /neither a live sandbox nor explicit absence/,
    );
  });

  it("retains ignored stderr so final recreate confirmation can prove explicit absence", () => {
    const captureOpenshell = vi.fn((_args: string[], _options?: Record<string, unknown>) =>
      failedCapture("Error: sandbox alpha not found"),
    );
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      captureOpenshell,
      getSandboxStateFromOutputs: vi.fn(() => "missing"),
    });

    expect(helpers.getSandboxRecreateObservation("alpha", "nemoclaw-9090")).toEqual({
      state: "missing",
      liveIdentityFingerprint: null,
    });
    expect(captureOpenshell.mock.calls[0]?.[1]).toMatchObject({
      includeStderr: true,
      includeStreams: true,
    });
  });

  it.each([
    [
      "timeout",
      failedCapture("Error: sandbox alpha not found", {
        status: null,
        error: Object.assign(new Error("spawnSync openshell ETIMEDOUT"), { code: "ETIMEDOUT" }),
        signal: "SIGTERM",
      }),
    ],
    [
      "signal",
      failedCapture("Error: sandbox alpha not found", {
        status: null,
        signal: "SIGKILL",
      }),
    ],
  ])("does not accept partial NotFound output from a %s as recreate absence", (_label, probe) => {
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      captureOpenshell: vi.fn(() => probe),
      getSandboxStateFromOutputs: vi.fn(() => "missing"),
    });

    expect(() => helpers.getSandboxRecreateObservation("alpha", "nemoclaw-9090")).toThrow(
      /neither a live sandbox nor explicit absence/,
    );
  });

  it("waits for explicit sandbox absence on the journaled gateway", () => {
    let currentMs = 0;
    const probes = [
      successfulCapture("Name: alpha\nId: source-id\nPhase: Ready\n"),
      successfulCapture("Name: alpha\nId: source-id\nPhase: Terminating\n"),
      failedCapture("Error: sandbox alpha not found"),
    ];
    const captureOpenshell = vi.fn(
      (_args: string[], _options?: Record<string, unknown>) =>
        probes.shift() ?? successfulCapture(""),
    );
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      captureOpenshell,
      getSandboxStateFromOutputs: vi.fn(() => "ready"),
      now: () => currentMs,
      sleep: (milliseconds) => {
        currentMs += milliseconds;
      },
      waitUntil,
    });
    const note = vi.fn();

    expect(helpers.waitForSandboxRecreateDeleteAbsence("alpha", "nemoclaw-9090", note)).toBe(true);
    expect(captureOpenshell).toHaveBeenCalledTimes(3);
    captureOpenshell.mock.calls.forEach(([args, options]) => {
      expect(args).toEqual(["sandbox", "get", "-g", "nemoclaw-9090", "alpha"]);
      expect(options).toMatchObject({
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
      });
      const timeout = Number(options?.timeout);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(SANDBOX_RECREATE_PROBE_TIMEOUT_MS);
    });
    expect(note).toHaveBeenLastCalledWith("  Delete convergence probe 3: state=absent");
  });

  it("bounds delete convergence without accepting timeout or gateway errors as absence", () => {
    let currentMs = 0;
    const failures = [
      failedCapture("Error: sandbox alpha not found", {
        status: null,
        error: Object.assign(new Error("spawnSync openshell ETIMEDOUT"), { code: "ETIMEDOUT" }),
        signal: "SIGTERM",
      }),
      failedCapture('status: NotFound, message: "gateway not found"'),
      failedCapture("gateway transport unavailable"),
    ];
    let attempt = 0;
    const captureOpenshell = vi.fn((_args: string[], _options?: Record<string, unknown>) => {
      const output = failures[attempt % failures.length] ?? successfulCapture("");
      attempt += 1;
      return output;
    });
    const helpers = createSandboxReuseHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      captureOpenshell,
      getSandboxStateFromOutputs: vi.fn(() => "unknown"),
      now: () => currentMs,
      sleep: (milliseconds) => {
        currentMs += milliseconds;
      },
      waitUntil,
    });

    expect(helpers.waitForSandboxRecreateDeleteAbsence("alpha", "nemoclaw-9090", vi.fn())).toBe(
      false,
    );
    expect(captureOpenshell.mock.calls.length).toBeGreaterThan(1);
    expect(captureOpenshell.mock.calls.length).toBeLessThanOrEqual(20);
    expect(currentMs).toBeLessThanOrEqual(SANDBOX_RECREATE_PROBE_TIMEOUT_MS);
  });
});
