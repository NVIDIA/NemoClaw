// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import type { SandboxEntry } from "../../state/registry/types";
import type {
  HostLocalInferenceDestroyResult,
  HostLocalInferenceOperation,
  HostLocalInferenceOperationInput,
  HostLocalInferenceReceipt,
  HostLocalInferenceRuntime,
} from "./host-local-inference";
import { serializeHostLocalInferenceReceipt } from "./host-local-inference";
import {
  confirmHostLocalInferenceAuthority,
  type ManagedHostLocalInferenceService,
  type PreparedHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceDestroyAuthority,
  retirePreparedHostLocalInferenceAuthority,
} from "./host-local-inference-lifecycle";

const AUTHORITY_ID = `mxc-endpoint:${"a".repeat(64)}`;
const BINDING_SHA256 = "b".repeat(64);
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"c".repeat(64)}`;
const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const SERVICES = ["ollama", "nim", "vllm"] as const;

function receipt(
  service: ManagedHostLocalInferenceService = "vllm",
  options: {
    readonly acceleration?: "cpu" | "nvidia-gpu";
    readonly runtimeId?: string;
    readonly targetSha256?: string;
  } = {},
): HostLocalInferenceReceipt {
  const model = service === "ollama" ? "nemotron:latest" : `${service}-model`;
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
      port: service === "ollama" ? 11434 : service === "nim" ? 8001 : 8000,
      networkName: "mxc-runtime-network",
      networkId: "d".repeat(64),
      networkGatewayIp: "10.89.0.1",
      networkAuthoritySha256: "e".repeat(64),
    },
    inference: {
      protocol: "openai-chat-completions",
      model,
      toolCallingRequired: true,
    },
    publication: {
      transactionId: "f".repeat(64),
      targetSha256: options.targetSha256 ?? "1".repeat(64),
      priorState: service === "ollama" ? "host-process" : "absent",
    },
    runtime:
      service === "ollama"
        ? {
            kind: "host",
            probeImageRef: PROBE_IMAGE,
            acceleration: options.acceleration ?? "nvidia-gpu",
            modelDigest: `sha256:${"2".repeat(64)}`,
          }
        : {
            kind: "container",
            runtimeId: options.runtimeId ?? `${"3".repeat(63)}${service === "nim" ? "4" : "5"}`,
            name: `nemoclaw-${service}`,
            imageRef: `nvcr.io/nvidia/${service}@sha256:${"6".repeat(64)}`,
            probeImageRef: PROBE_IMAGE,
            specSha256: "7".repeat(64),
            launchSha256: "8".repeat(64),
            gpu: {
              vendor: "nvidia",
              devices: ["nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc"],
            },
          },
  };
}

function sandbox(
  name = "alpha",
  value = receipt(),
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  return {
    name,
    agent: "openclaw",
    openshellDriver: "mxc",
    provider: value.service === "ollama" ? "ollama-local" : "vllm-local",
    model: value.inference?.model,
    endpointUrl: "https://inference.local/v1",
    gatewayName: "nemoclaw",
    lifecycleGeneration: `${name}-generation-1`,
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(value),
    ...overrides,
  };
}

function requiredPrepared(
  value: PreparedHostLocalInferenceAuthority | null,
): PreparedHostLocalInferenceAuthority {
  expect(value).not.toBeNull();
  if (!value) throw new Error("test expected managed lifecycle authority");
  return value;
}

function provider(
  options: {
    readonly authorityId?: string;
    readonly bindingSha256?: string;
    readonly engineId?: string;
    readonly preserveForRebuild?: (value: HostLocalInferenceReceipt) => HostLocalInferenceReceipt;
    readonly prepareDestroy?: (value: HostLocalInferenceReceipt) => HostLocalInferenceReceipt;
    readonly destroy?: (value: HostLocalInferenceReceipt) => HostLocalInferenceDestroyResult;
  } = {},
) {
  const operationInputs: HostLocalInferenceOperationInput[] = [];
  const preserveForRebuild = vi.fn(
    (value: HostLocalInferenceReceipt) => options.preserveForRebuild?.(value) ?? value,
  );
  const prepareDestroy = vi.fn(
    (value: HostLocalInferenceReceipt) => options.prepareDestroy?.(value) ?? value,
  );
  let present = true;
  const destroy = vi.fn((value: HostLocalInferenceReceipt): HostLocalInferenceDestroyResult => {
    if (options.destroy) return options.destroy(value);
    if (value.runtime.kind === "host") {
      return { status: "retained", reason: "host-process", receipt: value };
    }
    const status = present ? "removed" : "already-absent";
    present = false;
    return { status, receipt: value };
  });
  const runtime: HostLocalInferenceRuntime = {
    providerId: "mxc",
    authorityId: options.authorityId ?? AUTHORITY_ID,
    services: SERVICES,
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(),
    startManaged: vi.fn(),
    inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
    stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
    preserveForRebuild,
    prepareDestroy,
    destroy,
  };
  const assertAuthority = vi.fn();
  const operation: HostLocalInferenceOperation = {
    providerId: "mxc",
    engine: {
      operation: "host-local-inference",
      engineId: options.engineId ?? "memory",
      displayName: "In-memory",
      authorityId: options.authorityId ?? AUTHORITY_ID,
    } as HostLocalInferenceOperation["engine"],
    bindingSha256: options.bindingSha256 ?? BINDING_SHA256,
    assertAuthority,
    spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
    createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
    managedRuntime: runtime,
  };
  const createOperation = vi.fn((input?: HostLocalInferenceOperationInput) => {
    if (input) operationInputs.push(input);
    return operation;
  });
  const bundle = createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: {
      support: null,
      hostArchitectures: ["x64"],
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInference: { services: SERVICES, createOperation },
  });
  return {
    assertAuthority,
    bundle,
    createOperation,
    destroy,
    operationInputs,
    prepareDestroy,
    preserveForRebuild,
  };
}

const AGENT_SERVICE_CASES = AGENTS.flatMap((agent) =>
  SERVICES.map((service) => [agent, service] as const),
);

describe("host-local inference lifecycle authority", () => {
  it.each(AGENT_SERVICE_CASES)(
    "re-proves complete %s sandbox authority for %s",
    (agent, service) => {
      const value = receipt(service);
      const entry = sandbox("alpha", value, { agent });
      const runtimeProvider = provider();
      const prepared = requiredPrepared(
        prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, entry),
      );

      expect(prepared.sandboxAuthority).toMatchObject({
        sandboxName: "alpha",
        agent,
        providerId: "mxc",
        routeProvider: service === "ollama" ? "ollama-local" : "vllm-local",
        model: value.inference?.model,
        endpointUrl: "https://inference.local/v1",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "alpha-generation-1",
        serializedReceipt: entry.hostLocalInferenceReceipt,
      });
      confirmHostLocalInferenceAuthority(runtimeProvider.bundle, entry, prepared);
      expect(runtimeProvider.preserveForRebuild).toHaveBeenCalledTimes(2);
      expect(runtimeProvider.operationInputs).toEqual([
        expect.objectContaining({
          acceleration: value.runtime.kind === "host" ? value.runtime.acceleration : "nvidia-gpu",
        }),
        expect.objectContaining({
          acceleration: value.runtime.kind === "host" ? value.runtime.acceleration : "nvidia-gpu",
        }),
      ]);
    },
  );

  it("reconstructs a CPU Ollama operation from the durable acceleration authority", () => {
    const value = receipt("ollama", { acceleration: "cpu" });
    const entry = sandbox("alpha", value);
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, entry),
    );

    confirmHostLocalInferenceAuthority(runtimeProvider.bundle, entry, prepared);

    expect(runtimeProvider.operationInputs).toHaveLength(2);
    expect(runtimeProvider.operationInputs.every((input) => input.acceleration === "cpu")).toBe(
      true,
    );
  });

  it.each([
    ["sandbox name", (entry: SandboxEntry): SandboxEntry => ({ ...entry, name: "beta" })],
    ["agent", (entry: SandboxEntry): SandboxEntry => ({ ...entry, agent: "hermes" })],
    [
      "runtime provider",
      (entry: SandboxEntry): SandboxEntry => ({ ...entry, openshellDriver: "podman" }),
    ],
    [
      "route provider",
      (entry: SandboxEntry): SandboxEntry => ({ ...entry, provider: "ollama-local" }),
    ],
    ["model", (entry: SandboxEntry): SandboxEntry => ({ ...entry, model: "other-model" })],
    [
      "endpoint",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        endpointUrl: "http://127.0.0.1:8000/v1",
      }),
    ],
    [
      "gateway",
      (entry: SandboxEntry): SandboxEntry => ({ ...entry, gatewayName: "other-gateway" }),
    ],
    [
      "lifecycle generation",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        lifecycleGeneration: "alpha-generation-2",
      }),
    ],
    [
      "receipt",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(receipt("nim")),
      }),
    ],
  ] as const)("rejects %s drift after preparation", (_label, drift) => {
    const entry = sandbox();
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, entry),
    );

    expect(() =>
      confirmHostLocalInferenceAuthority(runtimeProvider.bundle, drift(entry), prepared),
    ).toThrow("Host-local inference lifecycle authority is invalid");
    expect(runtimeProvider.preserveForRebuild).toHaveBeenCalledOnce();
  });

  it.each([
    ["engine", { engineId: "other-engine" }],
    ["authority", { authorityId: `other:${"9".repeat(64)}` }],
    ["binding", { bindingSha256: "9".repeat(64) }],
  ] as const)("rejects operation-scoped %s drift before runtime proof", (_label, options) => {
    const runtimeProvider = provider(options);

    expect(() =>
      prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, sandbox()),
    ).toThrow();
    expect(runtimeProvider.preserveForRebuild).not.toHaveBeenCalled();
  });

  it.each(SERVICES)("retires exact unshared %s authority", (service) => {
    const value = receipt(service);
    const entry = sandbox("alpha", value);
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, entry),
    );

    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, entry, prepared, [entry])
        .status,
    ).toBe(service === "ollama" ? "retained" : "removed");
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
    expect(runtimeProvider.prepareDestroy).toHaveBeenCalledTimes(2);
  });

  it("retains an exact runtime referenced by a coherent peer sandbox", () => {
    const value = receipt();
    const alpha = sandbox("alpha", value);
    const beta = sandbox("beta", value, { agent: "hermes" });
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, alpha),
    );

    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        beta,
        alpha,
      ]).status,
    ).toBe("shared");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects a shared receipt whose peer row is not coherently bound", () => {
    const value = receipt();
    const alpha = sandbox("alpha", value);
    const beta = sandbox("beta", value, { model: "other-model" });
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, alpha),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        beta,
        alpha,
      ]),
    ).toThrow("sandbox model differs");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects conflicting receipts for the same immutable provider runtime", () => {
    const value = receipt("vllm", { targetSha256: "1".repeat(64) });
    const conflict = receipt("vllm", { targetSha256: "2".repeat(64) });
    const alpha = sandbox("alpha", value);
    const beta = sandbox("beta", conflict);
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, alpha),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        beta,
        alpha,
      ]),
    ).toThrow("conflicting registry authority");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("scans the complete peer snapshot and rejects malformed ownership", () => {
    const value = receipt();
    const alpha = sandbox("alpha", value);
    const beta = sandbox("beta", value);
    const malformed = {
      ...sandbox("gamma", receipt("nim")),
      hostLocalInferenceReceipt: "{",
    };
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, alpha),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        beta,
        alpha,
        malformed,
      ]),
    ).toThrow("malformed or indeterminate");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("requires one full-matching target row in the peer snapshot", () => {
    const value = receipt();
    const alpha = sandbox("alpha", value);
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, alpha),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        sandbox("beta", value),
      ]),
    ).toThrow("exactly one target sandbox authority");
    expect(() =>
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        { ...alpha, agent: "hermes" },
      ]),
    ).toThrow("different target sandbox authority");
    expect(() =>
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        alpha,
        { ...alpha },
      ]),
    ).toThrow("duplicate sandbox identities");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("does not retain an unrelated immutable runtime", () => {
    const value = receipt("vllm", { runtimeId: "4".repeat(64) });
    const alpha = sandbox("alpha", value);
    const beta = sandbox("beta", receipt("vllm", { runtimeId: "5".repeat(64) }));
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, alpha),
    );

    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared, [
        beta,
        alpha,
      ]).status,
    ).toBe("removed");
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
  });

  it("reconciles exact retirement idempotently from the durable row", () => {
    const entry = sandbox();
    const runtimeProvider = provider();
    const first = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, entry),
    );

    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, entry, first, [entry])
        .status,
    ).toBe("removed");
    const retry = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, entry),
    );
    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, entry, retry, [entry])
        .status,
    ).toBe("already-absent");
    expect(runtimeProvider.destroy).toHaveBeenCalledTimes(2);
  });
});
