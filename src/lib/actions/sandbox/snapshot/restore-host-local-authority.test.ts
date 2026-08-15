// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createInMemoryRuntimeProviderBundle } from "../../../../../test/helpers/runtime-provider-bundle";
import { createSandboxHostLocalInferenceProvenance } from "../../../state/registry/host-local-inference";
import {
  type HostLocalInferenceOperation,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceRuntime,
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

const AUTHORITY_ID = `mxc-endpoint:${"a".repeat(64)}`;
const BINDING_SHA256 = "d".repeat(64);
const MODEL = "qwen3.5-9b";

function receipt(service: Service, port = 8000): HostLocalInferenceReceipt {
  return {
    schemaVersion: 2,
    providerId: "mxc",
    service,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "memory",
      authorityId: AUTHORITY_ID,
      bindingSha256: BINDING_SHA256,
    },
    endpoint: {
      host: "host.openshell.internal",
      port,
      networkName: "mxc-runtime-network",
      networkId: "2".repeat(64),
      networkGatewayIp: "10.89.0.1",
      networkAuthoritySha256: "3".repeat(64),
    },
    inference: {
      protocol: "openai-chat-completions",
      model: service === "ollama" ? `${MODEL}:latest` : MODEL,
      toolCallingRequired: true,
    },
    publication: {
      transactionId: "4".repeat(64),
      targetSha256: "5".repeat(64),
      priorState: service === "ollama" ? "host-process" : "absent",
    },
    runtime:
      service === "ollama"
        ? {
            kind: "host",
            probeImageRef: `quay.io/curl/curl@sha256:${"6".repeat(64)}`,
            acceleration: "nvidia-gpu",
            modelDigest: `sha256:${"7".repeat(64)}`,
          }
        : {
            kind: "container",
            runtimeId: `mxc-runtime:${service}`,
            name: `nemoclaw-${service}`,
            imageRef: `nvcr.io/nvidia/${service}@sha256:${"8".repeat(64)}`,
            probeImageRef: `quay.io/curl/curl@sha256:${"6".repeat(64)}`,
            specSha256: "9".repeat(64),
            launchSha256: "b".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
          },
  };
}

function llamaCppReceipt(): string {
  return serializeHostLocalInferenceReceipt({
    schemaVersion: 1,
    providerId: "mxc",
    service: "llama-cpp",
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "memory",
      authorityId: AUTHORITY_ID,
      bindingSha256: BINDING_SHA256,
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 8081,
      networkName: "mxc-runtime-network",
    },
    runtime: {
      kind: "container",
      runtimeId: "c".repeat(64),
      name: "nemoclaw-llama-cpp",
      imageRef: `ghcr.io/nvidia/llama-cpp@sha256:${"d".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"e".repeat(64)}`,
      specSha256: "f".repeat(64),
      model: {
        planDigest: `sha256:${"1".repeat(64)}`,
        recipeId: "llama-cpp.test.v1",
        generation: "2".repeat(64),
        digest: `sha256:${"3".repeat(64)}`,
        sizeBytes: 64,
      },
      gpu: { vendor: "nvidia", count: 1 },
    },
  });
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

function sandbox(
  agent: Agent,
  service: Service,
  port = 8000,
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  const value = receipt(service, port);
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    provider: service === "ollama" ? "ollama-local" : "vllm-local",
    model: value.inference?.model ?? MODEL,
    endpointUrl: "https://inference.local/v1",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "alpha-generation-1",
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(value),
    ...overrides,
  };
}

function provider() {
  const preserveForRebuild = vi.fn((value: HostLocalInferenceReceipt) => value);
  const runtime: HostLocalInferenceRuntime = {
    providerId: "mxc",
    authorityId: AUTHORITY_ID,
    services: ["ollama", "nim", "vllm"],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(),
    startManaged: vi.fn(),
    inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
    stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
    preserveForRebuild,
    prepareDestroy: vi.fn((value) => value),
    destroy: vi.fn((value) => ({ status: "removed" as const, receipt: value })),
  };
  const operation: HostLocalInferenceOperation = {
    providerId: "mxc",
    engine: {
      operation: "host-local-inference",
      engineId: "memory",
      displayName: "In-memory",
      authorityId: AUTHORITY_ID,
      capture: vi.fn(),
      captureHost: vi.fn(),
    },
    bindingSha256: BINDING_SHA256,
    assertAuthority: vi.fn(),
    spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
    createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
    managedRuntime: runtime,
  };
  const bundle = createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: {
      support: null,
      hostArchitectures: ["x64"],
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInference: {
      services: ["ollama", "nim", "vllm"],
      createOperation: () => operation,
    },
  });
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

  it("rejects a dedicated llama.cpp receipt instead of skipping provider confirmation", () => {
    const runtimeProvider = provider();
    const serialized = llamaCppReceipt();
    const target = {
      ...sandbox("openclaw", "vllm"),
      model: "llama-cpp-model",
      hostLocalInferenceReceipt: serialized,
    };
    const restore = vi.fn();
    const captureContentAuthority = vi.fn();

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      { ...manifest("openclaw", "vllm"), hostLocalInferenceReceipt: serialized },
      { targetAgentType: "openclaw" },
      {
        getSandbox: () => target,
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority,
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("no common lifecycle authority"),
    });
    expect(captureContentAuthority).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "re-proves explicit llama.cpp authority throughout %s restore",
    (agent) => {
      const serialized = llamaCppReceipt();
      const provenance = createSandboxHostLocalInferenceProvenance("alpha", serialized);
      const target: SandboxEntry = {
        ...sandbox(agent, "vllm"),
        provider: "llama-cpp-local",
        model: "llama-cpp-model",
        gatewayPort: 8080,
        hostLocalInferenceReceipt: serialized,
        hostLocalInferenceProvenance: provenance,
      };
      const prepared = {
        providerId: "mxc",
        sandboxName: "alpha",
        serializedReceipt: serialized,
      };
      const prepareHostLocalInference = vi.fn(() => prepared);
      const confirmHostLocalInference = vi.fn();
      const restore = vi.fn((_name, _path, options: RecreatedSandboxRestoreOptions) =>
        successfulRestore(options),
      );

      const result = restoreRecreatedSandboxStateWithManagedAuthority(
        "alpha",
        {
          ...manifest(agent, "vllm"),
          hostLocalInferenceReceipt: serialized,
          hostLocalInferenceProvenance: provenance,
        },
        { targetAgentType: agent },
        {
          getSandbox: () => target,
          requireProvider: () => provider().bundle,
          prepareHostLocalInference: prepareHostLocalInference as never,
          confirmHostLocalInference: confirmHostLocalInference as never,
          captureContentAuthority: () => ({
            schemaVersion: 1,
            backupPath: "/tmp/alpha",
            contentSha256: "f".repeat(64),
          }),
          restore,
        },
      );

      expect(result.success).toBe(true);
      expect(prepareHostLocalInference).toHaveBeenCalledWith(expect.anything(), target, serialized);
      expect(confirmHostLocalInference).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a manifest that omits explicit llama.cpp provenance", () => {
    const serialized = llamaCppReceipt();
    const target: SandboxEntry = {
      ...sandbox("openclaw", "vllm"),
      provider: "llama-cpp-local",
      model: "llama-cpp-model",
      gatewayPort: 8080,
      hostLocalInferenceReceipt: serialized,
      hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", serialized),
    };
    const prepareHostLocalInference = vi.fn();
    const restore = vi.fn();

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      { ...manifest("openclaw", "vllm"), hostLocalInferenceReceipt: serialized },
      { targetAgentType: "openclaw" },
      {
        getSandbox: () => target,
        requireProvider: () => provider().bundle,
        prepareHostLocalInference: prepareHostLocalInference as never,
        captureContentAuthority: vi.fn(),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("provenance differs"),
    });
    expect(prepareHostLocalInference).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("fails closed when sandbox authority changes at the filesystem mutation fence", () => {
    const runtimeProvider = provider();
    const initial = sandbox("openclaw", "ollama");
    const changed = sandbox("openclaw", "ollama", 8000, {
      lifecycleGeneration: "alpha-generation-2",
    });
    const getSandbox = vi
      .fn<() => SandboxEntry | null>()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(changed);

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
      error: expect.stringContaining("sandbox authority changed"),
    });
  });
});
