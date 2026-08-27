// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { llamaCppHostLocalInferenceReceipt } from "../../../../../test/helpers/host-local-inference-receipt";
import { createSession } from "../../../state/onboard-session";
import type { HostLocalInferenceReceipt } from "../../runtime-provider/host-local-inference";
import type {
  HostLocalInferenceApplication,
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
} from "../../runtime-provider/host-local-inference-routing";
import {
  createCachedHostLocalInferenceSetupResolver,
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./provider-inference";
import {
  baseOptions,
  baseSelection,
  createDeps,
  type Agent,
  type Gpu,
  type Host,
} from "./provider-inference.test-support";

type TestProviderInferenceOptions = ProviderInferenceStateOptions<Gpu, Agent, Host>;
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"b".repeat(64)}`;
const NIM_IMAGE = `nvcr.io/nim/meta/llama@sha256:${"d".repeat(64)}`;
const MANAGED_IMAGE = `nvcr.io/nvidia/vllm@sha256:${"c".repeat(64)}`;
const OLLAMA_IMAGE = `docker.io/ollama/ollama@sha256:${"e".repeat(64)}`;
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
  recoveryKind: "fresh" | "published" | "interrupted" = "published",
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
              acceleration: input.acceleration,
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
            ...(recoveryKind === "interrupted"
              ? { recover: true }
              : recoveryKind === "published" && input.recover
                ? {
                    resumeReceipt: publishedManagedReceipt(
                      service,
                      input.model,
                      requireToolCalling,
                    ),
                  }
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
  recoveredToolCallingRequired = true,
): HostLocalInferenceStartupSelection {
  const selected = hostLocalStartupSelection(input, service, recoveredToolCallingRequired);
  const managedRequest = selected.request as Extract<
    HostLocalInferenceStartupSelection["request"],
    { service: "nim" | "vllm" }
  >;
  return {
    ...selected,
    request: {
      ...managedRequest,
      resumeReceipt: publishedManagedReceipt(
        service,
        input.model,
        input.requireToolCalling ?? recoveredToolCallingRequired,
      ),
    },
  };
}

function managedOllamaSelection(
  input: HostLocalInferenceStartupSelectionInput,
  recover: boolean,
): HostLocalInferenceStartupSelection {
  const selected = hostLocalStartupSelection(
    input,
    "vllm",
    false,
    recover ? "interrupted" : "fresh",
  );
  const request = selected.request as Extract<
    HostLocalInferenceStartupSelection["request"],
    { managed: unknown }
  >;
  return {
    ...selected,
    request: {
      ...request,
      service: "ollama",
      managed: {
        ...request.managed,
        service: "ollama",
        containerName: "nemoclaw-ollama",
        containerPort: 11434,
        hostPort: 11434,
        imageRef: OLLAMA_IMAGE,
      },
    },
  };
}

function expectedOllamaSelection(
  selected: HostLocalInferenceStartupSelection,
): Extract<HostLocalInferenceStartupSelection["request"], { endpoint: unknown }> {
  expect(selected.request.service).toBe("ollama");
  return selected.request as Extract<
    HostLocalInferenceStartupSelection["request"],
    { endpoint: unknown }
  >;
}

function llamaCppLifecycleSelection(
  input: HostLocalInferenceStartupSelectionInput,
  publishedRoute: boolean,
): HostLocalInferenceStartupSelection {
  const value = llamaCppHostLocalInferenceReceipt("mxc");
  return {
    runtimeProviderId: "mxc",
    request: {
      application: input.application,
      service: "llama-cpp",
      adapter: {
        gatewayPort: 8080,
        runtimeOwnerSandboxName: "llama-owner",
        model: input.model,
        operation: {} as never,
        receipt: value,
        runtime: {} as never,
        prepareStartup: vi.fn() as never,
      },
      requireToolCalling: input.requireToolCalling ?? true,
      publishedRoute,
    },
    resolveRuntimeProvider: () => null,
    prepareGatewayMutation: async () => ({
      commit: () => {},
      rollback: () => {},
    }),
  };
}

describe("provider inference host-local startup selection", () => {
  it("does not require host-local application support for a hosted candidate provider", () => {
    const resolver = vi.fn();
    const resolve = createCachedHostLocalInferenceSetupResolver({
      resolver,
      application: "pi",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      acceleration: "cpu",
      requireToolCalling: null,
      freshRequireToolCalling: true,
      allowPublishedResume: false,
      recover: false,
      recordToolCallingRequirement: vi.fn(),
    });

    expect(resolve("pi-sandbox")).toEqual({});
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "dispatches a published %s llama.cpp route through the common lifecycle exactly once",
    async (application) => {
      const model = "llama-cpp-model";
      const session = createSession({
        provider: "llama-cpp-local",
        model,
        endpointUrl: "https://inference.local/v1",
        credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        preferredInferenceApi: "openai-completions",
      });
      session.steps.provider_selection.status = "complete";
      const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
        llamaCppLifecycleSelection(input, true),
      );
      const { deps, calls } = createDeps({
        isInferenceRouteReady: vi.fn(() => true),
        resolveHostLocalInferenceStartupSelection: resolver,
      });
      const options = baseOptions(deps, session);

      const result = await handleProviderInferenceState({
        ...options,
        agent: { name: application },
        initial: { ...options.initial, endpointSource: "inference-set" },
        resume: true,
        sandboxName: `${application}-sandbox`,
      });

      expect(resolver).toHaveBeenCalledOnce();
      expect(calls.recoverManagedLlamaCpp).not.toHaveBeenCalled();
      expect(calls.setupInference).toHaveBeenCalledOnce();
      expect(calls.setupInference.mock.calls[0]?.[7]).toEqual(
        expect.objectContaining({
          hostLocalInference: expect.objectContaining({
            request: expect.objectContaining({
              service: "llama-cpp",
              publishedRoute: true,
            }),
          }),
        }),
      );
      expect(result.hostLocalInferenceSandboxProofAuthority).toEqual(
        expect.objectContaining({ service: "llama-cpp", directHostPort: 8081 }),
      );
    },
  );

  it("keeps an unselected managed llama.cpp resume on the unchanged legacy dispatcher", async () => {
    const model = "llama-cpp-model";
    const session = createSession({
      provider: "llama-cpp-local",
      model,
      endpointUrl: "http://127.0.0.1:8081/v1",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: vi.fn(() => null),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "legacy-llama",
    });

    expect(calls.recoverManagedLlamaCpp).toHaveBeenCalledOnce();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "dispatches an authoritative %s llama.cpp rebuild through the common lifecycle exactly once",
    async (application) => {
      const model = "llama-cpp-model";
      const session = createSession({
        provider: "llama-cpp-local",
        model,
        endpointUrl: "https://inference.local/v1",
        credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        preferredInferenceApi: "openai-completions",
      });
      session.steps.provider_selection.status = "pending";
      const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
        llamaCppLifecycleSelection(input, true),
      );
      const { deps, calls } = createDeps({
        isInferenceRouteReady: vi.fn(() => true),
        resolveHostLocalInferenceStartupSelection: resolver,
      });
      const options = baseOptions(deps, session);

      await handleProviderInferenceState({
        ...options,
        agent: { name: application },
        authoritativeResumeConfig: true,
        initial: { ...options.initial, endpointSource: "inference-set" },
        resume: true,
        sandboxName: `${application}-sandbox`,
      });

      expect(resolver).toHaveBeenCalledOnce();
      expect(calls.recoverManagedLlamaCpp).not.toHaveBeenCalled();
      expect(calls.setupInference).toHaveBeenCalledOnce();
      expect(calls.setupInference.mock.calls[0]?.[7]).toEqual(
        expect.objectContaining({
          hostLocalInference: expect.objectContaining({
            request: expect.objectContaining({
              service: "llama-cpp",
              publishedRoute: true,
            }),
          }),
        }),
      );
    },
  );

  it("rejects reuse of cached startup authority for a different sandbox", () => {
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input),
    );
    const resolveCached = createCachedHostLocalInferenceSetupResolver({
      resolver,
      application: "openclaw",
      provider: "ollama-local",
      model: "qwen3.5-9b",
      acceleration: "nvidia-gpu",
      requireToolCalling: true,
      freshRequireToolCalling: true,
      allowPublishedResume: false,
      recover: false,
      recordToolCallingRequirement: vi.fn(),
    });

    expect(resolveCached("sandbox-alpha").hostLocalInference).toBeDefined();
    expect(() => resolveCached("sandbox-beta")).toThrow(
      "Cached host-local inference authority belongs to a different sandbox.",
    );
    expect(resolver).toHaveBeenCalledOnce();
  });

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
      acceleration: "nvidia-gpu",
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
  )(
    "carries accepted $service startup authority into $application inference setup",
    async ({ application, service }) => {
      const model = "qwen3.5-9b";
      const provider = service === "ollama" ? "ollama-local" : "vllm-local";
      const setupNim = vi.fn<TestProviderInferenceOptions["deps"]["setupNim"]>(
        async (
          _gpu,
          _sandboxName,
          _agent,
          _allowRecordedProviderRecovery,
          _gatewayName,
          _assertRouteCompatible,
          _canProbeRoute,
          _recoverySessionId,
          revalidatePolicyRequirements,
        ) => {
          const selection = {
            ...baseSelection,
            provider,
            model,
            acceleration: "nvidia-gpu" as const,
            endpointUrl: null,
            credentialEnv: null,
            preferredInferenceApi: "openai-completions",
          };
          expect(revalidatePolicyRequirements).toBeTypeOf("function");
          revalidatePolicyRequirements!(selection, "install managed local runtime");
          return selection;
        },
      );
      const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
        hostLocalStartupSelection(input, service),
      );
      const preflightPolicyRequirements = vi.fn(
        (requirements: { provider: string | null; hostLocalInferenceRouteOnly?: boolean }) => {
          expect(
            requirements.provider !== provider || requirements.hostLocalInferenceRouteOnly === true,
          ).toBe(true);
        },
      );
      const { deps, calls } = createDeps({
        setupNim,
        resolveHostLocalInferenceStartupSelection: resolver,
        preflightPolicyRequirements,
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
        acceleration: "nvidia-gpu",
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
      expect(
        service === "ollama"
          ? (setupCall[7] as { hostLocalInference: HostLocalInferenceStartupSelection })
              .hostLocalInference.request
          : null,
      ).toEqual(
        service === "ollama"
          ? expect.objectContaining({
              service: "ollama",
              endpoint: expect.objectContaining({ acceleration: "nvidia-gpu", model }),
            })
          : null,
      );
      expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
      expect(preflightPolicyRequirements).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          hostLocalInferenceRouteOnly: true,
          operation: "record successful inference configuration",
        }),
      );
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
    },
  );

  it("rejects non-boolean interrupted-recovery authority at the injected provider seam", async () => {
    const model = "persisted-served-alias";
    const session = createSession({
      provider: "vllm-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      resolveHostLocalInferenceStartupSelection: (input) => {
        const selected = hostLocalStartupSelection(input, "vllm", true, "fresh");
        return {
          ...selected,
          request: { ...selected.request, recover: "true" as unknown as boolean },
        };
      },
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        forceInferenceSetup: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("invalid recovery authority");

    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "non-boolean recovery",
      recover: "true" as unknown as boolean,
      error: /invalid recovery authority/u,
    },
    { name: "interrupted recovery", recover: true, error: /drifted from recovery authority/u },
  ])("rejects $name for fresh managed Ollama before provider setup", async ({ recover, error }) => {
    const model = "qwen3-vl:4b";
    const session = createSession({
      provider: "ollama-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "ollama-local",
        model,
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
      })),
      resolveHostLocalInferenceStartupSelection: (input) => {
        const selected = hostLocalStartupSelection(input, "vllm", true, "fresh");
        const request = selected.request as Extract<
          HostLocalInferenceStartupSelection["request"],
          { managed: unknown }
        >;
        return {
          ...selected,
          request: {
            ...request,
            service: "ollama" as const,
            recover,
            managed: { ...request.managed, service: "ollama" as const },
          },
        };
      },
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        agent: { name: "hermes" },
        forceInferenceSetup: true,
        sandboxName: "portable-hermes",
      }),
    ).rejects.toThrow(error);

    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("keeps fresh Ollama CPU-scoped when GPU passthrough was disabled on NVIDIA", async () => {
    const model = "nemotron:latest";
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input),
    );
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const options = baseOptions(deps, createSession());

    await handleProviderInferenceState({
      ...options,
      gpu: { type: "nvidia" },
      gpuPassthrough: false,
      sandboxName: "cpu-ollama",
    });

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ acceleration: "cpu", provider: "ollama-local", model }),
    );
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(
      (setupCall[7] as { hostLocalInference: HostLocalInferenceStartupSelection })
        .hostLocalInference.request,
    ).toMatchObject({ service: "ollama", endpoint: { acceleration: "cpu" } });
  });

  it("keeps canonical Ollama resume CPU-scoped when GPU passthrough was disabled on NVIDIA", async () => {
    const model = "nemotron:latest";
    const session = createSession({
      provider: "ollama-local",
      model,
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      hostLocalStartupSelection(input),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const options = baseOptions(deps, session);

    await handleProviderInferenceState({
      ...options,
      gpu: { type: "nvidia" },
      gpuPassthrough: false,
      initial: { ...options.initial, endpointSource: "inference-set" },
      resume: true,
      sandboxName: "cpu-ollama-resume",
    });

    expect(resolver).toHaveBeenCalledWith({
      application: "openclaw",
      sandboxName: "cpu-ollama-resume",
      provider: "ollama-local",
      model,
      acceleration: "cpu",
      requireToolCalling: null,
      allowPublishedResume: true,
      recover: true,
    });
    expect(calls.setupInference).toHaveBeenCalledOnce();
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(
      (setupCall[7] as { hostLocalInference: HostLocalInferenceStartupSelection })
        .hostLocalInference.request,
    ).toMatchObject({ service: "ollama", endpoint: { acceleration: "cpu" } });
  });

  it("rejects an Ollama resolver that enables GPU against accepted disabled authority", async () => {
    const model = "nemotron:latest";
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
      resolveHostLocalInferenceStartupSelection: (input) => {
        const selected = hostLocalStartupSelection(input);
        const request = expectedOllamaSelection(selected);
        return {
          ...selected,
          request: {
            ...request,
            endpoint: { ...request.endpoint, acceleration: "nvidia-gpu" },
          },
        };
      },
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        gpu: { type: "nvidia" },
        gpuPassthrough: false,
        sandboxName: "gpu-ollama",
      }),
    ).rejects.toThrow("accepted model proof");
    expect(calls.setupInference).not.toHaveBeenCalled();
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
      acceleration: "nvidia-gpu",
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

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "heals the narrow published-route session-marker gap for %s from injected exact authority",
    async (application) => {
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
        hostLocalPublishedResumeSelection(input, "vllm", false),
      );
      const { deps, calls } = createDeps({
        isInferenceRouteReady: vi.fn(() => true),
        resolveHostLocalInferenceStartupSelection: resolver,
      });

      const result = await handleProviderInferenceState({
        ...baseOptions(deps, session),
        agent: { name: application },
        resume: true,
        sandboxName: `${application}-sandbox`,
      });

      expect(resolver).toHaveBeenCalledWith({
        application,
        sandboxName: `${application}-sandbox`,
        provider: "vllm-local",
        model,
        acceleration: "nvidia-gpu",
        requireToolCalling: null,
        allowPublishedResume: true,
        recover: false,
      });
      const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
      expect(setupCall[7]).toEqual(
        expect.objectContaining({
          allowToolsIncompatible: true,
          hostLocalInference: expect.objectContaining({
            request: expect.objectContaining({
              service: "vllm",
              resumeReceipt: expect.objectContaining({
                providerId: "mxc",
                service: "vllm",
                inference: expect.objectContaining({ model, toolCallingRequired: false }),
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
    },
  );

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "recovers an interrupted exact managed startup for %s before route publication",
    async (application) => {
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
        hostLocalStartupSelection(input, "vllm", false, "interrupted"),
      );
      const { deps, calls } = createDeps({
        isInferenceRouteReady: vi.fn(() => true),
        resolveHostLocalInferenceStartupSelection: resolver,
      });

      const result = await handleProviderInferenceState({
        ...baseOptions(deps, session),
        agent: { name: application },
        resume: true,
        sandboxName: `${application}-sandbox`,
      });

      expect(resolver).toHaveBeenCalledWith({
        application,
        sandboxName: `${application}-sandbox`,
        provider: "vllm-local",
        model,
        acceleration: "nvidia-gpu",
        requireToolCalling: null,
        allowPublishedResume: true,
        recover: false,
      });
      const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
      expect(setupCall[7]).toEqual(
        expect.objectContaining({
          allowToolsIncompatible: true,
          hostLocalInference: expect.objectContaining({
            request: expect.objectContaining({
              service: "vllm",
              recover: true,
              managed: expect.objectContaining({ requireToolCalling: false }),
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
      expect(result).toMatchObject({
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set",
        hostLocalInferenceRouteOnly: true,
      });
    },
  );

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "rejects a fresh resumed %s runtime that weakens the current tool contract",
    async (application) => {
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
        hostLocalStartupSelection(input, "vllm", false, "fresh"),
      );
      const { deps, calls } = createDeps({
        isInferenceRouteReady: vi.fn(() => true),
        resolveHostLocalInferenceStartupSelection: resolver,
      });

      await expect(
        handleProviderInferenceState({
          ...baseOptions(deps, session),
          agent: { name: application },
          resume: true,
          sandboxName: `${application}-sandbox`,
        }),
      ).rejects.toThrow("accepted model proof");

      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({
          application,
          requireToolCalling: null,
          allowPublishedResume: true,
          recover: false,
        }),
      );
      expect(calls.setupInference).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["openclaw", "hermes", "langchain-deepagents-code"] as const).flatMap((application) =>
      (["published", "interrupted"] as const).map((recoveryKind) => ({
        application,
        recoveryKind,
      })),
    ),
  )(
    "rejects $recoveryKind authority for a fresh $application managed selection",
    async ({ application, recoveryKind }) => {
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
        recoveryKind === "published"
          ? hostLocalPublishedResumeSelection(input)
          : hostLocalStartupSelection(input, "vllm", true, "interrupted"),
      );
      const { deps, calls } = createDeps({
        setupNim,
        resolveHostLocalInferenceStartupSelection: resolver,
      });

      await expect(
        handleProviderInferenceState({
          ...baseOptions(deps, createSession()),
          agent: { name: application },
          sandboxName: `${application}-fresh-sandbox`,
        }),
      ).rejects.toThrow("recovery authority");

      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({
          application,
          allowPublishedResume: false,
          recover: false,
        }),
      );
      expect(calls.setupInference).not.toHaveBeenCalled();
    },
  );

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
      acceleration: "nvidia-gpu",
      requireToolCalling: true,
      allowPublishedResume: false,
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

  it.each(
    (["openclaw", "hermes", "langchain-deepagents-code"] as const).flatMap((application) =>
      (["published", "interrupted"] as const).map((recoveryKind) => ({
        application,
        recoveryKind,
      })),
    ),
  )(
    "rejects $recoveryKind authority for a force-selected $application provider in an unrelated resumed session",
    async ({ application, recoveryKind }) => {
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
        recoveryKind === "published"
          ? hostLocalPublishedResumeSelection(input)
          : hostLocalStartupSelection(input, "vllm", true, "interrupted"),
      );
      const { deps, calls } = createDeps({
        setupNim,
        resolveHostLocalInferenceStartupSelection: resolver,
      });

      await expect(
        handleProviderInferenceState({
          ...baseOptions(deps, session),
          agent: { name: application },
          resume: true,
          forceProviderSelection: true,
          sandboxName: "my-assistant",
        }),
      ).rejects.toThrow("recovery authority");

      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({
          application,
          allowPublishedResume: false,
          recover: false,
        }),
      );
      expect(calls.setupInference).not.toHaveBeenCalled();
    },
  );

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
      acceleration: "nvidia-gpu",
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

  it("resumes the exact managed Ollama route-publication gap through provider setup", async () => {
    const model = "qwen3-vl:4b";
    const session = createSession({
      provider: "ollama-local",
      model,
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      managedOllamaSelection(input, true),
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const options = baseOptions(deps, session);

    const result = await handleProviderInferenceState({
      ...options,
      agent: { name: "hermes" },
      initial: { ...options.initial, endpointSource: "inference-set" },
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
      recover: true,
    });
    expect(calls.repair).not.toHaveBeenCalled();
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).toEqual(
      expect.objectContaining({
        hostLocalInference: expect.objectContaining({
          request: expect.objectContaining({
            service: "ollama",
            recover: true,
            managed: expect.objectContaining({
              service: "ollama",
              containerName: "nemoclaw-ollama",
            }),
          }),
        }),
      }),
    );
    expect(
      (setupCall[7] as { hostLocalInference: HostLocalInferenceStartupSelection })
        .hostLocalInference.request,
    ).not.toHaveProperty("resumeReceipt");
    expect(result.hostLocalInferenceRouteOnly).toBe(true);
  });

  it("resumes after provider selection commits before inference completion (#9596)", async () => {
    const model = "qwen3-vl:4b";
    const session = createSession();
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn((input: HostLocalInferenceStartupSelectionInput) =>
      managedOllamaSelection(input, input.recover),
    );
    const completeStep = async (stepName: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
      session.steps[stepName]!.status = "complete";
      return session;
    };
    const recordStepComplete = vi
      .fn(completeStep)
      .mockImplementationOnce(completeStep)
      .mockImplementationOnce(async () => {
        throw new Error("simulated inference completion interruption");
      });
    const startRecordedStep = vi.fn(async (stepName: string) => {
      session.steps[stepName]!.status = "in_progress";
    });
    const setupInference = vi.fn(async () => ({ ok: true as const }));
    const { deps } = createDeps({
      setupNim,
      setupInference,
      resolveHostLocalInferenceStartupSelection: resolver,
      recordStepComplete,
      startRecordedStep,
      isInferenceRouteReady: vi.fn(() => true),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        agent: { name: "hermes" },
        sandboxName: "portable-hermes",
      }),
    ).rejects.toThrow("simulated inference completion interruption");

    expect(session.steps.provider_selection.status).toBe("complete");
    expect(session.steps.inference.status).toBe("in_progress");
    const resumed = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: "hermes" },
      initial: {
        ...baseOptions(deps, session).initial,
        endpointSource: "inference-set",
      },
      resume: true,
      sandboxName: "portable-hermes",
    });

    expect(resumed.hostLocalInferenceRouteOnly).toBe(true);
    expect(resolver).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowPublishedResume: true,
        recover: true,
      }),
    );
    expect(setupInference).toHaveBeenCalledTimes(2);
    expect(session.steps.inference.status).toBe("complete");
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

  it.each(
    (["openclaw", "hermes", "langchain-deepagents-code"] as const).flatMap((application) =>
      (["fresh", "interrupted"] as const).map((recoveryKind) => ({
        application,
        recoveryKind,
      })),
    ),
  )(
    "rejects $recoveryKind authority for a canonically published $application managed route",
    async ({ application, recoveryKind }) => {
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
          hostLocalStartupSelection(input, "vllm", true, recoveryKind),
      });
      const options = baseOptions(deps, session);

      await expect(
        handleProviderInferenceState({
          ...options,
          agent: { name: application },
          initial: { ...options.initial, endpointSource: "inference-set" },
          resume: true,
          sandboxName: `${application}-sandbox`,
        }),
      ).rejects.toThrow("recovery authority");

      expect(calls.setupInference).not.toHaveBeenCalled();
    },
  );

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
