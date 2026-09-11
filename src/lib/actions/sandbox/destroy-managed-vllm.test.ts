// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostLocalVllmRetirementResult } from "../../inference/local-model-profile/cleanup";
import type { HostGatewayRegistryEntry } from "../../state/gateway-registry";
import type { SandboxEntry } from "../../state/registry";
import {
  type ManagedVllmDestroyOutcome,
  reportManagedVllmDestroyOutcome,
  retireManagedVllmForDestroyedSandbox,
} from "./destroy-preflight";

const CONTAINER_ID = "a".repeat(64);

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    provider: "vllm-local",
    model: "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8",
    endpointUrl: "http://host.openshell.internal:46145/v1",
    ...overrides,
  };
}

function registryEntry(
  name: string,
  provider: string,
  gatewayPort = 8080,
): HostGatewayRegistryEntry {
  return {
    entry: { name, provider },
    gatewayPort,
    registryFile: `/home/user/.nemoclaw/${String(gatewayPort)}/sandboxes.json`,
    stateRoot: `/home/user/.nemoclaw/${String(gatewayPort)}`,
  };
}

function makeDeps(
  remaining: HostGatewayRegistryEntry[],
  retirement: HostLocalVllmRetirementResult = {
    status: "removed",
    containerId: CONTAINER_ID,
    removed: [`container:${CONTAINER_ID}`],
  },
) {
  const listHostRegistryEntries = vi.fn(() => remaining);
  const retireRuntime = vi.fn(() => retirement);
  return {
    listHostRegistryEntries,
    retireRuntime,
    deps: {
      listHostRegistryEntries,
      retireRuntime,
      resolveHomeDir: () => "/home/user",
    },
  };
}

describe("managed vLLM retirement after sandbox destroy", () => {
  it("retires the container when the destroyed sandbox was the last Local vLLM consumer", () => {
    const { deps, retireRuntime } = makeDeps([registryEntry("beta", "nvidia-prod")]);

    expect(retireManagedVllmForDestroyedSandbox(sandbox(), deps)).toEqual({
      kind: "retirement",
      status: "removed",
      containerId: CONTAINER_ID,
      removed: [`container:${CONTAINER_ID}`],
    });
    expect(retireRuntime).toHaveBeenCalledWith({ homeDir: "/home/user" });
  });

  it("keeps the container while another gateway state root still registers a Local vLLM sandbox", () => {
    const { deps, retireRuntime } = makeDeps([
      registryEntry("beta", "nvidia-prod"),
      registryEntry("gamma", "vllm-local", 8091),
    ]);

    expect(retireManagedVllmForDestroyedSandbox(sandbox(), deps)).toEqual({
      kind: "kept",
      reason: "consumers",
      consumers: 1,
    });
    expect(retireRuntime).not.toHaveBeenCalled();
  });

  it("keeps the container when the destroy requested --keep-vllm", () => {
    const { deps, listHostRegistryEntries, retireRuntime } = makeDeps([]);

    expect(retireManagedVllmForDestroyedSandbox(sandbox(), { ...deps, keepVllm: true })).toEqual({
      kind: "kept",
      reason: "option",
    });
    expect(listHostRegistryEntries).not.toHaveBeenCalled();
    expect(retireRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no registry row", entry: null },
    { label: "a hosted provider", entry: sandbox({ provider: "nvidia-prod" }) },
    { label: "Local Ollama", entry: sandbox({ provider: "ollama-local" }) },
    {
      label: "a runtime-provider host-local inference receipt",
      entry: sandbox({ hostLocalInferenceReceipt: '{"schemaVersion":2}' }),
    },
  ])("does not apply to a destroyed sandbox with $label", ({ entry }) => {
    const { deps, listHostRegistryEntries, retireRuntime } = makeDeps([]);

    expect(retireManagedVllmForDestroyedSandbox(entry, deps)).toEqual({ kind: "not-applicable" });
    expect(listHostRegistryEntries).not.toHaveBeenCalled();
    expect(retireRuntime).not.toHaveBeenCalled();
  });

  it("preserves the container when a gateway registry cannot be read", () => {
    const retireRuntime = vi.fn();

    expect(
      retireManagedVllmForDestroyedSandbox(sandbox(), {
        listHostRegistryEntries: () => {
          throw new Error("sandboxes.json is not owner-only");
        },
        resolveHomeDir: () => "/home/user",
        retireRuntime: retireRuntime as never,
      }),
    ).toEqual({ kind: "inventory-failed", detail: "sandboxes.json is not owner-only" });
    expect(retireRuntime).not.toHaveBeenCalled();
  });

  it("passes a preserved runtime result through", () => {
    const { deps } = makeDeps([], {
      status: "preserved",
      reason: "the container does not carry the NemoClaw managed vLLM label",
      removed: [],
    });

    expect(retireManagedVllmForDestroyedSandbox(sandbox(), deps)).toEqual({
      kind: "retirement",
      status: "preserved",
      reason: "the container does not carry the NemoClaw managed vLLM label",
      removed: [],
    });
  });
});

describe("managed vLLM retirement report", () => {
  function render(outcome: ManagedVllmDestroyOutcome) {
    const logs: string[] = [];
    const warnings: string[] = [];
    reportManagedVllmDestroyOutcome(outcome, {
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });
    return { logs, warnings };
  }

  it("prints nothing when retirement does not apply or no container exists", () => {
    expect(render({ kind: "not-applicable" })).toEqual({ logs: [], warnings: [] });
    expect(render({ kind: "retirement", status: "absent" })).toEqual({ logs: [], warnings: [] });
  });

  it("names the removed container and the option that keeps it next time", () => {
    const { logs, warnings } = render({
      kind: "retirement",
      status: "removed",
      containerId: CONTAINER_ID,
      removed: [`container:${CONTAINER_ID}`],
    });

    expect(warnings).toEqual([]);
    expect(logs[0]).toContain(`'nemoclaw-vllm' (${CONTAINER_ID.slice(0, 12)})`);
    expect(logs[1]).toContain("--keep-vllm");
    expect(logs[1]).toContain("NEMOCLAW_KEEP_VLLM=1");
  });

  it("reports remaining consumers, the keep option, or distributed ownership as preservation", () => {
    expect(render({ kind: "kept", reason: "consumers", consumers: 2 }).logs).toEqual([
      "  Managed vLLM container 'nemoclaw-vllm' preserved: 2 other registered sandbox(es) use Local vLLM.",
    ]);
    expect(render({ kind: "kept", reason: "option" }).logs).toEqual([
      "  Managed vLLM container 'nemoclaw-vllm' preserved (--keep-vllm).",
    ]);
    const distributed = render({
      kind: "retirement",
      status: "kept",
      reason: "a distributed vLLM receipt owns it until full uninstall",
    });
    expect(distributed.warnings).toEqual([]);
    expect(distributed.logs).toEqual([
      "  Managed vLLM container 'nemoclaw-vllm' preserved: a distributed vLLM receipt owns it until full uninstall.",
    ]);
  });

  it("warns with the reason and an inspection hint when the container was left in place", () => {
    const preserved = render({
      kind: "retirement",
      status: "preserved",
      reason: "Docker is unavailable",
      removed: [],
    });
    const inventory = render({ kind: "inventory-failed", detail: "registry unreadable" });

    expect(preserved.logs).toEqual([]);
    expect(preserved.warnings[0]).toContain("Docker is unavailable");
    expect(preserved.warnings[0]).toContain("docker container inspect nemoclaw-vllm");
    expect(inventory.warnings[0]).toContain("registry unreadable");
    expect(inventory.warnings[0]).toContain("docker container inspect nemoclaw-vllm");
  });
});
