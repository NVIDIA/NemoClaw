// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runInferenceSet } from "./actions/inference-set.js";
import { createDeps } from "./actions/inference-set.test-support.js";
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
    mockRegistryState.sandboxes[name] = {
      ...mockRegistryState.sandboxes[name],
      ...partial,
    } as SandboxEntry;
  },
  setDefault: (name: string) => {
    mockRegistryState.defaultSandbox = name;
  },
}));

vi.mock("./adapters/openshell/resolve.js", () => ({
  resolveOpenshell: vi.fn(),
}));

vi.mock("./gateway-runtime-action.js", () => ({
  recoverNamedGatewayRuntime: vi.fn(),
  getNamedGatewayLifecycleState: vi.fn(),
}));

vi.mock("./adapters/openshell/runtime.js", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("./state/onboard-session.js", () => ({
  loadSession: vi.fn(),
}));

vi.mock("./runtime-recovery.js", () => ({
  parseLiveSandboxEntries: vi.fn(),
}));

vi.mock("./runner.js", async () => {
  const actual = await vi.importActual<typeof import("./runner.js")>("./runner.js");
  return { validateName: actual.validateName };
});

import { resolveOpenshell } from "./adapters/openshell/resolve.js";
import { captureOpenshell } from "./adapters/openshell/runtime.js";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "./gateway-runtime-action.js";
import { recoverRegistryEntries } from "./registry-recovery-action.js";
import { parseLiveSandboxEntries } from "./runtime-recovery.js";
import { loadSession } from "./state/onboard-session.js";

const gammaEntry = (policies: string[]): SandboxEntry => ({
  name: "gamma",
  provider: "nvidia-prod",
  model: "nvidia/nemotron-3-super-120b-a12b",
  gpuEnabled: false,
  policies,
});

const completedSession = (sandboxName: string, policyPresets: string[]) =>
  ({
    sandboxName,
    provider: "nvidia-prod",
    model: "nvidia/nemotron-3-super-120b-a12b",
    policyPresets,
    nimContainer: null,
    steps: {
      sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
    },
  }) as never;

function resetSeededRecoveryMocks(): void {
  mockRegistryState.sandboxes = {};
  mockRegistryState.defaultSandbox = null;
  vi.mocked(loadSession).mockReset().mockReturnValue(null);
  vi.mocked(resolveOpenshell).mockReset().mockReturnValue("/usr/bin/openshell");
  vi.mocked(recoverNamedGatewayRuntime)
    .mockReset()
    .mockResolvedValue({ recovered: true } as never);
  vi.mocked(getNamedGatewayLifecycleState)
    .mockReset()
    .mockReturnValue({ state: "missing_named" } as never);
  vi.mocked(captureOpenshell)
    .mockReset()
    .mockReturnValue({ output: "live sandboxes", status: 0 } as never);
  vi.mocked(parseLiveSandboxEntries).mockReset().mockReturnValue([]);
}

describe("recoverRegistryEntries seeded recovery paths", () => {
  beforeEach(resetSeededRecoveryMocks);

  it("merges a confirmed session and additional live sandboxes without replacing the default", async () => {
    mockRegistryState.sandboxes.gamma = gammaEntry(["npm"]);
    mockRegistryState.defaultSandbox = "gamma";
    vi.mocked(loadSession).mockReturnValue(completedSession("alpha", ["pypi"]));
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([
      { name: "alpha", phase: "Ready" },
      { name: "beta", phase: "Ready" },
    ]);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromSession).toBe(true);
    expect(result.recoveredFromGateway).toBe(1);
    expect(result.sandboxes.map((sandbox) => sandbox.name).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(mockRegistryState.sandboxes.alpha?.policies).toEqual(["pypi"]);
    expect(mockRegistryState.defaultSandbox).toBe("gamma");
  });

  it("fails closed instead of restoring a conflicting session route", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRegistryState.sandboxes.gamma = {
      ...gammaEntry([]),
      provider: "existing-provider",
      model: "existing-model",
    };
    mockRegistryState.defaultSandbox = "gamma";
    vi.mocked(loadSession).mockReturnValue(completedSession("alpha", []));
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "alpha", phase: "Ready" }]);

    const result = await recoverRegistryEntries();

    expect(result.recoveredFromSession).toBe(false);
    expect(mockRegistryState.sandboxes.alpha).toBeUndefined();
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain("gamma");
  });

  it("keeps an existing route identity atomic when session metadata is stale", async () => {
    mockRegistryState.sandboxes.alpha = {
      name: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      endpointUrl: null,
      credentialEnv: "NVIDIA_API_KEY",
      preferredInferenceApi: null,
      gpuEnabled: false,
      policies: [],
    };
    vi.mocked(loadSession).mockReturnValue({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-ultra",
      endpointUrl: "https://historical.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      policyPresets: [],
      nimContainer: null,
      steps: {
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
      },
    } as never);
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "alpha", phase: "Ready" }]);

    await recoverRegistryEntries({ requestedSandboxName: "missing-sandbox" });

    expect(mockRegistryState.sandboxes.alpha).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      endpointUrl: null,
      credentialEnv: "NVIDIA_API_KEY",
      preferredInferenceApi: null,
    });
  });

  it("skips invalid session and live sandbox names during seeded recovery", async () => {
    mockRegistryState.sandboxes.gamma = gammaEntry([]);
    mockRegistryState.defaultSandbox = "gamma";
    vi.mocked(loadSession).mockReturnValue(completedSession("Alpha", []));
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([
      { name: "alpha", phase: "Ready" },
      { name: "Bad_Name", phase: "Ready" },
    ]);

    const result = await recoverRegistryEntries();

    expect(result.sandboxes.map((sandbox) => sandbox.name).sort()).toEqual(["alpha", "gamma"]);
    expect(mockRegistryState.sandboxes.Alpha).toBeUndefined();
    expect(mockRegistryState.sandboxes.Bad_Name).toBeUndefined();
    expect(mockRegistryState.defaultSandbox).toBe("gamma");
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

  it("persists a requested live sandbox and makes it the default", async () => {
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "alpha", phase: "Ready" }]);

    const result = await recoverRegistryEntries({ requestedSandboxName: "alpha" });

    expect(recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    expect(getNamedGatewayLifecycleState).not.toHaveBeenCalled();
    expect(result.recoveredFromGateway).toBe(1);
    expect(result.sandboxes.map((sandbox) => sandbox.name)).toEqual(["alpha"]);
    expect(mockRegistryState.sandboxes.alpha).toBeDefined();
    expect(mockRegistryState.defaultSandbox).toBe("alpha");
  });

  it("keeps a missing requested sandbox absent while recovering other live entries", async () => {
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([{ name: "alpha", phase: "Ready" }]);

    const result = await recoverRegistryEntries({ requestedSandboxName: "beta" });

    expect(result.recoveredFromGateway).toBe(1);
    expect(result.sandboxes.map((sandbox) => sandbox.name)).toEqual(["alpha"]);
    expect(mockRegistryState.sandboxes.alpha).toBeDefined();
    expect(mockRegistryState.sandboxes.beta).toBeUndefined();
    expect(mockRegistryState.defaultSandbox).toBeNull();
  });

  it("blocks route mutation after seeded recovery persists a live row without route metadata (#6315)", async () => {
    mockRegistryState.sandboxes.gamma = gammaEntry([]);
    mockRegistryState.defaultSandbox = "gamma";
    vi.mocked(parseLiveSandboxEntries).mockReturnValue([
      { name: "recovered-live", phase: "Ready" },
    ]);

    await recoverRegistryEntries({ requestedSandboxName: "missing-sandbox" });
    expect(mockRegistryState.sandboxes["recovered-live"]).toMatchObject({
      gatewayName: "nemoclaw",
      provider: null,
      model: null,
    });

    const deps = createDeps({
      config: {},
      entries: Object.values(mockRegistryState.sandboxes),
      defaultSandbox: "gamma",
    });
    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-b", sandboxName: "gamma" },
        deps,
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/recovered-live.*lacks durable provider or model metadata/s),
      exitCode: 2,
    });

    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expect(deps.calls.appendAuditEntry).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });
});
