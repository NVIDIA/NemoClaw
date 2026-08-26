// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { HostLocalInferenceReceipt } from "../../runtime-provider/host-local-inference";
import type {
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
} from "../../runtime-provider/host-local-inference-routing";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"b".repeat(64)}`;
const OLLAMA_IMAGE = `docker.io/ollama/ollama@sha256:${"e".repeat(64)}`;
const NETWORK_ID = "2".repeat(64);
const NETWORK_GATEWAY_IP = "10.89.0.1";
const NETWORK_AUTHORITY = "3".repeat(64);
const receiptWriter = {
  transactionId: "f".repeat(64),
  targetSha256: "1".repeat(64),
  writeExact: (value: string) => value,
};

function publishedManagedOllamaSelection(
  input: HostLocalInferenceStartupSelectionInput,
): HostLocalInferenceStartupSelection {
  const requireToolCalling = input.requireToolCalling ?? false;
  const receipt: HostLocalInferenceReceipt = {
    schemaVersion: 2,
    providerId: "podman",
    service: "ollama",
    engineAuthority: {
      schemaVersion: 1,
      providerId: "podman",
      operation: "host-local-inference",
      engineId: "podman",
      authorityId: `podman-endpoint:${"a".repeat(64)}`,
      bindingSha256: "e".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 11434,
      networkName: "nemoclaw-runtime-network",
      networkId: NETWORK_ID,
      networkGatewayIp: NETWORK_GATEWAY_IP,
      networkAuthoritySha256: NETWORK_AUTHORITY,
    },
    inference: {
      protocol: "openai-chat-completions",
      model: input.model,
      toolCallingRequired: requireToolCalling,
    },
    publication: {
      transactionId: receiptWriter.transactionId,
      targetSha256: receiptWriter.targetSha256,
      priorState: "absent",
    },
    runtime: {
      kind: "container",
      runtimeId: "podman-runtime:ollama",
      name: "nemoclaw-ollama",
      imageRef: OLLAMA_IMAGE,
      probeImageRef: PROBE_IMAGE,
      specSha256: "6".repeat(64),
      launchSha256: "7".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
  return {
    runtimeProviderId: "podman",
    request: {
      application: input.application,
      service: "ollama",
      resumeReceipt: receipt,
      managed: {
        service: "ollama",
        model: input.model,
        requireToolCalling,
        networkName: "nemoclaw-runtime-network",
        networkId: NETWORK_ID,
        networkGatewayIp: NETWORK_GATEWAY_IP,
        hostPort: 11434,
        probeImageRef: PROBE_IMAGE,
        containerName: "nemoclaw-ollama",
        containerPort: 11434,
        imageRef: OLLAMA_IMAGE,
        gpuDevices: ["nvidia.com/gpu=all"],
      },
      receiptWriter,
    },
    resolveRuntimeProvider: () => null,
    prepareGatewayMutation: async () => ({ commit: () => {}, rollback: () => {} }),
  };
}

describe("Hermes managed Ollama inference recovery", () => {
  it("heals a missing session route marker from exact published authority (#9211)", async () => {
    const model = "qwen3-vl:4b";
    const session = createSession({
      provider: "ollama-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      publishedManagedOllamaSelection(input),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: "hermes" },
      resume: true,
      sandboxName: "portable-hermes",
    });

    expect(resolver).toHaveBeenCalledWith({
      application: "hermes",
      sandboxName: "portable-hermes",
      provider: "ollama-local",
      model,
      acceleration: "nvidia-gpu",
      requireToolCalling: null,
      allowPublishedResume: true,
      recover: false,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        hostLocalInference: expect.objectContaining({
          request: expect.objectContaining({
            service: "ollama",
            resumeReceipt: expect.objectContaining({ service: "ollama" }),
          }),
        }),
      }),
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "inference",
      expect.objectContaining({
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set",
      }),
    );
    expect(result.hostLocalInferenceRouteOnly).toBe(true);
  });
});
