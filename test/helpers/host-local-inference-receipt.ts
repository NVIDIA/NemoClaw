// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../src/lib/onboard/runtime-provider/host-local-inference";

export function hostLocalInferenceReceipt(providerId = "mxc"): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
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
    endpoint: { host: `${providerId}.internal`, port: 8000, networkName: `${providerId}-network` },
    runtime: {
      kind: "container",
      runtimeId: `${providerId}-vllm`,
      name: "nemoclaw-vllm",
      imageRef: `nvcr.io/nvidia/vllm@sha256:${"b".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"c".repeat(64)}`,
      specSha256: "d".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
}

export function serializedHostLocalInferenceReceipt(providerId = "mxc"): string {
  return serializeHostLocalInferenceReceipt(hostLocalInferenceReceipt(providerId));
}
