// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "../../onboard/docker-gpu-patch";
import { finalizeDockerGpuPatchBackup } from "../../onboard/docker-gpu-patch-finalize";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "../../onboard/docker-startup-command-patch";
import {
  type ManagedSupervisorRelaunchDeps,
  relaunchManagedSupervisorSession,
} from "./supervisor-relaunch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function patchResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old-container-id",
    newContainerId: "new-container-id",
    originalName: "openshell-alpha",
    backupContainerName: "openshell-alpha-nemoclaw-backup",
    mode: {
      kind: "startup-command",
      label: "persistent sandbox startup command",
      device: "",
      args: [],
    },
    backupRemoved: false,
  };
}

function composedHandoffDeps() {
  const inspect = {
    Id: "old-container-id",
    Image: `sha256:${"c".repeat(64)}`,
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
    },
    HostConfig: {
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      CapAdd: [],
      SecurityOpt: [],
    },
  };
  const dockerCapture = vi.fn((args: readonly string[]) =>
    args[0] === "ps" ? "old-container-id\n" : JSON.stringify([inspect]),
  );
  const dockerForceRm = vi.fn(() => ({ status: 0 }));
  const dockerRm = vi.fn(() => ({ status: 0 }));
  const dockerStart = vi.fn(() => ({ status: 0 }));
  const dockerStop = vi.fn(() => ({ status: 0 }));
  const dockerRename = vi.fn(() => ({ status: 0 }));
  const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
  const dockerDeps: DockerGpuPatchDeps = {
    detectSandboxFallbackDns: () => null,
    dockerCapture,
    dockerForceRm,
    dockerRename,
    dockerRm,
    dockerRunDetached,
    dockerStart,
    dockerStop,
    now: () => new Date("2026-07-10T00:00:00Z"),
  };
  return {
    dockerDeps,
    dockerForceRm,
    dockerRename,
    dockerRm,
    dockerStart,
    dockerStop,
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
    resolveContainer: vi.fn(() => "old-container-id"),
    inspectContainer: vi.fn(() => ({
      Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"] },
    })),
    confirmMissingSupervisor: vi.fn(() => true),
    recreate: vi.fn(() => patchResult()),
    finalize: vi.fn(({ supervisorReady }) =>
      supervisorReady
        ? { backupRemoved: true, rolledBack: false }
        : { backupRemoved: false, rolledBack: true },
    ),
    ...overrides,
  } satisfies ManagedSupervisorRelaunchDeps;
}

describe("relaunchManagedSupervisorSession", () => {
  it("returns null without Docker discovery when the sandbox is not registered", () => {
    const deps = baseDeps({ getSandbox: vi.fn(() => null) });

    expect(relaunchManagedSupervisorSession("missing-box", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("honors the troubleshooting kill switch without mutating Docker", () => {
    vi.stubEnv("NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH", "1");
    const deps = baseDeps();

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("refuses a container that no longer has the legacy keepalive startup", () => {
    const deps = baseDeps({
      inspectContainer: vi.fn(() => ({
        Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=env nemoclaw-start"] },
      })),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("refuses recreation when the pinned container no longer proves supervisor absence", () => {
    const deps = baseDeps({ confirmMissingSupervisor: vi.fn(() => false) });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.confirmMissingSupervisor).toHaveBeenCalledWith("old-container-id");
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("pins the selected container and persists only a credential-free startup command", () => {
    vi.stubEnv("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS", "CUSTOM_PROVIDER_CREDENTIAL");
    vi.stubEnv("CUSTOM_PROVIDER_CREDENTIAL", "s3cr3t-token");
    vi.stubEnv("HTTPS_PROXY", "http://proxyuser:proxypass@proxy.example:8080");
    const deps = baseDeps();

    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch).not.toBeNull();
    expect(relaunch?.containerId).toBe("new-container-id");
    expect(deps.recreate).toHaveBeenCalledOnce();
    const options = vi.mocked(deps.recreate).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      sandboxName: "alpha",
      expectedOldContainerId: "old-container-id",
      keepOriginalRunningUntilFinalize: true,
      waitForSupervisor: false,
    });
    const serialized = options?.openshellSandboxCommand.join(" ") ?? "";
    expect(serialized).toContain("NEMOCLAW_DASHBOARD_PORT=18789");
    expect(serialized).toMatch(/nemoclaw-start$/);
    expect(serialized).not.toContain("s3cr3t-token");
    expect(serialized).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
    expect(serialized).not.toContain("proxypass");

    expect(relaunch?.finalize(true)).toEqual({ backupRemoved: true, rolledBack: false });
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ newContainerId: "new-container-id" }),
      supervisorReady: true,
    });
  });

  it("rolls the container transaction back when managed readiness is not proven", () => {
    const deps = baseDeps();
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(false)).toEqual({ backupRemoved: false, rolledBack: true });
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ backupContainerName: expect.any(String) }),
      supervisorReady: false,
    });
  });

  it("removes the running original container only after supervisor readiness is confirmed", () => {
    const handoff = composedHandoffDeps();
    const deps = baseDeps({
      recreate: (options) =>
        recreateOpenShellDockerSandboxWithStartupCommand(options, handoff.dockerDeps),
      finalize: (options) => finalizeDockerGpuPatchBackup(options, handoff.dockerDeps),
    });

    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.containerId).toBe("new-container-id");
    expect(handoff.dockerStop).not.toHaveBeenCalled();
    expect(handoff.dockerForceRm).not.toHaveBeenCalled();

    expect(relaunch?.finalize(true)).toEqual({ backupRemoved: true, rolledBack: false });
    expect(handoff.dockerForceRm).toHaveBeenCalledWith(
      expect.stringContaining("openshell-alpha-nemoclaw-gpu-backup-"),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(handoff.dockerStart).not.toHaveBeenCalled();
  });

  it("rolls back to the running original container without restarting it when supervisor readiness is not confirmed", () => {
    const handoff = composedHandoffDeps();
    const deps = baseDeps({
      recreate: (options) =>
        recreateOpenShellDockerSandboxWithStartupCommand(options, handoff.dockerDeps),
      finalize: (options) => finalizeDockerGpuPatchBackup(options, handoff.dockerDeps),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(false)).toEqual({ backupRemoved: false, rolledBack: true });
    expect(handoff.dockerStop).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(handoff.dockerRm).toHaveBeenCalledWith(
      "new-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(handoff.dockerRename).toHaveBeenLastCalledWith(
      expect.stringContaining("openshell-alpha-nemoclaw-gpu-backup-"),
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(handoff.dockerStart).not.toHaveBeenCalled();
    expect(handoff.dockerForceRm).not.toHaveBeenCalled();
  });

  it("returns null when the pinned recreation fails", () => {
    const deps = baseDeps({
      recreate: vi.fn(() => {
        throw new Error("container identity changed");
      }),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
  });

  it("redacts diagnostics when trusted recreation fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = baseDeps({
      recreate: vi.fn(() => {
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
