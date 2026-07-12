// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { DockerContainerInspect } from "./docker-gpu-patch";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "./docker-startup-command-patch";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Image: `sha256:${"c".repeat(64)}`,
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity", "NVIDIA_VISIBLE_DEVICES=void"],
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
}

describe("Docker startup-command patch", () => {
  it("persists the startup command without adding GPU-only container privileges", () => {
    const dockerCaptureOutput: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => dockerCaptureOutput[args[0] ?? ""] ?? "",
    );
    const dockerRunDetached = vi.fn((_args: readonly string[]) => ({
      status: 0,
      stdout: "new-container-id\n",
    }));

    const result = recreateOpenShellDockerSandboxWithStartupCommand(
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        waitForSupervisor: false,
        openshellSandboxCommand: ["env", "CHAT_UI_URL=http://127.0.0.1:8642", "nemoclaw-start"],
      },
      {
        dockerCapture,
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-07-10T00:00:00Z"),
      },
    );

    expect(result.mode.kind).toBe("startup-command");
    const cloneArgs = dockerRunDetached.mock.calls[0]?.[0] ?? [];
    expect(cloneArgs).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
      ]),
    );
    expect(cloneArgs).not.toContain("--gpus");
    expect(cloneArgs).not.toContain("--device");
    expect(cloneArgs).toEqual(expect.arrayContaining(["--env", "NVIDIA_VISIBLE_DEVICES=void"]));
    expect(cloneArgs).not.toEqual(expect.arrayContaining(["--cap-add", "SYS_PTRACE"]));
    expect(cloneArgs).not.toEqual(
      expect.arrayContaining(["--security-opt", "apparmor=unconfined"]),
    );
    expect(cloneArgs).toContain(`sha256:${"c".repeat(64)}`);
    expect(cloneArgs).not.toContain("openshell/sandbox:abc");
    expect(dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["ps", "-a", "--no-trunc"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("preserves OpenShell's native CDI GPU request during restart-persistence recreation", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.DeviceRequests = [
      {
        Driver: "cdi",
        DeviceIDs: ["nvidia.com/gpu=all"],
      },
    ];
    const dockerRunDetached = vi.fn((_args: readonly string[]) => ({
      status: 0,
      stdout: "new-container-id\n",
    }));

    recreateOpenShellDockerSandboxWithStartupCommand(
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        waitForSupervisor: false,
        openshellSandboxCommand: ["env", "nemoclaw-start"],
      },
      {
        dockerCapture: vi.fn((args: readonly string[]) =>
          args[0] === "ps" ? "old-container-id\n" : JSON.stringify([inspect]),
        ),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-07-10T00:00:00Z"),
      },
    );

    const cloneArgs = dockerRunDetached.mock.calls[0]?.[0] ?? [];
    expect(cloneArgs).toEqual(expect.arrayContaining(["--device", "nvidia.com/gpu=all"]));
    expect(cloneArgs).not.toContain("--gpus");
    expect(cloneArgs).not.toEqual(expect.arrayContaining(["--cap-add", "SYS_PTRACE"]));
    expect(cloneArgs).not.toEqual(
      expect.arrayContaining(["--security-opt", "apparmor=unconfined"]),
    );
  });

  it("rejects an empty restart-persistence command before Docker mutation", () => {
    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand({
        sandboxName: "alpha",
        openshellSandboxCommand: [],
      }),
    ).toThrow("OpenShell sandbox startup command is required for restart persistence");
  });

  it("rejects shell metacharacters before Docker mutation", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "VALUE=$(id)", "nemoclaw-start"],
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspectFixture()])
                : "",
          ),
          dockerRunDetached,
          dockerRename,
          dockerStop,
        },
      ),
    ).toThrow("OpenShell sandbox startup command tokens contain unsupported shell metacharacters");
    expect(dockerStop).not.toHaveBeenCalled();
    expect(dockerRename).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it("refuses startup-command recreation without an immutable image ID", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const inspect = inspectFixture();
    delete inspect.Image;

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "nemoclaw-start"],
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspect])
                : "",
          ),
          dockerRunDetached,
          dockerRename: vi.fn(() => ({ status: 0 })),
          dockerStop,
        },
      ),
    ).toThrow(/refusing startup-command recreation from a mutable image tag/);
    expect(dockerStop).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it.each([
    "different-container-id",
    "",
  ])("refuses to mutate when the pinned container identity is changed or empty", (expectedOldContainerId) => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "nemoclaw-start"],
          expectedOldContainerId,
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspectFixture()])
                : "",
          ),
          dockerRunDetached,
          dockerRename,
          dockerStop,
        },
      ),
    ).toThrow("observed container differs from the pinned identity");
    expect(dockerStop).not.toHaveBeenCalled();
    expect(dockerRename).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it("does not rename or recreate when the original container cannot be stopped", () => {
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerStart = vi.fn(() => ({ status: 0 }));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "nemoclaw-start"],
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspectFixture()])
                : "",
          ),
          dockerRunDetached,
          dockerRename,
          dockerStart,
          dockerStop: vi.fn(() => ({ status: null, error: new Error("stop timed out") })),
        },
      ),
    ).toThrow(
      /Could not stop original sandbox container: stop timed out; original sandbox container confirmed running/,
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "old-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRename).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it("normalizes and restarts the original container after an uncertain backup rename", () => {
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi
      .fn()
      .mockReturnValueOnce({ status: null, error: new Error("rename timed out") })
      .mockReturnValueOnce({ status: 0 });
    const dockerCapture = vi
      .fn()
      .mockReturnValueOnce("old-container-id\n")
      .mockReturnValueOnce(JSON.stringify([inspectFixture()]))
      .mockReturnValueOnce(JSON.stringify([inspectFixture()]));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "nemoclaw-start"],
        },
        {
          dockerCapture,
          dockerRunDetached,
          dockerRename,
          dockerStart,
          dockerStop: vi.fn(() => ({ status: 0 })),
        },
      ),
    ).toThrow(/rename timed out; original sandbox container restored/);
    expect(dockerRename).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("openshell-alpha-nemoclaw-gpu-backup-"),
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "old-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerCapture).toHaveBeenNthCalledWith(
      3,
      ["inspect", "--type", "container", "old-container-id"],
      expect.any(Object),
    );
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it("uses the full labeled replacement ID when detached run output is empty", () => {
    const oldContainerId = "a".repeat(64);
    const newContainerId = "b".repeat(64);
    const dockerCapture = vi
      .fn()
      .mockReturnValueOnce(`${oldContainerId}\n`)
      .mockReturnValueOnce(JSON.stringify([{ ...inspectFixture(), Id: oldContainerId }]))
      .mockReturnValueOnce(`${oldContainerId}\n${newContainerId}\n`);

    const result = recreateOpenShellDockerSandboxWithStartupCommand(
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        expectedOldContainerId: oldContainerId,
        waitForSupervisor: false,
        openshellSandboxCommand: ["env", "nemoclaw-start"],
      },
      {
        dockerCapture,
        dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "" })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-07-10T00:00:00Z"),
      },
    );

    expect(result.newContainerId).toBe(newContainerId);
  });

  it("restores the original sandbox when startup-command recreation fails", () => {
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "boom" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "nemoclaw-start"],
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspectFixture()])
                : "",
          ),
          dockerRunDetached,
          dockerRename: vi.fn(() => ({ status: 0 })),
          dockerRm: vi.fn(() => ({ status: 0 })),
          dockerStart: vi.fn(() => ({ status: 0 })),
          dockerStop: vi.fn(() => ({ status: 0 })),
          now: () => new Date("2026-07-10T00:00:00Z"),
        },
      ),
    ).toThrow(/Could not start recreated sandbox container: boom; pre-patch sandbox restored/);
  });

  it("restores the original sandbox when Docker omits the replacement container ID", () => {
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2_000);

    try {
      expect(() =>
        recreateOpenShellDockerSandboxWithStartupCommand(
          {
            sandboxName: "alpha",
            timeoutSecs: 1,
            openshellSandboxCommand: ["env", "nemoclaw-start"],
          },
          {
            dockerCapture: vi.fn((args: readonly string[]) =>
              args[0] === "ps"
                ? "old-container-id\n"
                : args[0] === "inspect"
                  ? JSON.stringify([inspectFixture()])
                  : "",
            ),
            dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "" })),
            dockerRename,
            dockerRm,
            dockerStart,
            dockerStop: vi.fn(() => ({ status: 0 })),
            sleep: vi.fn(),
            now: () => new Date("2026-07-10T00:00:00Z"),
          },
        ),
      ).toThrow(/Docker did not report its ID; pre-patch sandbox restored/);
    } finally {
      now.mockRestore();
    }

    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRename).toHaveBeenLastCalledWith(
      expect.stringContaining("openshell-alpha-nemoclaw-gpu-backup-"),
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
  });
});
