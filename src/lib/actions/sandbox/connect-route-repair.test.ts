// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../../state/registry";

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(() => ({ status: 0, output: "" })),
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0 })),
}));

vi.mock("../../gateway-runtime-action", () => ({
  getNamedGatewayLifecycleState: vi.fn(() => ({ kind: "healthy_named" })),
}));

vi.mock("../../inference/local", () => ({
  findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
  probeLocalProviderHealth: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../inference/ollama/proxy", () => ({
  ensureOllamaAuthProxy: vi.fn(() => true),
  probeOllamaAuthProxyHealth: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  runCapture: vi.fn(() => ({ status: 0, output: "" })),
  shellQuote: (value: string) => `'${value}'`,
}));

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(),
  printGatewayLifecycleHint: vi.fn(),
}));

import {
  repairSandboxInferenceRouteWithDeps,
  resetManagedInferenceRouteWithDeps,
  type ManagedInferenceRouteResetDeps,
  type SandboxInferenceRouteProbe,
  type SandboxInferenceRouteRepairDeps,
} from "./connect";

const healthy = (detail = "OK 200"): SandboxInferenceRouteProbe => ({
  healthy: true,
  broken: false,
  detail,
});

const broken = (detail = "BROKEN 503"): SandboxInferenceRouteProbe => ({
  healthy: false,
  broken: true,
  detail,
});

const inconclusive = (detail = "openshell sandbox exec exited with status 7"): SandboxInferenceRouteProbe => ({
  healthy: false,
  broken: false,
  detail,
});

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "demo",
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "nvidia-prod",
    gpuEnabled: false,
    policies: [],
    ...overrides,
  };
}

function makeRepairDeps(
  probes: SandboxInferenceRouteProbe[],
  overrides: Partial<SandboxInferenceRouteRepairDeps> = {},
) {
  const calls = {
    logs: [] as string[],
    errors: [] as string[],
    legacyRepairs: [] as Array<{ sandboxName: string; quiet: boolean }>,
    monkeypatches: [] as string[],
    reapplications: [] as string[],
    probeOptions: [] as Array<object | undefined>,
  };
  const queue = [...probes];
  const deps: SandboxInferenceRouteRepairDeps = {
    probe: vi.fn((_sandboxName, options) => {
      calls.probeOptions.push(options);
      return queue.shift() ?? broken("missing mocked probe");
    }),
    shouldApplyVmDnsMonkeypatch: vi.fn(() => false),
    applyVmDnsMonkeypatch: vi.fn((sandboxName) => {
      calls.monkeypatches.push(sandboxName);
      return { ok: false, reason: "not mocked" };
    }),
    reapplyVmInferenceRoute: vi.fn((sandboxName) => {
      calls.reapplications.push(sandboxName);
      return queue.shift() ?? broken("missing mocked reapply probe");
    }),
    repairLegacyDnsProxy: vi.fn((sandboxName, quiet) => {
      calls.legacyRepairs.push({ sandboxName, quiet });
      return { exitCode: 0 };
    }),
    log: (message) => calls.logs.push(message),
    error: (message) => calls.errors.push(message),
    ...overrides,
  };
  return { calls, deps };
}

describe("sandbox connect route repair unit flow", () => {
  it("skips work when route repair is disabled", () => {
    const { calls, deps } = makeRepairDeps([], {
      isRepairDisabled: () => true,
    });

    const result = repairSandboxInferenceRouteWithDeps("demo", sandbox(), {}, deps);

    expect(result).toEqual({
      healthy: true,
      repairAttempted: false,
      detail: "route repair disabled",
    });
    expect(calls.probeOptions).toEqual([]);
  });

  it("does not repair healthy or inconclusive initial probes", () => {
    for (const firstProbe of [healthy(), inconclusive()]) {
      const { calls, deps } = makeRepairDeps([firstProbe]);

      const result = repairSandboxInferenceRouteWithDeps("demo", sandbox(), {}, deps);

      expect(result).toEqual({
        healthy: true,
        repairAttempted: false,
        detail: firstProbe.detail,
      });
      expect(calls.legacyRepairs).toEqual([]);
      expect(calls.reapplications).toEqual([]);
    }
  });

  it("repairs legacy kubernetes routes through the DNS proxy path", () => {
    const { calls, deps } = makeRepairDeps([broken(), healthy()]);

    const result = repairSandboxInferenceRouteWithDeps(
      "legacy-box",
      sandbox({ openshellDriver: "kubernetes" }),
      {},
      deps,
    );

    expect(result).toEqual({
      healthy: true,
      repairAttempted: true,
      detail: "OK 200",
    });
    expect(calls.legacyRepairs).toEqual([{ sandboxName: "legacy-box", quiet: false }]);
    expect(calls.reapplications).toEqual([]);
    expect(calls.logs).toContain("  inference.local route repaired.");
  });

  it("returns the DNS repair failure detail without route reapply on legacy sandboxes", () => {
    const { calls, deps } = makeRepairDeps([broken()], {
      repairLegacyDnsProxy: vi.fn((sandboxName, quiet) => {
        calls.legacyRepairs.push({ sandboxName, quiet });
        return { exitCode: 1, message: "Could not find gateway container" };
      }),
    });

    const result = repairSandboxInferenceRouteWithDeps(
      "legacy-box",
      sandbox({ openshellDriver: "kubernetes" }),
      {},
      deps,
    );

    expect(result).toEqual({
      healthy: false,
      repairAttempted: true,
      detail: "Could not find gateway container",
    });
    expect(calls.errors).toContain("  Warning: failed to repair sandbox DNS proxy.");
    expect(calls.reapplications).toEqual([]);
  });

  it("uses inference route reapply instead of legacy DNS repair for docker sandboxes", () => {
    const { calls, deps } = makeRepairDeps([broken(), healthy()]);

    const result = repairSandboxInferenceRouteWithDeps(
      "docker-box",
      sandbox({ openshellDriver: "docker" }),
      {},
      deps,
    );

    expect(result.healthy).toBe(true);
    expect(result.repairAttempted).toBe(true);
    expect(calls.legacyRepairs).toEqual([]);
    expect(calls.reapplications).toEqual(["docker-box"]);
    expect(calls.logs).toContain("  inference.local route repaired.");
  });

  it("lets the VM monkeypatch satisfy the route before inference reapply", () => {
    const { calls, deps } = makeRepairDeps([broken(), healthy()], {
      shouldApplyVmDnsMonkeypatch: vi.fn(() => true),
      applyVmDnsMonkeypatch: vi.fn((sandboxName) => {
        calls.monkeypatches.push(sandboxName);
        return { ok: true };
      }),
    });

    const result = repairSandboxInferenceRouteWithDeps(
      "vm-box",
      sandbox({ openshellDriver: "vm" }),
      {},
      deps,
    );

    expect(result.healthy).toBe(true);
    expect(calls.monkeypatches).toEqual(["vm-box"]);
    expect(calls.reapplications).toEqual([]);
    expect(calls.legacyRepairs).toEqual([]);
  });

  it("falls back to inference reapply when the VM monkeypatch leaves the route broken", () => {
    const { calls, deps } = makeRepairDeps([broken(), broken(), healthy()], {
      shouldApplyVmDnsMonkeypatch: vi.fn(() => true),
      applyVmDnsMonkeypatch: vi.fn((sandboxName) => {
        calls.monkeypatches.push(sandboxName);
        return { ok: true };
      }),
    });

    const result = repairSandboxInferenceRouteWithDeps(
      "vm-box",
      sandbox({ openshellDriver: "vm" }),
      {},
      deps,
    );

    expect(result.healthy).toBe(true);
    expect(calls.monkeypatches).toEqual(["vm-box"]);
    expect(calls.reapplications).toEqual(["vm-box"]);
    expect(calls.errors).toContain(
      "  Warning: OpenShell VM DNS monkeypatch completed but inference.local is still unavailable.",
    );
  });

  it("reports broken non-legacy routes after inference reapply cannot repair them", () => {
    const { calls, deps } = makeRepairDeps([broken(), broken()]);

    const result = repairSandboxInferenceRouteWithDeps(
      "vm-box",
      sandbox({ openshellDriver: "vm" }),
      {},
      deps,
    );

    expect(result).toEqual({
      healthy: false,
      repairAttempted: true,
      detail: "BROKEN 503",
    });
    expect(calls.errors).toContain(
      "  Warning: inference.local is still unavailable through the OpenShell vm gateway path.",
    );
  });
});

function makeResetDeps(
  probes: SandboxInferenceRouteProbe[],
  overrides: Partial<ManagedInferenceRouteResetDeps> = {},
) {
  const calls = {
    localChecks: [] as Array<{ provider: string; quiet?: boolean }>,
    inferenceSets: [] as Array<{ provider: string; model: string }>,
    unrecoverable: [] as Array<{ sandboxName: string; detail: string }>,
    logs: [] as string[],
    errors: [] as string[],
    probeOptions: [] as Array<object | undefined>,
  };
  const queue = [...probes];
  const deps: ManagedInferenceRouteResetDeps = {
    verifyLocalInferenceRouteDependencies: vi.fn((provider, options) => {
      calls.localChecks.push({ provider, quiet: options.quiet });
      return true;
    }),
    runInferenceSet: vi.fn((provider, model) => {
      calls.inferenceSets.push({ provider, model });
      return { status: 0 };
    }),
    probe: vi.fn((_sandboxName, options) => {
      calls.probeOptions.push(options);
      return queue.shift() ?? broken("missing mocked reset probe");
    }),
    printUnrecoverableInferenceRoute: vi.fn((sandboxName, _sb, detail) => {
      calls.unrecoverable.push({ sandboxName, detail });
    }),
    log: (message) => calls.logs.push(message),
    error: (message) => calls.errors.push(message),
    ...overrides,
  };
  return { calls, deps };
}

describe("managed inference route reset unit flow", () => {
  it("verifies local dependencies before and after a successful route reset", () => {
    const { calls, deps } = makeResetDeps([healthy()]);

    const result = resetManagedInferenceRouteWithDeps(
      "demo",
      sandbox({ provider: "ollama-local", model: "qwen3:0.6b" }),
      { detail: "BROKEN 503" },
      deps,
    );

    expect(result).toBe(true);
    expect(calls.localChecks).toEqual([
      { provider: "ollama-local", quiet: false },
      { provider: "ollama-local", quiet: false },
    ]);
    expect(calls.inferenceSets).toEqual([{ provider: "ollama-local", model: "qwen3:0.6b" }]);
    expect(calls.logs).toContain("  inference.local route repaired.");
  });

  it("probes route health after a non-zero inference set and accepts a healthy route", () => {
    const { calls, deps } = makeResetDeps([healthy()], {
      runInferenceSet: vi.fn((provider, model) => {
        calls.inferenceSets.push({ provider, model });
        return { status: 1 };
      }),
    });

    const result = resetManagedInferenceRouteWithDeps(
      "demo",
      sandbox(),
      { detail: "BROKEN 503" },
      deps,
    );

    expect(result).toBe(true);
    expect(calls.localChecks).toHaveLength(1);
    expect(calls.probeOptions[0]).toEqual({ attempts: 3, delayMs: 2000 });
    expect(calls.errors).toEqual([]);
  });

  it("stops before inference set when local dependency checks fail", () => {
    const { calls, deps } = makeResetDeps([], {
      verifyLocalInferenceRouteDependencies: vi.fn((provider, options) => {
        calls.localChecks.push({ provider, quiet: options.quiet });
        return false;
      }),
    });

    const result = resetManagedInferenceRouteWithDeps(
      "demo",
      sandbox({ provider: "ollama-local", model: "qwen3:0.6b" }),
      { detail: "BROKEN 503" },
      deps,
    );

    expect(result).toBe(false);
    expect(calls.inferenceSets).toEqual([]);
    expect(calls.unrecoverable).toEqual([{ sandboxName: "demo", detail: "BROKEN 503" }]);
  });

  it("fails closed when route reset and the follow-up probe are both unhealthy", () => {
    const { calls, deps } = makeResetDeps([broken("BROKEN 503 still down")], {
      runInferenceSet: vi.fn((provider, model) => {
        calls.inferenceSets.push({ provider, model });
        return { status: 1 };
      }),
    });

    const result = resetManagedInferenceRouteWithDeps(
      "demo",
      sandbox(),
      { detail: "BROKEN 503" },
      deps,
    );

    expect(result).toBe(false);
    expect(calls.errors).toContain("  Error: failed to reset the OpenShell inference route.");
    expect(calls.unrecoverable).toEqual([
      { sandboxName: "demo", detail: "BROKEN 503 still down" },
    ]);
  });
});
