// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createPodmanOpenShellWatcherController,
  type PodmanManagedSandboxRecreateTransaction,
} from "../compute/podman/sandbox-recreate";
import type { PodmanManagedStartupTransaction } from "../managed-startup/podman-root-apply";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { createPodmanSandboxCreatePatch } from "./podman";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";
const SOCKET_AUTHORITY = {
  directoryChain: [
    {
      device: "8",
      inode: "7000",
      mode: "448",
      ownerUid: "1000",
      path: "/run/user/1000/podman",
    },
  ],
  device: "8",
  inode: "9001",
  ownerUid: "1000",
  socketPath: SOCKET_PATH,
} as const;
const CONTAINER_ID = "b".repeat(64);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;

function watcherController() {
  return createPodmanOpenShellWatcherController({
    assertStopped: vi.fn(),
    resumeAndProve: vi.fn(),
    stopAndProve: vi.fn(() => ({ stopped: true })),
  });
}

function recreation(): PodmanManagedSandboxRecreateTransaction {
  return {
    applied: true,
    driverName: "podman",
    immutableImage: IMAGE_ID,
    newContainerId: CONTAINER_ID,
    socketAuthority: SOCKET_AUTHORITY,
    socketPath: SOCKET_PATH,
  } as unknown as PodmanManagedSandboxRecreateTransaction;
}

function request(agent: ManagedStartupRootApplyRequest["agent"]): ManagedStartupRootApplyRequest {
  return { agent } as ManagedStartupRootApplyRequest;
}

function managedStartup(
  agent: ManagedStartupRootApplyRequest["agent"],
): PodmanManagedStartupTransaction {
  return {
    agent,
    containerId: CONTAINER_ID,
    image: IMAGE_ID,
    runtime: {
      fingerprint: "f".repeat(64),
      socketAuthority: SOCKET_AUTHORITY,
      socketPath: SOCKET_PATH,
    },
  };
}

function patchHarness(agent: ManagedStartupRootApplyRequest["agent"]) {
  const events: string[] = [];
  const transaction = recreation();
  const rootTransaction = managedStartup(agent);
  const fail = vi.fn();
  const applyRoot = vi.fn(() => {
    events.push(`root:${agent}`);
    return rootTransaction;
  });
  const recreate = vi.fn(() => {
    events.push("recreate");
    return transaction;
  });
  const waitForSupervisor = vi.fn(() => {
    events.push("wait");
    return true;
  });
  const finalizeSharedState = vi.fn((input) => {
    events.push(`shared:${String(input.supervisorReady)}`);
    return { failure: null, supervisorReady: input.supervisorReady };
  });
  const finalizeRecreation = vi.fn((input) => {
    events.push(`container:${String(input.replacementReady)}`);
    return input.replacementReady
      ? { backupRemoved: true, rolledBack: false }
      : { backupRemoved: false, rolledBack: true };
  });
  const assertSocketAuthority = vi.fn();
  const patch = createPodmanSandboxCreatePatch({
    managedStartupRootApplyRequest: request(agent),
    openshellSandboxCommand: ["/usr/local/bin/node", "/agent/start.js"],
    persistStartupCommand: true,
    sandboxName: "alpha",
    socketAuthority: SOCKET_AUTHORITY,
    socketPath: SOCKET_PATH,
    timeoutSecs: 60,
    watcherController: watcherController(),
    deps: {
      runCaptureOpenshell: vi.fn(() => ""),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      sleep: vi.fn(),
      assertSocketAuthority,
    },
    overrides: {
      applyRoot,
      fail,
      finalizeRecreation,
      finalizeSharedState,
      findContainerIds: vi.fn(() => ["a".repeat(64)]),
      recreate,
      waitForSupervisor,
    },
  });
  return {
    applyRoot,
    assertSocketAuthority,
    events,
    fail,
    finalizeRecreation,
    finalizeSharedState,
    patch,
    rootTransaction,
    transaction,
    waitForSupervisor,
  };
}

describe("Podman sandbox-create runtime patch", () => {
  it("revalidates its exact socket authority at an external mutation edge", () => {
    const harness = patchHarness("openclaw");
    harness.patch.revalidateBeforeMutation();
    expect(harness.assertSocketAuthority).toHaveBeenCalledExactlyOnceWith(SOCKET_AUTHORITY);
    expect(harness.events).toEqual([]);
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("commits %s only after recreation, root apply, and reconnect", (agent) => {
    const harness = patchHarness(agent);

    harness.patch.maybeApplyDuringCreate();
    harness.patch.exitOnPatchError();
    harness.patch.waitForSupervisorReconnectIfNeeded();
    harness.patch.commitAfterReady();

    expect(harness.events).toEqual([
      "recreate",
      `root:${agent}`,
      "wait",
      "shared:true",
      "container:true",
    ]);
    expect(harness.finalizeSharedState).toHaveBeenCalledWith(
      {
        containerRollbackAuthority: harness.transaction,
        supervisorReady: true,
        transaction: harness.rootTransaction,
      },
      expect.objectContaining({ socketAuthority: SOCKET_AUTHORITY }),
    );
    expect(harness.fail).not.toHaveBeenCalled();
  });

  it("rolls shared state back before restoring the original container", () => {
    const harness = patchHarness("hermes");
    harness.patch.maybeApplyDuringCreate();

    harness.patch.rollbackManagedStartupAfterCreateFailure();

    expect(harness.events).toEqual(["recreate", "root:hermes", "shared:false", "container:false"]);
    expect(harness.fail).not.toHaveBeenCalled();
  });

  it("uses the driver-neutral reconnect budget without Docker policy imports", () => {
    const harness = patchHarness("openclaw");
    harness.patch.maybeApplyDuringCreate();

    harness.patch.waitForSupervisorReconnectIfNeeded();

    expect(harness.waitForSupervisor).toHaveBeenCalledWith(
      "alpha",
      900,
      expect.objectContaining({
        runCaptureOpenshell: expect.any(Function),
        runOpenshell: expect.any(Function),
        sleep: expect.any(Function),
      }),
    );
  });

  it("refuses ambiguous discovery without starting a recreation", () => {
    const fail = vi.fn();
    const recreate = vi.fn();
    const patch = createPodmanSandboxCreatePatch({
      openshellSandboxCommand: ["node", "agent.js"],
      persistStartupCommand: true,
      sandboxName: "alpha",
      socketAuthority: SOCKET_AUTHORITY,
      socketPath: SOCKET_PATH,
      timeoutSecs: 60,
      watcherController: watcherController(),
      deps: {
        runCaptureOpenshell: vi.fn(() => ""),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        assertSocketAuthority: vi.fn(),
      },
      overrides: {
        fail,
        findContainerIds: vi.fn(() => ["a".repeat(64), "b".repeat(64)]),
        recreate,
      },
    });

    patch.maybeApplyDuringCreate();
    expect(patch.createFailureMessage()).toContain("Podman managed startup failed");
    patch.exitOnPatchError();

    expect(recreate).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("alpha", expect.objectContaining({ name: "Error" }));
  });

  it("rolls back instead of committing before supervisor reconnect", () => {
    const harness = patchHarness("langchain-deepagents-code");
    harness.patch.maybeApplyDuringCreate();

    harness.patch.commitAfterReady();

    expect(harness.events).toEqual([
      "recreate",
      "root:langchain-deepagents-code",
      "shared:false",
      "container:false",
    ]);
    expect(harness.fail).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ message: expect.stringContaining("before supervisor reconnect") }),
    );
  });

  it("rolls back both transactions when shared-state commit throws", () => {
    const harness = patchHarness("hermes");
    harness.finalizeSharedState.mockImplementationOnce((input) => {
      harness.events.push(`shared:${String(input.supervisorReady)}`);
      throw new Error("shared-state commit crashed");
    });
    harness.patch.maybeApplyDuringCreate();
    harness.patch.waitForSupervisorReconnectIfNeeded();

    harness.patch.commitAfterReady();

    expect(harness.events).toEqual([
      "recreate",
      "root:hermes",
      "wait",
      "shared:true",
      "shared:false",
      "container:false",
    ]);
    expect(harness.fail).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ message: "shared-state commit crashed" }),
    );
  });
});
