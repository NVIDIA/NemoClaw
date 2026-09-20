// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingHostLocalVllmRetirement,
  HOST_LOCAL_VLLM_PENDING_RETIREMENT_FILE,
  type HostLocalVllmRetirementResult,
  readPendingHostLocalVllmRetirement,
  recordPendingHostLocalVllmRetirement,
} from "../../inference/local-model-profile/cleanup";
import type { HostGatewayRegistryEntry } from "../../state/gateway-registry";
import type { SandboxEntry } from "../../state/registry";
import {
  type ManagedVllmDestroyDeps,
  type ManagedVllmDestroyOutcome,
  recordManagedVllmRetirementPending,
  reportManagedVllmDestroyOutcome,
  retireManagedVllmForDestroyedSandbox,
} from "./destroy-preflight";

const CONTAINER_ID = "a".repeat(64);
const REMOVED: HostLocalVllmRetirementResult = {
  status: "removed",
  containerId: CONTAINER_ID,
  removed: [`container:${CONTAINER_ID}`],
};

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
  retirement: HostLocalVllmRetirementResult = REMOVED,
  pending: string | null = null,
) {
  const listHostRegistryEntries = vi.fn(() => remaining);
  const retireRuntime = vi.fn(() => retirement);
  const clearPendingRetirement = vi.fn();
  const hostLifecycleLockState = { calls: 0 };
  const withHostLifecycleLock: NonNullable<
    ManagedVllmDestroyDeps["withHostLifecycleLock"]
  > = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    hostLifecycleLockState.calls += 1;
    return await operation();
  };
  return {
    clearPendingRetirement,
    hostLifecycleLockState,
    listHostRegistryEntries,
    retireRuntime,
    withHostLifecycleLock,
    deps: {
      clearPendingRetirement,
      listHostRegistryEntries,
      readPendingRetirement: () => pending,
      retireRuntime,
      resolveHomeDir: () => "/home/user",
      withHostLifecycleLock,
    },
  };
}

describe("managed vLLM retirement after sandbox destroy", () => {
  it("retires the container when the destroyed sandbox was the last Local vLLM consumer", async () => {
    const { clearPendingRetirement, deps, hostLifecycleLockState, retireRuntime } = makeDeps([
      registryEntry("beta", "nvidia-prod"),
    ]);

    expect(await retireManagedVllmForDestroyedSandbox("alpha", sandbox(), deps)).toEqual({
      kind: "retirement",
      ...REMOVED,
    });
    expect(hostLifecycleLockState.calls).toBe(1);
    expect(retireRuntime).toHaveBeenCalledWith({ homeDir: "/home/user" });
    expect(clearPendingRetirement).toHaveBeenCalledWith("/home/user");
  });

  it("keeps the container while another gateway state root still registers a Local vLLM sandbox", async () => {
    const { clearPendingRetirement, deps, retireRuntime } = makeDeps([
      registryEntry("beta", "nvidia-prod"),
      registryEntry("gamma", "vllm-local", 8091),
    ]);

    expect(await retireManagedVllmForDestroyedSandbox("alpha", sandbox(), deps)).toEqual({
      kind: "kept",
      reason: "consumers",
      consumers: 1,
    });
    expect(retireRuntime).not.toHaveBeenCalled();
    expect(clearPendingRetirement).toHaveBeenCalledWith("/home/user");
  });

  it("keeps the container when the destroy requested --keep-vllm", async () => {
    const { deps, hostLifecycleLockState, listHostRegistryEntries, retireRuntime } = makeDeps([]);

    expect(
      await retireManagedVllmForDestroyedSandbox("alpha", sandbox(), { ...deps, keepVllm: true }),
    ).toEqual({ kind: "kept", reason: "option" });
    expect(hostLifecycleLockState.calls).toBe(0);
    expect(listHostRegistryEntries).not.toHaveBeenCalled();
    expect(retireRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no registry row and no pending retirement", entry: null, pending: null },
    { label: "a pending retirement for another sandbox", entry: null, pending: "beta" },
    { label: "a hosted provider", entry: sandbox({ provider: "nvidia-prod" }), pending: null },
    { label: "Local Ollama", entry: sandbox({ provider: "ollama-local" }), pending: null },
    {
      label: "a runtime-provider host-local inference receipt",
      entry: sandbox({ hostLocalInferenceReceipt: '{"schemaVersion":2}' }),
      pending: null,
    },
  ])("does not apply to a destroyed sandbox with $label", async ({ entry, pending }) => {
    const { clearPendingRetirement, deps, hostLifecycleLockState, retireRuntime } = makeDeps(
      [],
      REMOVED,
      pending,
    );

    expect(await retireManagedVllmForDestroyedSandbox("alpha", entry, deps)).toEqual({
      kind: "not-applicable",
    });
    expect(hostLifecycleLockState.calls).toBe(0);
    expect(deps.listHostRegistryEntries).not.toHaveBeenCalled();
    expect(retireRuntime).not.toHaveBeenCalled();
    expect(clearPendingRetirement).not.toHaveBeenCalled();
  });

  it("retires the container on a retry whose registry row is gone but whose retirement is pending", async () => {
    const { clearPendingRetirement, deps, hostLifecycleLockState, retireRuntime } = makeDeps(
      [],
      REMOVED,
      "alpha",
    );

    expect(await retireManagedVllmForDestroyedSandbox("alpha", null, deps)).toEqual({
      kind: "retirement",
      ...REMOVED,
    });
    expect(hostLifecycleLockState.calls).toBe(1);
    expect(retireRuntime).toHaveBeenCalledOnce();
    expect(clearPendingRetirement).toHaveBeenCalledWith("/home/user");
  });

  it("preserves the container when a gateway registry cannot be read", async () => {
    const retireRuntime = vi.fn();
    const clearPendingRetirement = vi.fn();

    expect(
      await retireManagedVllmForDestroyedSandbox("alpha", sandbox(), {
        clearPendingRetirement,
        listHostRegistryEntries: () => {
          throw new Error("sandboxes.json is not owner-only");
        },
        resolveHomeDir: () => "/home/user",
        retireRuntime: retireRuntime as never,
        withHostLifecycleLock: async (operation) => await operation(),
      }),
    ).toEqual({ kind: "inventory-failed", detail: "sandboxes.json is not owner-only" });
    expect(retireRuntime).not.toHaveBeenCalled();
    expect(clearPendingRetirement).not.toHaveBeenCalled();
  });

  it("preserves the container when the host lifecycle fence cannot be acquired", async () => {
    const { deps, listHostRegistryEntries, retireRuntime } = makeDeps([]);

    expect(
      await retireManagedVllmForDestroyedSandbox("alpha", sandbox(), {
        ...deps,
        withHostLifecycleLock: async () => {
          throw new Error("lock unavailable");
        },
      }),
    ).toEqual({ kind: "inventory-failed", detail: "lock unavailable" });
    expect(listHostRegistryEntries).not.toHaveBeenCalled();
    expect(retireRuntime).not.toHaveBeenCalled();
  });

  it.each<{ label: string; retirement: HostLocalVllmRetirementResult }>([
    {
      label: "preserved",
      retirement: {
        status: "preserved",
        reason: "the container does not carry the NemoClaw managed vLLM label",
        removed: [],
      },
    },
    {
      label: "partial",
      retirement: {
        status: "partial",
        containerId: CONTAINER_ID,
        reason: "host-local-vllm-runtime.json: permission denied",
        remaining: ["host-local-vllm-runtime.json"],
        removed: [`container:${CONTAINER_ID}`],
      },
    },
  ])(
    "passes a $label runtime result through and keeps the retirement pending",
    async ({ retirement }) => {
      const { clearPendingRetirement, deps } = makeDeps([], retirement);

      expect(await retireManagedVllmForDestroyedSandbox("alpha", sandbox(), deps)).toEqual({
        kind: "retirement",
        ...retirement,
      });
      expect(clearPendingRetirement).not.toHaveBeenCalled();
    },
  );
});

describe("pending managed vLLM retirement record", () => {
  const temporaryHomes: string[] = [];

  afterEach(() => {
    for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { force: true, recursive: true });
  });

  function temporaryHome(): string {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pending-vllm-")));
    temporaryHomes.push(home);
    return home;
  }

  it("records the destroyed Local vLLM sandbox before its registry row is removed", () => {
    const recordPendingRetirement = vi.fn();
    const deps = { recordPendingRetirement, resolveHomeDir: () => "/home/user" };

    expect(recordManagedVllmRetirementPending(sandbox(), deps)).toBe(true);
    expect(recordPendingRetirement).toHaveBeenCalledWith("alpha", "/home/user");
  });

  it.each([
    { label: "--keep-vllm", entry: sandbox(), keepVllm: true },
    { label: "no registry row", entry: null, keepVllm: false },
    { label: "a hosted provider", entry: sandbox({ provider: "nvidia-prod" }), keepVllm: false },
    {
      label: "a runtime-provider host-local inference receipt",
      entry: sandbox({ hostLocalInferenceReceipt: '{"schemaVersion":2}' }),
      keepVllm: false,
    },
  ])("records nothing for $label", ({ entry, keepVllm }) => {
    const recordPendingRetirement = vi.fn();

    expect(recordManagedVllmRetirementPending(entry, { keepVllm, recordPendingRetirement })).toBe(
      false,
    );
    expect(recordPendingRetirement).not.toHaveBeenCalled();
  });

  it("round-trips the sandbox name through an owner-only file and clears it", () => {
    const home = temporaryHome();
    const filePath = path.join(home, ".nemoclaw", HOST_LOCAL_VLLM_PENDING_RETIREMENT_FILE);

    expect(readPendingHostLocalVllmRetirement(home)).toBeNull();
    recordPendingHostLocalVllmRetirement("alpha", home);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readPendingHostLocalVllmRetirement(home)).toBe("alpha");
    recordPendingHostLocalVllmRetirement("beta", home);
    expect(readPendingHostLocalVllmRetirement(home)).toBe("beta");
    clearPendingHostLocalVllmRetirement(home);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(readPendingHostLocalVllmRetirement(home)).toBeNull();
    expect(() => clearPendingHostLocalVllmRetirement(home)).not.toThrow();
  });

  it.each(["", "null", "{}", '{"sandboxName":""}', '{"sandboxName":7}', "not json"])(
    "treats the record %j as no pending retirement",
    (contents) => {
      const home = temporaryHome();
      fs.mkdirSync(path.join(home, ".nemoclaw"), { mode: 0o700, recursive: true });
      fs.writeFileSync(
        path.join(home, ".nemoclaw", HOST_LOCAL_VLLM_PENDING_RETIREMENT_FILE),
        contents,
      );

      expect(readPendingHostLocalVllmRetirement(home)).toBeNull();
    },
  );
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

  it("reports a removed container with retryable private state separately", () => {
    const partial = render({
      kind: "retirement",
      status: "partial",
      containerId: CONTAINER_ID,
      reason: "host-local-vllm-runtime.json: permission denied",
      remaining: ["host-local-vllm-runtime.json"],
      removed: [`container:${CONTAINER_ID}`],
    });

    expect(partial.logs).toEqual([]);
    expect(partial.warnings[0]).toContain(`was removed (${CONTAINER_ID.slice(0, 12)})`);
    expect(partial.warnings[0]).toContain("private state cleanup is incomplete");
    expect(partial.warnings[0]).toContain("Re-run uninstall");
  });
});
