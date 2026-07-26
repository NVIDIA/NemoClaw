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
  type SandboxInferenceRouteProbe,
  type SandboxInferenceRouteRepairDeps,
} from "./connect";

const broken = (): SandboxInferenceRouteProbe => ({
  healthy: false,
  broken: true,
  detail: "BROKEN 503",
});
const inconclusive = (): SandboxInferenceRouteProbe => ({
  healthy: false,
  broken: false,
  detail: "openshell sandbox exec exited with status 7",
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

function makeRepairDeps(probes: SandboxInferenceRouteProbe[]) {
  const calls = {
    legacyRepairs: [] as Array<{ sandboxName: string; quiet: boolean }>,
    reapplications: [] as string[],
  };
  const queue = [...probes];
  const deps: SandboxInferenceRouteRepairDeps = {
    probe: vi.fn(() => queue.shift() ?? broken()),
    shouldApplyVmDnsMonkeypatch: vi.fn(() => false),
    applyVmDnsMonkeypatch: vi.fn(() => ({ ok: false })),
    reapplyVmInferenceRoute: vi.fn((sandboxName) => {
      calls.reapplications.push(sandboxName);
      return queue.shift() ?? broken();
    }),
    repairLegacyDnsProxy: vi.fn((sandboxName, quiet) => {
      calls.legacyRepairs.push({ sandboxName, quiet });
      return { exitCode: 0 };
    }),
    log: vi.fn(),
    error: vi.fn(),
  };
  return { calls, deps };
}

describe("sandbox connect inconclusive route repair", () => {
  it("fails closed without repair when the initial probe is inconclusive (#6192)", () => {
    const { calls, deps } = makeRepairDeps([inconclusive()]);

    const result = repairSandboxInferenceRouteWithDeps("demo", sandbox(), {}, deps);

    expect(result).toEqual({
      healthy: false,
      repairAttempted: false,
      detail: "openshell sandbox exec exited with status 7",
    });
    expect(calls.legacyRepairs).toEqual([]);
    expect(calls.reapplications).toEqual([]);
  });

  it("fails closed when non-legacy route reapply remains inconclusive (#6192)", () => {
    const { calls, deps } = makeRepairDeps([broken(), inconclusive()]);

    const result = repairSandboxInferenceRouteWithDeps(
      "vm-box",
      sandbox({ openshellDriver: "vm" }),
      {},
      deps,
    );

    expect(result).toEqual({
      healthy: false,
      repairAttempted: true,
      detail: "openshell sandbox exec exited with status 7",
    });
    expect(calls.reapplications).toEqual(["vm-box"]);
  });

  it("fails closed when a legacy repair probe remains inconclusive (#6192)", () => {
    const { calls, deps } = makeRepairDeps([broken(), inconclusive()]);

    const result = repairSandboxInferenceRouteWithDeps(
      "legacy-box",
      sandbox({ openshellDriver: "kubernetes" }),
      {},
      deps,
    );

    expect(result).toEqual({
      healthy: false,
      repairAttempted: true,
      detail: "openshell sandbox exec exited with status 7",
    });
    expect(calls.legacyRepairs).toEqual([{ sandboxName: "legacy-box", quiet: false }]);
  });
});
