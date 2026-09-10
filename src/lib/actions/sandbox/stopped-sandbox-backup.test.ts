// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  providerCapture: vi.fn(),
  backupWithAuthority: vi.fn(),
}));

vi.mock("../../onboard/runtime-provider/selection", () => ({
  resolveRegisteredRuntimeProvider: (providerId: string | null | undefined) => {
    const normalized = String(providerId).trim().toLowerCase();
    return {
      identity: { id: normalized },
      lifecycle: {
        supported: true,
        containerMutationTimeoutMs: normalized === "podman" ? 75_000 : 30_000,
      },
      containerEngine: {
        supported: true,
        identities: [
          { operation: "sandbox-lifecycle", engineId: normalized, displayName: normalized },
        ],
        capture: adapterMocks.providerCapture,
      },
    };
  },
}));
vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
  isPublishedSandboxRegistration: (entry: { pendingRouteReservation?: true }) =>
    entry.pendingRouteReservation !== true,
  listSandboxes: vi.fn(),
}));
vi.mock("../../state/sandbox", () => ({
  backupSandboxState: vi.fn(),
}));
vi.mock("./snapshot/backup-authority", () => ({
  backupSandboxStateWithManagedAuthority: (name: string) => adapterMocks.backupWithAuthority(name),
}));

import * as registry from "../../state/registry";
import {
  backupStartedSandboxState,
  isSandboxContainerDefinitivelyAbsent,
  returnSandboxContainerToStopped,
  startStoppedSandboxContainerForBackup,
} from "./stopped-sandbox-backup";

function lifecycleEngine(runtimeProviderId = "docker") {
  return { runtimeProviderId, mutationTimeoutMs: 30_000, capture: vi.fn() };
}

describe("startStoppedSandboxContainerForBackup", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const engine = lifecycleEngine();
    return {
      getSandboxDriver: vi.fn().mockReturnValue("docker"),
      listSandboxNames: vi.fn().mockReturnValue(["my-sb"]),
      resolveLifecycleEngine: vi.fn().mockReturnValue(engine),
      listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-my-sb-abc123"]),
      inspectStatus: vi.fn().mockReturnValue("exited"),
      start: vi.fn().mockReturnValue(true),
      ...over,
    };
  };

  it("starts an exited provider-owned container and records its provider", () => {
    const d = deps();
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toEqual({
      containerName: "openshell-my-sb-abc123",
      runtimeProviderId: "docker",
    });
    expect(d.start).toHaveBeenCalledWith(expect.any(Object), "openshell-my-sb-abc123");
  });

  it("uses the same lifecycle path for a registered Podman provider", () => {
    const podmanEngine = lifecycleEngine("podman");
    const d = deps({
      getSandboxDriver: vi.fn().mockReturnValue("podman"),
      resolveLifecycleEngine: vi.fn().mockReturnValue(podmanEngine),
    });

    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toEqual({
      containerName: "openshell-my-sb-abc123",
      runtimeProviderId: "podman",
    });
    expect(d.start).toHaveBeenCalledWith(podmanEngine, "openshell-my-sb-abc123");
  });

  it("excludes created pending registrations from container ownership (#9733)", () => {
    vi.mocked(registry.listSandboxes).mockReturnValue({
      sandboxes: [
        { name: "my" },
        {
          name: "my-assistant",
          pendingRouteReservation: true,
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      ],
      defaultSandbox: null,
    });
    const { listSandboxNames: _listSandboxNames, ...d } = deps({
      listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-my-assistant-12ab"]),
      inspectStatus: vi.fn().mockReturnValue("exited"),
    });

    expect(startStoppedSandboxContainerForBackup("my", d)).toEqual({
      containerName: "openshell-my-assistant-12ab",
      runtimeProviderId: "docker",
    });
  });

  it("starts a created container (onboarded but never run)", () => {
    const d = deps({ inspectStatus: vi.fn().mockReturnValue("created") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).not.toBeNull();
  });

  it("leaves providers without a container lifecycle engine alone", () => {
    const d = deps({ resolveLifecycleEngine: vi.fn().mockReturnValue(null) });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.listLabeledContainerNames).not.toHaveBeenCalled();
  });

  it("returns null when no labeled container owns the sandbox name", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue([]) });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("refuses ambiguous labeled containers", () => {
    const d = deps({
      listLabeledContainerNames: vi
        .fn()
        .mockReturnValue(["openshell-my-sb-old", "openshell-my-sb-new"]),
    });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.inspectStatus).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("refuses a labeled container whose name does not belong to the sandbox", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-other-x"]) });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("leaves GPU recovery backup siblings to the dedicated recovery flow", () => {
    const d = deps({
      listLabeledContainerNames: vi
        .fn()
        .mockReturnValue(["openshell-my-sb-nemoclaw-gpu-backup-123"]),
    });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("leaves a running-but-not-Ready container alone (crash loop, gateway drift)", () => {
    const d = deps({ inspectStatus: vi.fn().mockReturnValue("running") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("leaves a paused container alone (#4495)", () => {
    const d = deps({ inspectStatus: vi.fn().mockReturnValue("paused") });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("returns null when the provider start operation fails", () => {
    const d = deps({ start: vi.fn().mockReturnValue(false) });
    expect(startStoppedSandboxContainerForBackup("my-sb", d)).toBeNull();
  });
});

describe("isSandboxContainerDefinitivelyAbsent (#6520)", () => {
  beforeEach(() => {
    adapterMocks.providerCapture.mockReset();
    vi.mocked(registry.getSandbox).mockReset();
  });

  const deps = (over: Record<string, unknown> = {}) => {
    const engine = lifecycleEngine();
    return {
      getSandboxDriver: vi.fn().mockReturnValue("docker"),
      resolveLifecycleEngine: vi.fn().mockReturnValue(engine),
      listLabeledContainerNames: vi.fn().mockReturnValue([]),
      ...over,
    };
  };

  it("reports absent when a successful labeled listing shows zero containers", () => {
    expect(isSandboxContainerDefinitivelyAbsent("my-sb", deps())).toBe(true);
  });

  it("reports present when a labeled container still exists", () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-my-sb-abc"]) });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb", d)).toBe(false);
  });

  it("fails closed for providers without a container lifecycle engine", () => {
    const d = deps({ resolveLifecycleEngine: vi.fn().mockReturnValue(null) });
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
    expect(adapterMocks.providerCapture).not.toHaveBeenCalled();
  });

  it("fails closed when the provider listing command fails", () => {
    vi.mocked(registry.getSandbox).mockReturnValue({
      openshellDriver: "docker",
    } as unknown as ReturnType<typeof registry.getSandbox>);
    adapterMocks.providerCapture.mockReturnValue({ status: 1, stdout: "", stderr: "down" });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(false);
    expect(adapterMocks.providerCapture).toHaveBeenCalledWith(
      "sandbox-lifecycle",
      expect.arrayContaining(["ps", "-a", "--filter", "label=openshell.ai/sandbox-name=my-sb"]),
      5_000,
    );
  });

  it("reports absent through the default wiring when the listing succeeds empty", () => {
    vi.mocked(registry.getSandbox).mockReturnValue({
      openshellDriver: "docker",
    } as unknown as ReturnType<typeof registry.getSandbox>);
    adapterMocks.providerCapture.mockReturnValue({ status: 0, stdout: "\n", stderr: "" });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(true);
  });

  it("reports present through the default wiring when the listing returns a container", () => {
    vi.mocked(registry.getSandbox).mockReturnValue({
      openshellDriver: "docker",
    } as unknown as ReturnType<typeof registry.getSandbox>);
    adapterMocks.providerCapture.mockReturnValue({
      status: 0,
      stdout: "openshell-my-sb-abc\n",
      stderr: "",
    });
    expect(isSandboxContainerDefinitivelyAbsent("my-sb")).toBe(false);
  });
});

describe("returnSandboxContainerToStopped", () => {
  beforeEach(() => adapterMocks.providerCapture.mockReset());

  const started = {
    containerName: "openshell-my-sb-abc123",
    runtimeProviderId: "podman",
  };

  it("uses the recorded provider and confirms the container stopped", () => {
    const engine = lifecycleEngine("podman");
    const resolveLifecycleEngine = vi.fn().mockReturnValue(engine);
    const stop = vi.fn().mockReturnValue(true);
    const inspectStatus = vi.fn().mockReturnValue("exited");
    expect(
      returnSandboxContainerToStopped(started, {
        resolveLifecycleEngine,
        stop,
        inspectStatus,
      }),
    ).toBe(true);
    expect(resolveLifecycleEngine).toHaveBeenCalledWith("podman");
    expect(stop).toHaveBeenCalledWith(engine, "openshell-my-sb-abc123");
    expect(inspectStatus).toHaveBeenCalledWith(engine, "openshell-my-sb-abc123");
  });

  it("uses the Podman lifecycle timeout when restoring a stopped container", () => {
    adapterMocks.providerCapture
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "exited\n", stderr: "" });

    expect(returnSandboxContainerToStopped(started)).toBe(true);
    expect(adapterMocks.providerCapture).toHaveBeenNthCalledWith(
      1,
      "sandbox-lifecycle",
      ["stop", "openshell-my-sb-abc123"],
      75_000,
    );
  });

  it("reports failure when the provider stop operation fails", () => {
    const engine = lifecycleEngine("podman");
    const stop = vi.fn().mockReturnValue(false);
    const inspectStatus = vi.fn();
    expect(
      returnSandboxContainerToStopped(started, {
        resolveLifecycleEngine: vi.fn().mockReturnValue(engine),
        stop,
        inspectStatus,
      }),
    ).toBe(false);
    expect(inspectStatus).not.toHaveBeenCalled();
  });

  it("reports failure when the container is still running after stop", () => {
    const engine = lifecycleEngine("podman");
    expect(
      returnSandboxContainerToStopped(started, {
        resolveLifecycleEngine: vi.fn().mockReturnValue(engine),
        stop: vi.fn().mockReturnValue(true),
        inspectStatus: vi.fn().mockReturnValue("running"),
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

  it("uses managed provider authority through the default stopped-backup path", async () => {
    adapterMocks.backupWithAuthority.mockReturnValueOnce(ok);

    await expect(backupStartedSandboxState("my-sb")).resolves.toEqual(ok);

    expect(adapterMocks.backupWithAuthority).toHaveBeenCalledWith("my-sb");
  });

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

  it("allows managed startup to exceed the legacy eight-second readiness window (#9356)", async () => {
    vi.useFakeTimers();
    adapterMocks.backupWithAuthority
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(ok);

    const pending = backupStartedSandboxState("my-sb");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(ok);
    expect(adapterMocks.backupWithAuthority).toHaveBeenCalledTimes(7);
    vi.useRealTimers();
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
