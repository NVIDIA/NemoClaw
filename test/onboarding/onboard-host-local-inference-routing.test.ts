// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  HostLocalInferenceOperation,
  HostLocalInferencePreparedStartup,
  HostLocalInferenceReceipt,
  HostLocalInferenceReceiptWriter,
  HostLocalInferenceRuntime,
  HostLocalInferenceService,
} from "../../src/lib/onboard/runtime-provider/host-local-inference.js";
import { parseHostLocalInferenceReceipt } from "../../src/lib/onboard/runtime-provider/host-local-inference.js";
import type {
  HostLocalInferenceApplication,
  HostLocalInferenceGatewayMutation,
  HostLocalInferenceStartupSelection,
} from "../../src/lib/onboard/runtime-provider/host-local-inference-routing.js";
import { createPodmanHostLocalInferenceOperation } from "../../src/lib/onboard/runtime-provider/podman-host-local-inference.js";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import { createPodmanHostLocalInferenceTestHarness } from "../helpers/podman-host-local-inference-test-harness.js";
import { createInMemoryRuntimeProviderBundle } from "../helpers/runtime-provider-bundle.js";
import { createDirectSetupInferenceHarnessFactory } from "../support/setup-inference-test-harness.js";
import { llamaCppHostLocalInferenceReceipt } from "../helpers/host-local-inference-receipt.js";

const onboard = require("../../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};

const createHarness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference);
const AUTHORITY_ID = `mxc-endpoint:${"a".repeat(64)}`;
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"b".repeat(64)}`;
const MANAGED_IMAGE = `nvcr.io/nvidia/inference@sha256:${"c".repeat(64)}`;
const NETWORK_ID = "2".repeat(64);
const NETWORK_GATEWAY_IP = "10.89.0.1";
const NETWORK_AUTHORITY = "3".repeat(64);
const MODEL = "qwen3.5-9b";
const SANDBOX = "host-local-agent";
const APPLICATIONS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const PUBLISHED_RESUME_ROLLBACK_CASES = APPLICATIONS.flatMap((application) =>
  (["running", "stopped"] as const).map((stateAtEntry) => ({ application, stateAtEntry })),
);
const writer: HostLocalInferenceReceiptWriter = {
  transactionId: "f".repeat(64),
  targetSha256: "1".repeat(64),
  writeExact: (value) => value,
};

function raise(error: Error): never {
  throw error;
}

function raiseOptional(error: Error | undefined): void {
  return error === undefined ? undefined : raise(error);
}

function requiredManagedRuntime(operation: HostLocalInferenceOperation): HostLocalInferenceRuntime {
  expect(operation.managedRuntime).toBeDefined();
  return operation.managedRuntime as HostLocalInferenceRuntime;
}

function receipt(
  service: Exclude<HostLocalInferenceService, "llama-cpp">,
  priorState: "absent" | "running" | "stopped" | "host-process" = service === "ollama"
    ? "host-process"
    : "absent",
): HostLocalInferenceReceipt {
  return {
    schemaVersion: 2,
    providerId: "mxc",
    service,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "memory",
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
      model: service === "ollama" ? `${MODEL}:latest` : MODEL,
      toolCallingRequired: true,
    },
    publication: {
      transactionId: writer.transactionId,
      targetSha256: writer.targetSha256,
      priorState,
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

function prepared(
  value: HostLocalInferenceReceipt,
  events: string[],
  options: {
    validationError?: Error;
    commitValidationError?: Error;
    commitError?: Error;
    rollbackError?: Error;
    rollbackPriorState?: "absent" | "running" | "stopped" | "host-process";
  } = {},
): HostLocalInferencePreparedStartup {
  let publicationState: "unpublished" | "indeterminate" | "published" = "unpublished";
  const rollbackPriorState =
    options.rollbackPriorState ?? value.publication?.priorState ?? "absent";
  return {
    receipt: value,
    rollbackPriorState,
    publicationState: vi.fn(() => publicationState),
    validateBeforeCommit: vi.fn(() => {
      events.push("runtime-precommit-validation");
      return options.validationError ? raise(options.validationError) : value;
    }),
    commit: vi.fn(() => {
      events.push("runtime-commit");
      raiseOptional(options.commitValidationError);
      publicationState = options.commitError === undefined ? "published" : "indeterminate";
      raiseOptional(options.commitError);
      return value;
    }),
    rollback: vi.fn(() => {
      events.push("runtime-rollback");
      options.rollbackError ? raise(options.rollbackError) : undefined;
      return {
        status:
          rollbackPriorState === "absent"
            ? ("removed" as const)
            : rollbackPriorState === "host-process"
              ? ("retained" as const)
              : ("restored" as const),
        priorState: rollbackPriorState,
        receipt: value,
      };
    }),
  };
}

function runtime(
  service: "ollama" | "nim" | "vllm",
  events: string[],
  options: {
    authorityId?: string;
    startupError?: Error;
    validationError?: Error;
    commitValidationError?: Error;
    commitError?: Error;
    rollbackError?: Error;
    priorState?: "absent" | "running" | "stopped" | "host-process";
    resumeStateAtEntry?: "running" | "stopped";
  } = {},
  preparedStartups: HostLocalInferencePreparedStartup[] = [],
): HostLocalInferenceRuntime {
  const value = receipt(service, options.priorState);
  const start = () => {
    events.push("provider-ready-proof");
    raiseOptional(options.startupError);
    const startup = prepared(value, events, options);
    preparedStartups.push(startup);
    return startup;
  };
  return {
    providerId: "mxc",
    authorityId: options.authorityId ?? AUTHORITY_ID,
    services: [service],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(start),
    startManaged: vi.fn(start),
    recoverManaged: vi.fn(() => {
      events.push("provider-recovery-proof");
      raiseOptional(options.startupError);
      const startup = prepared(value, events, options);
      preparedStartups.push(startup);
      return startup;
    }),
    resumeManaged: vi.fn(() => {
      events.push("provider-published-resume-proof");
      raiseOptional(options.startupError);
      const startup = prepared(value, events, {
        ...options,
        rollbackPriorState: options.resumeStateAtEntry ?? "running",
      });
      preparedStartups.push(startup);
      return startup;
    }),
    inspectManaged: vi.fn((current) => ({ running: true, receipt: current })),
    stopManaged: vi.fn((current) => ({ running: false, receipt: current })),
    preserveForRebuild: vi.fn((current) => current),
    validate: vi.fn((current) => current),
    prepareDestroy: vi.fn((current) => current),
    destroy: vi.fn((current) => ({ status: "removed" as const, receipt: current })),
  };
}

function operation(providerRuntime: HostLocalInferenceRuntime): HostLocalInferenceOperation {
  return {
    providerId: "mxc",
    engine: {
      operation: "host-local-inference",
      engineId: "memory",
      displayName: "In-memory",
      authorityId: AUTHORITY_ID,
    } as HostLocalInferenceOperation["engine"],
    bindingSha256: "d".repeat(64),
    assertAuthority: vi.fn(),
    spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
    createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
    managedRuntime: providerRuntime,
  };
}

function fixture(
  application: HostLocalInferenceApplication,
  service: "ollama" | "nim" | "vllm",
  options: Parameters<typeof runtime>[2] & {
    gatewayCommitError?: Error;
    gatewayRollbackError?: Error;
    gatewayUpsertProvider?: NonNullable<HostLocalInferenceGatewayMutation["upsertProvider"]>;
    recover?: boolean;
    resume?: boolean;
  } = {},
) {
  const events: string[] = [];
  const preparedStartups: HostLocalInferencePreparedStartup[] = [];
  const providerRuntime = runtime(service, events, options, preparedStartups);
  const providerOperation = operation(providerRuntime);
  const bundle = createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: {
      support: {
        exactDigestReferences: true,
        platforms: ["linux/amd64"],
        startupProfileContractVersions: [1],
        capabilityContractVersions: [1],
      },
      hostArchitectures: ["x64"],
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInference: {
      services: [service],
      createOperation: () => providerOperation,
    },
  });
  const gatewayCommit = vi.fn(() => {
    events.push("gateway-commit");
    options.gatewayCommitError ? raise(options.gatewayCommitError) : undefined;
  });
  const gatewayRollback = vi.fn(() => {
    events.push("gateway-rollback");
    options.gatewayRollbackError ? raise(options.gatewayRollbackError) : undefined;
  });
  const prepareGatewayMutation = vi.fn(() => {
    events.push("gateway-snapshot");
    return {
      ...(options.gatewayUpsertProvider ? { upsertProvider: options.gatewayUpsertProvider } : {}),
      commit: gatewayCommit,
      rollback: gatewayRollback,
    };
  });
  const request: HostLocalInferenceStartupSelection["request"] =
    service === "ollama"
      ? {
          application,
          service,
          endpoint: {
            acceleration: "nvidia-gpu",
            model: MODEL,
            requireToolCalling: true,
            networkName: "mxc-runtime-network",
            networkId: NETWORK_ID,
            networkGatewayIp: NETWORK_GATEWAY_IP,
            hostPort: 11434,
            probeImageRef: PROBE_IMAGE,
          },
          receiptWriter: writer,
        }
      : {
          application,
          service,
          ...(options.recover ? { recover: true } : {}),
          ...(options.resume ? { resumeReceipt: receipt(service, options.priorState) } : {}),
          managed: {
            service,
            model: MODEL,
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
          },
          receiptWriter: writer,
        };
  const selection: HostLocalInferenceStartupSelection = {
    runtimeProviderId: "mxc",
    request,
    resolveRuntimeProvider: (sandboxName) => (sandboxName === SANDBOX ? bundle : null),
    prepareGatewayMutation,
  };
  return {
    events,
    gatewayCommit,
    gatewayRollback,
    prepareGatewayMutation,
    preparedStartups,
    providerRuntime,
    selection,
  };
}

function llamaFixture(application: HostLocalInferenceApplication) {
  const events: string[] = [];
  const baseReceipt = llamaCppHostLocalInferenceReceipt("mxc");
  const value: HostLocalInferenceReceipt = {
    ...baseReceipt,
    engineAuthority: {
      ...baseReceipt.engineAuthority,
      engineId: "memory",
      authorityId: AUTHORITY_ID,
      bindingSha256: "d".repeat(64),
    },
  };
  const providerRuntime: HostLocalInferenceRuntime = {
    providerId: "mxc",
    authorityId: AUTHORITY_ID,
    services: ["llama-cpp"],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(),
    startManaged: vi.fn(),
    inspectManaged: vi.fn((current) => ({ running: true, receipt: current })),
    stopManaged: vi.fn((current) => ({ running: false, receipt: current })),
    preserveForRebuild: vi.fn((current) => current),
    prepareDestroy: vi.fn((current) => current),
    destroy: vi.fn((current) => ({
      status: "removed" as const,
      receipt: current,
    })),
  };
  const providerOperation = operation(providerRuntime);
  const bundle = createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: {
      support: null,
      hostArchitectures: ["x64"],
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInference: {
      services: ["llama-cpp"],
      createOperation: () => providerOperation,
    },
  });
  const prepareStartup = vi.fn(() => {
    events.push("provider-ready-proof");
    return prepared(value, events);
  });
  const gatewayCommit = vi.fn(() => {
    events.push("gateway-commit");
  });
  const gatewayRollback = vi.fn(() => {
    events.push("gateway-rollback");
  });
  const prepareGatewayMutation = vi.fn(() => {
    events.push("gateway-snapshot");
    return { commit: gatewayCommit, rollback: gatewayRollback };
  });
  const selection: HostLocalInferenceStartupSelection = {
    runtimeProviderId: "mxc",
    request: {
      application,
      service: "llama-cpp",
      adapter: {
        gatewayPort: 8080,
        runtimeOwnerSandboxName: SANDBOX,
        model: MODEL,
        operation: providerOperation,
        receipt: value,
        runtime: providerRuntime,
        prepareStartup,
      },
      requireToolCalling: true,
      publishedRoute: false,
    },
    resolveRuntimeProvider: (sandboxName) => (sandboxName === SANDBOX ? bundle : null),
    prepareGatewayMutation,
  };
  return {
    events,
    gatewayCommit,
    gatewayRollback,
    prepareGatewayMutation,
    prepareStartup,
    selection,
    value,
  };
}

describe("onboard host-local inference routing", () => {
  it("explicitly clears stale host-local ownership for a remote route", async () => {
    const harness = createHarness({
      overrides: {
        isRoutedInferenceProvider: () => true,
        reconcileModelRouter: vi.fn(async () => undefined),
        routedInference: {
          upsertRoutedProvider: vi.fn(() => ({
            ok: true,
            endpointUrl: "https://api.example.test/v1",
            result: { message: "configured" },
          })),
        },
      },
    });

    await expect(
      harness.setupInference(
        "sandbox-a",
        "remote-model",
        "nvidia-router",
        "https://api.example.test/v1",
        "REMOTE_API_KEY",
        null,
        [],
      ),
    ).resolves.toEqual({ ok: true });

    expect(harness.updateSandbox).toHaveBeenCalledWith(
      "sandbox-a",
      expect.objectContaining({
        provider: "nvidia-router",
        model: "remote-model",
        hostLocalInferenceReceipt: null,
      }),
    );
  });

  it.each(APPLICATIONS)(
    "routes %s through inference.local without legacy host probes",
    async (application) => {
      const route = fixture(application, "ollama");
      const legacyRun = vi.fn();
      const legacyValidate = vi.fn();
      const legacyOllamaProof = vi.fn();
      const verify = vi.fn(() => {
        route.events.push("gateway-route-verify");
      });
      const smoke = vi.fn(() => {
        route.events.push("gateway-smoke");
      });
      const reserve = vi.fn(
        (
          _sandboxName: string,
          _reservation: Parameters<SetupInferenceDeps["updateSandbox"]>[1],
        ) => {
          route.events.push("sandbox-reserve");
          return true;
        },
      );
      const harness = createHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get" ? { status: 1 } : undefined,
        overrides: {
          applyLocalInferenceRoute: undefined,
          run: legacyRun,
          validateLocalProvider: legacyValidate,
          localInference: {
            validateOllamaModelWithToolsOverride: legacyOllamaProof,
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            runOllamaWarmup: () => {},
            persistResolvedOllamaHost: () => () => {},
          },
          verifyInferenceRoute: verify,
          verifyOnboardInferenceSmoke: smoke,
          updateSandbox: reserve,
        },
      });
      await expect(
        harness.setupInference(SANDBOX, MODEL, "ollama-local", null, null, null, [], {
          gatewayName: "nemoclaw",
          hostLocalInference: route.selection,
        }),
      ).resolves.toEqual({ ok: true });

      const reservation = (
        reserve.mock.calls.at(-1) as unknown as
          | [
              string,
              {
                hostLocalInferenceReceipt?: string;
                hostLocalInferenceProvenance?: unknown;
              },
            ]
          | undefined
      )?.[1];
      expect(reservation?.hostLocalInferenceReceipt).toEqual(expect.any(String));
      expect(reservation?.hostLocalInferenceProvenance).toBeUndefined();
      expect(
        parseHostLocalInferenceReceipt(reservation?.hostLocalInferenceReceipt ?? ""),
      ).toMatchObject({
        providerId: "mxc",
        service: "ollama",
        endpoint: { port: 11434, networkName: "mxc-runtime-network" },
      });

      expect(route.prepareGatewayMutation).toHaveBeenCalledWith({
        gatewayName: "nemoclaw",
        sandboxName: SANDBOX,
        provider: "ollama-local",
        model: MODEL,
        providerBaseUrl: "http://host.openshell.internal:11434/v1",
      });
      expect(route.providerRuntime.qualifyOllama).toHaveBeenCalledWith(
        expect.objectContaining({ acceleration: "nvidia-gpu", model: MODEL }),
        writer,
      );
      expect(route.preparedStartups[0]?.receipt.runtime).toMatchObject({
        kind: "host",
        acceleration: "nvidia-gpu",
      });
      expect(harness.commands.map(({ command }) => command)).toEqual([
        "provider profile -g nemoclaw export openai --output json",
        "provider get -g nemoclaw ollama-local",
        "provider create -g nemoclaw --name ollama-local --type openai --credential NEMOCLAW_OLLAMA_PROXY_TOKEN --config OPENAI_BASE_URL=http://host.openshell.internal:11434/v1",
        `inference set -g nemoclaw --no-verify --provider ollama-local --model ${MODEL} --timeout 180`,
      ]);
      expect(harness.commands.map(({ command }) => command).join(" ")).not.toContain(
        "mxc-provider-native.internal",
      );
      expect(route.events).toEqual([
        "provider-ready-proof",
        "gateway-snapshot",
        "gateway-route-verify",
        "runtime-precommit-validation",
        "gateway-commit",
        "runtime-precommit-validation",
        "sandbox-reserve",
        "runtime-commit",
      ]);
      expect(smoke).not.toHaveBeenCalled();
      expect(reserve).toHaveBeenCalledWith(
        SANDBOX,
        expect.objectContaining({
          provider: "ollama-local",
          model: MODEL,
          endpointUrl: "https://inference.local/v1",
          endpointSource: "inference-set",
        }),
      );
      expect(legacyRun).not.toHaveBeenCalled();
      expect(legacyValidate).not.toHaveBeenCalled();
      expect(legacyOllamaProof).not.toHaveBeenCalled();
      expect(route.gatewayRollback).not.toHaveBeenCalled();
    },
  );

  it("uses a transaction-owned provider create instead of the generic gateway upsert", async () => {
    const exactProviderCreate = vi.fn(() => ({ ok: true }));
    const genericUpsertProvider = vi.fn(() => ({ ok: true }));
    const route = fixture("hermes", "ollama", {
      gatewayUpsertProvider: exactProviderCreate,
    });
    const harness = createHarness({
      overrides: {
        applyLocalInferenceRoute: undefined,
        upsertProvider: genericUpsertProvider,
      },
    });

    await expect(
      harness.setupInference(SANDBOX, MODEL, "ollama-local", null, null, null, [], {
        gatewayName: "nemoclaw",
        hostLocalInference: route.selection,
      }),
    ).resolves.toEqual({ ok: true });

    expect(exactProviderCreate).toHaveBeenCalledWith(
      "ollama-local",
      "openai",
      "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      "http://host.openshell.internal:11434/v1",
      { NEMOCLAW_OLLAMA_PROXY_TOKEN: "ollama" },
    );
    expect(genericUpsertProvider).not.toHaveBeenCalled();
  });

  it.each(APPLICATIONS)(
    "registers explicitly selected llama.cpp for %s with exact private provenance",
    async (application) => {
      const route = llamaFixture(application);
      const legacyRun = vi.fn();
      const legacyValidate = vi.fn();
      const reserve = vi.fn(
        (
          _sandboxName: string,
          _reservation: Parameters<SetupInferenceDeps["updateSandbox"]>[1],
        ) => {
          route.events.push("sandbox-reserve");
          return true;
        },
      );
      const harness = createHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get" ? { status: 1 } : undefined,
        overrides: {
          applyLocalInferenceRoute: undefined,
          run: legacyRun,
          validateLocalProvider: legacyValidate,
          hydrateCredentialEnv: vi.fn(() => "test-llama-secret"),
          updateSandbox: reserve,
        },
      });

      const result = await harness.setupInference(
        SANDBOX,
        MODEL,
        "llama-cpp-local",
        null,
        "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        null,
        [],
        {
          gatewayName: "nemoclaw",
          hostLocalInference: route.selection,
        },
      );
      expect(harness.errors).toEqual([]);
      expect(result).toEqual({ ok: true });

      const reservation = reserve.mock.calls.at(-1)?.[1];
      expect(reservation).toMatchObject({
        provider: "llama-cpp-local",
        model: MODEL,
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        openshellDriver: "mxc",
        hostLocalInferenceProvenance: {
          runtimeOwnerSandboxName: SANDBOX,
          transactionId:
            route.value.runtime.kind === "container"
              ? route.value.runtime.model?.generation
              : undefined,
          receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(reservation?.hostLocalInferenceReceipt).toEqual(expect.any(String));
      expect(route.prepareStartup).toHaveBeenCalledOnce();
      expect(route.gatewayCommit).toHaveBeenCalledOnce();
      expect(route.gatewayRollback).not.toHaveBeenCalled();
      expect(legacyRun).not.toHaveBeenCalled();
      expect(legacyValidate).not.toHaveBeenCalled();
    },
  );

  it("rejects injected llama.cpp engine drift before startup", async () => {
    const route = llamaFixture("openclaw");
    const request = route.selection.request as Extract<
      HostLocalInferenceStartupSelection["request"],
      { service: "llama-cpp" }
    >;
    const selection: HostLocalInferenceStartupSelection = {
      ...route.selection,
      request: {
        ...request,
        adapter: {
          ...request.adapter,
          operation: {
            ...request.adapter.operation,
            engine: { ...request.adapter.operation.engine, engineId: "other-engine" },
          },
        },
      },
    };
    const harness = createHarness();

    await expect(
      harness.setupInference(SANDBOX, MODEL, "llama-cpp-local", null, null, null, [], {
        hostLocalInference: selection,
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(route.prepareStartup).not.toHaveBeenCalled();
    expect(route.prepareGatewayMutation).not.toHaveBeenCalled();
    expect(harness.commands).toEqual([]);
    expect(harness.errors.join(" ")).toContain("mismatched host-local-inference authority");
  });

  it.each([
    ["nim", 8001],
    ["vllm", 8000],
  ] as const)("starts managed %s through the injected provider", async (service, port) => {
    const route = fixture("openclaw", service);
    const legacyRun = vi.fn();
    const legacyValidate = vi.fn();
    const harness = createHarness({
      runOpenshell: (args) =>
        args.slice(0, 2).join(" ") === "provider get" ? { status: 1 } : undefined,
      overrides: {
        applyLocalInferenceRoute: undefined,
        run: legacyRun,
        validateLocalProvider: legacyValidate,
      },
    });

    await expect(
      harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
        hostLocalInference: route.selection,
      }),
    ).resolves.toEqual({ ok: true });

    expect(harness.commands.some(({ command }) => command.includes(`:${String(port)}/v1`))).toBe(
      true,
    );
    expect(legacyRun).not.toHaveBeenCalled();
    expect(legacyValidate).not.toHaveBeenCalled();
    expect(route.gatewayCommit).toHaveBeenCalledOnce();
  });

  it.each(APPLICATIONS)(
    "recovers an interrupted exact %s managed start before route commit",
    async (application) => {
      const route = fixture(application, "vllm", { recover: true, priorState: "stopped" });
      const harness = createHarness();

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).resolves.toEqual({ ok: true });

      expect(route.providerRuntime.recoverManaged).toHaveBeenCalledOnce();
      expect(route.providerRuntime.startManaged).not.toHaveBeenCalled();
      expect(route.events[0]).toBe("provider-recovery-proof");
      expect(route.events).toContain("runtime-precommit-validation");
      expect(route.gatewayCommit).toHaveBeenCalledOnce();
    },
  );

  it.each(APPLICATIONS)(
    "re-proves the published exact %s managed runtime before route commit",
    async (application) => {
      const route = fixture(application, "vllm", {
        resume: true,
        priorState: "absent",
        resumeStateAtEntry: "running",
      });
      const harness = createHarness();

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).resolves.toEqual({ ok: true });

      expect(route.providerRuntime.resumeManaged).toHaveBeenCalledOnce();
      expect(route.providerRuntime.recoverManaged).not.toHaveBeenCalled();
      expect(route.providerRuntime.startManaged).not.toHaveBeenCalled();
      expect(route.events[0]).toBe("provider-published-resume-proof");
      expect(route.preparedStartups[0]?.rollbackPriorState).toBe("running");
      expect(route.events).toContain("runtime-precommit-validation");
      expect(route.gatewayCommit).toHaveBeenCalledOnce();
    },
  );

  it.each(PUBLISHED_RESUME_ROLLBACK_CASES)(
    "restores $application published resume state-at-entry=$stateAtEntry after post-prepare failure",
    async ({ application, stateAtEntry }) => {
      const route = fixture(application, "vllm", {
        resume: true,
        // This is the original creation state embedded in the durable receipt;
        // it is not rollback authority for an already-published runtime.
        priorState: "absent",
        resumeStateAtEntry: stateAtEntry,
      });
      const harness = createHarness({
        overrides: { applyLocalInferenceRoute: vi.fn(async () => true) },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).resolves.toEqual({ retry: "selection" });

      const preparedStartup = route.preparedStartups[0];
      expect(route.providerRuntime.resumeManaged).toHaveBeenCalledOnce();
      expect(route.prepareGatewayMutation).toHaveBeenCalledOnce();
      expect(preparedStartup?.receipt.publication?.priorState).toBe("absent");
      expect(preparedStartup?.rollbackPriorState).toBe(stateAtEntry);
      expect(preparedStartup?.rollback).toHaveReturnedWith(
        expect.objectContaining({ status: "restored", priorState: stateAtEntry }),
      );
      expect(preparedStartup?.rollback).not.toHaveReturnedWith(
        expect.objectContaining({ status: "removed" }),
      );
      expect(route.events.slice(-2)).toEqual(["gateway-rollback", "runtime-rollback"]);
    },
  );

  it.each(APPLICATIONS)(
    "rolls back %s gateway denial and exact prior runtime state",
    async (application) => {
      const route = fixture(application, "vllm", { priorState: "stopped" });
      const error = vi.fn(() => route.events.push("redacted-evidence"));
      const harness = createHarness({
        overrides: {
          applyLocalInferenceRoute: vi.fn(async () => true),
          error,
        },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).resolves.toEqual({ retry: "selection" });

      expect(route.events.slice(-3)).toEqual([
        "redacted-evidence",
        "gateway-rollback",
        "runtime-rollback",
      ]);
      expect(route.gatewayCommit).not.toHaveBeenCalled();
      expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
      expect(harness.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
      expect(harness.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(APPLICATIONS)(
    "fails closed for %s when gateway rollback evidence is indeterminate",
    async (application) => {
      const route = fixture(application, "vllm", {
        gatewayRollbackError: new Error("indeterminate gateway cleanup"),
      });
      const harness = createHarness({
        overrides: { applyLocalInferenceRoute: vi.fn(async () => true) },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.at(-1)).toBe("gateway-rollback");
      expect(route.events).not.toContain("runtime-rollback");
      expect(route.gatewayCommit).not.toHaveBeenCalled();
      expect(harness.errors.join(" ")).toContain("indeterminate gateway cleanup");
    },
  );

  it("emits bounded redacted provider-native evidence before gateway mutation", async () => {
    const route = fixture("langchain-deepagents-code", "vllm", {
      startupError: new Error(
        "probe https://provider-user:provider-password@native.example/signed/opaque-path-token/callback?token=query-secret OPENAI_API_KEY=env-secret Bearer bearer-secret",
      ),
    });
    const harness = createHarness();

    await expect(
      harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
        hostLocalInference: route.selection,
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    const evidence = harness.errors.join(" ");
    expect(evidence).toContain("runtime provider 'mxc'");
    expect(evidence).not.toContain("provider-user");
    expect(evidence).not.toContain("provider-password");
    expect(evidence).not.toContain("query-secret");
    expect(evidence).not.toContain("opaque-path-token");
    expect(evidence).not.toContain("env-secret");
    expect(evidence).not.toContain("bearer-secret");
    expect(harness.errors.every((line) => line.length < 340)).toBe(true);
    expect(route.prepareGatewayMutation).not.toHaveBeenCalled();
    expect(harness.commands).toEqual([]);
    expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
    expect(harness.updateSandbox).not.toHaveBeenCalled();
  });

  it("never emits a raw secret-bearing gateway provider failure", async () => {
    const route = fixture("openclaw", "vllm");
    const providerFailures = {
      "provider get": { status: 1 },
      "provider create": {
        status: 1,
        stderr:
          "https://gateway-user:gateway-password@gateway.example/v1?token=gateway-query OPENAI_API_KEY=gateway-env-secret",
      },
    } as const;
    const harness = createHarness({
      runOpenshell: (args) =>
        providerFailures[args.slice(0, 2).join(" ") as keyof typeof providerFailures],
    });

    await expect(
      harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
        hostLocalInference: route.selection,
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    const evidence = harness.errors.join(" ");
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toContain("runtime provider 'mxc'");
    expect(evidence).not.toContain("gateway-user");
    expect(evidence).not.toContain("gateway-password");
    expect(evidence).not.toContain("gateway-query");
    expect(evidence).not.toContain("gateway-env-secret");
    expect(route.events.slice(-2)).toEqual(["gateway-rollback", "runtime-rollback"]);
  });

  it.each(APPLICATIONS)(
    "rolls back %s when provider authority revalidation fails before commit",
    async (application) => {
      const route = fixture(application, "vllm", {
        validationError: new Error("provider authority changed before commit"),
      });
      const reserve = vi.fn(() => true);
      const harness = createHarness({ overrides: { updateSandbox: reserve } });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.slice(-3)).toEqual([
        "runtime-precommit-validation",
        "gateway-rollback",
        "runtime-rollback",
      ]);
      expect(route.gatewayCommit).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it.each(APPLICATIONS)(
    "rolls back %s when the gateway commit fails before receipt publication",
    async (application) => {
      const route = fixture(application, "vllm", {
        gatewayCommitError: new Error("gateway commit failed"),
      });
      const harness = createHarness({
        overrides: { error: vi.fn(() => route.events.push("redacted-evidence")) },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.slice(-5)).toEqual([
        "runtime-precommit-validation",
        "gateway-commit",
        "redacted-evidence",
        "gateway-rollback",
        "runtime-rollback",
      ]);
      expect(harness.updateSandbox).not.toHaveBeenCalled();
      expect(route.events).not.toContain("runtime-commit");
    },
  );

  it.each(APPLICATIONS)(
    "retains %s runtime and gateway when sandbox reservation declines at its publication boundary",
    async (application) => {
      const route = fixture(application, "vllm");
      const reserve = vi.fn(() => {
        route.events.push("sandbox-reserve-refused");
        return false;
      });
      const harness = createHarness({
        overrides: {
          updateSandbox: reserve,
          error: vi.fn(() => route.events.push("redacted-evidence")),
        },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.slice(-4)).toEqual([
        "gateway-commit",
        "runtime-precommit-validation",
        "sandbox-reserve-refused",
        "redacted-evidence",
      ]);
      expect(route.events).not.toContain("runtime-commit");
      expect(route.gatewayRollback).not.toHaveBeenCalled();
      expect(route.events).not.toContain("runtime-rollback");
    },
  );

  it.each(APPLICATIONS)(
    "retains %s runtime and gateway when sandbox reservation throws after a possible write",
    async (application) => {
      const route = fixture(application, "vllm");
      const reserve = vi.fn(() => {
        route.events.push("sandbox-reserve-write-entered");
        throw new Error("registry save failed after atomic replacement");
      });
      const harness = createHarness({
        overrides: {
          updateSandbox: reserve,
          error: vi.fn(() => route.events.push("redacted-evidence")),
        },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.slice(-4)).toEqual([
        "gateway-commit",
        "runtime-precommit-validation",
        "sandbox-reserve-write-entered",
        "redacted-evidence",
      ]);
      expect(route.events).not.toContain("runtime-commit");
      expect(route.gatewayRollback).not.toHaveBeenCalled();
      expect(route.events).not.toContain("runtime-rollback");
    },
  );

  it.each(APPLICATIONS)(
    "retains %s runtime and gateway when final receipt validation fails after reservation",
    async (application) => {
      const route = fixture(application, "vllm", {
        commitValidationError: new Error("route publication authority changed before writer entry"),
      });
      const reserve = vi.fn(() => {
        route.events.push("sandbox-reserve");
        return true;
      });
      const failureEvidence: string[] = [];
      const harness = createHarness({
        overrides: {
          updateSandbox: reserve,
          error: vi.fn((message: string) => {
            route.events.push("redacted-evidence");
            failureEvidence.push(message);
          }),
        },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.slice(-5)).toEqual([
        "gateway-commit",
        "runtime-precommit-validation",
        "sandbox-reserve",
        "runtime-commit",
        "redacted-evidence",
      ]);
      expect(route.gatewayRollback).not.toHaveBeenCalled();
      expect(route.events).not.toContain("runtime-rollback");
      expect(route.gatewayCommit).toHaveBeenCalledOnce();
      expect(reserve).toHaveBeenCalledWith(
        SANDBOX,
        expect.objectContaining({
          provider: "vllm-local",
          model: MODEL,
          endpointUrl: "https://inference.local/v1",
          endpointSource: "inference-set",
          gatewayName: "nemoclaw",
        }),
      );
      expect(route.preparedStartups).toHaveLength(1);
      expect(route.preparedStartups[0]?.receipt).toEqual(receipt("vllm"));
      expect(route.preparedStartups[0]?.publicationState()).toBe("unpublished");
      expect(route.preparedStartups[0]?.rollback).not.toHaveBeenCalled();
      expect(failureEvidence).toHaveLength(1);
      expect(failureEvidence[0]).toContain("runtime provider 'mxc'");
      expect(failureEvidence[0]).toContain("route publication authority changed");
    },
  );

  it("re-proves provider-native Ollama placement after asynchronous gateway commit", async () => {
    const provider = createPodmanHostLocalInferenceTestHarness();
    const providerOperation = createPodmanHostLocalInferenceOperation({
      engine: provider.engine,
      env: provider.env,
      authorityStore: provider.authorityStore,
      routeAuthorityStore: provider.routeAuthorityStore,
      onFailureEvidence: provider.onFailureEvidence,
      redactSensitive: provider.redactSensitive,
    });
    const sourceRuntime = requiredManagedRuntime(providerOperation);
    const preparedStartups: Array<{
      prepared: HostLocalInferencePreparedStartup;
      commit: ReturnType<typeof vi.fn>;
      rollback: ReturnType<typeof vi.fn>;
    }> = [];
    const capturedRuntime: HostLocalInferenceRuntime = {
      ...sourceRuntime,
      qualifyOllama: vi.fn((input, receiptWriter) => {
        const source = sourceRuntime.qualifyOllama(input, receiptWriter);
        const commit = vi.fn(() => source.commit());
        const rollback = vi.fn(() => source.rollback());
        const prepared = { ...source, commit, rollback };
        preparedStartups.push({ prepared, commit, rollback });
        return prepared;
      }),
    };
    const capturedOperation: HostLocalInferenceOperation = {
      ...providerOperation,
      managedRuntime: capturedRuntime,
    };
    const inMemoryBundle = createInMemoryRuntimeProviderBundle({
      providerId: "podman",
      workloadProfile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64"],
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["x64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      hostLocalInference: {
        services: ["ollama"],
        createOperation: () => capturedOperation,
      },
    });
    const bundle = {
      ...inMemoryBundle,
      containerEngine: {
        ...inMemoryBundle.containerEngine,
        identities: inMemoryBundle.containerEngine.identities.map((identity) =>
          identity.operation === "host-local-inference"
            ? { operation: identity.operation, engineId: "podman", displayName: "Podman" }
            : identity,
        ),
      },
    };
    const gatewayRollback = vi.fn();
    const gatewayCommit = vi.fn(() => {
      provider.state.ollamaPsModels = [
        {
          name: "nemotron:latest",
          model: "nemotron:latest",
          size: 8 * 1024 ** 3,
          size_vram: 4 * 1024 ** 3,
          digest: "7".repeat(64),
        },
      ];
    });
    const selection: HostLocalInferenceStartupSelection = {
      runtimeProviderId: "podman",
      request: {
        application: "openclaw",
        service: "ollama",
        endpoint: {
          acceleration: "nvidia-gpu",
          model: "nemotron:latest",
          requireToolCalling: true,
          networkName: provider.input.networkName,
          networkId: provider.input.networkId,
          networkGatewayIp: provider.input.networkGatewayIp,
          hostPort: 11434,
          probeImageRef: provider.input.probeImageRef,
        },
        receiptWriter: provider.writer,
      },
      resolveRuntimeProvider: () => bundle,
      prepareGatewayMutation: () => ({ commit: gatewayCommit, rollback: gatewayRollback }),
    };
    const reserve = vi.fn(() => true);
    const redactedEvidence: string[] = [];
    const harness = createHarness({
      overrides: {
        updateSandbox: reserve,
        error: vi.fn((message: string) => redactedEvidence.push(message)),
      },
    });

    const result = harness.setupInference(
      SANDBOX,
      "nemotron:latest",
      "ollama-local",
      null,
      null,
      null,
      [],
      { hostLocalInference: selection },
    );
    await expect(result).rejects.toThrow("EXIT_CALLED:1");

    expect(gatewayCommit).toHaveBeenCalledOnce();
    expect(gatewayRollback).toHaveBeenCalledOnce();
    expect(provider.failures.at(-1)).toMatchObject({ phase: "gpu" });
    expect(redactedEvidence).toHaveLength(1);
    expect(redactedEvidence[0]).toContain("runtime provider 'podman'");
    expect(redactedEvidence[0]).toContain("complete provider-native NVIDIA GPU offload");
    expect(redactedEvidence.join("\n")).not.toContain("nvapi-1234567890abcdef");
    expect(reserve).not.toHaveBeenCalled();
    expect(preparedStartups).toHaveLength(1);
    expect(preparedStartups[0]?.commit).not.toHaveBeenCalled();
    expect(preparedStartups[0]?.rollback).toHaveBeenCalledOnce();
    expect(preparedStartups[0]?.rollback).toHaveReturnedWith(
      expect.objectContaining({ status: "retained", priorState: "host-process" }),
    );
    expect(preparedStartups[0]?.prepared.publicationState()).toBe("unpublished");
    expect(provider.routeAuthorityStore.load("ollama")).toBeNull();
    expect(provider.written).toHaveLength(0);
  });

  it.each(APPLICATIONS)(
    "fails closed for %s at an indeterminate receipt boundary without destroying the durable route",
    async (application) => {
      const route = fixture(application, "vllm", {
        commitError: new Error("receipt publication indeterminate"),
      });
      const reserve = vi.fn(() => {
        route.events.push("sandbox-reserve");
        return true;
      });
      const harness = createHarness({
        overrides: {
          updateSandbox: reserve,
          error: vi.fn(() => route.events.push("redacted-evidence")),
        },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events.slice(-5)).toEqual([
        "gateway-commit",
        "runtime-precommit-validation",
        "sandbox-reserve",
        "runtime-commit",
        "redacted-evidence",
      ]);
      expect(reserve).toHaveBeenCalledWith(
        SANDBOX,
        expect.objectContaining({
          endpointUrl: "https://inference.local/v1",
          endpointSource: "inference-set",
        }),
      );
      expect(route.gatewayRollback).not.toHaveBeenCalled();
      expect(route.events).not.toContain("runtime-rollback");
    },
  );

  it.each(APPLICATIONS)(
    "rejects %s cross-engine authority before runtime or gateway mutation",
    async (application) => {
      const route = fixture(application, "vllm", {
        authorityId: `other-endpoint:${"9".repeat(64)}`,
      });
      const legacyDockerNamedRun = vi.fn();
      const legacyDockerValidation = vi.fn();
      const harness = createHarness({
        overrides: {
          run: legacyDockerNamedRun,
          validateLocalProvider: legacyDockerValidation,
        },
      });

      await expect(
        harness.setupInference(SANDBOX, MODEL, "vllm-local", null, null, null, [], {
          hostLocalInference: route.selection,
        }),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(route.events).toEqual([]);
      expect(route.prepareGatewayMutation).not.toHaveBeenCalled();
      expect(harness.commands).toEqual([]);
      expect(legacyDockerNamedRun).not.toHaveBeenCalled();
      expect(legacyDockerValidation).not.toHaveBeenCalled();
    },
  );
});
