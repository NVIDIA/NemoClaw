// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type HostLocalInferenceReceipt,
  normalizeHostLocalInferenceReceipt,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";

const ENGINE_AUTHORITY = {
  schemaVersion: 1,
  providerId: "mxc",
  operation: "host-local-inference",
  engineId: "mxc",
  authorityId: `mxc-endpoint:${"a".repeat(64)}`,
  bindingSha256: "b".repeat(64),
} as const;

const GPU_UUID = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function receipt(
  service: "ollama" | "nim" | "vllm" | "llama-cpp" = "vllm",
): HostLocalInferenceReceipt {
  return {
    schemaVersion: service === "llama-cpp" ? 1 : 2,
    providerId: "mxc",
    service,
    engineAuthority: ENGINE_AUTHORITY,
    endpoint: {
      host: "host.openshell.internal",
      port: service === "ollama" ? 11435 : 8000,
      networkName: "openshell",
      ...(service === "llama-cpp"
        ? {}
        : {
            networkId: "3".repeat(64),
            networkGatewayIp: "10.89.0.1",
            networkAuthoritySha256: "4".repeat(64),
          }),
    },
    ...(service === "llama-cpp"
      ? {}
      : {
          inference: {
            protocol: "openai-chat-completions" as const,
            model: service === "ollama" ? "nemotron:latest" : "nvidia/nemotron",
            toolCallingRequired: true,
          },
          publication: {
            transactionId: "1".repeat(64),
            targetSha256: "2".repeat(64),
            priorState: service === "ollama" ? "host-process" : "absent",
          },
        }),
    runtime:
      service === "ollama"
        ? {
            kind: "host",
            probeImageRef: `quay.io/curl/curl@sha256:${"d".repeat(64)}`,
          }
        : {
            kind: "container",
            runtimeId: "mxc-runtime:alpha",
            name: `nemoclaw-${service}-alpha`,
            imageRef: `nvcr.io/nvidia/${service}@sha256:${"c".repeat(64)}`,
            probeImageRef: `quay.io/curl/curl@sha256:${"e".repeat(64)}`,
            specSha256: "d".repeat(64),
            ...(service === "llama-cpp" ? {} : { launchSha256: "e".repeat(64) }),
            ...(service === "llama-cpp"
              ? {
                  model: {
                    planDigest: `sha256:${"f".repeat(64)}`,
                    recipeId: "llama-cpp.nemotron.spark.v1",
                    generation: "9".repeat(64),
                    digest: `sha256:${"a".repeat(64)}`,
                    sizeBytes: 22_833_947_424,
                  },
                }
              : {}),
            gpu:
              service === "llama-cpp"
                ? { vendor: "nvidia", count: 1 }
                : { vendor: "nvidia", devices: [`nvidia.com/gpu=${GPU_UUID}`] },
          },
  };
}

function containerRuntime(value: HostLocalInferenceReceipt) {
  expect(value.runtime.kind).toBe("container");
  return value.runtime as Extract<HostLocalInferenceReceipt["runtime"], { kind: "container" }>;
}

describe("host-local inference receipt contract", () => {
  it.each([
    "ollama",
    "nim",
    "vllm",
    "llama-cpp",
  ] as const)("round-trips %s authority without provider-specific state", (service) => {
    const expected = normalizeHostLocalInferenceReceipt(receipt(service));
    const serialized = serializeHostLocalInferenceReceipt(expected);

    expect(parseHostLocalInferenceReceipt(serialized)).toEqual(expected);
    expect(expected.providerId).toBe("mxc");
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected.endpoint)).toBe(true);
    expect(Object.isFrozen(expected.runtime)).toBe(true);
  });

  it("requires declarative model authority only for llama.cpp receipts (#8395)", () => {
    const llamaCpp = receipt("llama-cpp");
    const llamaRuntime = containerRuntime(llamaCpp);
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...llamaCpp,
        runtime: { ...llamaRuntime, model: undefined },
      }),
    ).toThrow("model authority must be an object");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...llamaCpp,
        runtime: { ...llamaRuntime, gpu: { vendor: "nvidia", count: 2 } },
      }),
    ).toThrow("exactly one GPU");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...llamaCpp,
        runtime: {
          ...llamaRuntime,
          gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
        },
      }),
    ).toThrow("GPU authority schema is unsupported");

    for (const service of ["nim", "vllm"] as const) {
      const managed = receipt(service);
      expect(() =>
        normalizeHostLocalInferenceReceipt({
          ...managed,
          runtime: {
            ...managed.runtime,
            model: {
              planDigest: `sha256:${"f".repeat(64)}`,
              recipeId: "unexpected",
              generation: "9".repeat(64),
              digest: `sha256:${"a".repeat(64)}`,
              sizeBytes: 1,
            },
          },
        }),
      ).toThrow("container authority schema is unsupported");
    }
  });

  it("rejects malformed llama.cpp model identity without exposing executor state (#8395)", () => {
    const llamaCpp = receipt("llama-cpp");
    const llamaRuntime = containerRuntime(llamaCpp);
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...llamaCpp,
        runtime: {
          ...llamaRuntime,
          model: { ...llamaRuntime.model, digest: "mutable" },
        },
      }),
    ).toThrow("model digest is malformed");
    expect(JSON.stringify(normalizeHostLocalInferenceReceipt(llamaCpp))).not.toContain("hostPath");
  });

  it("rejects provider, operation, endpoint, image, and device authority drift", () => {
    const base = receipt();
    expect(() => normalizeHostLocalInferenceReceipt({ ...base, providerId: "other" })).toThrow(
      "does not match engine authority",
    );
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...base,
        engineAuthority: { ...ENGINE_AUTHORITY, operation: "sandbox-lifecycle" },
      }),
    ).toThrow("wrong operation scope");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...base,
        endpoint: { ...base.endpoint, port: 0 },
      }),
    ).toThrow("endpoint port is malformed");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...base,
        runtime: { ...base.runtime, imageRef: "nvcr.io/nvidia/vllm:latest" },
      }),
    ).toThrow("runtime image reference is malformed");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...base,
        runtime: {
          ...base.runtime,
          gpu: { vendor: "nvidia", devices: ["/dev/nvidia0"] },
        },
      }),
    ).toThrow("GPU device is malformed");
  });

  it("rejects a host runtime for managed services and container runtime for Ollama", () => {
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...receipt("nim"),
        runtime: {
          kind: "host",
          probeImageRef: `quay.io/curl/curl@sha256:${"d".repeat(64)}`,
        },
      }),
    ).toThrow("only Ollama");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...receipt("ollama"),
        runtime: receipt("vllm").runtime,
      }),
    ).toThrow("Ollama must use host-process authority");
  });

  it("rejects mutable probe images and malformed managed specification digests", () => {
    const ollama = receipt("ollama");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...ollama,
        runtime: { kind: "host", probeImageRef: "curlimages/curl:latest" },
      }),
    ).toThrow("runtime image reference is malformed");

    const vllm = receipt("vllm");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...vllm,
        runtime: { ...vllm.runtime, specSha256: "mutable" },
      }),
    ).toThrow("runtime specification digest is malformed");
  });

  it("requires the service-specific real-inference authority", () => {
    const ollama = receipt("ollama");
    expect(() => normalizeHostLocalInferenceReceipt({ ...ollama, inference: undefined })).toThrow(
      "inference proof authority must be an object",
    );
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...ollama,
        inference: {
          model: "nemotron:latest",
          protocol: "ollama-generate",
          toolCallingRequired: true,
        },
      }),
    ).toThrow("protocol is unsupported");

    const vllm = receipt("vllm");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...vllm,
        inference: { ...vllm.inference, model: "../../secret" },
      }),
    ).toThrow("inference model is malformed");

    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...vllm,
        inference: { ...vllm.inference, toolCallingRequired: "yes" },
      }),
    ).toThrow("tool-calling requirement is malformed");

    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...vllm,
        publication: { ...vllm.publication, targetSha256: "other" },
      }),
    ).toThrow("receipt publication target is malformed");

    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...vllm,
        publication: { ...vllm.publication, priorState: "unknown" },
      }),
    ).toThrow("receipt publication prior state is malformed");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...vllm,
        publication: { ...vllm.publication, priorState: "host-process" },
      }),
    ).toThrow("prior state does not match the service lifecycle");
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...ollama,
        publication: { ...ollama.publication, priorState: "absent" },
      }),
    ).toThrow("prior state does not match the service lifecycle");
  });

  it("keeps canonical schema-v1 non-llama receipts compatible", () => {
    const modern = receipt("vllm");
    const { inference: _inference, publication: _publication, ...legacy } = modern;
    const { launchSha256: _launchSha256, ...legacyRuntime } = containerRuntime(legacy);
    const normalized = normalizeHostLocalInferenceReceipt({
      ...legacy,
      schemaVersion: 1,
      endpoint: {
        host: legacy.endpoint.host,
        port: legacy.endpoint.port,
        networkName: legacy.endpoint.networkName,
      },
      runtime: legacyRuntime,
    });

    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.inference).toBeUndefined();
    expect(normalized.publication).toBeUndefined();
    expect(parseHostLocalInferenceReceipt(serializeHostLocalInferenceReceipt(normalized))).toEqual(
      normalized,
    );
  });

  it("rejects extensions and noncanonical serialized receipts", () => {
    const base = receipt();
    expect(() => normalizeHostLocalInferenceReceipt({ ...base, extra: true })).toThrow(
      "receipt schema is unsupported",
    );
    expect(() => parseHostLocalInferenceReceipt(JSON.stringify(base))).toThrow("not canonical");
  });
});
