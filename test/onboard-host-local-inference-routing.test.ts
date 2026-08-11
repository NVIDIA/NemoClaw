// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  HostLocalInferenceReceipt,
  HostLocalInferenceRuntime,
} from "../src/lib/onboard/runtime-provider/host-local-inference.js";
import { parseHostLocalInferenceReceipt } from "../src/lib/onboard/runtime-provider/host-local-inference.js";
import { createSetupInference } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectCommandRouter,
  createDirectSetupInferenceHarnessFactory,
} from "./support/setup-inference-test-harness.js";

const createHarness = createDirectSetupInferenceHarnessFactory((overrides) =>
  createSetupInference({
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    getOllamaWarmupCommand: () => ["true"],
    ollamaProxyCredentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    vllmLocalCredentialEnv: "NEMOCLAW_VLLM_LOCAL_API_KEY",
    withGatewayRouteMutationLock: async <T>(
      _gatewayName: string,
      operation: () => Promise<T> | T,
    ) => await operation(),
    withSandboxMutationLock: async <T>(_sandboxName: string, operation: () => Promise<T> | T) =>
      await operation(),
    ...overrides,
  } as never),
);
const AUTHORITY_ID = "mxc:host-local-authority";
const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"a".repeat(64)}`;
const MANAGED_IMAGE = `nvcr.io/nvidia/vllm@sha256:${"b".repeat(64)}`;

function runtime(): HostLocalInferenceRuntime {
  return {
    providerId: "mxc",
    authorityId: AUTHORITY_ID,
    services: ["ollama", "nim", "vllm"],
    translateContainerArgs: (args) => args,
    qualifyOllama: vi.fn(
      (): HostLocalInferenceReceipt => ({
        schemaVersion: 1,
        providerId: "mxc",
        service: "ollama",
        engineAuthority: {
          schemaVersion: 1,
          providerId: "mxc",
          operation: "host-local-inference",
          engineId: "mxc",
          authorityId: AUTHORITY_ID,
          bindingSha256: "c".repeat(64),
        },
        endpoint: { host: "mxc.internal", port: 11434, networkName: "mxc-network" },
        runtime: { kind: "host", probeImageRef: PROBE_IMAGE },
      }),
    ),
    startManaged: vi.fn(() => {
      throw new Error("not used");
    }),
    inspectManaged: vi.fn((receipt) => ({ running: true, receipt })),
    stopManaged: vi.fn((receipt) => ({ running: false, receipt })),
    preserveForRebuild: vi.fn((receipt) => receipt),
    prepareDestroy: vi.fn((receipt) => receipt),
    destroy: vi.fn((receipt) => ({ status: "removed" as const, receipt })),
  };
}

function managedVllmReceipt(): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    service: "vllm",
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "mxc",
      authorityId: AUTHORITY_ID,
      bindingSha256: "c".repeat(64),
    },
    endpoint: { host: "mxc.internal", port: 8000, networkName: "mxc-network" },
    runtime: {
      kind: "container",
      runtimeId: "mxc-runtime:vllm",
      name: "nemoclaw-vllm",
      imageRef: MANAGED_IMAGE,
      probeImageRef: PROBE_IMAGE,
      specSha256: "d".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
}

function managedVllmRequest() {
  return {
    service: "vllm" as const,
    managed: {
      service: "vllm" as const,
      containerName: "nemoclaw-vllm",
      containerPort: 8000,
      imageRef: MANAGED_IMAGE,
      gpuDevices: ["nvidia.com/gpu=all"],
      networkName: "mxc-network",
      hostPort: 8000,
      probeImageRef: PROBE_IMAGE,
    },
  };
}

describe("setupInference host-local runtime integration", () => {
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

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("routes %s through the canonical all-agent inference boundary", async (application) => {
    const providerRuntime = runtime();
    const harness = createHarness({
      overrides: {
        resolveHostLocalInferenceRuntime: vi.fn(() => providerRuntime),
      },
    });

    await expect(
      harness.setupInference(
        `${application}-sandbox`,
        "qwen3.5:9b",
        "ollama-local",
        null,
        null,
        null,
        [],
        {
          hostLocalInference: {
            service: "ollama",
            endpoint: {
              networkName: "mxc-network",
              hostPort: 11434,
              probeImageRef: PROBE_IMAGE,
            },
          },
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(providerRuntime.qualifyOllama).toHaveBeenCalledOnce();
    const providerMutation = harness.commands
      .map(({ command }) => command)
      .find((command) => command.startsWith("provider update -g nemoclaw ollama-local"));
    expect(providerMutation).toContain(
      "--credential NEMOCLAW_OLLAMA_PROXY_TOKEN --config OPENAI_BASE_URL=http://host.openshell.internal:11434/v1",
    );
    expect(harness.commands.join("\n")).not.toContain("mxc.internal");
    expect(harness.verifyInferenceRoute).toHaveBeenCalledWith(
      "nemoclaw",
      "ollama-local",
      "qwen3.5:9b",
    );
    const reservation = (
      harness.updateSandbox.mock.calls.at(-1) as unknown as
        | [string, { hostLocalInferenceReceipt?: string }]
        | undefined
    )?.[1];
    expect(reservation?.hostLocalInferenceReceipt).toEqual(expect.any(String));
    expect(
      parseHostLocalInferenceReceipt(reservation?.hostLocalInferenceReceipt ?? ""),
    ).toMatchObject({
      providerId: "mxc",
      service: "ollama",
      endpoint: { port: 11434, networkName: "mxc-network" },
    });
  });

  it("fails before gateway mutation when the selected provider does not match the startup service", async () => {
    const providerRuntime = runtime();
    const harness = createHarness({
      overrides: { resolveHostLocalInferenceRuntime: () => providerRuntime },
    });

    await expect(
      harness.setupInference("sandbox-a", "model-a", "vllm-local", null, null, null, [], {
        hostLocalInference: {
          service: "ollama",
          endpoint: {
            networkName: "mxc-network",
            hostPort: 11434,
            probeImageRef: PROBE_IMAGE,
          },
        },
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(providerRuntime.qualifyOllama).not.toHaveBeenCalled();
    expect(harness.commands).toEqual([]);
    expect(harness.errors).toContain("  Host-local ollama cannot configure provider 'vllm-local'.");
  });

  it("starts a provider-owned managed vLLM input before registering the canonical route", async () => {
    const providerRuntime = runtime();
    providerRuntime.startManaged = vi.fn(() => managedVllmReceipt());
    const harness = createHarness({
      overrides: { resolveHostLocalInferenceRuntime: () => providerRuntime },
    });

    await expect(
      harness.setupInference("sandbox-a", "model-a", "vllm-local", null, null, null, [], {
        hostLocalInference: managedVllmRequest(),
      }),
    ).resolves.toEqual({ ok: true });

    expect(providerRuntime.startManaged).toHaveBeenCalledOnce();
    const providerMutation = harness.commands
      .map(({ command }) => command)
      .find((command) => command.startsWith("provider update -g nemoclaw vllm-local"));
    expect(providerMutation).toContain(
      "--credential NEMOCLAW_VLLM_LOCAL_API_KEY --config OPENAI_BASE_URL=http://host.openshell.internal:8000/v1",
    );
  });

  it("retries exact managed startup after provider registration failure without duplicate reservation", async () => {
    const receipt = managedVllmReceipt();
    const providerRuntime = runtime();
    providerRuntime.startManaged = vi.fn(() => receipt);
    const router = createDirectCommandRouter([
      {
        name: "provider-upsert",
        matches: (command) => command.startsWith("provider update -g nemoclaw vllm-local"),
        results: [{ status: 1, stderr: "injected provider registration failure" }, { status: 0 }],
      },
    ]);
    const harness = createHarness({
      runOpenshell: router.runOpenshell,
      overrides: { resolveHostLocalInferenceRuntime: () => providerRuntime },
    });
    const setup = () =>
      harness.setupInference("sandbox-a", "model-a", "vllm-local", null, null, null, [], {
        hostLocalInference: managedVllmRequest(),
      });

    await expect(setup()).rejects.toThrow("EXIT_CALLED:1");
    expect(harness.updateSandbox).not.toHaveBeenCalled();

    await expect(setup()).resolves.toEqual({ ok: true });
    expect(providerRuntime.startManaged).toHaveBeenCalledTimes(2);
    expect(providerRuntime.startManaged).toHaveNthReturnedWith(1, receipt);
    expect(providerRuntime.startManaged).toHaveNthReturnedWith(2, receipt);
    expect(router.callCount("provider-upsert")).toBe(2);
    expect(harness.updateSandbox).toHaveBeenCalledOnce();
    expect(harness.updateSandbox).toHaveBeenCalledWith(
      "sandbox-a",
      expect.objectContaining({ model: "model-a", provider: "vllm-local" }),
    );
  });
});
