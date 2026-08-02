// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import {
  type HostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../../onboard/runtime-provider/host-local-inference";
import type { SandboxEntry } from "../../../state/registry/types";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
} from "../../../state/sandbox";
import { restoreRecreatedSandboxStateWithManagedAuthority } from "./restore-authority";

type Agent = "openclaw" | "hermes" | "langchain-deepagents-code";
type Service = "ollama" | "nim" | "vllm";

function receipt(service: Service, port = 8000): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    service,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "mxc",
      authorityId: "mxc:host-local",
      bindingSha256: "a".repeat(64),
    },
    endpoint: { host: "mxc.internal", port, networkName: "mxc-network" },
    runtime:
      service === "ollama"
        ? {
            kind: "host",
            probeImageRef: `quay.io/curl/curl@sha256:${"b".repeat(64)}`,
          }
        : {
            kind: "container",
            runtimeId: `mxc-${service}-runtime`,
            name: `nemoclaw-${service}`,
            imageRef: `nvcr.io/nvidia/${service}@sha256:${"c".repeat(64)}`,
            specSha256: "d".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
          },
  };
}

function manifest(agent: Agent, service: Service, port = 8000): RebuildManifest {
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-08-02T00-00-00-000Z",
    agentType: agent,
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox",
    backupPath: "/tmp/alpha",
    blueprintDigest: null,
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(receipt(service, port)),
  };
}

function sandbox(agent: Agent, service: Service, port = 8000): SandboxEntry {
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(receipt(service, port)),
  };
}

function provider() {
  const preserveForRebuild = vi.fn((value: HostLocalInferenceReceipt) => value);
  const bundle = {
    identity: { contractVersion: 1, id: "mxc", displayName: "MXC" },
    hostLocalInference: {
      providerId: "mxc",
      supported: true,
      runtime: {
        providerId: "mxc",
        authorityId: "mxc:host-local",
        services: ["ollama", "nim", "vllm"],
        translateContainerArgs: (args: readonly string[]) => args,
        qualifyOllama: vi.fn(),
        startManaged: vi.fn(),
        inspectManaged: vi.fn(),
        stopManaged: vi.fn(),
        preserveForRebuild,
        prepareDestroy: vi.fn((value: HostLocalInferenceReceipt) => value),
        destroy: vi.fn((value: HostLocalInferenceReceipt) => ({
          status: "removed" as const,
          receipt: value,
        })),
      },
    },
  } as unknown as RuntimeProviderBundle;
  return { bundle, preserveForRebuild };
}

function successfulRestore(options: RecreatedSandboxRestoreOptions): RestoreResult {
  try {
    options.validateBeforeMutation?.();
    return {
      success: true,
      restoredDirs: ["workspace"],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    };
  } catch (error) {
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["workspace"],
      restoredFiles: [],
      failedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("host-local inference snapshot restore authority", () => {
  it.each([
    ["openclaw", "ollama"],
    ["openclaw", "nim"],
    ["openclaw", "vllm"],
    ["hermes", "ollama"],
    ["hermes", "nim"],
    ["hermes", "vllm"],
    ["langchain-deepagents-code", "ollama"],
    ["langchain-deepagents-code", "nim"],
    ["langchain-deepagents-code", "vllm"],
  ] as const)("re-proves exact %s %s authority before, at, and after restore", (agent, service) => {
    const target = sandbox(agent, service);
    const runtimeProvider = provider();
    const restore = vi.fn((_name, _path, options: RecreatedSandboxRestoreOptions) =>
      successfulRestore(options),
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      manifest(agent, service),
      { targetAgentType: agent },
      {
        getSandbox: () => target,
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "e".repeat(64),
        }),
        restore,
      },
    );

    expect(result.success).toBe(true);
    expect(runtimeProvider.preserveForRebuild).toHaveBeenCalledTimes(3);
    expect(restore).toHaveBeenCalledWith(
      "alpha",
      "/tmp/alpha",
      expect.objectContaining({
        authority: expect.objectContaining({ contentSha256: "e".repeat(64) }),
        validateBeforeMutation: expect.any(Function),
      }),
    );
  });

  it("fails before mutation when the target route differs from the manifest", () => {
    const runtimeProvider = provider();
    const restore = vi.fn();
    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      manifest("hermes", "vllm"),
      { targetAgentType: "hermes" },
      {
        getSandbox: () => sandbox("hermes", "vllm", 8001),
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority: vi.fn(),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("different host-local inference authority"),
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("fails closed when the route changes at the filesystem mutation fence", () => {
    const runtimeProvider = provider();
    const entries = [sandbox("openclaw", "ollama"), sandbox("openclaw", "ollama", 11435)];
    const getSandbox = vi
      .fn<() => SandboxEntry | null>()
      .mockReturnValueOnce(entries[0])
      .mockReturnValueOnce(entries[1]);

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      manifest("openclaw", "ollama"),
      { targetAgentType: "openclaw" },
      {
        getSandbox,
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "f".repeat(64),
        }),
        restore: (_name, _path, options) => successfulRestore(options),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("different host-local inference authority"),
    });
  });
});
