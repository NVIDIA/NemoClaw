// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ManagedSupervisorRelaunchDeps,
  relaunchManagedSupervisorSession,
} from "./supervisor-relaunch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function dockerResult(status: number) {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status,
    signal: null,
  };
}

function baseDeps(overrides: ManagedSupervisorRelaunchDeps = {}) {
  return {
    getSandbox: vi.fn(() => ({
      name: "alpha",
      agent: "openclaw",
      dashboardPort: 18789,
      openshellDriver: "docker",
    })),
    getSessionAgent: vi.fn(
      () =>
        ({
          name: "openclaw",
          displayName: "OpenClaw",
          forwardPort: 18789,
        }) as never,
    ),
    resolveDashboardPort: vi.fn(() => 18789),
    resolveContainer: vi.fn(() => "registered-container-id"),
    inspectContainer: vi.fn(() => ({
      Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"] },
    })),
    confirmMissingSupervisor: vi.fn(() => true),
    createNonce: vi.fn(() => "a".repeat(64)),
    privilegedExecArgv: vi.fn(() => [
      "exec",
      "--user",
      "root",
      "registered-container-id",
      "/usr/local/bin/nemoclaw-gateway-control",
      "launch-supervisor",
      "a".repeat(64),
    ]),
    runDocker: vi.fn(() => dockerResult(0)),
    ...overrides,
  } satisfies ManagedSupervisorRelaunchDeps;
}

describe("relaunchManagedSupervisorSession", () => {
  it("returns null without Docker discovery when the sandbox is not registered", () => {
    const deps = baseDeps({ getSandbox: vi.fn(() => null) });

    expect(relaunchManagedSupervisorSession("missing-box", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.runDocker).not.toHaveBeenCalled();
  });

  it("honors the troubleshooting kill switch without mutating Docker", () => {
    vi.stubEnv("NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH", "1");
    const deps = baseDeps();

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.runDocker).not.toHaveBeenCalled();
  });

  it("refuses a container that no longer has the legacy keepalive startup", () => {
    const deps = baseDeps({
      inspectContainer: vi.fn(() => ({
        Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=env nemoclaw-start"] },
      })),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.runDocker).not.toHaveBeenCalled();
  });

  it("refuses launch when the pinned container no longer proves supervisor absence", () => {
    const deps = baseDeps({ confirmMissingSupervisor: vi.fn(() => false) });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.confirmMissingSupervisor).toHaveBeenCalledWith("registered-container-id");
    expect(deps.runDocker).not.toHaveBeenCalled();
  });

  it("requests a credential-free managed launch in the registered keepalive", () => {
    vi.stubEnv("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS", "CUSTOM_PROVIDER_CREDENTIAL");
    vi.stubEnv("CUSTOM_PROVIDER_CREDENTIAL", "s3cr3t-token");
    vi.stubEnv("HTTPS_PROXY", "http://proxyuser:proxypass@proxy.example:8080");
    const deps = baseDeps();

    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch).toEqual({ containerId: "registered-container-id" });
    expect(deps.privilegedExecArgv).toHaveBeenCalledOnce();
    const [sandboxName, launchCommand, stdin, sanitizeEnvironment, expectedContainerId] =
      vi.mocked(deps.privilegedExecArgv).mock.calls[0] ?? [];
    expect({
      expectedContainerId,
      sandboxName,
      sanitizeEnvironment,
      stdin,
    }).toEqual({
      expectedContainerId: "registered-container-id",
      sandboxName: "alpha",
      sanitizeEnvironment: true,
      stdin: false,
    });
    expect(launchCommand?.slice(0, 3)).toEqual([
      "/usr/local/bin/nemoclaw-gateway-control",
      "launch-supervisor",
      "a".repeat(64),
    ]);
    const serialized = launchCommand?.join(" ") ?? "";
    expect(serialized).toContain("NEMOCLAW_DASHBOARD_PORT=18789");
    expect(serialized).not.toContain("s3cr3t-token");
    expect(serialized).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
    expect(serialized).not.toContain("proxypass");
    expect(deps.runDocker).toHaveBeenCalledWith(
      expect.arrayContaining(["exec", "registered-container-id"]),
      expect.objectContaining({
        ignoreError: true,
        suppressOutput: true,
        timeout: 30000,
      }),
    );
  });

  it("reconstructs the persisted Hermes dashboard environment", () => {
    const deps = baseDeps({
      getSandbox: vi.fn(() => ({
        name: "alpha",
        agent: "hermes",
        dashboardPort: 18790,
        hermesDashboardEnabled: true,
        hermesDashboardInternalPort: 19119,
        hermesDashboardPort: 18790,
        hermesDashboardTui: true,
        openshellDriver: "docker",
      })),
      getSessionAgent: vi.fn(
        () =>
          ({
            name: "hermes",
            displayName: "Hermes",
            forwardPort: 18790,
          }) as never,
      ),
      resolveDashboardPort: vi.fn(() => 18790),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toEqual({
      containerId: "registered-container-id",
    });
    const launchCommand = vi.mocked(deps.privilegedExecArgv).mock.calls[0]?.[1] ?? [];
    expect(launchCommand).toEqual(
      expect.arrayContaining([
        "CHAT_UI_URL=http://127.0.0.1:18790",
        "NEMOCLAW_DASHBOARD_PORT=18790",
        "NEMOCLAW_HERMES_DASHBOARD=1",
        "NEMOCLAW_HERMES_DASHBOARD_PORT=18790",
        "NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT=19119",
        "NEMOCLAW_HERMES_DASHBOARD_TUI=1",
      ]),
    );
    expect(launchCommand.some((value) => value.startsWith("OPENCLAW_"))).toBe(false);
  });

  it("returns null when the registered container refuses managed launch", () => {
    const deps = baseDeps({ runDocker: vi.fn(() => dockerResult(1)) });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
  });

  it("redacts diagnostics when trusted in-place launch fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = baseDeps({
      runDocker: vi.fn(() => {
        throw new Error(
          "OPENAI_API_KEY=sk-recovery-secret HTTPS_PROXY=http://proxyuser:proxypass@proxy.example:8080",
        );
      }),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: false, deps })).toBeNull();
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(output).not.toContain("sk-recovery-secret");
    expect(output).not.toContain("proxyuser");
    expect(output).not.toContain("proxypass");
  });
});
