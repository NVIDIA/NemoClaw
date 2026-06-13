// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "./state/registry.js";

interface MockRegistryState {
  sandboxes: Record<string, SandboxEntry>;
  defaultSandbox: string | null;
}

const mockRegistryState: MockRegistryState = { sandboxes: {}, defaultSandbox: null };

vi.mock("./state/registry.js", () => ({
  listSandboxes: () => ({
    sandboxes: Object.values(mockRegistryState.sandboxes),
    defaultSandbox: mockRegistryState.defaultSandbox,
  }),
  getSandbox: (name: string) => mockRegistryState.sandboxes[name] ?? null,
  registerSandbox: (entry: SandboxEntry) => {
    mockRegistryState.sandboxes[entry.name] = entry;
  },
  updateSandbox: (name: string, partial: Partial<SandboxEntry>) => {
    if (mockRegistryState.sandboxes[name]) {
      mockRegistryState.sandboxes[name] = { ...mockRegistryState.sandboxes[name], ...partial };
    }
  },
  setDefault: (name: string) => {
    if (mockRegistryState.sandboxes[name]) {
      mockRegistryState.defaultSandbox = name;
    }
  },
}));

vi.mock("./adapters/openshell/resolve.js", () => ({
  resolveOpenshell: vi.fn(() => null),
}));

vi.mock("./gateway-runtime-action.js", () => ({
  recoverNamedGatewayRuntime: vi.fn(),
}));

vi.mock("./adapters/openshell/runtime.js", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("./state/onboard-session.js", () => ({
  loadSession: vi.fn(),
}));

vi.mock("./runtime-recovery.js", () => ({
  parseLiveSandboxNames: () => new Set<string>(),
}));

vi.mock("./runner.js", () => ({
  validateName: (name: string) => {
    if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      throw new Error(`Invalid sandbox name: '${name}'`);
    }
    return name;
  },
}));

import { recoverRegistryEntries } from "./registry-recovery-action.js";
import { loadSession } from "./state/onboard-session.js";

describe("recoverRegistryEntries (#2753 seed-time guard)", () => {
  beforeEach(() => {
    mockRegistryState.sandboxes = {};
    mockRegistryState.defaultSandbox = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not seed the session sandbox when the sandbox step never completed", async () => {
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "interrupt-test",
      provider: "nvidia",
      model: "nemotron",
      policyPresets: [],
      nimContainer: null,
      steps: {
        sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
      },
    } as never);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromSession).toBe(false);
    expect(result.sandboxes.find((s) => s.name === "interrupt-test")).toBeUndefined();
    expect(mockRegistryState.sandboxes["interrupt-test"]).toBeUndefined();
  });

  it("seeds the session sandbox when the sandbox step completed", async () => {
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "alpha",
      provider: "nvidia",
      model: "nemotron",
      policyPresets: ["npm"],
      nimContainer: null,
      steps: {
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
      },
    } as never);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromSession).toBe(true);
    const recovered = result.sandboxes.find((s) => s.name === "alpha");
    expect(recovered).toBeDefined();
    expect(recovered?.policies).toEqual(["npm"]);
  });

  it("returns empty recovery when there is no session and no registry entries", async () => {
    vi.mocked(loadSession).mockReturnValue(null);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromSession).toBe(false);
    expect(result.sandboxes).toEqual([]);
  });

  it("preserves a persisted Hermes agent when the session re-seeds the same sandbox", async () => {
    // A Hermes sandbox already in the registry must keep `agent: "hermes"`
    // even when registry-recovery re-seeds from session metadata that has
    // no agent field. Object.assign in updateSandbox would otherwise clobber
    // the persisted agent to null, breaking rebuild-time agent resolution
    // (state paths under /sandbox/.hermes-data versus /sandbox/.openclaw-data).
    mockRegistryState.sandboxes["my-hermes"] = {
      name: "my-hermes",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      gpuEnabled: false,
      policies: ["npm", "pypi"],
      nimContainer: null,
      agent: "hermes",
      agentVersion: "2026.5.16",
    };
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "my-hermes",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      policyPresets: ["npm", "pypi"],
      nimContainer: null,
      agent: "hermes",
      steps: {
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
      },
    } as never);

    await recoverRegistryEntries();

    expect(mockRegistryState.sandboxes["my-hermes"]?.agent).toBe("hermes");
    expect(mockRegistryState.sandboxes["my-hermes"]?.agentVersion).toBe("2026.5.16");
  });

  it("does not clobber a persisted agent when session metadata omits it", async () => {
    // Defensive: even if a stale session has no `agent` field at all (older
    // session format), recovery must not overwrite the persisted agent.
    mockRegistryState.sandboxes["my-hermes"] = {
      name: "my-hermes",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      gpuEnabled: false,
      policies: [],
      nimContainer: null,
      agent: "hermes",
    };
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "my-hermes",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      policyPresets: [],
      nimContainer: null,
      steps: {
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
      },
    } as never);

    await recoverRegistryEntries();

    expect(mockRegistryState.sandboxes["my-hermes"]?.agent).toBe("hermes");
  });

  it("does not evict a registered sandbox even when its session step is incomplete (avoids false positives)", async () => {
    // A user with a real registered sandbox alpha and a stale session that
    // happens to record alpha with an incomplete sandbox step (e.g. a
    // pre-fix interrupted re-onboard) must NOT lose their real registry
    // entry. Persisted phantoms in sandboxes.json from before this fix are
    // a documented one-time `nemoclaw destroy <name>` migration instead.
    mockRegistryState.sandboxes["alpha"] = {
      name: "alpha",
      provider: "nvidia",
      model: "nemotron",
      gpuEnabled: false,
      policies: [],
      nimContainer: null,
      agent: null,
    };
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "alpha",
      provider: "nvidia",
      model: "nemotron",
      policyPresets: [],
      nimContainer: null,
      steps: {
        sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
      },
    } as never);

    const result = await recoverRegistryEntries();

    expect(mockRegistryState.sandboxes["alpha"]).toBeDefined();
    expect(result.sandboxes.find((s) => s.name === "alpha")).toBeDefined();
  });
});
