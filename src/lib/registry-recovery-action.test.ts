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
  getNamedGatewayLifecycleState: vi.fn(() => ({ state: "missing_named" })),
}));

vi.mock("./adapters/openshell/runtime.js", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("./state/onboard-session.js", () => ({
  loadSession: vi.fn(),
}));

vi.mock("./runtime-recovery.js", () => ({
  parseLiveSandboxNames: vi.fn(() => new Set<string>()),
}));

vi.mock("./runner.js", () => ({
  validateName: (name: string) => {
    if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      throw new Error(`Invalid sandbox name: '${name}'`);
    }
    return name;
  },
}));

import { resolveOpenshell } from "./adapters/openshell/resolve.js";
import { captureOpenshell } from "./adapters/openshell/runtime.js";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "./gateway-runtime-action.js";
import { recoverRegistryEntries } from "./registry-recovery-action.js";
import { parseLiveSandboxNames } from "./runtime-recovery.js";
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

describe("recoverRegistryEntries (#5714 empty-registry live gateway recovery)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistryState.sandboxes = {};
    mockRegistryState.defaultSandbox = null;
    vi.mocked(loadSession).mockReturnValue(null);
    vi.mocked(resolveOpenshell).mockReturnValue("/usr/bin/openshell");
    vi.mocked(captureOpenshell).mockReturnValue({ output: "", status: 0 } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set<string>());
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "missing_named" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers live gateway sandboxes for display when the registry is empty and unseeded", async () => {
    // Reporter case: `nemoclaw list` ran with an empty/lost local registry and
    // no onboard session, while the gateway was connected and the live sandbox
    // existed (`status` reported Ready). list must rediscover it for display.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set(["dcode-station"]));

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(1);
    const recovered = result.sandboxes.find((s) => s.name === "dcode-station");
    expect(recovered).toBeDefined();
    // Minimal safe entry: no invented agent/model/provider metadata.
    expect(recovered?.model).toBeNull();
    expect(recovered?.provider).toBeNull();
    expect(recovered?.agent).toBeUndefined();
  });

  it("does NOT persist unseeded gateway recoveries to the on-disk registry (#5714 agent safety)", async () => {
    // `openshell sandbox list` does not expose the agent type, so persisting a
    // recovered entry would default agent to "openclaw" everywhere downstream
    // and permanently misclassify a Deep Agents/Hermes sandbox. Recovery is
    // display-only: the on-disk registry must stay empty.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set(["dcode-station"]));

    await recoverRegistryEntries();

    expect(mockRegistryState.sandboxes["dcode-station"]).toBeUndefined();
  });

  it("recovers via a NemoClaw per-port gateway when it is the active gateway", async () => {
    // A non-default NEMOCLAW_GATEWAY_PORT runs `nemoclaw-<port>`; that is still
    // a NemoClaw-managed gateway, so connected_other against it is trustworthy.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({
      state: "connected_other",
      activeGateway: "nemoclaw-8092",
    } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set(["dcode-station"]));

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(1);
    expect(result.sandboxes.find((s) => s.name === "dcode-station")).toBeDefined();
  });

  it("ignores a failed `sandbox list` probe instead of parsing error text as names", async () => {
    // A non-zero `openshell sandbox list` may print free-form error text; its
    // first token must never be surfaced as a recovered sandbox.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(captureOpenshell).mockReturnValue({
      output: "transport error: connection reset",
      status: 1,
    } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set(["transport"]));

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(0);
    expect(result.sandboxes).toEqual([]);
  });

  it("does NOT recover from a foreign (non-NemoClaw) active gateway", async () => {
    // `openshell sandbox list` is scoped to the active gateway; if that gateway
    // is not NemoClaw-managed, its sandboxes must not be surfaced as recovered
    // NemoClaw entries.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({
      state: "connected_other",
      activeGateway: "some-other-project",
    } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set(["foreign-sbox"]));

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(0);
    expect(result.sandboxes).toEqual([]);
  });

  it("inspects the gateway read-only (never mutates gateway state) when unseeded", async () => {
    // A plain `nemoclaw list` must never select/start a gateway as a side
    // effect of listing: it inspects the lifecycle directly and never calls
    // the mutating recoverNamedGatewayRuntime path.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxNames).mockReturnValue(new Set(["dcode-station"]));

    await recoverRegistryEntries();

    expect(getNamedGatewayLifecycleState).toHaveBeenCalledWith(undefined, {
      ignoreProbeErrors: true,
    });
    expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("falls back to the empty registry when no gateway is connected", async () => {
    // Read-only inspection: gateway is not connected, so no live names are
    // written. list stays empty instead of starting a gateway.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "missing_named" } as never);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(0);
    expect(result.sandboxes).toEqual([]);
    expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("does not probe the gateway when OpenShell is not installed", async () => {
    vi.mocked(resolveOpenshell).mockReturnValue(null);

    const result = await recoverRegistryEntries();

    expect(getNamedGatewayLifecycleState).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(result.sandboxes).toEqual([]);
  });
});
