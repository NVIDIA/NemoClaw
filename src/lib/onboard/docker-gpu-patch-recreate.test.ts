// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createDockerGpuInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import {
  getDockerGpuPatchFailureContext,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";

const OLD_CONTAINER_ID = "a".repeat(64);
const NEW_CONTAINER_ID = "b".repeat(64);

function dockerCaptureFixture() {
  const responses: Record<string, string> = {
    ps: `${OLD_CONTAINER_ID}\n`,
    inspect: JSON.stringify([inspectFixture()]),
    info: "",
  };
  return vi.fn((args: readonly string[]) => responses[args[0]] ?? "");
}

describe("Docker GPU recreate orchestration", () => {
  it("recreates the OpenShell-managed container and waits for supervisor exec", () => {
    const dockerCapture = dockerCaptureFixture();
    const dockerRunResults = {
      ps: { status: 0, stdout: `${NEW_CONTAINER_ID}\n` },
      inspect: { status: 0, stdout: "true\n" },
    };
    const dockerRun = vi.fn(
      (args: readonly string[]) =>
        dockerRunResults[String(args[0]) as keyof typeof dockerRunResults] ?? {
          status: 0,
          stdout: "probe-id\n",
        },
    );
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: `${NEW_CONTAINER_ID}\n` }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const runOpenshell = vi.fn((args: readonly string[]) =>
      args[1] === "list" ? { status: 0, stdout: "No sandboxes found.\n" } : { status: 0 },
    );
    const runCaptureOpenshell = vi.fn(() => "alpha  2026-08-23 10:00:00  Ready\n");

    const result = recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1 },
      {
        dockerCapture,
        dockerRun,
        dockerRunDetached,
        dockerRename,
        dockerStop,
        dockerRm,
        dockerStart,
        runCaptureOpenshell,
        runOpenshell,
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
        detectSandboxFallbackDns: vi.fn(() => null),
        readDir: vi.fn(() => null),
        readFile: vi.fn(() => null),
      },
    );

    expect(result.newContainerId).toBe(NEW_CONTAINER_ID);
    expect(result.backupRemoved).toBe(true);
    expect(result.mode.kind).toBe("gpus");
    expect(dockerStop).toHaveBeenCalledWith(
      OLD_CONTAINER_ID,
      expect.objectContaining({ timeout: 90_000 }),
    );
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining([
        "--name",
        "openshell-alpha",
        "--gpus",
        "all",
        "--cap-add",
        "SYS_ADMIN",
        "--cap-add",
        "SYS_PTRACE",
        "--security-opt",
        "apparmor=unconfined",
        "--network",
        "openshell-docker",
        "--add-host",
        "host.openshell.internal:172.17.0.1",
        "--env",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
      ]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    const dockerRmCalls = dockerRm.mock.calls as unknown[][];
    const backupRmCall = dockerRmCalls.findIndex((call) => call[0] === OLD_CONTAINER_ID);
    expect(backupRmCall).toBeGreaterThanOrEqual(0);
    expect(dockerRm.mock.invocationCallOrder[backupRmCall]).toBeGreaterThan(
      runOpenshell.mock.invocationCallOrder[0],
    );
    expect(dockerStart).toHaveBeenCalledWith(
      NEW_CONTAINER_ID,
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "list"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("does not report success when the final OpenShell phase is Deleting (#9531)", () => {
    let failure: unknown;
    try {
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture: dockerCaptureFixture(),
          dockerRun: vi.fn(() => ({ status: 0, stdout: `${NEW_CONTAINER_ID}\n` })),
          dockerRunDetached: vi.fn(() => ({ status: 0, stdout: `${NEW_CONTAINER_ID}\n` })),
          dockerRename: vi.fn(() => ({ status: 0 })),
          dockerStop: vi.fn(() => ({ status: 0 })),
          dockerRm: vi.fn(() => ({ status: 0 })),
          dockerStart: vi.fn(() => ({ status: 0 })),
          runCaptureOpenshell: vi.fn(() => "alpha  2026-08-23 10:00:00  Deleting\n"),
          runOpenshell: vi.fn((args: readonly string[]) =>
            args[1] === "list" ? { status: 0, stdout: "No sandboxes found.\n" } : { status: 0 },
          ),
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          detectSandboxFallbackDns: vi.fn(() => null),
          readDir: vi.fn(() => null),
          readFile: vi.fn(() => null),
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("final replacement handoff");
    expect((failure as Error).message).toContain("automatic rollback is unavailable");
    expect((failure as Error).message).toContain("Rebuild the sandbox before retrying");
    expect(getDockerGpuPatchFailureContext(failure)).toMatchObject({
      backupRemoved: true,
      oldContainerId: OLD_CONTAINER_ID,
      newContainerId: NEW_CONTAINER_ID,
      lastSandboxPhase: "Deleting",
      rolledBack: false,
    });
  });

  it("can recreate during sandbox create before supervisor exec is allowed", () => {
    const dockerCapture = dockerCaptureFixture();
    const dockerRunDetached = vi.fn(
      (_args: readonly string[], _opts?: Record<string, unknown>) => ({
        status: 0,
        stdout: "new-container-id\n",
      }),
    );
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "phase: Provisioning" }));

    const result = recreateOpenShellDockerSandboxWithGpu(
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        waitForSupervisor: false,
        openshellSandboxCommand: ["env", "CHAT_UI_URL=http://127.0.0.1:8642", "nemoclaw-start"],
      },
      {
        dockerCapture,
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm,
        runOpenshell,
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
        detectSandboxFallbackDns: vi.fn(() => null),
      },
    );

    expect(result.newContainerId).toBe("new-container-id");
    expect(result.backupRemoved).toBe(false);
    expect(result.originalName).toBe("openshell-alpha");
    expect(result.backupContainerName).toContain("nemoclaw-gpu-backup");
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
    const cloneArgs = dockerRunDetached.mock.calls[0]?.[0] ?? [];
    expect(cloneArgs).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
        `sha256:${"c".repeat(64)}`,
      ]),
    );
    expect(cloneArgs.slice(cloneArgs.indexOf(`sha256:${"c".repeat(64)}`))).toEqual([
      `sha256:${"c".repeat(64)}`,
    ]);
    expect(dockerRunDetached).toHaveBeenCalledWith(
      cloneArgs,
      expect.objectContaining({ ignoreError: true }),
    );
  });
});
