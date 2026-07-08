// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type DockerContainerInspect,
  getDockerGpuPatchFailureContext,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: [
        "A=1",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
        "OPENSHELL_TEST=1",
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
        "NVIDIA_VISIBLE_DEVICES=void",
      ],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-id",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
      Hostname: "alpha-host",
      Tty: true,
    },
    HostConfig: {
      Binds: ["/host:/container:rw"],
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      CapAdd: ["SYS_ADMIN", "NET_ADMIN"],
      SecurityOpt: ["apparmor=unconfined"],
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
      Memory: 8 * 1024 * 1024 * 1024,
      NanoCpus: 2_500_000_000,
    },
    NetworkSettings: {
      Networks: {
        "openshell-docker": {
          IPAddress: "172.18.0.2",
          Gateway: "172.18.0.1",
          Aliases: ["openshell-alpha"],
        },
      },
    },
  };
}

describe("recreateOpenShellDockerSandboxWithGpu rollback path", () => {
  it("rolls back to the backup container when supervisor reconnect fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/pre-patch sandbox restored/);

    const restoreRename = dockerRename.mock.calls.find(
      (call) => String(call[0]).includes("nemoclaw-gpu-backup") && call[1] === "openshell-alpha",
    );
    expect(restoreRename).toBeDefined();
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });

  it("restores the pre-patch sandbox when the recreate run fails before the supervisor wait (#5512)", () => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
      info: "",
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    // The recreate `docker run` fails after the original was renamed aside.
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "docker: boom" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      ),
    ).toThrow(/Could not start GPU-enabled sandbox container/);

    // The original sandbox is restored from the backup (rename backup -> original, then start).
    const restoreRename = dockerRename.mock.calls.find(
      (call) => String(call[0]).includes("nemoclaw-gpu-backup") && call[1] === "openshell-alpha",
    );
    expect(restoreRename).toBeDefined();
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    // The failed recreate container (named originalName by `docker run --name`) is removed.
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    // The backup is renamed back, never left as an orphaned container.
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });

  it("reports early recreate rollback failure when backup rename back fails (#5512)", () => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
      info: "",
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "docker: boom" }));
    const dockerRename = vi.fn((oldName: string) =>
      String(oldName).includes("nemoclaw-gpu-backup")
        ? { status: 1, stderr: "rename failed" }
        : { status: 0 },
    );
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "");

    let thrown: unknown;
    try {
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(String((thrown as Error).message)).toMatch(
      /rollback failed; pre-patch sandbox was NOT restored/,
    );
    expect(getDockerGpuPatchFailureContext(thrown)?.rolledBack).toBe(false);
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports early recreate rollback failure when restored original start fails (#5512)", () => {
    const captureResponses: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
      info: "",
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => captureResponses[String(args[0])] ?? "",
    );
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "docker: boom" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 1, stderr: "container start failed" }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "");

    let thrown: unknown;
    try {
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(String((thrown as Error).message)).toMatch(
      /rollback failed; pre-patch sandbox was NOT restored/,
    );
    expect(getDockerGpuPatchFailureContext(thrown)?.rolledBack).toBe(false);
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("reports rollback failure when restoring the backup container fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((oldName: string) => {
      if (String(oldName).includes("nemoclaw-gpu-backup")) {
        return { status: 1, stderr: "no such container" };
      }
      return { status: 0 };
    });
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/rollback failed; pre-patch sandbox was NOT restored/);

    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports rollback failure when restarting the backup container fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 1, stderr: "container start failed" }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/rollback failed; pre-patch sandbox was NOT restored/);

    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });
});
