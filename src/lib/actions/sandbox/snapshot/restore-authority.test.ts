// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import type { OpenShellDockerSandboxRuntimeSnapshotQuery } from "../../../onboard/openshell-docker-sandbox-containers";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedProfileRestoreAuthority,
  RuntimeProviderRuntimeReceipt,
  RuntimeProviderSnapshotSurface,
} from "../../../onboard/runtime-provider/contract";
import { createDockerRuntimeProviderBundle } from "../../../onboard/runtime-provider/docker";
import { createRuntimeProviderSnapshotSurface } from "../../../onboard/runtime-provider/snapshot";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
} from "../../../state/sandbox";
import { captureSandboxRuntimeSnapshot } from "./provider-lifecycle";
import { restoreRecreatedSandboxStateWithManagedAuthority } from "./restore-authority";

function workload(
  agent: ShippedManagedImageAgent,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(agent));
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.88",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function runtimeSnapshot() {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    providerHandle: "opaque-preflight",
    lifecycleState: "running",
    lifecycleGeneration: "generation-1",
    runtime: {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "session", handle: "session-1" },
      acceleration: { kind: "none" },
    },
  } as const;
}

function manifest(agent: ShippedManagedImageAgent): RebuildManifest {
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-07-31T00-00-00-000Z",
    agentType: agent,
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox",
    backupPath: "/tmp/alpha",
    blueprintDigest: null,
    workload: workload(agent),
    runtimeSnapshot: runtimeSnapshot(),
  };
}

function sandbox(
  agent: ShippedManagedImageAgent,
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  const receipt = workload(agent);
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    imageTag: receipt.reference,
    fromDockerfile: null,
    workload: receipt,
    ...overrides,
  };
}

function retainedDockerSnapshot(
  target: SandboxEntry,
  acceleration: RuntimeProviderRuntimeReceipt["acceleration"],
) {
  const source = createRuntimeProviderSnapshotSurface("docker", {
    observe: () => ({
      lifecycleState: "running",
      lifecycleGeneration: "retained-generation",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "c".repeat(64) },
        acceleration,
      },
    }),
    restoreManagedProfile: () => "unused-source-proof",
  });
  return captureSandboxRuntimeSnapshot(
    {
      identity: { contractVersion: 1, id: "docker", displayName: "Docker" },
      snapshot: source,
    } as RuntimeProviderBundle,
    target,
  );
}

function dockerRuntimeSnapshot(
  selection: "all" | "exact",
): Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }> {
  return {
    ok: true,
    imageId: `sha256:${"b".repeat(64)}`,
    bookkeepingImageRef: "managed@example",
    stateError: "",
    deviceRequests: [
      selection === "all"
        ? {
            Driver: "",
            Count: -1,
            DeviceIDs: null,
            Capabilities: [["gpu"]],
            Options: null,
          }
        : {
            Driver: "cdi",
            Count: 0,
            DeviceIDs: ["nvidia.com/gpu=0"],
            Capabilities: null,
            Options: null,
          },
    ],
    devices: null,
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "present",
    containerId: "c".repeat(64),
  };
}

function dockerCapture() {
  return vi.fn((_command: string, args: string[]) =>
    args[0] === "exec"
      ? {
          status: 0,
          stdout: "[managed-startup] verified profile completion\n",
          stderr: "",
        }
      : {
          status: 0,
          stdout: JSON.stringify([
            "c".repeat(64),
            "running",
            false,
            "2026-07-30T12:00:00Z",
            "0001-01-01T00:00:00Z",
            0,
          ]),
          stderr: "",
        },
  );
}

function managedDockerRestoreFixture(
  sourceDevices: string[],
  initialTargetSelection: "all" | "exact",
  backupPath = "/tmp/alpha",
) {
  const agent = "openclaw";
  const target = sandbox(agent, { openshellDriver: "docker" });
  const source = retainedDockerSnapshot(target, {
    kind: "gpu",
    vendor: "nvidia",
    devices: sourceDevices,
  });
  let targetSelection = initialTargetSelection;
  const captureHostCommand = dockerCapture();
  const runtimeProvider = createDockerRuntimeProviderBundle({
    captureHostCommand,
    queryRuntimeSnapshot: () => dockerRuntimeSnapshot(targetSelection),
  });
  expect(runtimeProvider.snapshot.supported).toBe(true);
  const snapshot = runtimeProvider.snapshot as Extract<
    RuntimeProviderSnapshotSurface,
    { supported: true }
  >;
  const providerRestore = vi.spyOn(snapshot, "restore");
  const restore = vi.fn(
    (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
      options.validateBeforeMutation?.();
      return {
        success: true,
        restoredDirs: ["workspace"],
        failedDirs: [],
        restoredFiles: [],
        failedFiles: [],
      };
    },
  );
  const retainedManifest = { ...manifest(agent), backupPath, runtimeSnapshot: source };
  const run = () =>
    restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      retainedManifest,
      { targetAgentType: agent },
      {
        getSandbox: () => target,
        requireProvider: () => runtimeProvider,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath,
          contentSha256: "c".repeat(64),
        }),
        restore,
      },
    );
  return {
    captureHostCommand,
    providerRestore,
    restore,
    run,
    selectTarget: (selection: "all" | "exact") => {
      targetSelection = selection;
    },
  };
}

function provider(agent: ShippedManagedImageAgent) {
  const preflight = vi.fn((operation: "backup" | "restore", entry: SandboxEntry) => ({
    schemaVersion: 1 as const,
    providerId: "mxc",
    operation,
    sandboxName: entry.name,
    providerHandle: "opaque-preflight",
    lifecycleState: "running" as const,
    lifecycleGeneration: "generation-1",
  }));
  const validateRestore = vi.fn();
  const restore = vi.fn(
    (
      entry: SandboxEntry,
      _preflight: unknown,
      _source: unknown,
      authority: RuntimeProviderManagedProfileRestoreAuthority,
    ) => ({
      schemaVersion: 1 as const,
      providerId: "mxc",
      sandboxName: entry.name,
      providerHandle: "opaque-restore",
      lifecycleState: "running" as const,
      lifecycleGeneration: "generation-1",
      runtime: runtimeSnapshot().runtime,
      managedProfile: authority,
    }),
  );
  const bundle = {
    identity: { contractVersion: 1, id: "mxc", displayName: "MXC" },
    workload: {
      providerId: "mxc",
      supported: true,
      profile: {
        support: null,
        hostArchitectures: [],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: (receipt: SandboxWorkloadReceipt | undefined) =>
        receipt?.kind === "managed-image" && receipt.reference === workload(agent).reference,
    },
    snapshot: {
      providerId: "mxc",
      supported: true,
      contractVersion: 1,
      capabilities: { backup: true, restore: true, managedProfileRestore: true },
      preflight,
      capture: () => runtimeSnapshot().runtime,
      validateRestore,
      restore,
    },
  } as unknown as RuntimeProviderBundle;
  return { bundle, preflight, validateRestore, restore };
}

describe("managed rebuild restore authority", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "revalidates %s content and provider authority at the mutation edge",
    (agent) => {
      const target = sandbox(agent);
      const runtimeProvider = provider(agent);
      const restore = vi.fn(
        (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
          options.validateBeforeMutation?.();
          return {
            success: true,
            restoredDirs: ["workspace"],
            failedDirs: [],
            restoredFiles: [],
            failedFiles: [],
          };
        },
      );

      const result = restoreRecreatedSandboxStateWithManagedAuthority(
        "alpha",
        manifest(agent),
        { targetAgentType: agent },
        {
          getSandbox: () => target,
          requireProvider: () => runtimeProvider.bundle,
          captureContentAuthority: () => ({
            schemaVersion: 1,
            backupPath: "/tmp/alpha",
            contentSha256: "c".repeat(64),
          }),
          restore,
        },
      );

      expect(result.success).toBe(true);
      expect(restore).toHaveBeenCalledWith(
        "alpha",
        "/tmp/alpha",
        expect.objectContaining({
          authority: expect.objectContaining({ contentSha256: "c".repeat(64) }),
          validateBeforeMutation: expect.any(Function),
        }),
      );
      expect(runtimeProvider.preflight).toHaveBeenCalledTimes(2);
      expect(runtimeProvider.validateRestore).toHaveBeenCalledTimes(2);
      expect(runtimeProvider.restore).toHaveBeenCalledOnce();
    },
  );

  it("keeps legacy rebuild manifests on the state-only restore path", () => {
    const legacy = { ...manifest("openclaw"), workload: undefined, runtimeSnapshot: undefined };
    const restore = vi.fn(() => ({
      success: true,
      restoredDirs: [],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    }));

    expect(
      restoreRecreatedSandboxStateWithManagedAuthority(
        "alpha",
        legacy,
        { targetAgentType: "openclaw" },
        {
          getSandbox: vi.fn(),
          requireProvider: vi.fn() as never,
          captureContentAuthority: vi.fn(),
          restore,
        },
      ).success,
    ).toBe(true);
    expect(restore).toHaveBeenCalledWith("alpha", "/tmp/alpha", {
      targetAgentType: "openclaw",
    });
  });

  it("rejects a managed manifest without provider runtime authority", () => {
    const restore = vi.fn();
    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      { ...manifest("hermes"), runtimeSnapshot: undefined },
      { targetAgentType: "hermes" },
      {
        getSandbox: vi.fn(),
        requireProvider: vi.fn() as never,
        captureContentAuthority: vi.fn(),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("missing provider runtime authority"),
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores retained all-GPU authority through the managed rebuild path (#10758)", () => {
    const fixture = managedDockerRestoreFixture(["docker-device-id:nvidia.com/gpu=all"], "all");

    expect(fixture.run()).toMatchObject({ success: true, restoredDirs: ["workspace"] });
    expect(fixture.restore).toHaveBeenCalledOnce();
    expect(
      fixture.captureHostCommand.mock.calls.filter(([, args]) => args[0] === "exec"),
    ).toHaveLength(1);
    expect(fixture.providerRestore).toHaveReturnedWith(
      expect.objectContaining({
        runtime: expect.objectContaining({
          acceleration: {
            kind: "gpu",
            vendor: "nvidia",
            devices: ["nvidia.com/gpu=all"],
          },
        }),
      }),
    );
  });

  it("retains exact-device authority before mutation and succeeds on retry (#10758)", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acceleration-retry-"));
    const retainedFile = path.join(backupPath, "retained-state");
    fs.writeFileSync(retainedFile, "state");
    try {
      const fixture = managedDockerRestoreFixture(
        ["docker-device-id:nvidia.com/gpu=0"],
        "all",
        backupPath,
      );

      expect(fixture.run()).toMatchObject({
        success: false,
        error: expect.stringContaining("cannot represent the snapshot acceleration state"),
      });
      expect(fixture.restore).not.toHaveBeenCalled();
      expect(fixture.providerRestore).not.toHaveBeenCalled();
      expect(fixture.captureHostCommand.mock.calls.some(([, args]) => args[0] === "exec")).toBe(
        false,
      );
      expect(fs.readFileSync(retainedFile, "utf8")).toBe("state");

      fixture.selectTarget("exact");
      expect(fixture.run()).toMatchObject({ success: true, restoredDirs: ["workspace"] });
      expect(fixture.restore).toHaveBeenCalledOnce();
      expect(fixture.providerRestore).toHaveBeenCalledOnce();
      expect(
        fixture.captureHostCommand.mock.calls.filter(([, args]) => args[0] === "exec"),
      ).toHaveLength(1);
      expect(fs.readFileSync(retainedFile, "utf8")).toBe("state");
    } finally {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
  });
});
