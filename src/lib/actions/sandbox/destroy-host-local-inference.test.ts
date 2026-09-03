// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { llamaCppHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import type { HostLocalInferenceOperation } from "../../onboard/runtime-provider/host-local-inference";
import {
  type HostLocalInferenceDestroyResult,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceRuntime,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import type { SandboxEntry } from "../../state/registry";
import { createSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";
import { executeSandboxDestroy } from "./destroy-execution";

const AUTHORITY_ID = `mxc-endpoint:${"a".repeat(64)}`;
const BINDING_SHA256 = "d".repeat(64);
const MODEL = "qwen3.5-9b";
const SANDBOX_FINGERPRINT = "a".repeat(64);
type PendingCreateVerification = NonNullable<SandboxEntry["pendingCreateIdentity"]>;

function pendingCreateIdentity(
  overrides: Partial<PendingCreateVerification> = {},
): PendingCreateVerification {
  return {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sandboxName: "alpha",
    lifecycleGeneration: "alpha-generation-1",
    sandboxIdentityFingerprint: SANDBOX_FINGERPRINT,
    route: "none",
    ...overrides,
  };
}

function receipt(
  service: "ollama" | "nim" | "vllm" = "vllm",
  publicationTransactionId = "1".repeat(64),
): HostLocalInferenceReceipt {
  const port = service === "ollama" ? 11434 : service === "nim" ? 8001 : 8000;
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
      bindingSha256: BINDING_SHA256,
    },
    endpoint: {
      host: "host.openshell.internal",
      port,
      networkName: "mxc-runtime-network",
      networkId: "2".repeat(64),
      networkGatewayIp: "10.89.0.1",
      networkAuthoritySha256: "3".repeat(64),
    },
    inference: {
      protocol: "openai-chat-completions",
      model: service === "ollama" ? `${MODEL}:latest` : MODEL,
      toolCallingRequired: true,
    },
    publication: {
      transactionId: publicationTransactionId,
      targetSha256: "4".repeat(64),
      priorState: service === "ollama" ? "host-process" : "absent",
    },
    runtime:
      service === "ollama"
        ? {
            kind: "host",
            probeImageRef: `quay.io/curl/curl@sha256:${"5".repeat(64)}`,
            acceleration: "nvidia-gpu",
            modelDigest: `sha256:${"6".repeat(64)}`,
          }
        : {
            kind: "container",
            runtimeId: `mxc-runtime:${service}`,
            name: `nemoclaw-${service}`,
            imageRef: `nvcr.io/nvidia/${service}@sha256:${"7".repeat(64)}`,
            probeImageRef: `quay.io/curl/curl@sha256:${"5".repeat(64)}`,
            specSha256: "8".repeat(64),
            launchSha256: "9".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
          },
  };
}

function sandbox(
  name = "alpha",
  value = receipt(),
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  return {
    name,
    agent: "openclaw",
    openshellDriver: "mxc",
    provider: value.service === "ollama" ? "ollama-local" : "vllm-local",
    model: value.inference?.model ?? MODEL,
    endpointUrl: "https://inference.local/v1",
    gatewayName: "nemoclaw",
    lifecycleGeneration: `${name}-generation-1`,
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(value),
    ...overrides,
  };
}

function provider(
  options: {
    prepareDestroy?: (value: HostLocalInferenceReceipt) => HostLocalInferenceReceipt;
    destroy?: (value: HostLocalInferenceReceipt) => HostLocalInferenceDestroyResult;
  } = {},
) {
  const events: string[] = [];
  const prepareDestroy = vi.fn((value: HostLocalInferenceReceipt) => {
    events.push("runtime prepare destroy");
    return options.prepareDestroy?.(value) ?? value;
  });
  const destroy = vi.fn((value: HostLocalInferenceReceipt) => {
    events.push("runtime destroy");
    return options.destroy?.(value) ?? { status: "removed" as const, receipt: value };
  });
  const runtime: HostLocalInferenceRuntime = {
    providerId: "mxc",
    authorityId: AUTHORITY_ID,
    services: ["ollama", "nim", "vllm"],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(),
    startManaged: vi.fn(),
    inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
    stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
    preserveForRebuild: vi.fn((value) => value),
    prepareDestroy,
    destroy,
  };
  const operation: HostLocalInferenceOperation = {
    providerId: "mxc",
    engine: {
      operation: "host-local-inference",
      engineId: "memory",
      displayName: "In-memory",
      authorityId: AUTHORITY_ID,
      capture: vi.fn(),
      captureHost: vi.fn(),
    },
    bindingSha256: BINDING_SHA256,
    assertAuthority: vi.fn(),
    spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
    createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
    managedRuntime: runtime,
  };
  const createOperation = vi.fn(() => operation);
  const bundle = createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: {
      support: null,
      hostArchitectures: ["x64"],
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInference: {
      services: ["ollama", "nim", "vllm"],
      createOperation,
    },
    recordEvent: (event) => events.push(event),
  });
  return { bundle, createOperation, destroy, events, prepareDestroy };
}

async function runDestroy(
  runtimeProvider: ReturnType<typeof provider>,
  options: {
    entry?: SandboxEntry;
    peers?: SandboxEntry[];
    currentAfterDelete?: SandboxEntry | null;
    deleteResult?: { status: number; stdout: string; stderr: string };
    sandboxConfirmedAbsent?: boolean;
    force?: boolean;
    includeRegistryReaders?: boolean;
    inspectSandboxIdentityFingerprint?: () => string;
    lifecycleOptions?: NonNullable<
      NonNullable<
        Parameters<typeof executeSandboxDestroy>[0]["deps"]
      >["hostLocalInferenceLifecycleOptions"]
    >;
  } = {},
) {
  const entry = options.entry ?? sandbox();
  const peers = options.peers ?? [];
  const afterDelete = Object.hasOwn(options, "currentAfterDelete")
    ? (options.currentAfterDelete ?? null)
    : entry;
  let current: SandboxEntry | null = entry;
  const getSandbox = vi.fn(() => current);
  const listSandboxes = vi.fn(() => ({
    sandboxes: [...(current ? [current] : []), ...peers],
  }));
  const stopInferenceResources = vi.fn(() => {
    runtimeProvider.events.push("legacy inference cleanup");
  });
  const runOpenshell = vi.fn((args: string[]) => {
    const command = args.join(" ");
    runtimeProvider.events.push(command);
    current = command === "sandbox delete alpha" ? afterDelete : current;
    return (
      options.deleteResult ?? {
        status: 0,
        stdout: "",
        stderr: "",
      }
    );
  });
  const result = await executeSandboxDestroy({
    cleanupShieldsArtifacts: () => runtimeProvider.events.push("cleanup"),
    force: options.force ?? false,
    ...(options.includeRegistryReaders === false ? {} : { getSandbox, listSandboxes }),
    runOpenshell,
    sandbox: entry,
    sandboxConfirmedAbsent: options.sandboxConfirmedAbsent ?? false,
    sandboxName: "alpha",
    stopInferenceResources,
    runtimeProviders: { mxc: runtimeProvider.bundle },
    deps: {
      ...(options.lifecycleOptions
        ? { hostLocalInferenceLifecycleOptions: options.lifecycleOptions }
        : {}),
      ...(options.inspectSandboxIdentityFingerprint
        ? {
            inspectOpenShellSandboxIdentityFingerprint: options.inspectSandboxIdentityFingerprint,
          }
        : {}),
      readTimerMarker: () => null,
      wipeSandboxState: () => undefined,
    },
  });
  return {
    getSandbox,
    listSandboxes,
    result,
    runOpenshell,
    stopInferenceResources,
  };
}

describe("sandbox destroy host-local inference transaction", () => {
  function explicitLlamaReceipt(): HostLocalInferenceReceipt {
    const value = llamaCppHostLocalInferenceReceipt();
    return {
      ...value,
      engineAuthority: {
        ...value.engineAuthority,
        engineId: "memory",
      },
    };
  }

  it.each([
    ["changes", () => "b".repeat(64)],
    [
      "cannot be inspected",
      () => {
        throw new Error("identity unavailable");
      },
    ],
  ])("preserves a pending create when its sandbox identity %s", async (_case, inspect) => {
    const runtimeProvider = provider();
    const entry = sandbox("alpha", receipt(), {
      pendingCreateIdentity: pendingCreateIdentity(),
    });

    const { result, runOpenshell, stopInferenceResources } = await runDestroy(runtimeProvider, {
      entry,
      inspectSandboxIdentityFingerprint: inspect,
    });

    expect(result).toMatchObject({
      ok: false,
      deleteOutput: expect.stringContaining("Pending create sandbox identity"),
    });
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(stopInferenceResources).not.toHaveBeenCalled();
    expect(runtimeProvider.events).toEqual([]);
  });

  it("re-reads a matching pending checkpoint and gateway-scopes its delete", async () => {
    const runtimeProvider = provider();
    const entry = sandbox("alpha", receipt(), {
      pendingCreateIdentity: pendingCreateIdentity(),
    });
    const inspect = vi.fn(() => SANDBOX_FINGERPRINT);

    const { getSandbox, result, runOpenshell } = await runDestroy(runtimeProvider, {
      entry,
      inspectSandboxIdentityFingerprint: inspect,
    });

    expect(result).toMatchObject({ ok: true });
    expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(getSandbox.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("preserves a pending create when its checkpoint changes during identity inspection", async () => {
    const runtimeProvider = provider();
    const entry = sandbox("alpha", receipt(), {
      pendingCreateIdentity: pendingCreateIdentity(),
    });
    const getSandbox = vi
      .fn()
      .mockReturnValueOnce(entry)
      .mockReturnValueOnce({
        ...entry,
        pendingCreateIdentity: pendingCreateIdentity({ route: "compatibility" }),
      });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const stopInferenceResources = vi.fn();

    const result = await executeSandboxDestroy({
      cleanupShieldsArtifacts: vi.fn(),
      force: false,
      getSandbox,
      listSandboxes: () => ({ sandboxes: [entry] }),
      runOpenshell,
      sandbox: entry,
      sandboxConfirmedAbsent: false,
      sandboxName: "alpha",
      stopInferenceResources,
      runtimeProviders: { mxc: runtimeProvider.bundle },
      deps: {
        inspectOpenShellSandboxIdentityFingerprint: () => SANDBOX_FINGERPRINT,
        readTimerMarker: () => null,
        wipeSandboxState: () => undefined,
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  function explicitLlamaSandbox(value = explicitLlamaReceipt()): SandboxEntry {
    const serialized = serializeHostLocalInferenceReceipt(value);
    return {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "docker",
      provider: "llama-cpp-local",
      model: "llama-cpp-model",
      endpointUrl: "https://inference.local/v1",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "alpha-generation-1",
      hostLocalInferenceReceipt: serialized,
      hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", serialized),
    };
  }

  function explicitLlamaProvider(options: { readonly failDestroy?: boolean } = {}) {
    const value = explicitLlamaReceipt();
    const prepareDestroy = vi.fn((receiptValue: HostLocalInferenceReceipt) => receiptValue);
    const destroy = options.failDestroy
      ? vi.fn((_receiptValue: HostLocalInferenceReceipt) => {
          throw new Error("injected exact llama.cpp cleanup failure");
        })
      : vi.fn((receiptValue: HostLocalInferenceReceipt) => ({
          status: "removed" as const,
          receipt: receiptValue,
        }));
    const runtime: HostLocalInferenceRuntime = {
      providerId: "docker",
      authorityId: value.engineAuthority.authorityId,
      services: ["llama-cpp"],
      translateContainerArgs: (args) => args,
      qualifyOllama: vi.fn(),
      startManaged: vi.fn(),
      inspectManaged: vi.fn((receiptValue) => ({
        running: true,
        receipt: receiptValue,
      })),
      stopManaged: vi.fn((receiptValue) => ({
        running: false,
        receipt: receiptValue,
      })),
      preserveForRebuild: vi.fn((receiptValue) => receiptValue),
      prepareDestroy,
      destroy,
    };
    const operation: HostLocalInferenceOperation = {
      providerId: "docker",
      engine: {
        operation: "host-local-inference",
        engineId: "memory",
        displayName: "In-memory",
        authorityId: value.engineAuthority.authorityId,
        capture: vi.fn(),
        captureHost: vi.fn(),
      },
      bindingSha256: value.engineAuthority.bindingSha256,
      assertAuthority: vi.fn(),
      spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
      createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
    };
    const bundle = createInMemoryRuntimeProviderBundle({
      providerId: "docker",
      workloadProfile: {
        support: null,
        hostArchitectures: ["x64"],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: false,
      },
      hostLocalInference: {
        services: ["llama-cpp"],
        createOperation: () => operation,
      },
    });
    const createLlamaCppAdapter = vi.fn((adapterOptions) => ({
      gatewayPort: adapterOptions.gatewayPort ?? 8080,
      runtimeOwnerSandboxName: adapterOptions.runtimeOwnerSandboxName,
      model: adapterOptions.expectedModel,
      operation: adapterOptions.operation!,
      receipt: adapterOptions.expectedReceipt,
      runtime,
      prepareStartup: vi.fn(),
    }));
    return { bundle, createLlamaCppAdapter, destroy, prepareDestroy };
  }

  it("marks explicit llama.cpp authority retired only after one conclusive common cleanup", async () => {
    const runtimeProvider = explicitLlamaProvider();
    const entry = explicitLlamaSandbox();
    let current: SandboxEntry | null = entry;
    const stopInferenceResources = vi.fn();
    const result = await executeSandboxDestroy({
      cleanupShieldsArtifacts: vi.fn(),
      force: false,
      getSandbox: () => current,
      listSandboxes: () => ({ sandboxes: current ? [current] : [] }),
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      sandbox: entry,
      sandboxConfirmedAbsent: false,
      sandboxName: "alpha",
      stopInferenceResources,
      runtimeProviders: { docker: runtimeProvider.bundle },
      deps: {
        hostLocalInferenceLifecycleOptions: {
          createLlamaCppAdapter: runtimeProvider.createLlamaCppAdapter,
        },
        readTimerMarker: () => null,
        wipeSandboxState: () => undefined,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      commonLlamaCppAuthorityRetired: true,
    });
    expect(runtimeProvider.prepareDestroy).toHaveBeenCalledTimes(2);
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  it("retains explicit llama.cpp retry authority when common cleanup fails", async () => {
    const runtimeProvider = explicitLlamaProvider({ failDestroy: true });
    const entry = explicitLlamaSandbox();
    const stopInferenceResources = vi.fn();
    const result = await executeSandboxDestroy({
      cleanupShieldsArtifacts: vi.fn(),
      force: false,
      getSandbox: () => entry,
      listSandboxes: () => ({ sandboxes: [entry] }),
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      sandbox: entry,
      sandboxConfirmedAbsent: false,
      sandboxName: "alpha",
      stopInferenceResources,
      runtimeProviders: { docker: runtimeProvider.bundle },
      deps: {
        hostLocalInferenceLifecycleOptions: {
          createLlamaCppAdapter: runtimeProvider.createLlamaCppAdapter,
        },
        readTimerMarker: () => null,
        wipeSandboxState: () => undefined,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: expect.stringContaining("injected exact llama.cpp"),
    });
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  it("retires the exact unshared runtime only after confirmed sandbox deletion", async () => {
    const runtimeProvider = provider();
    const { result, stopInferenceResources } = await runDestroy(runtimeProvider);

    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("commonLlamaCppAuthorityRetired");
    expect(runtimeProvider.events.indexOf("runtime destroy")).toBeGreaterThan(
      runtimeProvider.events.indexOf("sandbox delete alpha"),
    );
    expect(runtimeProvider.prepareDestroy).toHaveBeenCalledTimes(2);
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  it("keeps an exact runtime referenced by another sandbox", async () => {
    const runtimeProvider = provider();
    const entry = sandbox();
    const peer = sandbox("beta", receipt());
    const { result } = await runDestroy(runtimeProvider, { entry, peers: [peer] });

    expect(result).toMatchObject({ ok: true });
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("retains externally owned Ollama instead of removing its host process", async () => {
    const value = receipt("ollama");
    const runtimeProvider = provider({
      destroy: (current) => ({ status: "retained", reason: "host-process", receipt: current }),
    });
    const { result, stopInferenceResources } = await runDestroy(runtimeProvider, {
      entry: sandbox("alpha", value),
    });

    expect(result).toMatchObject({ ok: true });
    expect(runtimeProvider.destroy).toHaveBeenCalledWith(value);
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  it("redacts provider-native preflight failures and fails closed before legacy cleanup", async () => {
    const runtimeProvider = provider({
      prepareDestroy: () => {
        throw new Error("provider failed with OPENAI_API_KEY=super-secret");
      },
    });
    const { result, runOpenshell, stopInferenceResources } = await runDestroy(runtimeProvider);

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).toContain("<REDACTED>");
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  it("requires exact registry readers before deleting a sandbox with durable authority", async () => {
    const runtimeProvider = provider();
    const { result, runOpenshell, stopInferenceResources } = await runDestroy(runtimeProvider, {
      includeRegistryReaders: false,
    });

    expect(result).toMatchObject({ ok: false });
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(stopInferenceResources).not.toHaveBeenCalled();
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects a malformed durable receipt before sandbox deletion", async () => {
    const runtimeProvider = provider();
    const entry = sandbox("alpha", receipt(), { hostLocalInferenceReceipt: "not-json" });
    const { result, runOpenshell, stopInferenceResources } = await runDestroy(runtimeProvider, {
      entry,
    });

    expect(result).toMatchObject({ ok: false });
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(stopInferenceResources).not.toHaveBeenCalled();
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("preserves authority when the registry row is missing or reused after deletion", async () => {
    const missingProvider = provider();
    const missing = await runDestroy(missingProvider, { currentAfterDelete: null });
    expect(missing.result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: expect.stringContaining("no longer registered"),
    });
    expect(missingProvider.destroy).not.toHaveBeenCalled();

    const reusedProvider = provider();
    const reused = await runDestroy(reusedProvider, {
      currentAfterDelete: sandbox("alpha", receipt(), {
        lifecycleGeneration: "alpha-generation-reused",
      }),
    });
    expect(reused.result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: expect.any(String),
    });
    expect(reusedProvider.destroy).not.toHaveBeenCalled();
  });

  it("fails closed on ambiguous peer authority for the same immutable runtime", async () => {
    const runtimeProvider = provider();
    const peer = sandbox("beta", receipt("vllm", "a".repeat(64)));
    const { result } = await runDestroy(runtimeProvider, { peers: [peer] });

    expect(result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: expect.any(String),
    });
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("preserves local authority when exact runtime retirement is indeterminate", async () => {
    const runtimeProvider = provider({
      destroy: () => {
        throw new Error("cleanup failed with NVIDIA_API_KEY=super-secret");
      },
    });
    const { result } = await runDestroy(runtimeProvider);

    expect(result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: expect.stringContaining("<REDACTED>"),
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("does not discard durable authority when --force cannot reach the gateway", async () => {
    const runtimeProvider = provider();
    const { result, stopInferenceResources } = await runDestroy(runtimeProvider, {
      deleteResult: {
        status: 1,
        stdout: "",
        stderr: "tcp connect error: Connection refused (os error 61)",
      },
      force: true,
    });

    expect(result).toMatchObject({
      ok: false,
      gatewayUnreachable: true,
      hostLocalInferenceOwnershipRequiresGateway: true,
    });
    expect(runtimeProvider.events).not.toContain("cleanup");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
    expect(stopInferenceResources).not.toHaveBeenCalled();
  });

  it("reconciles retained authority only after stable sandbox absence", async () => {
    const destroy = vi
      .fn((value: HostLocalInferenceReceipt): HostLocalInferenceDestroyResult => ({
        status: "already-absent",
        receipt: value,
      }))
      .mockImplementationOnce(() => {
        throw new Error("injected runtime removal failure");
      });
    const runtimeProvider = provider({
      destroy,
    });

    const first = await runDestroy(runtimeProvider);
    const retry = await runDestroy(runtimeProvider, {
      deleteResult: {
        status: 1,
        stdout: "",
        stderr: "Error: sandbox alpha not found",
      },
      sandboxConfirmedAbsent: true,
    });

    expect(first.result).toMatchObject({ ok: false, deleteConfirmed: true });
    expect(retry.result).toMatchObject({ ok: true, alreadyGone: true });
    expect(runtimeProvider.destroy).toHaveBeenCalledTimes(2);
  });
});
