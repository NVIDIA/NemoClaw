// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);
describe("runSandboxSnapshot restore: observability policy replay", () => {
  it.each([
    { enabled: true, expectedValue: "1" },
    { enabled: false, expectedValue: "0" },
  ])("starts a snapshot clone with the authoritative source observability state when enabled=$enabled", async ({
    enabled,
    expectedValue,
  }) => {
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    vi.stubEnv("NEMOCLAW_OBSERVABILITY", "1");
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "langchain-deepagents-code",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            observabilityEnabled: enabled,
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    const createCall = f.streamSandboxCreateMock.mock.calls[0] ?? [];
    const createArgs = createCall[1] as readonly string[];
    const createEnv = createCall[2] as NodeJS.ProcessEnv | undefined;
    expect(createCall[0]).toBe("openshell");
    expect(createArgs).toContain(`NEMOCLAW_OBSERVABILITY=${expectedValue}`);
    expect(createEnv?.NEMOCLAW_OBSERVABILITY).toBeUndefined();
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        observabilityEnabled: enabled,
      }),
    );
    expect(f.applyPresetMock).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it.each([
    { label: "recorded", policyPresets: ["npm"] },
    { label: "legacy", policyPresets: undefined },
  ])("adds built-in OTLP egress for a $label snapshot", async ({ policyPresets }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets });
    f.getAppliedPresetsMock.mockReturnValue(["npm"]);
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.removePresetMock).not.toHaveBeenCalled();
  });

  it("removes historical built-in OTLP egress when observability was disabled after the snapshot", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["npm", "observability-otlp-local"],
    });
    f.getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("removes an exact unrecorded built-in OTLP policy when observability is disabled", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, policyPresets: [] });
    f.getAppliedPresetsMock.mockReturnValue([]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      f.builtinObservabilityPolicy,
    );
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.updateSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "returns false",
      configureRemoval: () => f.removePresetMock.mockReturnValue(false),
    },
    {
      label: "throws",
      configureRemoval: () =>
        f.removePresetMock.mockImplementation(() => {
          throw new Error("remove exploded");
        }),
    },
    {
      label: "claims success without removing",
      configureRemoval: () => f.removePresetMock.mockReturnValue(true),
    },
  ])("retains built-in OTLP attribution when removal $label", async ({ configureRemoval }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: [],
    });
    f.getAppliedPresetsMock.mockReturnValue([]);
    f.getPresetContentGatewayStateMock.mockReturnValue("match");
    configureRemoval();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledTimes(2);
    expect(f.updateSandboxMock).toHaveBeenCalledWith("alpha", {
      policies: ["observability-otlp-local"],
    });
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "exact content still live after remove",
    );
  });
});
