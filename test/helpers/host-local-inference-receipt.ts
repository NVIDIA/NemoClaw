// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../src/lib/onboard/runtime-provider/host-local-inference";

export function hostLocalInferenceReceipt(providerId = "mxc"): HostLocalInferenceReceipt {
  return {
    schemaVersion: 2,
    providerId,
    service: "vllm",
    engineAuthority: {
      schemaVersion: 1,
      providerId,
      operation: "host-local-inference",
      engineId: providerId,
      authorityId: `${providerId}:host-local`,
      bindingSha256: "a".repeat(64),
    },
    endpoint: {
      host: `${providerId}.internal`,
      port: 8000,
      networkName: `${providerId}-network`,
      networkId: "e".repeat(64),
      networkGatewayIp: "10.89.0.1",
      networkAuthoritySha256: "f".repeat(64),
    },
    inference: {
      protocol: "openai-chat-completions",
      model: "model-a",
      toolCallingRequired: true,
    },
    publication: {
      transactionId: "1".repeat(64),
      targetSha256: "2".repeat(64),
      priorState: "absent",
    },
    runtime: {
      kind: "container",
      runtimeId: `${providerId}-vllm`,
      name: "nemoclaw-vllm",
      imageRef: `nvcr.io/nvidia/vllm@sha256:${"b".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"c".repeat(64)}`,
      specSha256: "d".repeat(64),
      launchSha256: "3".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
}

export function serializedHostLocalInferenceReceipt(providerId = "mxc"): string {
  return serializeHostLocalInferenceReceipt(hostLocalInferenceReceipt(providerId));
}

export function llamaCppHostLocalInferenceReceipt(
  providerId = "docker",
): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
    providerId,
    service: "llama-cpp",
    engineAuthority: {
      schemaVersion: 1,
      providerId,
      operation: "host-local-inference",
      engineId: providerId,
      authorityId: `${providerId}:host-local`,
      bindingSha256: "4".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 8081,
      networkName: "nemoclaw-llama-cpp-internal",
    },
    runtime: {
      kind: "container",
      runtimeId: "5".repeat(64),
      name: "nemoclaw-llama-cpp",
      imageRef: `nvcr.io/nvidia/llama-cpp@sha256:${"6".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"7".repeat(64)}`,
      specSha256: "8".repeat(64),
      model: {
        planDigest: `sha256:${"9".repeat(64)}`,
        recipeId: "nemotron-llama-cpp",
        generation: "a".repeat(64),
        digest: `sha256:${"b".repeat(64)}`,
        sizeBytes: 1024,
      },
      gpu: { vendor: "nvidia", count: 1 },
    },
  };
}

export function serializedLlamaCppHostLocalInferenceReceipt(providerId = "docker"): string {
  return serializeHostLocalInferenceReceipt(llamaCppHostLocalInferenceReceipt(providerId));
}
