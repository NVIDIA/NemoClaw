// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  dockerRun: vi.fn(),
  dockerCapture: vi.fn(),
}));

vi.mock("../../adapters/docker/run", () => ({
  dockerRun: adapterMocks.dockerRun,
  dockerCapture: adapterMocks.dockerCapture,
}));
vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
  listSandboxes: vi.fn(),
}));
vi.mock("../../state/sandbox", () => ({
  backupSandboxState: vi.fn(),
}));

import * as registry from "../../state/registry";
import {
  backupStartedSandboxState,
  isSandboxContainerDefinitivelyAbsent,
  returnSandboxContainerToStopped,
  startStoppedSandboxContainerForBackup,
} from "./stopped-sandbox-backup";

describe("startStoppedSandboxContainerForBackup", () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    getSandboxDriver: vi.fn().mockReturnValue("docker"),
    listSandboxNames: vi.fn().mockReturnValue(["my-sb"]),
    listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-my-sb-abc123"]),
    dockerInspectStatus: vi.fn().mockReturnValue("exited"),
    dockerStart: vi.fn().mockReturnValue("openshell-my-sb-abc123"),
    ...over,
  });

  it("starts an exited docker-driver container and reports its name", () => {
    const d = deps();
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toEqual({
      containerName: "openshell-my-sb-abc123",
    });
    expect(d.dockerStart).toHaveBeenCalledWith("openshell-my-sb-abc123");
  });

  it("starts a created container (onboarded but never run)", () => {
    const d = deps({ dockerInspectStatus: vi.fn().mockReturnValue("created") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).not.toBeNull();
  });

  it("leaves non-docker-driver sandboxes alone", () => {
    const d = deps({ getSandboxDriver: vi.fn().mockReturnValue("kubernetes") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.listLabeledContainerNames).not.toHaveBeenCalled();
  });

  it("returns null when no labeled container owns the sandbox name", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue([]) });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.dockerStart).not.toHaveBeenCalled();
  });

  it("refuses ambiguous labeled containers", () => {
    const d = deps({
      listLabeledContainerNames: vi
        .fn()
        .mockReturnValue(["openshell-my-sb-old", "openshell-my-sb-new"]),
    });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.dockerInspectStatus).not.toHaveBeenCalled();
    expect(d.dockerStart).not.toHaveBeenCalled();
  });

  it("refuses a labeled container whose name does not belong to the sandbox", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-other-x"]) });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.dockerStart).not.toHaveBeenCalled();
  });

  it("leaves GPU recovery backup siblings to the dedicated recovery flow", () => {
    const d = deps({
      listLabeledContainerNames: vi
        .fn()
        .mockReturnValue(["openshell-my-sb-nemoclaw-gpu-backup-123"]),
    });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.dockerStart).not.toHaveBeenCalled();
  });

  it("leaves a running-but-not-Ready container alone (crash loop, gateway drift)", () => {
    const d = deps({ dockerInspectStatus: vi.fn().mockReturnValue("running") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.dockerStart).not.toHaveBeenCalled();
  });

  it("leaves a paused container alone (#4495)", () => {
    const d = deps({ dockerInspectStatus: vi.fn().mockReturnValue("paused") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.dockerStart).not.toHaveBeenCalled();
  });

  it("returns null when docker start fails", () => {
    const d = deps({ dockerStart: vi.fn().mockReturnValue("") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
  });
});

describe("isSandboxContainerDefinitivelyAbsent (#6520)", () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    getSandboxDriver: vi.fn().mockReturnValue("docker"),
    listLabeledContainerNames: vi.fn().mockReturnValue([]),
    ...over,
  });

  it("reports absent when a successful labeled listing shows zero containers", () => {
    expect(isSandboxContainerDefinitivelyAbsent("my-sb", deps())).toBe(true);
  });

  it("reports present when a labeled container still exists", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-my-sb-abc"]) });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb", d)).toBe(false);
  });

  it("fails closed for non-docker-driver sandboxes", () => {
    const d = deps({ getSandboxDriver: vi.fn().mockReturnValue("kubernetes") });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb", d)).toBe(false);
    expect(d.listLabeledContainerNames).not.toHaveBeenCalled();
  });

  it("fails closed when the labeled listing itself fails (a swallowed ps error is not absence)", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue(null) });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb", d)).toBe(false);
  });

  it("fails closed when the registry read behind the driver gate throws", () => {
    vi.mocked(registry.getSandbox).mockImplementation(() => {
      throw new Error("corrupt sandboxes.json");
    });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(false);
    expect(adapterMocks.dockerRun).not.toHaveBeenCalled();
  });

  it("status-checks the default listing with ignoreError so a dead daemon fails closed, not the process", () => {
    // runner.run() calls process.exit on a non-zero status unless ignoreError
    // is set, and a swallowed listing error must never read as "absent": a
    // failed `docker ps` has to surface as false, not as an exit and not as
    // an empty listing.
    vi.mocked(registry.getSandbox).mockReturnValue({
      openshellDriver: "docker",
    } as unknown as ReturnType<typeof registry.getSandbox>);
    adapterMocks.dockerRun.mockReturnValue({ status: 1, stdout: "" });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(false);
    expect(adapterMocks.dockerRun).toHaveBeenCalledWith(
      expect.arrayContaining(["ps", "-a", "--filter", "label=openshell.ai/sandbox-name=my-sb"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("reports absent through the default wiring when the listing succeeds empty", () => {
    vi.mocked(registry.getSandbox).mockReturnValue({
      openshellDriver: "docker",
    } as unknown as ReturnType<typeof registry.getSandbox>);
    adapterMocks.dockerRun.mockReturnValue({ status: 0, stdout: "\n" });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(true);
  });

  it("reports present through the default wiring when the listing returns a container", () => {
    vi.mocked(registry.getSandbox).mockReturnValue({
      openshellDriver: "docker",
    } as unknown as ReturnType<typeof registry.getSandbox>);
    adapterMocks.dockerRun.mockReturnValue({ status: 0, stdout: "openshell-my-sb-abc\n" });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(false);
  });
});

describe("returnSandboxContainerToStopped", () => {
  it("reports success when docker stop echoes the name and inspect confirms exited", () => {
    const dockerStop = vi.fn().mockReturnValue("openshell-my-sb-abc123");
    const dockerInspectStatus = vi.fn().mockReturnValue("exited");
    expect(
      returnSandboxContainerToStopped("openshell-my-sb-abc123", {
        dockerStop,
        dockerInspectStatus,
      }),
    ).toBe(true);
    expect(dockerStop).toHaveBeenCalledWith("openshell-my-sb-abc123");
    expect(dockerInspectStatus).toHaveBeenCalledWith("openshell-my-sb-abc123");
  });

  it("reports failure when docker stop produces no output", () => {
    const dockerStop = vi.fn().mockReturnValue("");
    const dockerInspectStatus = vi.fn();
    expect(
      returnSandboxContainerToStopped("openshell-my-sb-abc123", {
        dockerStop,
        dockerInspectStatus,
      }),
    ).toBe(false);
    expect(dockerInspectStatus).not.toHaveBeenCalled();
  });

  it("reports failure when the container is still running after docker stop", () => {
    const dockerStop = vi.fn().mockReturnValue("openshell-my-sb-abc123");
    const dockerInspectStatus = vi.fn().mockReturnValue("running");
    expect(
      returnSandboxContainerToStopped("openshell-my-sb-abc123", {
        dockerStop,
        dockerInspectStatus,
      }),
    ).toBe(false);
  });
});

describe("backupStartedSandboxState", () => {
  const ok = {
    success: true,
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
  };
  const unreachable = { ...ok, success: false, unreachable: true };
  const denied = { ...ok, success: false };

  it("retries while the just-started container's SSH endpoint is unreachable (#6500)", async () => {
    const backup = vi
      .fn()
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(ok);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await backupStartedSandboxState("my-sb", {
      backup,
      sleep,
      attempts: 5,
      delayMs: 1,
    });
    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns a non-transport failure without retrying", async () => {
    const backup = vi.fn().mockReturnValue(denied);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await backupStartedSandboxState("my-sb", {
      backup,
      sleep,
      attempts: 5,
      delayMs: 1,
    });
    expect(result.success).toBe(false);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the attempt budget while still unreachable", async () => {
    const backup = vi.fn().mockReturnValue(unreachable);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await backupStartedSandboxState("my-sb", {
      backup,
      sleep,
      attempts: 3,
      delayMs: 1,
    });
    expect(result.unreachable).toBe(true);
    expect(backup).toHaveBeenCalledTimes(3);
  });
});
