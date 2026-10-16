// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  serializedHostLocalInferenceReceipt,
  serializedLlamaCppHostLocalInferenceReceipt,
} from "../../../../../test/helpers/host-local-inference-receipt";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import { createSandboxHostLocalInferenceProvenance } from "../../../state/registry/host-local-inference";
import type { BackupOptions, BackupResult } from "../../../state/sandbox";
import {
  backupSandboxStateWithManagedAuthority,
  prepareStoppedAgentState,
} from "./backup-authority";

function workload(
  agent: ShippedManagedImageAgent,
  changedProfile = false,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(
    managedStartupE2eProfile(agent, changedProfile),
  );
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

function sandbox(
  agent: ShippedManagedImageAgent,
  receipt: SandboxWorkloadReceipt = workload(agent),
): SandboxEntry {
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    imageTag: receipt.kind === "managed-image" ? receipt.reference : null,
    fromDockerfile: null,
    workload: receipt,
  };
}

function runtime(handle = "session-1") {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    providerHandle: `opaque-${handle}`,
    lifecycleState: "running",
    lifecycleGeneration: "generation-1",
    runtime: {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "session", handle },
      acceleration: { kind: "none" },
    },
  } as const;
}

function provider(acceptsReceipt = true): RuntimeProviderBundle {
  return {
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
      acceptsReceipt: () => acceptsReceipt,
    },
  } as unknown as RuntimeProviderBundle;
}

function successfulBackup(options: BackupOptions): BackupResult {
  try {
    options.validateBeforePublish?.();
  } catch (error) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    success: true,
    manifest: {
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-31T00-00-00-000Z",
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      backupPath: "/tmp/alpha",
      blueprintDigest: null,
    },
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
  };
}

function hostLocalSandbox(
  agent: "openclaw" | "hermes" | "langchain-deepagents-code",
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    provider: "vllm-local",
    model: "model-a",
    endpointUrl: "https://inference.local/v1",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "alpha-generation-1",
    hostLocalInferenceReceipt: serializedHostLocalInferenceReceipt("mxc"),
    ...overrides,
  };
}

function explicitLlamaSandbox(agent: "openclaw" | "hermes" | "langchain-deepagents-code") {
  const hostLocalInferenceReceipt = serializedLlamaCppHostLocalInferenceReceipt("mxc");
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    provider: "llama-cpp-local",
    model: "llama-cpp-model",
    endpointUrl: "https://inference.local/v1",
    endpointSource: "inference-set",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "alpha-generation-1",
    hostLocalInferenceReceipt,
    hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance(
      "alpha",
      hostLocalInferenceReceipt,
    ),
  } satisfies SandboxEntry;
}

describe("managed snapshot backup authority", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requests provider capture for legacy Docker without managed workload authority", async () => {
    const entry = {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: null,
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      fromDockerfile: "Dockerfile",
    } as SandboxEntry;
    const runtimeSnapshot = {
      schemaVersion: 1,
      providerId: "docker",
      providerHandle: "opaque-container",
      lifecycleState: "stopped",
      lifecycleGeneration: "generation-1",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "b".repeat(64) },
        acceleration: { kind: "none" },
      },
    } as const;
    const prepareCapture = vi.fn(() => null);
    const runtimeProvider = {
      identity: { id: "docker", contractVersion: 1, displayName: "Docker" },
      snapshot: {
        providerId: "docker",
        supported: true,
        contractVersion: 1,
        capabilities: { backup: true, restore: true, managedProfileRestore: true },
        prepareStoppedStateCapture: prepareCapture,
      },
    } as unknown as RuntimeProviderBundle;
    const requireProvider = vi.fn(() => runtimeProvider);
    const captureRuntime = vi.fn(() => runtimeSnapshot);

    await expect(
      prepareStoppedAgentState("alpha", () => entry, { requireProvider, captureRuntime }),
    ).resolves.toBeNull();

    expect(requireProvider).toHaveBeenCalledWith(entry);
    expect(captureRuntime).toHaveBeenCalledWith(runtimeProvider, entry);
    expect(prepareCapture).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      runtimeSnapshot,
      { nativeRoot: "/sandbox", managedStateRoots: [] },
    );
  });

  it("prepares a legacy Docker source when the provider reports it stopped", async () => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-docker-stopped-source-"),
    );
    const entry = {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: null,
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      fromDockerfile: "Dockerfile",
    } as SandboxEntry;
    const runtimeSnapshot = {
      schemaVersion: 1,
      providerId: "docker",
      providerHandle: "opaque-container",
      lifecycleState: "stopped",
      lifecycleGeneration: "generation-1",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "b".repeat(64) },
        acceleration: { kind: "none" },
      },
    } as const;
    const capture = {
      capture: async (archiveFd: number) => {
        const archive = execFileSync("tar", ["-C", sourceDirectory, "-cf", "-", "."]);
        fs.writeSync(archiveFd, archive);
      },
      assertCurrent: vi.fn(),
    };
    const prepareCapture = vi.fn(() => capture);
    const runtimeProvider = {
      identity: { id: "docker", contractVersion: 1, displayName: "Docker" },
      snapshot: {
        providerId: "docker",
        supported: true,
        contractVersion: 1,
        capabilities: { backup: true, restore: true, managedProfileRestore: true },
        prepareStoppedStateCapture: prepareCapture,
      },
    } as unknown as RuntimeProviderBundle;

    try {
      fs.mkdirSync(path.join(sourceDirectory, ".openclaw"));
      fs.writeFileSync(path.join(sourceDirectory, ".openclaw", "openclaw.json"), "{}");
      const prepared = await prepareStoppedAgentState("alpha", () => entry, {
        requireProvider: () => runtimeProvider,
        captureRuntime: () => runtimeSnapshot,
      });

      expect(prepared).not.toBeNull();
      expect(prepareCapture).toHaveBeenCalledWith(
        expect.objectContaining({ name: "alpha" }),
        runtimeSnapshot,
        { nativeRoot: "/sandbox", managedStateRoots: [] },
      );
      expect(fs.existsSync(path.join(prepared!.directory, "openclaw.json"))).toBe(true);
      prepared!.dispose();
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  it("does not capture a legacy Docker source while the provider reports it running", async () => {
    const entry = {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: null,
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      fromDockerfile: "Dockerfile",
    } as SandboxEntry;
    const runtimeSnapshot = {
      schemaVersion: 1,
      providerId: "docker",
      providerHandle: "opaque-container",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "b".repeat(64) },
        acceleration: { kind: "none" },
      },
    } as const;
    const prepareCapture = vi.fn();
    const runtimeProvider = {
      identity: { id: "docker", contractVersion: 1, displayName: "Docker" },
      snapshot: {
        providerId: "docker",
        supported: true,
        contractVersion: 1,
        capabilities: { backup: true, restore: true, managedProfileRestore: true },
        prepareStoppedStateCapture: prepareCapture,
      },
    } as unknown as RuntimeProviderBundle;
    const captureRuntime = vi.fn(() => runtimeSnapshot);

    await expect(
      prepareStoppedAgentState("alpha", () => entry, {
        requireProvider: () => runtimeProvider,
        captureRuntime,
      }),
    ).resolves.toBeNull();

    expect(captureRuntime).toHaveBeenCalledOnce();
    expect(prepareCapture).not.toHaveBeenCalled();
  });

  it("skips legacy capture when the provider has no stopped-state capability", async () => {
    const entry = {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "mxc",
      fromDockerfile: "Dockerfile",
    } as SandboxEntry;
    const runtimeProvider = {
      identity: { id: "mxc", contractVersion: 1, displayName: "MXC" },
      snapshot: { supported: true, prepareStoppedStateCapture: undefined },
    } as unknown as RuntimeProviderBundle;
    const captureRuntime = vi.fn();
    const requireProvider = vi.fn(() => runtimeProvider);

    await expect(
      prepareStoppedAgentState("alpha", () => entry, { requireProvider, captureRuntime }),
    ).resolves.toBeNull();

    expect(requireProvider).toHaveBeenCalledWith(entry);
    expect(captureRuntime).not.toHaveBeenCalled();
  });

  it("uses only the whole-home state path for unmanaged Hermes backup", () => {
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));
    const result = backupSandboxStateWithManagedAuthority("alpha", {
      getSandbox: () => ({ name: "alpha", agent: "hermes" }) as SandboxEntry,
      backup,
    });
    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledWith("alpha");
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "captures and republishes exact %s provider authority",
    (agent) => {
      const entry = sandbox(agent);
      const getSandbox = vi.fn(() => entry);
      const requireProvider = vi.fn(() => provider());
      const captureRuntime = vi.fn(() => runtime());
      const backup = vi.fn((_name: string, options: BackupOptions = {}) =>
        successfulBackup(options),
      );

      const result = backupSandboxStateWithManagedAuthority("alpha", {
        getSandbox,
        requireProvider,
        captureRuntime,
        backup,
      });

      expect(result.success).toBe(true);
      expect(backup).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          workload: entry.workload,
          runtimeSnapshot: runtime(),
          validateBeforePublish: expect.any(Function),
        }),
      );
      expect(getSandbox).toHaveBeenCalledTimes(2);
      expect(requireProvider).toHaveBeenCalledTimes(2);
      expect(captureRuntime).toHaveBeenCalledTimes(2);
    },
  );

  it("backs up a stopped sandbox from its prepared native-state copy", () => {
    const entry = sandbox("openclaw");
    const assertCurrent = vi.fn();
    const stoppedNativeState = {
      sandboxName: "alpha",
      agentName: "openclaw" as const,
      nativeDirectory: "/private/stopped-native",
      directory: "/private/stopped-native/.openclaw",
      cleanupDirectory: "/private",
      assertCurrent,
      dispose: vi.fn(),
    };
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));

    const result = backupSandboxStateWithManagedAuthority(
      "alpha",
      {
        getSandbox: () => entry,
        requireProvider: () => provider(),
        captureRuntime: () => runtime(),
        backup,
      },
      stoppedNativeState,
    );

    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeStateSource: {
          root: "/sandbox",
          directory: stoppedNativeState.nativeDirectory,
          assertCurrent,
        },
        validateBeforePublish: expect.any(Function),
      }),
    );
    const options = backup.mock.calls[0]?.[1];
    options?.nativeStateSource?.assertCurrent();
    expect(assertCurrent).toHaveBeenCalledOnce();
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "carries exact explicit llama.cpp authority through %s backup",
    (agent) => {
      const entry = explicitLlamaSandbox(agent);
      const prepared = {
        providerId: "mxc",
        sandboxName: entry.name,
        serializedReceipt: entry.hostLocalInferenceReceipt,
      };
      const prepareHostLocalInference = vi.fn(() => prepared);
      const confirmHostLocalInference = vi.fn();
      const backup = vi.fn((_name: string, options: BackupOptions = {}) =>
        successfulBackup(options),
      );

      const result = backupSandboxStateWithManagedAuthority(entry.name, {
        getSandbox: () => entry,
        requireProvider: () => provider(),
        captureRuntime: vi.fn() as never,
        prepareHostLocalInference: prepareHostLocalInference as never,
        confirmHostLocalInference: confirmHostLocalInference as never,
        backup,
      });

      expect(result.success).toBe(true);
      expect(backup).toHaveBeenCalledWith(
        entry.name,
        expect.objectContaining({
          hostLocalInferenceReceipt: entry.hostLocalInferenceReceipt,
          hostLocalInferenceProvenance: entry.hostLocalInferenceProvenance,
          validateBeforePublish: expect.any(Function),
        }),
      );
      expect(prepareHostLocalInference).toHaveBeenCalledOnce();
      expect(confirmHostLocalInference).toHaveBeenCalledOnce();
    },
  );

  it("fails before backup when explicit llama.cpp authority cannot be reconstructed", () => {
    const entry = explicitLlamaSandbox("openclaw");
    const backup = vi.fn();

    const result = backupSandboxStateWithManagedAuthority(entry.name, {
      getSandbox: () => entry,
      requireProvider: () => provider(),
      captureRuntime: vi.fn() as never,
      prepareHostLocalInference: vi.fn(() => null),
      backup,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("explicit host-local inference lifecycle authority"),
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("keeps explicit Dockerfile backups on the whole-home state path", () => {
    const entry = {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "mxc",
      fromDockerfile: "/tmp/Dockerfile",
    } satisfies SandboxEntry;
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));
    const requireProvider = vi.fn();
    const captureRuntime = vi.fn();

    const result = backupSandboxStateWithManagedAuthority("alpha", {
      getSandbox: () => entry,
      requireProvider,
      captureRuntime: captureRuntime as never,
      backup,
    });

    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledWith("alpha");
    expect(requireProvider).not.toHaveBeenCalled();
    expect(captureRuntime).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "captures and confirms exact %s host-local inference authority",
    (agent) => {
      const entry = hostLocalSandbox(agent);
      const prepared = {
        providerId: "mxc",
        sandboxName: "alpha",
        serializedReceipt: entry.hostLocalInferenceReceipt,
        sandboxAuthority: { model: entry.model },
      };
      const prepareHostLocalInference = vi.fn(() => prepared);
      const confirmHostLocalInference = vi.fn();
      const backup = vi.fn((_name: string, options: BackupOptions = {}) =>
        successfulBackup(options),
      );

      const result = backupSandboxStateWithManagedAuthority("alpha", {
        getSandbox: () => entry,
        requireProvider: () => provider(),
        captureRuntime: vi.fn() as never,
        prepareHostLocalInference: prepareHostLocalInference as never,
        confirmHostLocalInference: confirmHostLocalInference as never,
        backup,
      });

      expect(result.success).toBe(true);
      expect(backup).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          hostLocalInferenceReceipt: entry.hostLocalInferenceReceipt,
          validateBeforePublish: expect.any(Function),
        }),
      );
      expect(prepareHostLocalInference).toHaveBeenCalledWith(expect.anything(), entry);
      expect(confirmHostLocalInference).toHaveBeenCalledWith(expect.anything(), entry, prepared);
    },
  );

  it.each([
    ["agent", { agent: "hermes" }],
    ["runtime provider", { openshellDriver: "docker" }],
    ["route provider", { provider: "ollama-local" }],
    ["model", { model: "model-b" }],
    ["endpoint", { endpointUrl: "https://inference.local/v1/" }],
    ["gateway", { gatewayName: "nemoclaw-8081" }],
    ["lifecycle generation", { lifecycleGeneration: "alpha-generation-2" }],
  ] as const)("rejects host-local %s drift before manifest publication", (_label, drift) => {
    const initial = hostLocalSandbox("openclaw");
    const current = hostLocalSandbox("openclaw", drift);
    const entries = [initial, current];
    const prepared = {
      providerId: "mxc",
      sandboxName: "alpha",
      serializedReceipt: initial.hostLocalInferenceReceipt,
    };
    const confirmHostLocalInference = vi.fn((_provider, candidate: SandboxEntry) => {
      const fields = [
        "agent",
        "openshellDriver",
        "provider",
        "model",
        "endpointUrl",
        "gatewayName",
        "lifecycleGeneration",
      ] as const;
      expect(fields.some((field) => candidate[field] !== initial[field])).toBe(true);
      throw new Error("sandbox authority changed after lifecycle preparation");
    });
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));

    const result = backupSandboxStateWithManagedAuthority("alpha", {
      getSandbox: vi.fn(() => entries.shift() ?? null),
      requireProvider: () => provider(),
      captureRuntime: vi.fn() as never,
      prepareHostLocalInference: vi.fn(() => prepared) as never,
      confirmHostLocalInference: confirmHostLocalInference as never,
      backup,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("sandbox authority changed"),
    });
  });

  it("fails before filesystem capture when the provider rejects managed authority", () => {
    const entry = sandbox("openclaw");
    const backup = vi.fn();

    const result = backupSandboxStateWithManagedAuthority("alpha", {
      getSandbox: () => entry,
      requireProvider: () => provider(false),
      captureRuntime: vi.fn() as never,
      backup,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("does not accept the managed workload receipt"),
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "workload",
      secondEntry: sandbox("openclaw", workload("openclaw", true)),
      secondRuntime: runtime(),
      error: "managed workload changed during backup",
    },
    {
      label: "runtime",
      secondEntry: sandbox("openclaw"),
      secondRuntime: runtime("session-2"),
      error: "runtime changed during backup",
    },
  ])(
    "rejects $label drift before manifest publication",
    ({ secondEntry, secondRuntime, error }) => {
      const initialEntry = sandbox("openclaw");
      const getSandbox = vi
        .fn<() => SandboxEntry | null>()
        .mockReturnValueOnce(initialEntry)
        .mockReturnValueOnce(secondEntry);
      const captureRuntime = vi
        .fn<() => ReturnType<typeof runtime>>()
        .mockReturnValueOnce(runtime())
        .mockReturnValueOnce(secondRuntime);
      const backup = vi.fn((_name: string, options: BackupOptions = {}) =>
        successfulBackup(options),
      );

      const result = backupSandboxStateWithManagedAuthority("alpha", {
        getSandbox,
        requireProvider: () => provider(),
        captureRuntime: captureRuntime as (
          bundle: RuntimeProviderBundle,
          entry: SandboxEntry,
        ) => ReturnType<typeof runtime>,
        backup,
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining(error),
      });
    },
  );
});
