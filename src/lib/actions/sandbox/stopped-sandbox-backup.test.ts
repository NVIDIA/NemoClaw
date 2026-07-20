// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { BackupResult } from "../../state/sandbox";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
  listSandboxes: vi.fn(),
}));
vi.mock("../../state/sandbox", () => ({
  backupSandboxState: vi.fn(),
}));

import {
  backupStartedSandboxState,
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
  const ok: BackupResult = {
    success: true,
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
  };
  const unreachable: BackupResult = { ...ok, success: false, unreachable: true };
  const denied: BackupResult = { ...ok, success: false };

  it("retries while the just-started container's SSH endpoint is unreachable (#6500)", async () => {
    const first = deferred<BackupResult>();
    const second = deferred<BackupResult>();
    const third = deferred<BackupResult>();
    const backup = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const resultPromise = backupStartedSandboxState("my-sb", {
      backup,
      sleep,
      attempts: 5,
      delayMs: 1,
    });

    expect(backup).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    first.resolve(unreachable);
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(2));
    expect(sleep).toHaveBeenCalledTimes(1);
    second.resolve(unreachable);
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(3));
    expect(sleep).toHaveBeenCalledTimes(2);
    const settled = vi.fn();
    void resultPromise.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    third.resolve(ok);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns a non-transport failure without retrying", async () => {
    const pending = deferred<BackupResult>();
    const backup = vi.fn().mockReturnValue(pending.promise);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const resultPromise = backupStartedSandboxState("my-sb", {
      backup,
      sleep,
      attempts: 5,
      delayMs: 1,
    });

    const settled = vi.fn();
    void resultPromise.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    pending.resolve(denied);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the attempt budget while still unreachable", async () => {
    const first = deferred<BackupResult>();
    const second = deferred<BackupResult>();
    const third = deferred<BackupResult>();
    const backup = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const resultPromise = backupStartedSandboxState("my-sb", {
      backup,
      sleep,
      attempts: 3,
      delayMs: 1,
    });

    expect(backup).toHaveBeenCalledTimes(1);
    first.resolve(unreachable);
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(2));
    second.resolve(unreachable);
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(3));
    const settled = vi.fn();
    void resultPromise.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    third.resolve(unreachable);

    const result = await resultPromise;
    expect(result.unreachable).toBe(true);
    expect(backup).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
