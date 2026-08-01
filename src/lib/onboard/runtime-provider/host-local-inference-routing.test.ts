// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostLocalInferenceReceipt, HostLocalInferenceRuntime } from "./host-local-inference";
import {
  HOST_LOCAL_INFERENCE_APPLICATIONS,
  hostLocalInferenceApplicationBaseUrl,
  prepareHostLocalInferenceStartup,
} from "./host-local-inference-routing";

const AUTHORITY_ID = `mxc-endpoint:${"a".repeat(64)}`;
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"b".repeat(64)}`;
const MANAGED_IMAGE = `nvcr.io/nvidia/inference@sha256:${"c".repeat(64)}`;

function receipt(service: "ollama" | "nim" | "vllm"): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
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
      host: "mxc-provider-native.internal",
      port: service === "ollama" ? 11434 : service === "nim" ? 8001 : 8000,
      networkName: "mxc-runtime-network",
    },
    runtime:
      service === "ollama"
        ? { kind: "host", probeImageRef: PROBE_IMAGE }
        : {
            kind: "container",
            runtimeId: `mxc-runtime:${service}`,
            name: `nemoclaw-${service}`,
            imageRef: MANAGED_IMAGE,
            specSha256: "e".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
          },
  };
}

function runtime(): HostLocalInferenceRuntime {
  return {
    providerId: "mxc",
    authorityId: AUTHORITY_ID,
    services: ["ollama", "nim", "vllm"],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(() => receipt("ollama")),
    startManaged: vi.fn((input) => receipt(input.service)),
    inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
    stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
    preserveForRebuild: vi.fn((value) => value),
  };
}

const endpoint = {
  networkName: "mxc-runtime-network",
  hostPort: 11434,
  probeImageRef: PROBE_IMAGE,
} as const;

const managed = (service: "nim" | "vllm") => ({
  service,
  containerName: `nemoclaw-${service}`,
  containerPort: 8000,
  imageRef: MANAGED_IMAGE,
  gpuDevices: ["nvidia.com/gpu=all"],
  networkName: "mxc-runtime-network",
  hostPort: service === "nim" ? 8001 : 8000,
  probeImageRef: PROBE_IMAGE,
});

describe("provider-neutral host-local inference startup routing", () => {
  it.each([
    ["ollama", "ollama-local", "http://host.openshell.internal:11434/v1"],
    ["nim", "vllm-local", "http://host.openshell.internal:8001/v1"],
    ["vllm", "vllm-local", "http://host.openshell.internal:8000/v1"],
  ] as const)("starts %s without exposing the provider-native host", (service, provider, baseUrl) => {
    const providerRuntime = runtime();
    const route = prepareHostLocalInferenceStartup(
      providerRuntime,
      service === "ollama" ? { service, endpoint } : { service, managed: managed(service) },
    );

    expect(route.gatewayProvider).toBe(provider);
    expect(route.gatewayProviderBaseUrl).toBe(baseUrl);
    expect(route.gatewayProviderBaseUrl).not.toContain("mxc-provider-native.internal");
    expect(route.applicationBaseUrl).toBe("https://inference.local/v1");
  });

  it("presents the same inference.local route to every supported application", () => {
    const route = prepareHostLocalInferenceStartup(runtime(), {
      service: "vllm",
      managed: managed("vllm"),
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

  it("fails closed on service and runtime authority drift", () => {
    const providerRuntime = runtime();
    expect(() =>
      prepareHostLocalInferenceStartup(providerRuntime, {
        service: "nim",
        managed: managed("vllm"),
      }),
    ).toThrow("service identity is inconsistent");

    const drifted = runtime();
    drifted.startManaged = vi.fn(() => ({
      ...receipt("vllm"),
      engineAuthority: {
        ...receipt("vllm").engineAuthority,
        authorityId: `other-endpoint:${"f".repeat(64)}`,
      },
    }));
    expect(() =>
      prepareHostLocalInferenceStartup(drifted, {
        service: "vllm",
        managed: managed("vllm"),
      }),
    ).toThrow("different runtime authority");
  });
});
