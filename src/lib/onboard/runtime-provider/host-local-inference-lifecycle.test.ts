// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry/types";
import type { RuntimeProviderBundle } from "./contract";
import {
  type HostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import {
  prepareSandboxHostLocalInferenceDestroyAuthority,
  retirePreparedHostLocalInferenceAuthority,
} from "./host-local-inference-lifecycle";

function serializedReceipt(service: "ollama" | "nim" | "vllm" = "vllm"): string {
  return serializeHostLocalInferenceReceipt({
    schemaVersion: 1,
    providerId: "mxc",
    service,
    engineAuthority: {
      schemaVersion: 1,
      providerId: "mxc",
      operation: "host-local-inference",
      engineId: "mxc",
      authorityId: "mxc:host-local",
      bindingSha256: "a".repeat(64),
    },
    endpoint: { host: "mxc.internal", port: 8000, networkName: "mxc-network" },
    runtime:
      service === "ollama"
        ? { kind: "host", probeImageRef: `quay.io/curl/curl@sha256:${"b".repeat(64)}` }
        : {
            kind: "container",
            runtimeId: `mxc-${service}`,
            name: `nemoclaw-${service}`,
            imageRef: `nvcr.io/nvidia/${service}@sha256:${"c".repeat(64)}`,
            probeImageRef: `quay.io/curl/curl@sha256:${"b".repeat(64)}`,
            specSha256: "d".repeat(64),
            gpu: { vendor: "nvidia", devices: ["nvidia.com/gpu=all"] },
          },
  });
}

function sandbox(name: string, receipt = serializedReceipt()): SandboxEntry {
  return { name, agent: "openclaw", openshellDriver: "mxc", hostLocalInferenceReceipt: receipt };
}

function provider() {
  const preserveForRebuild = vi.fn((receipt: HostLocalInferenceReceipt) => receipt);
  const prepareDestroy = vi.fn((receipt: HostLocalInferenceReceipt) => receipt);
  const destroy = vi.fn((receipt: HostLocalInferenceReceipt) => ({
    status: receipt.runtime.kind === "host" ? ("retained" as const) : ("removed" as const),
    ...(receipt.runtime.kind === "host" ? { reason: "host-process" as const } : {}),
    receipt,
  }));
  const bundle = {
    identity: { contractVersion: 1, id: "mxc", displayName: "MXC" },
    hostLocalInference: {
      providerId: "mxc",
      supported: true,
      runtime: {
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
    },
  } as unknown as RuntimeProviderBundle;
  return { bundle, destroy, prepareDestroy, preserveForRebuild };
}

describe("host-local inference lifecycle authority", () => {
  it.each([
    "ollama",
    "nim",
    "vllm",
  ] as const)("retires exact unshared %s authority through an MXC-style provider", (service) => {
    const runtimeProvider = provider();
    const entry = sandbox("alpha", serializedReceipt(service));
    const prepared = prepareSandboxHostLocalInferenceDestroyAuthority(
      runtimeProvider.bundle,
      entry,
    );

    expect(prepared).not.toBeNull();
    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, entry, prepared!, [entry])
        .status,
    ).toBe(service === "ollama" ? "retained" : "removed");
    expect(runtimeProvider.destroy).toHaveBeenCalledOnce();
    expect(runtimeProvider.prepareDestroy).toHaveBeenCalledTimes(2);
  });

  it("keeps a managed runtime while another sandbox owns the exact receipt", () => {
    const runtimeProvider = provider();
    const alpha = sandbox("alpha");
    const beta = sandbox("beta");
    const prepared = prepareSandboxHostLocalInferenceDestroyAuthority(
      runtimeProvider.bundle,
      alpha,
    );

    expect(
      retirePreparedHostLocalInferenceAuthority(runtimeProvider.bundle, alpha, prepared!, [
        alpha,
        beta,
      ]).status,
    ).toBe("shared");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });

  it("rejects registry drift before provider mutation", () => {
    const runtimeProvider = provider();
    const alpha = sandbox("alpha");
    const prepared = prepareSandboxHostLocalInferenceDestroyAuthority(
      runtimeProvider.bundle,
      alpha,
    );

    expect(() =>
      retirePreparedHostLocalInferenceAuthority(
        runtimeProvider.bundle,
        sandbox("alpha", serializedReceipt("nim")),
        prepared!,
        [],
      ),
    ).toThrow("destroy target changed runtime identity");
    expect(runtimeProvider.destroy).not.toHaveBeenCalled();
  });
});
