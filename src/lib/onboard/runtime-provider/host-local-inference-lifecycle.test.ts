// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { createSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";
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
  assertPreparedHostLocalInferenceRuntimePresent,
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
const PROVIDER_SERVICES = [...SERVICES, "llama-cpp"] as const;

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

function llamaCppReceipt(): HostLocalInferenceReceipt {
  return {
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
      networkName: "nemoclaw-llama-cpp-internal",
    },
    runtime: {
      kind: "container",
      runtimeId: "9".repeat(64),
      name: "nemoclaw-llama-cpp",
      imageRef: `nvcr.io/nvidia/llama-cpp@sha256:${"a".repeat(64)}`,
      probeImageRef: PROBE_IMAGE,
      specSha256: "d".repeat(64),
      model: {
        planDigest: `sha256:${"e".repeat(64)}`,
        recipeId: "llama-cpp-model",
        generation: "f".repeat(64),
        digest: `sha256:${"1".repeat(64)}`,
        sizeBytes: 1024,
      },
      gpu: { vendor: "nvidia", count: 1 },
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
    provider:
      value.service === "ollama"
        ? "ollama-local"
        : value.service === "llama-cpp"
          ? "llama-cpp-local"
          : "vllm-local",
    model: value.service === "llama-cpp" ? "llama-cpp-model" : value.inference?.model,
    endpointUrl: "https://inference.local/v1",
    endpointSource: "inference-set",
    credentialEnv: value.service === "llama-cpp" ? "NEMOCLAW_LLAMACPP_LOCAL_TOKEN" : null,
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: `${name}-generation-1`,
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(value),
    ...overrides,
  };
}

function requiredPrepared(
  value: PreparedHostLocalInferenceAuthority | null,
): PreparedHostLocalInferenceAuthority {
  expect(value).not.toBeNull();
  return value!;
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
  const destroyContainer = (value: HostLocalInferenceReceipt): HostLocalInferenceDestroyResult => {
    const status = present ? "removed" : "already-absent";
    present = false;
    return { status, receipt: value };
  };
  const defaultDestroy = (value: HostLocalInferenceReceipt): HostLocalInferenceDestroyResult =>
    value.runtime.kind === "host"
      ? { status: "retained", reason: "host-process", receipt: value }
      : destroyContainer(value);
  const destroy = vi.fn(options.destroy ?? defaultDestroy);
  const runtime: HostLocalInferenceRuntime = {
    providerId: "mxc",
    authorityId: options.authorityId ?? AUTHORITY_ID,
    services: PROVIDER_SERVICES,
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
    operationInputs.push(...(input === undefined ? [] : [input]));
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
    hostLocalInference: { services: PROVIDER_SERVICES, createOperation },
  });
  return {
    assertAuthority,
    bundle,
    createOperation,
    destroy,
    operationInputs,
    prepareDestroy,
    preserveForRebuild,
    runtime,
  };
}

function explicitLlamaSandbox(name = "alpha", agent = "openclaw"): SandboxEntry {
  const value = llamaCppReceipt();
  const serialized = serializeHostLocalInferenceReceipt(value);
  return sandbox(name, value, {
    agent,
    hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", serialized),
  });
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
        endpointSource: "inference-set",
        preferredInferenceApi: "openai-completions",
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

  it.each(AGENTS)(
    "routes explicitly provenanced llama.cpp for %s through the common coordinator",
    (agent) => {
      const entry = explicitLlamaSandbox("alpha", agent);
      const runtimeProvider = provider();
      const createLlamaCppAdapter = vi.fn((options) => ({
        gatewayPort: options.gatewayPort ?? 8080,
        runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
        model: "llama-cpp-model",
        operation: options.operation!,
        receipt: options.expectedReceipt,
        runtime: runtimeProvider.runtime,
        prepareStartup: vi.fn(),
      }));

      const prepared = requiredPrepared(
        prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, entry, {
          createLlamaCppAdapter,
        }),
      );

      expect(prepared.serializedReceipt).toBe(entry.hostLocalInferenceReceipt);
      expect(prepared.sandboxAuthority).toMatchObject({
        agent,
        routeProvider: "llama-cpp-local",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        hostLocalInferenceProvenance: entry.hostLocalInferenceProvenance,
      });
      expect(createLlamaCppAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeOwnerSandboxName: "alpha",
          gatewayPort: 8080,
          expectedReceipt: llamaCppReceipt(),
        }),
      );
      expect(runtimeProvider.preserveForRebuild).toHaveBeenCalledOnce();
    },
  );

  it("keeps an unmarked schema-v1 llama.cpp receipt on the dedicated legacy lifecycle", () => {
    const runtimeProvider = provider();
    const entry = sandbox("alpha", llamaCppReceipt());

    expect(prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, entry)).toBeNull();
    expect(runtimeProvider.createOperation).not.toHaveBeenCalled();
    expect(runtimeProvider.preserveForRebuild).not.toHaveBeenCalled();
  });

  it("rejects changed explicit llama.cpp provenance before provider mutation", () => {
    const runtimeProvider = provider();
    const entry = explicitLlamaSandbox();
    const drifted = {
      ...entry,
      hostLocalInferenceProvenance: {
        ...entry.hostLocalInferenceProvenance!,
        receiptSha256: "0".repeat(64),
      },
    };

    expect(() =>
      prepareSandboxHostLocalInferenceAuthority(runtimeProvider.bundle, drifted, {
        createLlamaCppAdapter: vi.fn(),
      }),
    ).toThrow(/provenance does not match its receipt/);
    expect(runtimeProvider.createOperation).not.toHaveBeenCalled();
  });

  it("retains an exact same-gateway llama.cpp runtime while a provenanced clone remains", () => {
    const runtimeProvider = provider();
    const alpha = explicitLlamaSandbox("alpha");
    const beta = explicitLlamaSandbox("beta", "hermes");
    const createLlamaCppAdapter = vi.fn((options) => ({
      gatewayPort: options.gatewayPort ?? 8080,
      runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
      model: "llama-cpp-model",
      operation: options.operation!,
      receipt: options.expectedReceipt,
      runtime: runtimeProvider.runtime,
      prepareStartup: vi.fn(),
    }));
    const lifecycleOptions = { createLlamaCppAdapter };
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(
        runtimeProvider.bundle,
        alpha,
        lifecycleOptions,
      ),
    );

    expect(
      retirePreparedHostLocalInferenceAuthority(
        runtimeProvider.bundle,
        alpha,
        prepared,
        [beta, alpha],
        lifecycleOptions,
      ).status,
    ).toBe("shared");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects a llama.cpp peer on a different gateway before retirement", () => {
    const runtimeProvider = provider();
    const alpha = explicitLlamaSandbox("alpha");
    const beta = { ...explicitLlamaSandbox("beta"), gatewayPort: 8090 };
    const createLlamaCppAdapter = vi.fn((options) => ({
      gatewayPort: options.gatewayPort ?? 8080,
      runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
      model: "llama-cpp-model",
      operation: options.operation!,
      receipt: options.expectedReceipt,
      runtime: runtimeProvider.runtime,
      prepareStartup: vi.fn(),
    }));
    const lifecycleOptions = { createLlamaCppAdapter };
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(
        runtimeProvider.bundle,
        alpha,
        lifecycleOptions,
      ),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(
        runtimeProvider.bundle,
        alpha,
        prepared,
        [alpha, beta],
        lifecycleOptions,
      ),
    ).toThrow(/conflicting gateway, route, or provenance authority/);
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects a llama.cpp peer with different route authority before retirement", () => {
    const runtimeProvider = provider();
    const alpha = explicitLlamaSandbox("alpha");
    const beta = {
      ...explicitLlamaSandbox("beta"),
      credentialEnv: "DIFFERENT_TOKEN",
    };
    const createLlamaCppAdapter = vi.fn((options) => ({
      gatewayPort: options.gatewayPort ?? 8080,
      runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
      model: "llama-cpp-model",
      operation: options.operation!,
      receipt: options.expectedReceipt,
      runtime: runtimeProvider.runtime,
      prepareStartup: vi.fn(),
    }));
    const lifecycleOptions = { createLlamaCppAdapter };
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(
        runtimeProvider.bundle,
        alpha,
        lifecycleOptions,
      ),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(
        runtimeProvider.bundle,
        alpha,
        prepared,
        [alpha, beta],
        lifecycleOptions,
      ),
    ).toThrow(/conflicting gateway, route, or provenance authority/);
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects a llama.cpp peer with different model authority before retirement", () => {
    const runtimeProvider = provider();
    const alpha = explicitLlamaSandbox("alpha");
    const beta = {
      ...explicitLlamaSandbox("beta"),
      model: "different-model",
    };
    const createLlamaCppAdapter = vi.fn((options) => ({
      gatewayPort: options.gatewayPort ?? 8080,
      runtimeOwnerSandboxName: options.runtimeOwnerSandboxName,
      model: "llama-cpp-model",
      operation: options.operation!,
      receipt: options.expectedReceipt,
      runtime: runtimeProvider.runtime,
      prepareStartup: vi.fn(),
    }));
    const lifecycleOptions = { createLlamaCppAdapter };
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(
        runtimeProvider.bundle,
        alpha,
        lifecycleOptions,
      ),
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(
        runtimeProvider.bundle,
        alpha,
        prepared,
        [alpha, beta],
        lifecycleOptions,
      ),
    ).toThrow(/conflicting gateway, route, or provenance authority/);
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

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
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        openshellDriver: "podman",
      }),
    ],
    [
      "route provider",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        provider: "ollama-local",
      }),
    ],
    [
      "model",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        model: "other-model",
      }),
    ],
    [
      "endpoint",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        endpointUrl: "http://127.0.0.1:8000/v1",
      }),
    ],
    [
      "endpoint source",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        endpointSource: "onboard",
      }),
    ],
    [
      "credential",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        credentialEnv: "DIFFERENT_TOKEN",
      }),
    ],
    [
      "inference API",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        preferredInferenceApi: "openai-responses",
      }),
    ],
    [
      "gateway",
      (entry: SandboxEntry): SandboxEntry => ({
        ...entry,
        gatewayName: "other-gateway",
      }),
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

  it("inspects prepared runtime presence without another destroy preflight", () => {
    const entry = sandbox();
    const runtimeProvider = provider();
    const prepared = requiredPrepared(
      prepareSandboxHostLocalInferenceDestroyAuthority(runtimeProvider.bundle, entry),
    );

    assertPreparedHostLocalInferenceRuntimePresent(runtimeProvider.bundle, entry, prepared);

    expect(runtimeProvider.prepareDestroy).toHaveBeenCalledOnce();
    expect(runtimeProvider.runtime.inspectManaged).toHaveBeenCalledWith(prepared.receipt);
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
