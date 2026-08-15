// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  HostLocalInferenceOperation,
  HostLocalInferencePublicationState,
  HostLocalInferenceReceipt,
  HostLocalInferenceReceiptWriter,
  HostLocalInferenceRuntime,
} from "./host-local-inference";
import {
  HOST_LOCAL_INFERENCE_APPLICATIONS,
  hostLocalInferenceApplicationBaseUrl,
  hostLocalInferenceOperationEnvironment,
  prepareHostLocalInferenceStartup,
} from "./host-local-inference-routing";

const AUTHORITY_ID = `mxc-endpoint:${"a".repeat(64)}`;
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"b".repeat(64)}`;
const MANAGED_IMAGE = `nvcr.io/nvidia/inference@sha256:${"c".repeat(64)}`;
const NETWORK_ID = "2".repeat(64);
const NETWORK_GATEWAY_IP = "10.89.0.1";
const NETWORK_AUTHORITY = "3".repeat(64);
const writer: HostLocalInferenceReceiptWriter = {
  transactionId: "f".repeat(64),
  targetSha256: "1".repeat(64),
  writeExact: (value) => value,
};

function receipt(service: "ollama" | "nim" | "vllm"): HostLocalInferenceReceipt {
  return {
    schemaVersion: 2,
    providerId: "mxc",
    service,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "mxc",
      authorityId: AUTHORITY_ID,
      bindingSha256: "d".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: service === "ollama" ? 11434 : service === "nim" ? 8001 : 8000,
      networkName: "mxc-runtime-network",
      networkId: NETWORK_ID,
      networkGatewayIp: NETWORK_GATEWAY_IP,
      networkAuthoritySha256: NETWORK_AUTHORITY,
    },
    inference: {
      protocol: "openai-chat-completions",
      model: service === "ollama" ? "qwen3.5:9b" : "model-a",
      toolCallingRequired: true,
    },
    publication: {
      transactionId: writer.transactionId,
      targetSha256: writer.targetSha256,
      priorState: service === "ollama" ? "host-process" : "absent",
    },
    runtime:
      service === "ollama"
        ? {
            kind: "host",
            probeImageRef: PROBE_IMAGE,
            acceleration: "nvidia-gpu",
            modelDigest: `sha256:${"8".repeat(64)}`,
          }
        : {
            kind: "container",
            runtimeId: `mxc-runtime:${service}`,
            name: `nemoclaw-${service}`,
            imageRef: MANAGED_IMAGE,
            probeImageRef: PROBE_IMAGE,
            specSha256: "e".repeat(64),
            launchSha256: "5".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
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
      engineId: "mxc",
      authorityId: AUTHORITY_ID,
      bindingSha256: "d".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 8081,
      networkName: "nemoclaw-llama-cpp-internal",
    },
    runtime: {
      kind: "container",
      runtimeId: "6".repeat(64),
      name: "nemoclaw-llama-cpp",
      imageRef: MANAGED_IMAGE,
      probeImageRef: PROBE_IMAGE,
      specSha256: "7".repeat(64),
      model: {
        planDigest: `sha256:${"8".repeat(64)}`,
        recipeId: "llama-cpp-model",
        generation: "9".repeat(64),
        digest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 1024,
      },
      gpu: { vendor: "nvidia", count: 1 },
    },
  };
}

function prepared(value: HostLocalInferenceReceipt) {
  const rollbackPriorState = value.publication?.priorState ?? "absent";
  return {
    receipt: value,
    rollbackPriorState,
    publicationState: vi.fn((): HostLocalInferencePublicationState => "unpublished"),
    validateBeforeCommit: vi.fn(() => value),
    commit: vi.fn(() => value),
    rollback: vi.fn(() => ({
      status: value.runtime.kind === "host" ? ("retained" as const) : ("removed" as const),
      priorState: rollbackPriorState,
      receipt: value,
    })),
  };
}

function runtime(): HostLocalInferenceRuntime {
  return {
    providerId: "mxc",
    authorityId: AUTHORITY_ID,
    services: ["ollama", "nim", "vllm", "llama-cpp"],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(() => prepared(receipt("ollama"))),
    startManaged: vi.fn((input) => prepared(receipt(input.service))),
    inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
    stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
    preserveForRebuild: vi.fn((value) => value),
    prepareDestroy: vi.fn((value) => value),
    destroy: vi.fn((value) => ({ status: "removed" as const, receipt: value })),
  };
}

function operation(
  managedRuntime: HostLocalInferenceRuntime = runtime(),
): HostLocalInferenceOperation {
  return {
    providerId: "mxc",
    engine: {
      operation: "host-local-inference",
      engineId: "mxc",
      displayName: "MXC",
      authorityId: AUTHORITY_ID,
    } as HostLocalInferenceOperation["engine"],
    bindingSha256: "d".repeat(64),
    assertAuthority: vi.fn(),
    spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
    createLlamaCppLifecycle: vi.fn(),
    managedRuntime,
  };
}

const endpoint = {
  acceleration: "nvidia-gpu",
  model: "qwen3.5:9b",
  requireToolCalling: true,
  networkName: "mxc-runtime-network",
  networkId: NETWORK_ID,
  networkGatewayIp: NETWORK_GATEWAY_IP,
  hostPort: 11434,
  probeImageRef: PROBE_IMAGE,
} as const;

const managed = (service: "nim" | "vllm") => ({
  service,
  model: "model-a",
  requireToolCalling: true,
  containerName: `nemoclaw-${service}`,
  containerPort: 8000,
  imageRef: MANAGED_IMAGE,
  gpuDevices: ["nvidia.com/gpu=all"],
  networkName: "mxc-runtime-network",
  networkId: NETWORK_ID,
  networkGatewayIp: NETWORK_GATEWAY_IP,
  hostPort: service === "nim" ? 8001 : 8000,
  probeImageRef: PROBE_IMAGE,
});

describe("provider-neutral host-local inference startup routing", () => {
  it("passes only service-required credentials through a null-prototype operation environment", () => {
    const source = {
      NGC_API_KEY: "ngc-secret",
      NIM_NGC_API_KEY: "nim-secret",
      AWS_SECRET_ACCESS_KEY: "unrelated-secret",
      GITHUB_TOKEN: "unrelated-token",
    };

    const nim = hostLocalInferenceOperationEnvironment("nim", source);
    expect(Object.getPrototypeOf(nim)).toBeNull();
    expect({ ...nim }).toEqual({
      NGC_API_KEY: "ngc-secret",
      NIM_NGC_API_KEY: "nim-secret",
    });
    expect(Object.keys(hostLocalInferenceOperationEnvironment("ollama", source))).toEqual([]);
    expect(Object.keys(hostLocalInferenceOperationEnvironment("vllm", source))).toEqual([]);
    expect(Object.keys(hostLocalInferenceOperationEnvironment("llama-cpp", source))).toEqual([]);
  });

  it.each(HOST_LOCAL_INFERENCE_APPLICATIONS)(
    "resumes explicitly selected llama.cpp for %s through the same route transaction",
    (application) => {
      const value = llamaCppReceipt();
      const providerRuntime = runtime();
      const providerOperation = operation(providerRuntime);
      const prepareStartup = vi.fn(() => prepared(value));
      const route = prepareHostLocalInferenceStartup(providerOperation, {
        application,
        service: "llama-cpp",
        adapter: {
          gatewayPort: 8080,
          runtimeOwnerSandboxName: "llama-owner",
          model: "llama-cpp-model",
          operation: providerOperation,
          receipt: value,
          runtime: providerRuntime,
          prepareStartup,
        },
        requireToolCalling: true,
        publishedRoute: true,
  });

      expect(route.gatewayProvider).toBe("llama-cpp-local");
      expect(route.gatewayProviderBaseUrl).toBe("http://host.openshell.internal:8081/v1");
      expect(route.applicationBaseUrl).toBe("https://inference.local/v1");
      expect(route.receipt).toEqual(value);
      expect(prepareStartup).toHaveBeenCalledOnce();
      expect(providerRuntime.startManaged).not.toHaveBeenCalled();
      expect(providerRuntime.qualifyOllama).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ollama", "ollama-local", "http://host.openshell.internal:11434/v1"],
    ["nim", "vllm-local", "http://host.openshell.internal:8001/v1"],
    ["vllm", "vllm-local", "http://host.openshell.internal:8000/v1"],
  ] as const)(
    "starts %s without exposing the provider-native host",
    (service, provider, baseUrl) => {
      const providerRuntime = runtime();
      const route = prepareHostLocalInferenceStartup(
        operation(providerRuntime),
        service === "ollama"
          ? { application: "openclaw", service, endpoint, receiptWriter: writer }
          : {
              application: "openclaw",
              service,
              managed: managed(service),
              receiptWriter: writer,
            },
      );

      expect(route.gatewayProvider).toBe(provider);
      expect(route.gatewayProviderBaseUrl).toBe(baseUrl);
      expect(route.gatewayProviderBaseUrl).not.toContain("mxc-provider-native.internal");
      expect(route.applicationBaseUrl).toBe("https://inference.local/v1");
    },
  );

  it("presents the same inference.local route to every supported application", () => {
    const route = prepareHostLocalInferenceStartup(operation(), {
      application: "openclaw",
      service: "vllm",
      managed: managed("vllm"),
      receiptWriter: writer,
    });

    expect(
      HOST_LOCAL_INFERENCE_APPLICATIONS.map((application) =>
        hostLocalInferenceApplicationBaseUrl(application, route),
      ),
    ).toEqual([
      "https://inference.local/v1",
      "https://inference.local/v1",
      "https://inference.local/v1",
    ]);
  });

  it("rejects an application outside the all-agent route boundary", () => {
    const providerRuntime = runtime();
    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "unknown-agent" as "openclaw",
        service: "ollama",
        endpoint,
        receiptWriter: writer,
      }),
    ).toThrow("Unsupported host-local inference application");
    expect(providerRuntime.qualifyOllama).not.toHaveBeenCalled();
    expect(providerRuntime.startManaged).not.toHaveBeenCalled();
  });

  it("fails closed on service and runtime authority drift", () => {
    const providerRuntime = runtime();
    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "openclaw",
        service: "nim",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("service identity is inconsistent");

    const drifted = runtime();
    const driftedStartup = prepared({
      ...receipt("vllm"),
      engineAuthority: {
        ...receipt("vllm").engineAuthority,
        authorityId: `other-endpoint:${"f".repeat(64)}`,
      },
    });
    drifted.startManaged = vi.fn(() => driftedStartup);
    expect(() =>
      prepareHostLocalInferenceStartup(operation(drifted), {
        application: "openclaw",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("different runtime, proof, or publication authority");
    expect(driftedStartup.rollback).toHaveBeenCalledOnce();
  });

  it("rejects receipt engine identity and binding drift", () => {
    const driftedEngine = runtime();
    const driftedEngineStartup = prepared({
      ...receipt("vllm"),
      engineAuthority: {
        ...receipt("vllm").engineAuthority,
        engineId: "other-engine",
      },
    });
    driftedEngine.startManaged = vi.fn(() => driftedEngineStartup);
    expect(() =>
      prepareHostLocalInferenceStartup(operation(driftedEngine), {
        application: "openclaw",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("different runtime, proof, or publication authority");
    expect(driftedEngineStartup.rollback).toHaveBeenCalledOnce();

    const driftedBinding = runtime();
    const driftedBindingStartup = prepared({
      ...receipt("vllm"),
      engineAuthority: {
        ...receipt("vllm").engineAuthority,
        bindingSha256: "9".repeat(64),
      },
    });
    driftedBinding.startManaged = vi.fn(() => driftedBindingStartup);
    expect(() =>
      prepareHostLocalInferenceStartup(operation(driftedBinding), {
        application: "hermes",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("different runtime, proof, or publication authority");
    expect(driftedBindingStartup.rollback).toHaveBeenCalledOnce();
  });

  it("rejects authenticated vLLM without a memory-only gateway credential handoff", () => {
    const providerRuntime = runtime();

    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "openclaw",
        service: "vllm",
        managed: { ...managed("vllm"), environment: ["VLLM_API_KEY"] },
        receiptWriter: writer,
      }),
    ).toThrow("Authenticated managed vLLM is unsupported");
    expect(providerRuntime.startManaged).not.toHaveBeenCalled();
  });

  it("rejects non-boolean recovery authority at the provider-neutral runtime boundary", () => {
    const providerRuntime = runtime();
    providerRuntime.recoverManaged = vi.fn(() => prepared(receipt("vllm")));

    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "openclaw",
        service: "vllm",
        managed: managed("vllm"),
        recover: 1 as unknown as boolean,
        receiptWriter: writer,
      }),
    ).toThrow("recovery authority is invalid");
    expect(providerRuntime.recoverManaged).not.toHaveBeenCalled();
    expect(providerRuntime.startManaged).not.toHaveBeenCalled();
  });

  it("fails closed on provider-native inference and publication proof drift", () => {
    const driftedProof = runtime();
    const driftedProofStartup = prepared({
      ...receipt("ollama"),
      inference: {
        protocol: "openai-chat-completions",
        model: "other-model",
        toolCallingRequired: true,
      },
    });
    driftedProof.qualifyOllama = vi.fn(() => driftedProofStartup);
    expect(() =>
      prepareHostLocalInferenceStartup(operation(driftedProof), {
        application: "openclaw",
        service: "ollama",
        endpoint,
        receiptWriter: writer,
      }),
    ).toThrow("different runtime, proof, or publication authority");
    expect(driftedProofStartup.rollback).toHaveBeenCalledOnce();

    const driftedPublication = runtime();
    const driftedPublicationStartup = prepared({
      ...receipt("vllm"),
      publication: { ...receipt("vllm").publication!, targetSha256: "9".repeat(64) },
    });
    driftedPublication.startManaged = vi.fn(() => driftedPublicationStartup);
    expect(() =>
      prepareHostLocalInferenceStartup(operation(driftedPublication), {
        application: "hermes",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("different runtime, proof, or publication authority");
    expect(driftedPublicationStartup.rollback).toHaveBeenCalledOnce();
  });

  it("binds endpoint, immutable images, runtime name, and canonical CDI devices", () => {
    const base = receipt("vllm");
    expect(base.runtime.kind).toBe("container");
    const baseRuntime = base.runtime as Extract<
      HostLocalInferenceReceipt["runtime"],
      { readonly kind: "container" }
    >;
    const request = managed("vllm");
    const cases: HostLocalInferenceReceipt[] = [
      { ...base, endpoint: { ...base.endpoint, host: "host.openshell.internal.evil" } },
      { ...base, endpoint: { ...base.endpoint, port: 9000 } },
      { ...base, endpoint: { ...base.endpoint, networkName: "other-network" } },
      { ...base, endpoint: { ...base.endpoint, networkId: "4".repeat(64) } },
      { ...base, endpoint: { ...base.endpoint, networkGatewayIp: "10.89.0.2" } },
      {
        ...base,
        runtime: {
          ...baseRuntime,
          probeImageRef: `quay.io/curl/curl@sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...base,
        runtime: { ...baseRuntime, name: "other-runtime" },
      },
      {
        ...base,
        runtime: {
          ...baseRuntime,
          imageRef: `nvcr.io/nvidia/inference@sha256:${"8".repeat(64)}`,
        },
      },
      {
        ...base,
        runtime: {
          ...baseRuntime,
          gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=1"] },
        },
      },
    ];

    for (const value of cases) {
      const providerRuntime = runtime();
      const rejected = prepared(value);
      providerRuntime.startManaged = vi.fn(() => rejected);

      expect(() =>
        prepareHostLocalInferenceStartup(operation(providerRuntime), {
          application: "langchain-deepagents-code",
          service: "vllm",
          managed: request,
          receiptWriter: writer,
        }),
      ).toThrow("different runtime, proof, or publication authority");
      expect(rejected.rollback).toHaveBeenCalledOnce();
    }

    const reorderedDevices = runtime();
    const multiGpuRequest = { ...request, gpuDevices: ["1", "nvidia.com/gpu=0"] };
    const accepted = prepared({
      ...base,
      runtime: {
        ...baseRuntime,
        gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=0", "nvidia.com/gpu=1"] },
      },
    });
    reorderedDevices.startManaged = vi.fn(() => accepted);
    expect(
      prepareHostLocalInferenceStartup(operation(reorderedDevices), {
        application: "openclaw",
        service: "vllm",
        managed: multiGpuRequest,
        receiptWriter: writer,
      }).receipt,
    ).toEqual(accepted.receipt);
    expect(accepted.rollback).not.toHaveBeenCalled();
  });

  it("rejects a managed proof receipt without immutable network identity", () => {
    const base = receipt("vllm");
    const rejected = prepared({
      ...base,
      endpoint: {
        host: base.endpoint.host,
        port: base.endpoint.port,
        networkName: base.endpoint.networkName,
      },
    });
    const providerRuntime = runtime();
    providerRuntime.startManaged = vi.fn(() => rejected);

    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "openclaw",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("could not prove exact prior-runtime restoration");
    expect(rejected.rollback).toHaveBeenCalledOnce();
  });

  it("binds Ollama endpoint, network, and immutable probe image authority", () => {
    const base = receipt("ollama");
    expect(base.runtime.kind).toBe("host");
    const baseRuntime = base.runtime as Extract<
      HostLocalInferenceReceipt["runtime"],
      { readonly kind: "host" }
    >;
    const cases: HostLocalInferenceReceipt[] = [
      { ...base, endpoint: { ...base.endpoint, host: "HOST.openshell.internal" } },
      { ...base, endpoint: { ...base.endpoint, port: 11435 } },
      { ...base, endpoint: { ...base.endpoint, networkName: "other-network" } },
      { ...base, endpoint: { ...base.endpoint, networkId: "4".repeat(64) } },
      { ...base, endpoint: { ...base.endpoint, networkGatewayIp: "10.89.0.2" } },
      {
        ...base,
        runtime: {
          ...baseRuntime,
          probeImageRef: `quay.io/curl/curl@sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...base,
        runtime: { ...baseRuntime, acceleration: "cpu" },
      },
    ];

    for (const value of cases) {
      const providerRuntime = runtime();
      const rejected = prepared(value);
      providerRuntime.qualifyOllama = vi.fn(() => rejected);

      expect(() =>
        prepareHostLocalInferenceStartup(operation(providerRuntime), {
          application: "hermes",
          service: "ollama",
          endpoint,
          receiptWriter: writer,
        }),
      ).toThrow("different runtime, proof, or publication authority");
      expect(rejected.rollback).toHaveBeenCalledOnce();
    }
  });

  it("fails closed when rejected startup rollback evidence is indeterminate", () => {
    const providerRuntime = runtime();
    const rejected = prepared({
      ...receipt("vllm"),
      endpoint: { ...receipt("vllm").endpoint, port: 9000 },
    });
    rejected.rollback.mockImplementation(() => {
      throw new Error("cleanup identity indeterminate");
    });
    providerRuntime.startManaged = vi.fn(() => rejected);

    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "openclaw",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("could not prove exact prior-runtime restoration");
    expect(rejected.rollback).toHaveBeenCalledOnce();
  });

  it("does not destructively roll back a rejected startup after publication is indeterminate", () => {
    const providerRuntime = runtime();
    const rejected = prepared({
      ...receipt("vllm"),
      endpoint: { ...receipt("vllm").endpoint, port: 9000 },
    });
    rejected.publicationState.mockReturnValue("indeterminate");
    providerRuntime.startManaged = vi.fn(() => rejected);

    expect(() =>
      prepareHostLocalInferenceStartup(operation(providerRuntime), {
        application: "openclaw",
        service: "vllm",
        managed: managed("vllm"),
        receiptWriter: writer,
      }),
    ).toThrow("could not prove exact prior-runtime restoration");
    expect(rejected.rollback).not.toHaveBeenCalled();
  });

  it("rejects an operation whose provider runtime crosses engine authority", () => {
    const drifted = runtime();
    Object.defineProperty(drifted, "authorityId", { value: `other:${"9".repeat(64)}` });

    expect(() =>
      prepareHostLocalInferenceStartup(operation(drifted), {
        application: "hermes",
        service: "ollama",
        endpoint,
        receiptWriter: writer,
      }),
    ).toThrow("operation returned a different runtime authority");
  });
});
