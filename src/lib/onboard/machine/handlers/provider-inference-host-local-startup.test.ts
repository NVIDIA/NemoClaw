// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { HostLocalInferenceReceipt } from "../../runtime-provider/host-local-inference";
import type {
  HostLocalInferenceApplication,
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
} from "../../runtime-provider/host-local-inference-routing";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"b".repeat(64)}`;
const NIM_IMAGE = `nvcr.io/nim/meta/llama@sha256:${"d".repeat(64)}`;
const MANAGED_IMAGE = `nvcr.io/nvidia/vllm@sha256:${"c".repeat(64)}`;
const NETWORK_ID = "2".repeat(64);
const NETWORK_GATEWAY_IP = "10.89.0.1";
const NETWORK_AUTHORITY = "3".repeat(64);
const receiptWriter = {
  transactionId: "f".repeat(64),
  targetSha256: "1".repeat(64),
  writeExact: (value: string) => value,
};

function publishedManagedReceipt(
  service: "nim" | "vllm",
  model: string,
  requireToolCalling: boolean,
): HostLocalInferenceReceipt {
  const port = service === "nim" ? 8001 : 8000;
  return {
    schemaVersion: 2,
    providerId: "mxc",
    service,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "mxc",
      authorityId: `mxc-endpoint:${"a".repeat(64)}`,
      bindingSha256: "e".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port,
      networkName: "mxc-runtime-network",
      networkId: NETWORK_ID,
      networkGatewayIp: NETWORK_GATEWAY_IP,
      networkAuthoritySha256: NETWORK_AUTHORITY,
    },
    inference: {
      protocol: "openai-chat-completions",
      model,
      toolCallingRequired: requireToolCalling,
    },
    publication: {
      transactionId: receiptWriter.transactionId,
      targetSha256: receiptWriter.targetSha256,
      priorState: "absent",
    },
    runtime: {
      kind: "container",
      runtimeId: `mxc-runtime:${service}`,
      name: `nemoclaw-${service}`,
      imageRef: service === "nim" ? NIM_IMAGE : MANAGED_IMAGE,
      probeImageRef: PROBE_IMAGE,
      specSha256: "6".repeat(64),
      launchSha256: "7".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
}

function hostLocalStartupSelection(
  input: HostLocalInferenceStartupSelectionInput,
  service: "ollama" | "nim" | "vllm" = "ollama",
  recoveredToolCallingRequired = true,
  recoveryKind: "published" | "interrupted" = "published",
): HostLocalInferenceStartupSelection {
  const requireToolCalling = input.requireToolCalling ?? recoveredToolCallingRequired;
  return {
    runtimeProviderId: "mxc",
    request:
      service === "ollama"
        ? {
            application: input.application,
            service,
            endpoint: {
              model: input.model,
              requireToolCalling,
              networkName: "mxc-runtime-network",
              networkId: NETWORK_ID,
              networkGatewayIp: NETWORK_GATEWAY_IP,
              hostPort: 11434,
              probeImageRef: PROBE_IMAGE,
            },
            receiptWriter,
          }
        : {
            application: input.application,
            service,
            ...(input.recover
              ? recoveryKind === "published"
                ? {
                    resumeReceipt: publishedManagedReceipt(
                      service,
                      input.model,
                      requireToolCalling,
                    ),
                  }
                : { recover: true }
              : {}),
            managed: {
              service,
              model: input.model,
              requireToolCalling,
              networkName: "mxc-runtime-network",
              networkId: NETWORK_ID,
              networkGatewayIp: NETWORK_GATEWAY_IP,
              hostPort: service === "nim" ? 8001 : 8000,
              probeImageRef: PROBE_IMAGE,
              containerName: service === "nim" ? "nemoclaw-nim" : "nemoclaw-vllm",
              containerPort: service === "nim" ? 8001 : 8000,
              imageRef: service === "nim" ? NIM_IMAGE : MANAGED_IMAGE,
              gpuDevices: ["nvidia.com/gpu=all"],
            },
            receiptWriter,
          },
    resolveRuntimeProvider: () => null,
    prepareGatewayMutation: async () => ({ commit: () => {}, rollback: () => {} }),
  };
}

function hostLocalPublishedResumeSelection(
  input: HostLocalInferenceStartupSelectionInput,
  service: "nim" | "vllm" = "vllm",
): HostLocalInferenceStartupSelection {
  const selected = hostLocalStartupSelection(input, service);
  const managedRequest =
    selected.request.service === "ollama"
      ? (() => {
          throw new Error("managed published-resume test selection unexpectedly resolved Ollama");
        })()
      : selected.request;
  return {
    ...selected,
    request: {
      ...managedRequest,
      resumeReceipt: publishedManagedReceipt(
        service,
        input.model,
        input.requireToolCalling ?? true,
      ),
    },
  };
}

describe("provider inference host-local startup selection", () => {
  it("leaves the current provider path unchanged when the resolver returns null", async () => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.complete.mockResolvedValue(session);

    const result = await handleProviderInferenceState(baseOptions(deps, session));

    expect(calls.resolveHostLocalInferenceStartupSelection).toHaveBeenCalledWith({
      application: "openclaw",
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "nvidia/test",
      requireToolCalling: true,
      allowPublishedResume: false,
      recover: false,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).not.toHaveProperty("hostLocalInference");
    expect(result.hostLocalInferenceRouteOnly).toBe(false);
  });

  it.each(
    (["openclaw", "hermes", "langchain-deepagents-code"] as const).flatMap((application) =>
      (["ollama", "nim", "vllm"] as const).map((service) => ({ application, service })),
    ),
  )("carries accepted $service startup authority into $application inference setup", async ({
    application,
    service,
  }) => {
    const model = "qwen3.5-9b";
    const provider = service === "ollama" ? "ollama-local" : "vllm-local";
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider,
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input, service),
    );
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const session = createSession();
    calls.complete.mockResolvedValue(session);

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: application },
      sandboxName: `${application}-sandbox`,
    });

    expect(resolver).toHaveBeenCalledWith({
      application,
      sandboxName: `${application}-sandbox`,
      provider,
      model,
      requireToolCalling: true,
      allowPublishedResume: false,
      recover: false,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        hostLocalInference: expect.objectContaining({ runtimeProviderId: "mxc" }),
      }),
    );
    expect(setupCall[7]).not.toHaveProperty("preparedOllamaProxyToken");
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      hostLocalInferenceRouteOnly: true,
      hostLocalInferenceSandboxProofAuthority: {
        service,
        directHostPort: service === "ollama" ? 11434 : service === "nim" ? 8001 : 8000,
        directHealthPath:
          service === "ollama" ? "/api/tags" : service === "nim" ? "/v1/health/ready" : "/health",
        toolCallingRequired: true,
      },
    });
  });

  it("carries a durable published receipt into managed runtime resume", async () => {
    const model = "persisted-served-alias";
    const session = createSession({
      provider: "vllm-local",
      model,
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input, "vllm"),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => false),
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    const options = baseOptions(deps, session);
    await handleProviderInferenceState({
      ...options,
      initial: { ...options.initial, endpointSource: "inference-set" },
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(resolver).toHaveBeenCalledWith({
      application: "openclaw",
      sandboxName: "my-assistant",
      provider: "vllm-local",
      model,
      requireToolCalling: null,
      allowPublishedResume: true,
      recover: true,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        hostLocalInference: expect.objectContaining({
          request: expect.objectContaining({
            service: "vllm",
            resumeReceipt: expect.objectContaining({
              providerId: "mxc",
              service: "vllm",
              inference: expect.objectContaining({ model }),
            }),
          }),
        }),
      }),
    );
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("heals the narrow published-route session-marker gap for %s from injected exact authority", async (application) => {
    const model = "persisted-served-alias";
    const session = createSession({
      provider: "vllm-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalPublishedResumeSelection(input),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => false),
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: application },
      resume: true,
      forceInferenceSetup: true,
      sandboxName: `${application}-sandbox`,
    });

    expect(resolver).toHaveBeenCalledWith({
      application,
      sandboxName: `${application}-sandbox`,
      provider: "vllm-local",
      model,
      requireToolCalling: true,
      allowPublishedResume: true,
      recover: false,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        hostLocalInference: expect.objectContaining({
          request: expect.objectContaining({
            service: "vllm",
            resumeReceipt: expect.objectContaining({
              providerId: "mxc",
              service: "vllm",
              inference: expect.objectContaining({ model }),
            }),
          }),
        }),
      }),
    );
    expect(
      (setupCall[7] as { hostLocalInference: HostLocalInferenceStartupSelection })
        .hostLocalInference.request,
    ).not.toHaveProperty("recover");
    expect(calls.complete).toHaveBeenCalledWith(
      "inference",
      expect.objectContaining({
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set",
      }),
    );
    expect(result).toMatchObject({
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      hostLocalInferenceRouteOnly: true,
    });
  });

  it("rejects an injected published receipt on a fresh managed selection", async () => {
    const model = "fresh-model";
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "vllm-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalPublishedResumeSelection(input),
    );
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        sandboxName: "fresh-sandbox",
      }),
    ).rejects.toThrow("recovery authority");

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPublishedResume: false,
        recover: false,
      }),
    );
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("starts a newly selected managed runtime during an unrelated resumed session", async () => {
    const model = "new-managed-model";
    const session = createSession({
      provider: "nvidia-prod",
      model: "nvidia/old-model",
      endpointUrl: null,
      credentialEnv: "NVIDIA_API_KEY",
    });
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "vllm-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input, "vllm"),
    );
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      forceProviderSelection: true,
      sandboxName: "my-assistant",
    });

    expect(resolver).toHaveBeenCalledWith({
      application: "openclaw",
      sandboxName: "my-assistant",
      provider: "vllm-local",
      model,
      requireToolCalling: true,
      allowPublishedResume: true,
      recover: false,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        hostLocalInference: expect.objectContaining({
          request: expect.not.objectContaining({ recover: true }),
        }),
      }),
    );
  });

  it("does not bypass injected recovery when a resumed gateway route is already Ready", async () => {
    const model = "persisted-served-alias";
    const session = createSession({
      provider: "vllm-local",
      model,
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input, "vllm"),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    const options = baseOptions(deps, session);
    const result = await handleProviderInferenceState({
      ...options,
      initial: { ...options.initial, endpointSource: "inference-set" },
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(resolver).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.skipped).not.toHaveBeenCalledWith("inference", expect.any(String));
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        endpointSource: "inference-set",
        hostLocalInference: expect.objectContaining({
          request: expect.objectContaining({
            service: "vllm",
            resumeReceipt: expect.objectContaining({ providerId: "mxc", service: "vllm" }),
          }),
        }),
      }),
    );
    expect(result.hostLocalInferenceRouteOnly).toBe(true);
    expect(result).toMatchObject({
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      hostLocalInferenceSandboxProofAuthority: {
        service: "vllm",
        directHostPort: 8000,
        directHealthPath: "/health",
        toolCallingRequired: true,
      },
    });
    expect(calls.complete).toHaveBeenCalledWith(
      "inference",
      expect.objectContaining({
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set",
      }),
    );
  });

  it("derives a tool-incompatible Ollama recovery contract from durable resolver authority", async () => {
    const model = "legacy-no-tools";
    const session = createSession({
      provider: "ollama-local",
      model,
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input, "ollama", false),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const options = baseOptions(deps, session);

    const result = await handleProviderInferenceState({
      ...options,
      initial: { ...options.initial, endpointSource: "inference-set" },
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(resolver).toHaveBeenCalledWith({
      application: "openclaw",
      sandboxName: "my-assistant",
      provider: "ollama-local",
      model,
      requireToolCalling: null,
      allowPublishedResume: true,
      recover: true,
    });
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        allowToolsIncompatible: true,
        hostLocalInference: expect.objectContaining({
          request: expect.objectContaining({
            endpoint: expect.objectContaining({ requireToolCalling: false }),
          }),
        }),
      }),
    );
    expect(result.hostLocalInferenceSandboxProofAuthority).toEqual(
      expect.objectContaining({ service: "ollama", toolCallingRequired: false }),
    );
  });

  it("fails closed when canonical resumed state loses its injected runtime resolver", async () => {
    const session = createSession({
      provider: "ollama-local",
      model: "qwen3.5-9b",
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const options = baseOptions(deps, session);
    await expect(
      handleProviderInferenceState({
        ...options,
        initial: { ...options.initial, endpointSource: "inference-set" },
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("requires exact injected runtime recovery authority");

    expect(calls.resolveHostLocalInferenceStartupSelection).toHaveBeenCalledOnce();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.routeReady).not.toHaveBeenCalled();
  });

  it("rejects interrupted-recovery authority for a canonically published managed route", async () => {
    const model = "persisted-served-alias";
    const session = createSession({
      provider: "vllm-local",
      model,
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: (input) =>
        hostLocalStartupSelection(input, "vllm", true, "interrupted"),
    });
    const options = baseOptions(deps, session);

    await expect(
      handleProviderInferenceState({
        ...options,
        initial: { ...options.initial, endpointSource: "inference-set" },
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("recovery authority");

    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rejects a resolver result for a different accepted application", async () => {
    const model = "qwen3.5-9b";
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) => {
      const selected = hostLocalStartupSelection(input);
      return {
        ...selected,
        request: { ...selected.request, application: "hermes" as const },
      };
    });
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        agent: { name: "openclaw" },
        sandboxName: "openclaw-sandbox",
      }),
    ).rejects.toThrow("accepted application");

    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rejects a resolver result cross-wired to a different accepted provider", async () => {
    const model = "qwen3.5-9b";
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: (input) =>
        hostLocalStartupSelection(input, "vllm"),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        sandboxName: "openclaw-sandbox",
      }),
    ).rejects.toThrow("accepted provider");

    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
