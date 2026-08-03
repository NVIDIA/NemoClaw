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

function receipt(service: "ollama" | "nim" | "vllm" = "vllm"): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    service,
    engineAuthority: ENGINE_AUTHORITY,
    endpoint: {
      host: "host.openshell.internal",
      port: service === "ollama" ? 11435 : 8000,
      networkName: "openshell",
    },
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
            specSha256: "d".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
          },
  };
}

describe("host-local inference receipt contract", () => {
  it.each([
    "ollama",
    "nim",
    "vllm",
  ] as const)("round-trips %s authority without Podman-specific state", (service) => {
    const expected = normalizeHostLocalInferenceReceipt(receipt(service));
    const serialized = serializeHostLocalInferenceReceipt(expected);

    expect(parseHostLocalInferenceReceipt(serialized)).toEqual(expected);
    expect(expected.providerId).toBe("mxc");
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected.endpoint)).toBe(true);
    expect(Object.isFrozen(expected.runtime)).toBe(true);
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

  it("rejects extensions and noncanonical serialized receipts", () => {
    const base = receipt();
    expect(() => normalizeHostLocalInferenceReceipt({ ...base, extra: true })).toThrow(
      "receipt schema is unsupported",
    );
    expect(() => parseHostLocalInferenceReceipt(JSON.stringify(base))).toThrow("not canonical");
  });
});
