// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasPreparedRemoteDashboardBind,
  patchStagedDockerfile,
} from "../src/lib/onboard/dockerfile-patch";
import { prepareSandboxCreateLaunch } from "../src/lib/onboard/sandbox-create-launch";
import { buildCreatedSandboxRegistryEntry } from "../src/lib/onboard/sandbox-registration";
import { applyReusedSandboxDashboardState } from "../src/lib/onboard/sandbox-reuse";

const requireSource = createRequire(import.meta.url);
const { ensureSandboxPortForward, ensureSandboxPortForwardForPort } = requireSource(
  "../src/lib/actions/sandbox/forward-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/forward-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("remote dashboard bind production lifecycle", () => {
  it("carries the audited remote-exposure signal through image and sandbox creation (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789");
      expect(fs.readFileSync(dockerfile, "utf8")).toContain("ARG NEMOCLAW_DASHBOARD_BIND=0.0.0.0");

      const launch = prepareSandboxCreateLaunch({
        agent: { name: "openclaw" } as never,
        chatUiUrl: "http://127.0.0.1:18789",
        createArgs: [],
        env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "18789",
        hermesDashboardState: { enabled: false, config: null },
        openshellShellCommand: (args) => args.join(" "),
        buildEnv: () => ({}),
      });
      expect(launch.envArgs).toContain("NEMOCLAW_DASHBOARD_BIND=0.0.0.0");

      const entry = buildCreatedSandboxRegistryEntry({
        sandboxName: "beta",
        inferenceSelection: {
          model: "test-model",
          provider: "nvidia",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          compatibleEndpointReasoning: null,
          nimContainer: null,
        },
        runtimeFields: {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "0",
          sandboxGpuDevice: null,
          sandboxGpuProof: null,
          openshellDriver: "docker",
          openshellVersion: "0.1.2",
        },
        agent: { name: "openclaw" } as never,
        agentVersionKnown: true,
        imageTag: null,
        appliedPolicies: [],
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        dashboardRemoteBindPrepared: hasPreparedRemoteDashboardBind(dockerfile),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });
      expect(entry.dashboardRemoteBindPrepared).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses remote preparation when a custom Dockerfile lacks the bind contract (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-custom-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      ["ARG NEMOCLAW_MODEL=", "ARG CHAT_UI_URL=", "FROM scratch"].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/missing ARG NEMOCLAW_DASHBOARD_BIND/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses remote preparation when a custom Dockerfile declares but never consumes the bind arg (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-unused-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/does not promote it to generate-openclaw-config/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects remote-bind proof that only appears in an unused build stage (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-decoy-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch AS decoy",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/does not promote it to generate-openclaw-config/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when connect requests remote exposure for a local-only sandbox (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
    });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(ensureSandboxPortForward("beta")).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not prepared for remote exposure"));
  });

  it("refuses to reuse a local-only sandbox for remote exposure during onboarding (#6024)", () => {
    const ensureDashboardForward = vi.fn();
    expect(() =>
      applyReusedSandboxDashboardState({
        sandboxName: "beta",
        chatUiUrl: "http://127.0.0.1:18789",
        env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
        agent: { name: "openclaw" } as never,
        model: "test-model",
        provider: "nvidia",
        selectionVerified: true,
        sandboxGpuConfig: { mode: "0" } as never,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        getSandbox: () => ({ name: "beta" }),
        ensureDashboardForward,
        hermesDashboardForwarding: {
          resolveStateForPort: () => ({ enabled: false, config: null }),
          ensureForState: vi.fn(),
        },
        updateReusedSandboxMetadata: vi.fn(),
      }),
    ).toThrow(/--recreate-sandbox/);
    expect(ensureDashboardForward).not.toHaveBeenCalled();
  });

  it("uses an all-interfaces target only for a sandbox prepared during onboarding (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    let started = false;
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => started);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: started
        ? "SANDBOX  BIND  PORT  PID  STATUS\nbeta  0.0.0.0  18789  12345  running"
        : "",
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        started ||= args[0] === "forward" && args[1] === "start";
        return { status: 0 } as never;
      });

    expect(ensureSandboxPortForward("beta")).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "0.0.0.0:18789", "beta"],
      { ignoreError: true },
    );
  });

  it("re-verifies remote-bind preparation immediately before opening the forward (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(registry, "getSandbox")
      .mockReturnValueOnce({
        name: "beta",
        dashboardPort: 18789,
        dashboardRemoteBindPrepared: true,
      })
      .mockReturnValueOnce({
        name: "beta",
        dashboardPort: 18789,
        dashboardRemoteBindPrepared: true,
      })
      .mockReturnValue({ name: "beta", dashboardPort: 18789 });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({ status: 0, output: "" });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    expect(ensureSandboxPortForward("beta")).toBe(false);
    expect(
      runOpenshell.mock.calls.some(
        ([rawArgs]) => Array.isArray(rawArgs) && rawArgs[0] === "forward" && rawArgs[1] === "start",
      ),
    ).toBe(false);
  });

  it("can force a loopback restart independently of remote-bind selection (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    let stopped = false;
    let started = false;
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(
      () => !stopped || started,
    );
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output:
        !stopped || started
          ? "SANDBOX  BIND  PORT  PID  STATUS\nbeta  127.0.0.1  18789  12345  running"
          : "",
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        stopped ||= args[0] === "forward" && args[1] === "stop";
        started ||= args[0] === "forward" && args[1] === "start";
        return { status: 0 } as never;
      });

    expect(
      ensureSandboxPortForwardForPort("beta", 18789, {
        forwardTarget: "18789",
        forceRestart: true,
      }),
    ).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18789", "beta"],
      { ignoreError: true },
    );
  });
});
