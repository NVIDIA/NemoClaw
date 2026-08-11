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
      probeImageRef: `quay.io/curl/curl@sha256:${"d".repeat(64)}`,
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

function destroySuccessfully(value: HostLocalInferenceReceipt) {
  return { status: "removed" as const, receipt: value };
}

function failDestroy(message: string) {
  return (_value: HostLocalInferenceReceipt): never => {
    throw new Error(message);
  };
}

function provider(
  destroyRuntime: (value: HostLocalInferenceReceipt) => {
    status: "removed";
    receipt: HostLocalInferenceReceipt;
  } = destroySuccessfully,
) {
  const preserveForRebuild = vi.fn((value: HostLocalInferenceReceipt) => value);
  const prepareDestroy = vi.fn((value: HostLocalInferenceReceipt) => value);
  const destroy = vi.fn(destroyRuntime);
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

async function runDestroy(
  runtimeProvider: ReturnType<typeof provider>,
  peers: SandboxEntry[],
  deleteResult: { status: number; stdout: string; stderr: string } = {
    status: 0,
    stdout: "",
    stderr: "",
  },
  sandboxConfirmedAbsent = false,
  force = false,
) {
  const entry = sandbox();
  const events: string[] = [];
  const result = await executeSandboxDestroy({
    cleanupShieldsArtifacts: () => events.push("cleanup"),
    force,
    getSandbox: () => entry,
    listSandboxes: () => ({ sandboxes: [entry, ...peers] }),
    runOpenshell: (args) => {
      events.push(args.join(" "));
      return deleteResult;
    },
    sandbox: entry,
    sandboxConfirmedAbsent,
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
    expect(events.slice(-2)).toEqual(["sandbox delete alpha", "cleanup"]);
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
    const runtimeProvider = provider(failDestroy("injected runtime removal failure"));
    const { events, result } = await runDestroy(runtimeProvider, []);

    expect(result).toMatchObject({
      ok: false,
      deleteConfirmed: true,
      hostLocalInferenceCleanupFailure: "injected runtime removal failure",
    });
    expect(events.slice(-2)).toEqual(["sandbox delete alpha", "cleanup"]);
  });

  it("preserves durable runtime ownership when --force cannot reach the gateway", async () => {
    const runtimeProvider = provider();
    const { events, result } = await runDestroy(
      runtimeProvider,
      [],
      {
        status: 1,
        stdout: "",
        stderr: "tcp connect error: Connection refused (os error 61)",
      },
      false,
      true,
    );

    expect(result).toMatchObject({
      ok: false,
      gatewayUnreachable: true,
      hostLocalInferenceOwnershipRequiresGateway: true,
    });
    expect(events).toContain("sandbox delete alpha");
    expect(events).not.toContain("cleanup");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("reconciles retained ownership when destroy is retried after confirmed deletion", async () => {
    const destroyRuntime = vi
      .fn(destroySuccessfully)
      .mockImplementationOnce(failDestroy("injected runtime removal failure"));
    const runtimeProvider = provider(destroyRuntime);

    const first = await runDestroy(runtimeProvider, []);
    const retry = await runDestroy(
      runtimeProvider,
      [],
      { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" },
      true,
    );

    expect(first.result).toMatchObject({ ok: false, deleteConfirmed: true });
    expect(retry.result).toMatchObject({ ok: true, alreadyGone: true });
    expect(retry.events.slice(-2)).toEqual(["sandbox delete alpha", "cleanup"]);
    expect(runtimeProvider.destroy).toHaveBeenCalledTimes(2);
  });
});
