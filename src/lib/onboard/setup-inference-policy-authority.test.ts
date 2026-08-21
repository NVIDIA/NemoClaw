// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceReceipt,
  HostLocalInferenceRuntime,
} from "./runtime-provider/host-local-inference";
import type { HostLocalInferenceStartupSelection } from "./runtime-provider/host-local-inference-routing";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

const refuseAuthorityChange = (): never => {
  throw new Error("authority changed");
};

function createRemoteSetupDeps() {
  const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const upsertProvider = vi.fn(() => ({ ok: true as const }));
  const updateSandbox = vi.fn(() => true);
  const resolveEndpointHost = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  const deps = {
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    step: vi.fn(),
    getGatewayName: () => "nemoclaw",
    runOpenshell,
    updateSandbox,
    upsertProvider,
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    resolveEndpointHost,
    isNonInteractive: () => true,
    isRoutedInferenceProvider: () => false,
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    REMOTE_PROVIDER_CONFIG: {
      custom: {
        label: "Compatible endpoint",
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://endpoint.example/v1",
        helpUrl: null,
        modelMode: "input",
        defaultModel: "model-a",
      },
    },
    hydrateCredentialEnv: vi.fn(() => "secret"),
    promptValidationRecovery: vi.fn(),
    classifyApplyFailure: vi.fn(),
    localInferenceTimeoutSecs: 60,
    bedrockRuntimeOnboard: {
      setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false as const })),
    },
    openrouterRuntimeOnboard: {
      setupOpenRouterRuntimeInference: vi.fn(async () => ({ handled: false as const })),
    },
    redact: (value: string) => value,
    compactText: (value: string) => value,
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    }),
  } as unknown as SetupInferenceDeps;
  return { deps, resolveEndpointHost, runOpenshell, updateSandbox, upsertProvider };
}

function hostLocalReceipt(): HostLocalInferenceReceipt {
  return {
    schemaVersion: 2,
    providerId: "mxc",
    service: "vllm",
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "mxc",
      authorityId: "mxc:host-local",
      bindingSha256: "a".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 8000,
      networkName: "mxc-network",
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
      runtimeId: "mxc-vllm",
      name: "nemoclaw-vllm",
      imageRef: `nvcr.io/nvidia/vllm@sha256:${"b".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"c".repeat(64)}`,
      specSha256: "d".repeat(64),
      launchSha256: "3".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
}

describe("onboard inference policy authority mutation edges", () => {
  it("refuses a policy-authority change after endpoint DNS validation (#9833)", async () => {
    const { deps, resolveEndpointHost, runOpenshell, updateSandbox, upsertProvider } =
      createRemoteSetupDeps();
    const setupInference = createSetupInference(deps);

    await expect(
      setupInference(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          revalidatePolicyRequirements: (operation) => {
            operation.includes("after DNS validation") ? refuseAuthorityChange() : undefined;
          },
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(resolveEndpointHost).toHaveBeenCalledOnce();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("refuses route and registry mutation when authority changes after provider upsert (#9833)", async () => {
    const { deps, runOpenshell, updateSandbox, upsertProvider } = createRemoteSetupDeps();
    const setupInference = createSetupInference(deps);

    await expect(
      setupInference(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          endpointPinnedAddresses: ["93.184.216.34"],
          revalidatePolicyRequirements: (operation) =>
            operation.includes("OpenShell inference provider route")
              ? refuseAuthorityChange()
              : undefined,
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after inference smoke before reporting setup success (#9833)", async () => {
    const { deps } = createRemoteSetupDeps();
    const setupInference = createSetupInference(deps);

    await expect(
      setupInference(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          endpointPinnedAddresses: ["93.184.216.34"],
          revalidatePolicyRequirements: (operation) =>
            operation === "report successful inference provider setup"
              ? refuseAuthorityChange()
              : undefined,
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(deps.verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("Inference route set"));
  });

  it("carries the exact provider check through validation recovery prompts (#9833)", async () => {
    const { deps, runOpenshell, updateSandbox } = createRemoteSetupDeps();
    deps.isNonInteractive = () => false;
    deps.upsertProvider = vi.fn(() => ({
      ok: false,
      status: 1,
      message: "credential rejected",
    })) as SetupInferenceDeps["upsertProvider"];
    deps.classifyApplyFailure = vi.fn(() => ({ kind: "credential", retry: "credential" }));
    deps.promptValidationRecovery = vi.fn<SetupInferenceDeps["promptValidationRecovery"]>(
      async (_label, _recovery, _credentialEnv, _helpUrl, revalidatePolicyRequirements) => {
        await Promise.resolve();
        revalidatePolicyRequirements?.("save the recovered inference credential");
        return "credential" as const;
      },
    );
    const setupInference = createSetupInference(deps);

    await expect(
      setupInference(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          endpointPinnedAddresses: ["93.184.216.34"],
          revalidatePolicyRequirements: (operation) =>
            operation === "save the recovered inference credential"
              ? refuseAuthorityChange()
              : undefined,
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(deps.promptValidationRecovery).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after route setup before releasing a superseded Ollama model (#9833)", async () => {
    const { deps } = createRemoteSetupDeps();
    const unloadOllamaModels = vi.fn();
    deps.getSandbox = vi.fn(() => ({
      name: "sandbox-a",
      provider: "ollama-local",
      model: "old-model",
    })) as SetupInferenceDeps["getSandbox"];
    deps.listSandboxes = vi.fn(() => ({
      sandboxes: [{ name: "sandbox-a", provider: "ollama-local", model: "old-model" }],
      defaultSandbox: "sandbox-a",
    })) as unknown as SetupInferenceDeps["listSandboxes"];
    deps.unloadOllamaModels = unloadOllamaModels;
    deps.withOllamaModelOwnershipLock = (operation) => operation();
    const setupInference = createSetupInference(deps);

    await expect(
      setupInference(
        "sandbox-a",
        "new-model",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          endpointPinnedAddresses: ["93.184.216.34"],
          revalidatePolicyRequirements: (operation) =>
            operation === "release the superseded Ollama model"
              ? refuseAuthorityChange()
              : undefined,
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(deps.verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("does not commit or publish a host-local route after authority changes (#9833)", async () => {
    const receipt = hostLocalReceipt();
    const runtimeCommit = vi.fn(() => receipt);
    const runtimeRollback = vi.fn(() => ({
      status: "removed" as const,
      priorState: "absent" as const,
      receipt,
    }));
    const runtime: HostLocalInferenceRuntime = {
      providerId: "mxc",
      authorityId: "mxc:host-local",
      services: ["vllm"],
      startManaged: vi.fn(() => ({
        receipt,
        rollbackPriorState: "absent" as const,
        publicationState: () => "unpublished" as const,
        validateBeforeCommit: () => receipt,
        commit: runtimeCommit,
        rollback: runtimeRollback,
      })),
    } as unknown as HostLocalInferenceRuntime;
    const operation: HostLocalInferenceOperation = {
      providerId: "mxc",
      engine: {
        operation: "host-local-inference",
        engineId: "mxc",
        displayName: "MXC",
        authorityId: "mxc:host-local",
      },
      bindingSha256: "a".repeat(64),
      assertAuthority: vi.fn(),
      managedRuntime: runtime,
    } as unknown as HostLocalInferenceOperation;
    const provider = {
      identity: { id: "mxc" },
      capabilities: { hostLocalInference: true },
      hostLocalInference: {
        supported: true,
        services: ["vllm"],
        createOperation: () => operation,
      },
      containerEngine: {
        supported: true,
        identities: [{ operation: "host-local-inference", engineId: "mxc", displayName: "MXC" }],
      },
    } as unknown as RuntimeProviderBundle;
    const gatewayCommit = vi.fn();
    const gatewayRollback = vi.fn();
    const gatewayUpsert = vi.fn(() => ({ ok: true as const }));
    const selection: HostLocalInferenceStartupSelection = {
      runtimeProviderId: "mxc",
      request: {
        application: "openclaw",
        service: "vllm",
        managed: {
          service: "vllm",
          model: "model-a",
          requireToolCalling: true,
          networkName: "mxc-network",
          networkId: "e".repeat(64),
          networkGatewayIp: "10.89.0.1",
          hostPort: 8000,
          probeImageRef: `quay.io/curl/curl@sha256:${"c".repeat(64)}`,
          containerName: "nemoclaw-vllm",
          containerPort: 8000,
          imageRef: `nvcr.io/nvidia/vllm@sha256:${"b".repeat(64)}`,
          gpuDevices: ["nvidia.com/gpu=all"],
        },
        receiptWriter: {
          transactionId: "1".repeat(64),
          targetSha256: "2".repeat(64),
          writeExact: (value) => value,
        },
      },
      resolveRuntimeProvider: () => provider,
      prepareGatewayMutation: async () => ({
        upsertProvider: gatewayUpsert,
        commit: gatewayCommit,
        rollback: gatewayRollback,
      }),
    };
    const updateSandbox = vi.fn(() => true);
    const deps = {
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, action: () => Promise<T> | T) =>
        await action(),
      withGatewayRouteMutationLock: async <T>(_name: string, action: () => Promise<T> | T) =>
        await action(),
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox,
      upsertProvider: vi.fn(() => ({ ok: true as const })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(),
      isNonInteractive: () => true,
      isRoutedInferenceProvider: () => false,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      validateLocalProvider: vi.fn(() => ({ ok: true as const })),
      getLocalProviderBaseUrl: vi.fn(() => "http://host.openshell.internal:8000/v1"),
      getManagedVllmProviderBinding: vi.fn(() => null),
      run: vi.fn(() => ({ status: 0 })),
      vllmLocalCredentialEnv: "VLLM_LOCAL_API_KEY",
      localInferenceTimeoutSecs: 60,
      promptValidationRecovery: vi.fn(),
      classifyApplyFailure: vi.fn(),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${String(code)}`);
      }),
    } as unknown as SetupInferenceDeps;
    const setupInference = createSetupInference(deps);

    await expect(
      setupInference("sandbox-a", "model-a", "vllm-local", null, null, null, [], {
        hostLocalInference: selection,
        revalidatePolicyRequirements: (operationName) =>
          operationName.includes("commit the host-local") ? refuseAuthorityChange() : undefined,
      }),
    ).rejects.toThrow("exit 1");

    expect(gatewayUpsert).toHaveBeenCalledOnce();
    expect(gatewayCommit).not.toHaveBeenCalled();
    expect(runtimeCommit).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(gatewayRollback).toHaveBeenCalledOnce();
    expect(runtimeRollback).toHaveBeenCalledOnce();
  });
});
