// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry/types";
import {
  normalizeHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
  type HostLocalInferencePreparedStartup,
  type HostLocalInferenceReceipt,
} from "../runtime-provider/host-local-inference";
import type { HostLocalInferenceStartupRequest } from "../runtime-provider/host-local-inference-routing";
const GPU_DEVICE = "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

export function publishedReceipt(): HostLocalInferenceReceipt {
  return normalizeHostLocalInferenceReceipt({
    schemaVersion: 2,
    providerId: "podman",
    service: "ollama",
    engineAuthority: {
      schemaVersion: 1,
      providerId: "podman",
      operation: "host-local-inference",
      engineId: "podman",
      authorityId: `podman-endpoint:${"a".repeat(64)}`,
      bindingSha256: "b".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 11_434,
      networkName: "openshell-docker",
      networkId: "c".repeat(64),
      networkGatewayIp: "10.89.0.1",
      networkListenerIp: "10.89.0.2",
      networkAuthoritySha256: "d".repeat(64),
    },
    inference: {
      protocol: "openai-chat-completions",
      model: "qwen3-vl:4b",
      toolCallingRequired: true,
    },
    publication: {
      transactionId: "e".repeat(64),
      targetSha256: "f".repeat(64),
      priorState: "absent",
    },
    runtime: {
      kind: "container",
      runtimeId: "a".repeat(64),
      name: "nemoclaw-portable-ollama-alpha",
      imageRef: `docker.io/library/ollama@sha256:${"1".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"2".repeat(64)}`,
      specSha256: "3".repeat(64),
      launchSha256: "4".repeat(64),
      modelDigest: `sha256:${"5".repeat(64)}`,
      gpu: { vendor: "nvidia", devices: [GPU_DEVICE] },
    },
  });
}

export function createHarness(initiallyRunning = false, registryInitiallyRunning = false) {
  const receipt = publishedReceipt();
  const serializedReceipt = serializeHostLocalInferenceReceipt(receipt);
  const entry = {
    name: "alpha",
    agent: "hermes",
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    policies: ["personal-open-internet"],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    endpointUrl: "https://inference.local/v1",
    hostLocalInferenceReceipt: serializedReceipt,
  } as SandboxEntry;
  const events: string[] = [];
  let running = initiallyRunning;
  let registryRunning = registryInitiallyRunning;
  let publicationState: "unpublished" | "published" = "unpublished";
  const writeExact = vi.fn((value: string) => value);
  const runtime = {
    providerId: "podman",
    authorityId: `podman-endpoint:${"a".repeat(64)}`,
    services: ["ollama"],
    resumeManaged: vi.fn(),
    inspectManaged: vi.fn(() => ({ running, receipt })),
    inspectPublishedRecoveryRestoration: vi.fn(() => ({ running, receipt })),
    validatePublishedResume: vi.fn(() => {
      events.push("provider-validate");
      return receipt;
    }),
    preserveForRebuild: vi.fn(() => receipt),
  };
  const managedOperation = {
    providerId: "podman",
    engine: {
      operation: "host-local-inference",
      engineId: "podman",
      authorityId: `podman-endpoint:${"a".repeat(64)}`,
    },
    bindingSha256: "b".repeat(64),
    assertAuthority: vi.fn(),
    assertTransactionCurrent: vi.fn(),
    managedRuntime: runtime,
  };
  const prepared: HostLocalInferencePreparedStartup = {
    receipt,
    rollbackPriorState: "stopped",
    publicationState: () => publicationState,
    validateBeforeCommit: vi.fn(() => {
      events.push("prepared-validate");
      return receipt;
    }),
    commit: vi.fn(() => {
      events.push("commit");
      publicationState = "published";
      return receipt;
    }),
    finalizePublishedResume: vi.fn((assertPublishedAuthority) => {
      events.push("finalize");
      assertPublishedAuthority();
      publicationState = "published";
      return receipt;
    }),
    rollback: vi.fn(() => {
      events.push("rollback");
      running = false;
      return { priorState: "stopped" as const, status: "restored" as const, receipt };
    }),
  };
  const prepareStartup = vi.fn((_operation: unknown, request: HostLocalInferenceStartupRequest) => {
    events.push("resume");
    expect(request).toMatchObject({
      application: "hermes",
      service: "ollama",
      managed: {
        containerName: "nemoclaw-portable-ollama-alpha",
        model: "qwen3-vl:4b",
        gpuDevices: [GPU_DEVICE],
        networkName: "openshell-docker",
      },
      resumeReceipt: receipt,
    });
    running = true;
    return { prepared, receipt };
  });
  const assertOperating = vi.fn(() => events.push("operating"));
  const assertRuntimeRetainedCurrent = vi.fn(() => events.push("runtime-retained-current"));
  const assertRuntimeTransactionCurrent = vi.fn(() => events.push("runtime-transaction-current"));
  const assertRuntimeCurrent = vi.fn(() => {
    events.push("runtime-current");
    expect(running).toBe(true);
  });
  const assertPublished = vi.fn(() => {
    events.push("publication");
  });
  const prepareInferenceAuthority = vi.fn(
    (
      _bundle,
      lifecycleEntry: SandboxEntry,
      _options,
      entryTiming?: {
        readonly now?: () => number;
        readonly onComplete: (durationMs: number) => void;
      },
    ) => {
      expect(lifecycleEntry).toMatchObject({
        name: "alpha",
        agent: "hermes",
        openshellDriver: "podman",
        provider: "ollama-local",
      });
      expect(lifecycleEntry.hostLocalInferenceProvenance).toBeUndefined();
      const startedAt = entryTiming?.now?.() ?? 0;
      const managedInspection = { running, receipt };
      entryTiming?.onComplete((entryTiming.now?.() ?? startedAt) - startedAt);
      return {
        serializedReceipt,
        sandboxAuthoritySha256: "6".repeat(64),
        managedInspection,
        managedOperation,
        assertPublishedRecoveryTransactionCurrent: managedOperation.assertTransactionCurrent,
      };
    },
  );
  const createRuntimeAuthority = vi.fn(() => ({
    bundle: { identity: { id: "podman" } },
    inferenceStateDir: "/state/portable-inference/alpha",
    operation: managedOperation,
    assertRetainedCurrent: assertRuntimeRetainedCurrent,
    assertTransactionCurrent: assertRuntimeTransactionCurrent,
    assertCurrent: assertRuntimeCurrent,
  }));
  const prepareRegistryRecovery = vi.fn(() => {
    const started = !registryRunning;
    started ? events.push("registry-start") : undefined;
    registryRunning = started ? true : registryRunning;
    return {
      started,
      assertCurrent: vi.fn(() => {
        events.push("registry-current");
        expect(registryRunning).toBe(true);
      }),
      assertTransactionCurrent: vi.fn(() => {
        events.push("registry-transaction-current");
        expect(registryRunning).toBe(true);
      }),
      assertRetainedCurrent: vi.fn(() => {
        events.push("registry-retained-current");
        expect(registryRunning).toBe(true);
      }),
      rollback: vi.fn(() => {
        events.push("registry-rollback");
        registryRunning = started ? false : registryRunning;
      }),
      release: vi.fn(() => events.push("registry-release")),
    };
  });
  const overrides = {
    readReceipt: vi.fn(() => ({ receipt: { phase: "active" }, successor: {} })),
    qualifyOperatingAuthority: vi.fn(() => ({
      receipt: {},
      assertTransactionCurrent: assertOperating,
      assertCurrent: assertOperating,
    })),
    createRuntimeAuthority,
    prepareRecoveryEntry: vi.fn(() => ({
      registryRecovery: prepareRegistryRecovery(),
      createRuntimeAuthority,
    })),
    prepareInferenceAuthority,
    assertPreparedInferenceAuthorityCurrent: vi.fn(() => ({ running, receipt })),
    assertPreparedInferenceAuthorityTransactionCurrent: vi.fn(),
    preparePublishedAuthority: vi.fn(() => ({
      receipt,
      serializedReceipt,
      receiptWriter: {
        transactionId: "e".repeat(64),
        targetSha256: "f".repeat(64),
        writeExact,
      },
      assertTransactionCurrent: assertPublished,
      assertCurrent: assertPublished,
    })),
    prepareRegistryRecovery,
    prepareStartup,
  };
  const input = {
    intent: "connect-probe-only" as const,
    sandboxName: "alpha",
    entry,
    env: {},
    stateDir: "/state",
    runGatewayOpenshell: vi.fn(),
    readRegistry: vi.fn(() => entry),
    verifyRoute: vi.fn(async () => {
      events.push("route");
      return entry;
    }),
  };
  return {
    assertRuntimeCurrent,
    assertRuntimeRetainedCurrent,
    assertRuntimeTransactionCurrent,
    events,
    input,
    managedOperation,
    overrides,
    prepared,
    prepareStartup,
    receipt,
    registryRunning: () => registryRunning,
    runtime,
    running: () => running,
    writeExact,
  };
}
