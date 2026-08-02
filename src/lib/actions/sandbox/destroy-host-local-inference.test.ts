// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import {
  type HostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import type { SandboxEntry } from "../../state/registry";
import { executeSandboxDestroy } from "./destroy-execution";

function receipt(): HostLocalInferenceReceipt {
  return {
    schemaVersion: 1,
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
    endpoint: { host: "mxc.internal", port: 8000, networkName: "mxc-network" },
    runtime: {
      kind: "container",
      runtimeId: "mxc-vllm",
      name: "nemoclaw-vllm",
      imageRef: `nvcr.io/nvidia/vllm@sha256:${"b".repeat(64)}`,
      specSha256: "c".repeat(64),
      gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
    },
  };
}

function sandbox(name = "alpha"): SandboxEntry {
  return {
    name,
    agent: "openclaw",
    openshellDriver: "mxc",
    hostLocalInferenceReceipt: serializeHostLocalInferenceReceipt(receipt()),
  };
}

function provider(destroyError?: string) {
  const preserveForRebuild = vi.fn((value: HostLocalInferenceReceipt) => value);
  const prepareDestroy = vi.fn((value: HostLocalInferenceReceipt) => value);
  const destroy = vi.fn((value: HostLocalInferenceReceipt) => {
    if (destroyError) throw new Error(destroyError);
    return { status: "removed" as const, receipt: value };
  });
  const bundle = createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: {
      support: null,
      hostArchitectures: ["amd64"],
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInferenceRuntime: {
      providerId: "mxc",
      authorityId: "mxc:host-local",
      services: ["ollama", "nim", "vllm"],
      translateContainerArgs: (args: readonly string[]) => args,
      qualifyOllama: vi.fn(),
      startManaged: vi.fn(),
      inspectManaged: vi.fn(),
      stopManaged: vi.fn(),
      preserveForRebuild,
      prepareDestroy,
      destroy,
    },
  });
  return { bundle, destroy, prepareDestroy, preserveForRebuild };
}

async function runDestroy(runtimeProvider: ReturnType<typeof provider>, peers: SandboxEntry[]) {
  const entry = sandbox();
  const events: string[] = [];
  const result = await executeSandboxDestroy({
    cleanupShieldsArtifacts: () => events.push("cleanup"),
    force: false,
    getSandbox: () => entry,
    listSandboxes: () => ({ sandboxes: [entry, ...peers] }),
    runOpenshell: (args) => {
      if (args[0] === "sandbox" && args[1] === "delete") events.push("delete");
      return { status: 0, stdout: "", stderr: "" };
    },
    sandbox: entry,
    sandboxConfirmedAbsent: false,
    sandboxName: "alpha",
    runtimeProviders: { mxc: runtimeProvider.bundle },
    deps: {
      readTimerMarker: () => null,
      wipeSandboxState: () => undefined,
    },
  });
  return { events, result };
}

describe("sandbox destroy host-local inference transaction", () => {
  it("deletes the sandbox before retiring the exact unshared runtime", async () => {
    const runtimeProvider = provider();
    const { events, result } = await runDestroy(runtimeProvider, []);

    expect(result).toMatchObject({ ok: true });
    expect(events).toEqual(["delete", "cleanup"]);
    expect(runtimeProvider.prepareDestroy).toHaveBeenCalledTimes(2);
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
  });

  it("keeps a runtime referenced by another sandbox", async () => {
    const runtimeProvider = provider();
    const { result } = await runDestroy(runtimeProvider, [sandbox("beta")]);

    expect(result).toMatchObject({ ok: true });
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("preserves local ownership when exact runtime retirement fails", async () => {
    const runtimeProvider = provider("injected runtime removal failure");
    const { events, result } = await runDestroy(runtimeProvider, []);

    expect(result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: "injected runtime removal failure",
    });
    expect(events).toEqual(["delete", "cleanup"]);
  });
});
