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
  parseLiveSandboxEntries: vi.fn(() => [] as Array<{ name: string; phase: string | null }>),
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
import { parseLiveSandboxEntries } from "./runtime-recovery.js";
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
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([]);
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "missing_named" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list displays recovered sandbox Ready phase and authoritative agent when available, otherwise documents unknown fallback", async () => {
    // Reporter case (#5714): `nemoclaw list` ran with an empty/lost local
    // registry and no onboard session while the gateway was connected and the
    // live sandbox existed (`status` reported Ready). list must rediscover it
    // for display, carrying the TRUSTED live PHASE (Ready) from the gateway
    // sandbox list, but leaving agent/model/provider unknown — the gateway list
    // is not an authoritative agent source; the real agent is reconciled by a
    // follow-up `nemoclaw <name> status`.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "dcode-station", phase: "Ready" }]);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(1);
    const recovered = result.sandboxes.find((s) => s.name === "dcode-station") as
      | ((typeof result.sandboxes)[number] & {
          recoveredFromGateway?: boolean;
          livePhase?: string | null;
        })
      | undefined;
    expect(recovered).toBeDefined();
    // Minimal safe entry: no invented agent/model/provider metadata.
    expect(recovered?.model).toBeNull();
    expect(recovered?.provider).toBeNull();
    expect(recovered?.agent).toBeUndefined();
    // Marked recovered-from-gateway so the inventory renderer shows unknown
    // agent/GPU instead of OpenClaw/CPU defaults (consumed by buildSandboxInventoryRow).
    expect(recovered?.recoveredFromGateway).toBe(true);
    // Trusted live PHASE is carried for display so list agrees with status.
    expect(recovered?.livePhase).toBe("Ready");
  });

  it("treats an incomplete (phantom) session as unseeded — stays in read-only/display-only path", async () => {
    // PRA-2: a session that recorded sandboxName but whose sandbox step never
    // completed is a phantom (#2753). It must NOT count as a recovery seed,
    // otherwise an empty registry + phantom session would take the mutating,
    // persisting seeded path. Recovery must stay read-only/display-only.
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "phantom",
      provider: "nvidia",
      model: "nemotron",
      policyPresets: [],
      nimContainer: null,
      steps: {
        sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
      },
    } as never);
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "dcode-station", phase: "Ready" }]);

    const result = await recoverRegistryEntries();

    // Read-only path: never invokes the mutating gateway recovery, inspects
    // lifecycle directly, and surfaces the live sandbox display-only.
    expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(getNamedGatewayLifecycleState).toHaveBeenCalledWith(undefined, {
      ignoreProbeErrors: true,
    });
    const recovered = result.sandboxes.find((s) => s.name === "dcode-station") as
      | { recoveredFromGateway?: boolean }
      | undefined;
    expect(recovered?.recoveredFromGateway).toBe(true);
    // Nothing persisted — neither the phantom session sandbox nor the recovered one.
    expect(mockRegistryState.sandboxes["dcode-station"]).toBeUndefined();
    expect(mockRegistryState.sandboxes["phantom"]).toBeUndefined();
  });

  it("incomplete session with existing registry entries does not trigger mutating gateway recovery solely because the phantom session name is missing", async () => {
    // PRA-5: with an existing registry entry plus an incomplete (phantom)
    // session naming a DIFFERENT, missing sandbox, recovery must not flip on and
    // call the mutating gateway recovery (select/start). `shouldRecoverRegistryEntries`
    // must treat the phantom session as not-a-seed (isSessionSandboxConfirmed),
    // so `missingSessionSandbox` stays false and no recovery runs.
    mockRegistryState.sandboxes["beta"] = {
      name: "beta",
      provider: "nvidia",
      model: "nemotron",
      gpuEnabled: false,
      policies: [],
      nimContainer: null,
      agent: "openclaw",
    };
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "phantom",
      provider: "nvidia",
      model: "nemotron",
      policyPresets: [],
      nimContainer: null,
      steps: {
        sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
      },
    } as never);
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "live-x", phase: "Ready" }]);

    const result = await recoverRegistryEntries();

    // No mutating recovery, no read-only gateway inspection — recovery never ran.
    expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(getNamedGatewayLifecycleState).not.toHaveBeenCalled();
    // Existing entry preserved; nothing new surfaced or persisted.
    expect(result.sandboxes.map((s) => s.name)).toEqual(["beta"]);
    expect(result.recoveredFromGateway).toBe(0);
  });

  it("does NOT persist unseeded gateway recoveries to the on-disk registry (#5714 agent safety)", async () => {
    // `openshell sandbox list` does not expose the agent type, so persisting a
    // recovered entry would default agent to "openclaw" everywhere downstream
    // and permanently misclassify a Deep Agents/Hermes sandbox. Recovery is
    // display-only: the on-disk registry must stay empty.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "dcode-station", phase: "Ready" }]);

    await recoverRegistryEntries();

    expect(mockRegistryState.sandboxes["dcode-station"]).toBeUndefined();
  });

  it("does NOT recover when a different NemoClaw gateway is active (connected_other)", async () => {
    // The active gateway differs from the one this process resolves (e.g. active
    // `nemoclaw-8092` while `list` targets the default `nemoclaw`). `sandbox
    // list` may be scoped to the active gateway and a follow-up `<name> status`
    // resolves the target gateway, so advertising the other gateway's sandboxes
    // would be unactionable — read-only recovery requires healthy_named only.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({
      state: "connected_other",
      activeGateway: "nemoclaw-8092",
    } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "dcode-station", phase: "Ready" }]);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(0);
    expect(result.sandboxes).toEqual([]);
  });

  it("ignores a failed `sandbox list` probe instead of parsing error text as names", async () => {
    // A non-zero `openshell sandbox list` may print free-form error text; its
    // first token must never be surfaced as a recovered sandbox.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(captureOpenshell).mockReturnValue({
      output: "transport error: connection reset",
      status: 1,
    } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "transport", phase: null }]);

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
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "foreign-sbox", phase: "Ready" }]);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromGateway).toBe(0);
    expect(result.sandboxes).toEqual([]);
  });

  it("inspects the gateway read-only (never mutates gateway state) when unseeded", async () => {
    // A plain `nemoclaw list` must never select/start a gateway as a side
    // effect of listing: it inspects the lifecycle directly and never calls
    // the mutating recoverNamedGatewayRuntime path.
    vi.mocked(getNamedGatewayLifecycleState).mockReturnValue({ state: "healthy_named" } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "dcode-station", phase: "Ready" }]);

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
