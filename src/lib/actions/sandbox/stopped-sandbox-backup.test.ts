// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  providerCapture: vi.fn(),
  backupWithAuthority: vi.fn(),
  probeSsh: vi.fn(),
  startSandbox: vi.fn(),
  stopSandbox: vi.fn(),
}));

vi.mock("../../adapters/openshell/sandbox-lifecycle-sdk", () => ({
  createSdkOpenShellSandboxStateLifecycle: () => ({
    startSandbox: adapterMocks.startSandbox,
    stopSandbox: adapterMocks.stopSandbox,
  }),
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
  probeSandboxSshReachable: (...args: unknown[]) => adapterMocks.probeSsh(...args),
}));
vi.mock("./snapshot/backup-authority", () => ({
  backupSandboxStateWithManagedAuthority: (name: string, options: unknown) =>
    adapterMocks.backupWithAuthority(name, options),
}));

import * as registry from "../../state/registry";
import {
  backupStartedSandboxState,
  isSandboxContainerDefinitivelyAbsent,
  returnSandboxContainerToStopped,
  startedSandboxBackupTransactionDeadline,
  startStoppedSandboxContainerForBackup,
} from "./stopped-sandbox-backup";

function lifecycleEngine(runtimeProviderId = "docker") {
  return { runtimeProviderId, mutationTimeoutMs: 30_000, capture: vi.fn() };
}

describe("startStoppedSandboxContainerForBackup", () => {
  beforeEach(() => {
    adapterMocks.providerCapture.mockReset();
    adapterMocks.startSandbox.mockReset();
    vi.mocked(registry.getSandbox).mockReset();
    vi.mocked(registry.listSandboxes).mockReset();
  });

  const deps = (over: Record<string, unknown> = {}) => {
    const engine = lifecycleEngine();
    return {
      getSandbox: vi.fn().mockReturnValue({
        gatewayName: "nemoclaw",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        openshellDriver: "docker",
      }),
      listSandboxNames: vi.fn().mockReturnValue(["my-sb"]),
      resolveLifecycleEngine: vi.fn().mockReturnValue(engine),
      listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-my-sb-abc123"]),
      inspectStatus: vi.fn().mockReturnValue("exited"),
      createOpenShellLifecycle: vi.fn().mockReturnValue({
        startSandbox: vi.fn().mockResolvedValue({ kind: "accepted" }),
        stopSandbox: vi.fn(),
      }),
      ...over,
    };
  };

  it("starts an exited provider-owned container through exact-identity OpenShell", async () => {
    const d = deps();
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toEqual({
      containerName: "openshell-my-sb-abc123",
      gatewayName: "nemoclaw",
      mutationTimeoutMs: 30_000,
      runtimeProviderId: "docker",
      sandboxIdentityFingerprint: "a".repeat(64),
      sandboxName: "my-sb",
    });
    expect(d.createOpenShellLifecycle().startSandbox).toHaveBeenCalledWith({
      sandboxName: "my-sb",
      sandboxIdentityFingerprint: "a".repeat(64),
      target: { kind: "named", gatewayName: "nemoclaw" },
      timeoutMs: 30_000,
    });
    expect(d.resolveLifecycleEngine().capture).not.toHaveBeenCalledWith(
      expect.arrayContaining(["start"]),
      expect.anything(),
    );
  });

  it("bounds the start operation by the shared transaction deadline", async () => {
    const d = deps({
      deadlineMs: 20_000,
      now: () => 5_000,
    });

    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.not.toBeNull();

    expect(d.createOpenShellLifecycle().startSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 15_000,
      }),
    );
  });

  it("uses the same OpenShell lifecycle path for a registered Podman provider", async () => {
    const podmanEngine = lifecycleEngine("podman");
    const d = deps({
      getSandbox: vi.fn().mockReturnValue({
        gatewayName: "nemoclaw",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        openshellDriver: "podman",
      }),
      resolveLifecycleEngine: vi.fn().mockReturnValue(podmanEngine),
    });

    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toEqual({
      containerName: "openshell-my-sb-abc123",
      gatewayName: "nemoclaw",
      mutationTimeoutMs: 30_000,
      runtimeProviderId: "podman",
      sandboxIdentityFingerprint: "a".repeat(64),
      sandboxName: "my-sb",
    });
  });

  it("uses the default OpenShell lifecycle adapter without container start mutation", async () => {
    vi.mocked(registry.getSandbox).mockReturnValue({
      gatewayName: "nemoclaw",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      openshellDriver: "docker",
    } as ReturnType<typeof registry.getSandbox>);
    vi.mocked(registry.listSandboxes).mockReturnValue({
      sandboxes: [{ name: "my-sb" }],
      defaultSandbox: null,
    });
    adapterMocks.providerCapture.mockImplementation(
      (_operation: string, args: readonly string[]) => ({
        status: 0,
        stdout: args[0] === "ps" ? "openshell-my-sb-abc123\n" : "exited\n",
        stderr: "",
      }),
    );
    adapterMocks.startSandbox.mockResolvedValueOnce({ kind: "accepted" });

    await expect(startStoppedSandboxContainerForBackup("my-sb")).resolves.toMatchObject({
      containerName: "openshell-my-sb-abc123",
      sandboxName: "my-sb",
    });
    expect(adapterMocks.startSandbox).toHaveBeenCalledOnce();
    expect(
      adapterMocks.providerCapture.mock.calls.some(
        ([, args]) => Array.isArray(args) && (args[0] === "start" || args[0] === "stop"),
      ),
    ).toBe(false);
  });

  it("refuses lifecycle mutation without immutable sandbox identity", async () => {
    const d = deps({
      getSandbox: vi.fn().mockReturnValue({
        gatewayName: "nemoclaw",
        lifecycleLiveIdentityFingerprint: null,
        openshellDriver: "docker",
      }),
    });

    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.resolveLifecycleEngine).not.toHaveBeenCalled();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("excludes created pending registrations from container ownership (#9733)", async () => {
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

    await expect(startStoppedSandboxContainerForBackup("my", d)).resolves.toEqual({
      containerName: "openshell-my-assistant-12ab",
      gatewayName: "nemoclaw",
      mutationTimeoutMs: 30_000,
      runtimeProviderId: "docker",
      sandboxIdentityFingerprint: "a".repeat(64),
      sandboxName: "my",
    });
  });

  it("starts a created container (onboarded but never run)", async () => {
    const d = deps({ inspectStatus: vi.fn().mockReturnValue("created") });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.not.toBeNull();
  });

  it("leaves providers without a container lifecycle engine alone", async () => {
    const d = deps({ resolveLifecycleEngine: vi.fn().mockReturnValue(null) });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.listLabeledContainerNames).not.toHaveBeenCalled();
  });

  it("returns null when no labeled container owns the sandbox name", async () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue([]) });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("refuses ambiguous labeled containers", async () => {
    const d = deps({
      listLabeledContainerNames: vi
        .fn()
        .mockReturnValue(["openshell-my-sb-old", "openshell-my-sb-new"]),
    });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.inspectStatus).not.toHaveBeenCalled();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("refuses a labeled container whose name does not belong to the sandbox", async () => {
    const d = deps({ listLabeledContainerNames: vi.fn().mockReturnValue(["openshell-other-x"]) });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("leaves GPU recovery backup siblings to the dedicated recovery flow", async () => {
    const d = deps({
      listLabeledContainerNames: vi
        .fn()
        .mockReturnValue(["openshell-my-sb-nemoclaw-gpu-backup-123"]),
    });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("leaves a running-but-not-Ready container alone (crash loop, gateway drift)", async () => {
    const d = deps({ inspectStatus: vi.fn().mockReturnValue("running") });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("leaves a paused container alone (#4495)", async () => {
    const d = deps({ inspectStatus: vi.fn().mockReturnValue("paused") });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
    expect(d.createOpenShellLifecycle).not.toHaveBeenCalled();
  });

  it("returns null when the OpenShell start operation fails", async () => {
    const d = deps({
      createOpenShellLifecycle: vi.fn().mockReturnValue({
        startSandbox: vi.fn().mockResolvedValue({
          kind: "failed",
          error: { kind: "timeout", message: "OpenShell timed out." },
        }),
        stopSandbox: vi.fn(),
      }),
    });
    await expect(startStoppedSandboxContainerForBackup("my-sb", d)).resolves.toBeNull();
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
  beforeEach(() => {
    adapterMocks.providerCapture.mockReset();
    adapterMocks.stopSandbox.mockReset();
  });

  const started = {
    containerName: "openshell-my-sb-abc123",
    gatewayName: "nemoclaw",
    mutationTimeoutMs: 75_000,
    runtimeProviderId: "podman",
    sandboxIdentityFingerprint: "a".repeat(64),
    sandboxName: "my-sb",
  };

  it("uses the recorded exact identity and confirms OpenShell stopped the sandbox", async () => {
    const stopSandbox = vi.fn().mockResolvedValue({ kind: "accepted" });
    await expect(
      returnSandboxContainerToStopped(started, {
        createOpenShellLifecycle: () => ({ startSandbox: vi.fn(), stopSandbox }),
      }),
    ).resolves.toBe(true);
    expect(stopSandbox).toHaveBeenCalledWith({
      sandboxName: "my-sb",
      sandboxIdentityFingerprint: "a".repeat(64),
      target: { kind: "named", gatewayName: "nemoclaw" },
      timeoutMs: 75_000,
    });
  });

  it("uses the OpenShell lifecycle adapter without direct container mutation", async () => {
    adapterMocks.stopSandbox.mockResolvedValueOnce({ kind: "accepted" });

    await expect(returnSandboxContainerToStopped(started)).resolves.toBe(true);
    expect(adapterMocks.stopSandbox).toHaveBeenCalledOnce();
    expect(adapterMocks.providerCapture).not.toHaveBeenCalled();
  });

  it("reports failure when the OpenShell stop operation fails", async () => {
    const stopSandbox = vi.fn().mockResolvedValue({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell timed out." },
    });
    await expect(
      returnSandboxContainerToStopped(started, {
        createOpenShellLifecycle: () => ({ startSandbox: vi.fn(), stopSandbox }),
      }),
    ).resolves.toBe(false);
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
  const denied = { ...ok, success: false };

  beforeEach(() => {
    adapterMocks.backupWithAuthority.mockReset();
    adapterMocks.probeSsh.mockReset();
  });

  it("uses managed provider authority through the default stopped-backup path", async () => {
    adapterMocks.probeSsh.mockReturnValueOnce(true);
    adapterMocks.backupWithAuthority.mockReturnValueOnce(ok);

    await expect(backupStartedSandboxState("my-sb")).resolves.toEqual(ok);

    expect(adapterMocks.backupWithAuthority).toHaveBeenCalledWith("my-sb", {
      deadlineMs: expect.any(Number),
    });
  });

  it("retries while the just-started container's SSH endpoint is unreachable (#6500)", async () => {
    let now = 0;
    const probe = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const backup = vi.fn().mockReturnValue(ok);
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const result = await backupStartedSandboxState("my-sb", {
      backup,
      probe,
      sleep,
      delayMs: 1,
      now: () => now,
    });
    expect(result.success).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("allows managed startup to exceed the legacy eight-second readiness window (#9356)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    adapterMocks.probeSsh
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    adapterMocks.backupWithAuthority.mockReturnValueOnce(ok);

    const pending = backupStartedSandboxState("my-sb");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(ok);
    expect(adapterMocks.probeSsh).toHaveBeenCalledTimes(7);
    expect(adapterMocks.backupWithAuthority).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("waits beyond the former ninety-second SSH readiness boundary (#11936)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    adapterMocks.probeSsh.mockImplementation(() => adapterMocks.probeSsh.mock.calls.length > 46);
    adapterMocks.backupWithAuthority.mockReturnValueOnce(ok);

    const pending = backupStartedSandboxState("my-sb");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(ok);
    expect(adapterMocks.probeSsh).toHaveBeenCalledTimes(47);
    expect(adapterMocks.backupWithAuthority).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("returns a non-transport failure without retrying", async () => {
    const probe = vi.fn().mockReturnValue(true);
    const backup = vi.fn().mockReturnValue(denied);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await backupStartedSandboxState("my-sb", {
      backup,
      probe,
      sleep,
      delayMs: 1,
    });
    expect(result.success).toBe(false);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops the default readiness probes at the transaction bound (#11936)", async () => {
    let now = 0;
    adapterMocks.probeSsh.mockReturnValue(false);
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const result = await backupStartedSandboxState("my-sb", {
      sleep,
      now: () => now,
    });

    expect(result.unreachable).toBe(true);
    expect(adapterMocks.probeSsh).toHaveBeenCalledTimes(90);
    expect(sleep).toHaveBeenCalledTimes(90);
    expect(adapterMocks.backupWithAuthority).not.toHaveBeenCalled();
  });

  it("reserves final backup and stopped-state cleanup near the readiness deadline (#11936)", async () => {
    let now = 179_999;
    const transactionDeadlineMs = startedSandboxBackupTransactionDeadline(() => 0);
    const backup = vi.fn((_name: string, deadlineMs: number) => {
      expect(deadlineMs).toBe(300_000);
      now = deadlineMs;
      return ok;
    });

    await expect(
      backupStartedSandboxState("my-sb", {
        backup,
        probe: vi.fn().mockReturnValue(true),
        deadlineMs: transactionDeadlineMs,
        now: () => now,
      }),
    ).resolves.toEqual(ok);

    const stopSandbox = vi.fn().mockImplementation(async ({ timeoutMs }: { timeoutMs: number }) => {
      now += timeoutMs;
      return { kind: "accepted" };
    });
    await expect(
      returnSandboxContainerToStopped(
        {
          containerName: "openshell-my-sb-abc123",
          gatewayName: "nemoclaw",
          mutationTimeoutMs: 75_000,
          runtimeProviderId: "podman",
          sandboxIdentityFingerprint: "a".repeat(64),
          sandboxName: "my-sb",
        },
        {
          createOpenShellLifecycle: () => ({ startSandbox: vi.fn(), stopSandbox }),
          deadlineMs: transactionDeadlineMs,
          now: () => now,
        },
      ),
    ).resolves.toBe(true);
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 30_000,
      }),
    );
    expect(now).toBe(transactionDeadlineMs);
  });

  it("keeps the full stop reserve when extraction and sanitization reach the backup deadline", async () => {
    const transactionDeadlineMs = startedSandboxBackupTransactionDeadline(() => 0);
    const backupDeadlineMs = transactionDeadlineMs - 30_000;
    let now = backupDeadlineMs - 120_001;
    const extract = vi.fn(() => {
      now = backupDeadlineMs - 1;
    });
    const sanitize = vi.fn(() => {
      now += 1;
    });
    const backup = vi.fn(() => {
      extract();
      sanitize();
      return ok;
    });

    await expect(
      backupStartedSandboxState("my-sb", {
        backup,
        probe: vi.fn().mockReturnValue(true),
        deadlineMs: transactionDeadlineMs,
        now: () => now,
      }),
    ).resolves.toEqual(ok);
    expect(extract).toHaveBeenCalledOnce();
    expect(sanitize).toHaveBeenCalledOnce();
    expect(now).toBe(backupDeadlineMs);

    const stopSandbox = vi.fn().mockResolvedValue({ kind: "accepted" });
    await expect(
      returnSandboxContainerToStopped(
        {
          containerName: "openshell-my-sb-abc123",
          gatewayName: "nemoclaw",
          mutationTimeoutMs: 75_000,
          runtimeProviderId: "podman",
          sandboxIdentityFingerprint: "a".repeat(64),
          sandboxName: "my-sb",
        },
        {
          createOpenShellLifecycle: () => ({ startSandbox: vi.fn(), stopSandbox }),
          deadlineMs: transactionDeadlineMs,
          now: () => now,
        },
      ),
    ).resolves.toBe(true);
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 30_000,
      }),
    );
  });
});
