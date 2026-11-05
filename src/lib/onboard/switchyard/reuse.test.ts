// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { switchyardBindingFixture } from "../../../../test/helpers/hermes-switchyard";
import { createSwitchyardProviderFixture } from "../../../../test/support/switchyard-provider-adapter";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_ROUTING_ENV,
  type HermesSwitchyardRoutingIntent,
} from "../../hermes-switchyard-routing";
import type { SandboxEntry } from "../../state/registry";
import { createSession } from "../../state/onboard-session";
import { handleSandboxState } from "../machine/handlers/sandbox";
import {
  baseOptions,
  bindJournaledRecreate,
  createDeps,
} from "../machine/handlers/sandbox-test-fixtures";
import {
  encodeManagedStartupProfile,
  type ManagedStartupHermesConfig,
} from "../managed-startup/profile";
import {
  assertHermesSwitchyardRoutingReusable,
  restoreReusedSandboxDashboardState,
} from "../sandbox-reuse";

const ROUTING = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "efficient-model" },
  capable: { provider: "openai-api", model: "capable-model" },
});

function environment(routing: HermesSwitchyardRoutingIntent | null): NodeJS.ProcessEnv {
  return routing
    ? { [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing) }
    : {};
}

function entry(routing: HermesSwitchyardRoutingIntent | null) {
  const profile = managedStartupE2eProfile("hermes");
  const agentConfig = profile.agentConfig as ManagedStartupHermesConfig;
  const encodedProfile = encodeManagedStartupProfile({
    ...profile,
    agentConfig: {
      ...agentConfig,
      switchyardRouting: routing,
      ...(routing ? { switchyardBindings: switchyardBindingFixture(routing) } : {}),
    },
  });
  return {
    name: "hermes",
    agent: "hermes",
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"1".repeat(64)}`,
      release: "v0.1.0",
      sourceRevision: "2".repeat(40),
      sourceCohort: "ghrun-1-1",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile,
      startupProfileSha256: "3".repeat(64),
      credentialProxyReplayRequired: true,
      shared: true,
    },
  } satisfies SandboxEntry;
}

async function readyReuseFixture(options: { sandboxState?: string; recreate?: boolean } = {}) {
  const fixture = createSwitchyardProviderFixture(ROUTING, "nemoclaw", "hermes");
  const { bindings } = await fixture.setup();
  const session = createSession({ sandboxName: "hermes", agent: "hermes" });
  const journal = bindJournaledRecreate(session, "hermes", "hermes");
  const recorded: SandboxEntry = {
    ...entry(ROUTING),
    createdAt: "2026-11-04T00:00:00Z",
    gatewayName: "nemoclaw",
    provider: ROUTING.capable.provider,
    model: ROUTING.capable.model,
    endpointUrl: "https://api.openai.com/v1",
    preferredInferenceApi: "openai-completions",
    toolDisclosure: "progressive",
    webSearchEnabled: false,
    fromDockerfile: null,
    hermesAuthMethod: null,
    hermesSwitchyard: { routing: ROUTING, bindings },
    pendingRouteReservation: true,
    reservationSessionId: session.sessionId,
  };
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => options.sandboxState ?? "ready",
      getSandboxRegistryEntry: () => recorded,
      getSandboxRecreateObservation: journal.observe,
    },
    session,
  );
  return {
    fixture,
    calls,
    recorded,
    reuse: () =>
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "hermes",
        gatewayName: "nemoclaw",
        agent: { name: "hermes" },
        recreateSandbox: () => options.recreate ?? false,
        provider: ROUTING.capable.provider,
        model: ROUTING.capable.model,
        endpointUrl: "https://api.openai.com/v1",
        env: environment(ROUTING),
      }),
  };
}

describe("Hermes Switchyard sandbox reuse", () => {
  it.each(["ready", "not_ready", "missing"])(
    "rejects recreation of a %s routed sandbox before lifecycle effects (#13863)",
    async (sandboxState) => {
      const { fixture, calls, recorded, reuse } = await readyReuseFixture({
        sandboxState,
        recreate: true,
      });
      const before = structuredClone(recorded);
      vi.clearAllMocks();
      await expect(reuse()).rejects.toThrow("new sandbox name");
      expect(calls.createSandbox).not.toHaveBeenCalled();
      expect(calls.finalizeRouteReservation).not.toHaveBeenCalled();
      expect(calls.recordSkip).not.toHaveBeenCalled();
      expect(Object.values(fixture.methods).every((method) => method.mock.calls.length === 0)).toBe(
        true,
      );
      expect(recorded).toEqual(before);
    },
  );

  it("rejects Ready sandbox reuse before provider access or reservation finalization (#13863)", async () => {
    const { fixture, calls, recorded, reuse } = await readyReuseFixture();
    const before = structuredClone(recorded);
    vi.clearAllMocks();
    await expect(reuse()).rejects.toThrow("fresh sandbox");
    expect(calls.finalizeRouteReservation).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(Object.values(fixture.methods).every((method) => method.mock.calls.length === 0)).toBe(
      true,
    );
    expect(recorded).toEqual(before);
  });

  it.each([
    {
      state: "detached",
      mutate: (fixture: ReturnType<typeof createSwitchyardProviderFixture>) =>
        fixture.names.splice(0, 1),
    },
    {
      state: "removed",
      mutate: (fixture: ReturnType<typeof createSwitchyardProviderFixture>) =>
        fixture.providers.delete(fixture.names[0]),
    },
    {
      state: "replaced",
      mutate: (fixture: ReturnType<typeof createSwitchyardProviderFixture>) => {
        const provider = fixture.providers.get(fixture.names[0])!;
        fixture.providers.set(fixture.names[0], {
          ...provider,
          revision: { id: "replacement", resourceVersion: 1 },
        });
      },
    },
  ])(
    "rejects $state provider state before finalizing Ready sandbox reuse (#13863)",
    async ({ mutate }) => {
      const { fixture, calls, reuse } = await readyReuseFixture();
      mutate(fixture);
      await expect(reuse()).rejects.toThrow("fresh sandbox");
      expect(calls.finalizeRouteReservation).not.toHaveBeenCalled();
      expect(calls.recordSkip).not.toHaveBeenCalled();
      expect(fixture.methods.createProvider).toHaveBeenCalledTimes(2);
      expect(fixture.methods.deleteProvider).not.toHaveBeenCalled();
      expect(fixture.methods.updateProvider).not.toHaveBeenCalled();
    },
  );

  it("rejects routed replacement restoration before dashboard or registry effects (#13863)", async () => {
    const fixture = createSwitchyardProviderFixture(ROUTING, "nemoclaw", "hermes");
    const { bindings } = await fixture.setup();
    const releaseDashboardPort = vi.fn(async () => undefined);
    const updateReusedSandboxMetadata = vi.fn();
    const updateSandbox = vi.fn();
    const input = {
      sandboxName: "hermes",
      chatUiUrl: "",
      env: {},
      agent: { name: "hermes" } as never,
      model: "switchyard",
      provider: "nvidia-prod",
      selectionVerified: true,
      sandboxGpuConfig: {
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        mode: "auto" as const,
        sandboxGpuDevice: null,
        errors: [],
      },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      getSandbox: () => ({ ...entry(ROUTING), hermesSwitchyard: { routing: ROUTING, bindings } }),
      manageDashboard: false,
      releaseDashboardPort,
      ensureDashboardForward: vi.fn(() => 0),
      hermesDashboardForwarding: {
        resolveStateForPort: vi.fn(() => ({ enabled: false, config: null })),
        ensureForState: vi.fn(),
      },
      updateSandbox,
      updateReusedSandboxMetadata,
    };
    await expect(restoreReusedSandboxDashboardState(input)).rejects.toThrow(
      "routing configuration changed",
    );
    expect(releaseDashboardPort).not.toHaveBeenCalled();
    expect(updateReusedSandboxMetadata).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    await expect(
      restoreReusedSandboxDashboardState({ ...input, env: environment(ROUTING) }),
    ).rejects.toThrow("fresh sandbox");
    expect(releaseDashboardPort).not.toHaveBeenCalled();
    expect(updateReusedSandboxMetadata).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it.each(["ready", "not_ready", "missing"])(
    "preserves ordinary recreation of a %s sandbox with routing disabled (#13863)",
    (sandboxState) => {
      expect(() =>
        assertHermesSwitchyardRoutingReusable({
          agentName: "hermes",
          entry: entry(null),
          env: {},
          recreate: true,
          sandboxState,
        }),
      ).not.toThrow();
    },
  );

  it.each([undefined, "other-session"])(
    "requires matching fresh binding ownership and routing when session=%s (#13863)",
    (reservationSessionId) => {
      const sandbox: SandboxEntry = {
        name: "hermes",
        agent: "hermes",
        pendingRouteReservation: true,
        reservationSessionId: "current-session",
        hermesSwitchyard: { routing: ROUTING, bindings: switchyardBindingFixture(ROUTING) },
      };
      const before = structuredClone(sandbox);
      const input = {
        agentName: "hermes",
        entry: sandbox,
        env: environment(ROUTING),
        recreate: false,
        sandboxState: "missing",
        reservationSessionId,
      };
      expect(() => assertHermesSwitchyardRoutingReusable(input)).toThrow("new sandbox name");
      expect(sandbox).toEqual(before);
    },
  );

  it("accepts an owned fresh reservation only with matching routing (#13863)", () => {
    const sandbox: SandboxEntry = {
      name: "hermes",
      agent: "hermes",
      pendingRouteReservation: true,
      reservationSessionId: "current-session",
      hermesSwitchyard: { routing: ROUTING, bindings: switchyardBindingFixture(ROUTING) },
    };
    const before = structuredClone(sandbox);
    const input = {
      agentName: "hermes",
      entry: sandbox,
      env: environment(ROUTING),
      recreate: false,
      sandboxState: "missing",
      reservationSessionId: "current-session",
    };
    expect(() => assertHermesSwitchyardRoutingReusable(input)).not.toThrow();
    const changed = createHermesSwitchyardRoutingIntent({
      efficient: { provider: ROUTING.efficient.provider, model: "changed-efficient-model" },
      capable: ROUTING.capable,
    });
    expect(() =>
      assertHermesSwitchyardRoutingReusable({ ...input, env: environment(changed) }),
    ).toThrow("new sandbox name");
    expect(sandbox).toEqual(before);
  });

  it("allows fresh routed creation without a recorded sandbox (#13863)", () => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: null,
        env: environment(ROUTING),
        recreate: false,
        sandboxState: "missing",
      }),
    ).not.toThrow();
  });

  it("rejects replacing a recorded routed sandbox with another agent (#13863)", () => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "openclaw",
        entry: {
          ...entry(ROUTING),
          hermesSwitchyard: { routing: ROUTING, bindings: switchyardBindingFixture(ROUTING) },
        },
        env: {},
        recreate: true,
        sandboxState: "ready",
      }),
    ).toThrow("new sandbox name");
  });

  it("rejects matching routed profiles until provider reuse is supported (#13863)", () => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: entry(ROUTING),
        env: environment(ROUTING),
        recreate: false,
        sandboxState: "ready",
      }),
    ).toThrow(/fresh sandbox.*onboard with a new sandbox name/u);
  });

  it("rejects recorded bindings even when a legacy sandbox has no routing profile (#13863)", () => {
    const sandbox = {
      name: "hermes",
      agent: "hermes",
      hermesSwitchyard: { routing: ROUTING, bindings: switchyardBindingFixture(ROUTING) },
    };
    const before = structuredClone(sandbox);
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: sandbox,
        env: {},
        recreate: false,
        sandboxState: "ready",
      }),
    ).toThrow("fresh sandbox");
    expect(sandbox).toEqual(before);
  });

  it.each([
    ["enabled", null, ROUTING],
    ["disabled", ROUTING, null],
    [
      "changed",
      ROUTING,
      createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "another-efficient-model" },
        capable: { provider: "openai-api", model: "capable-model" },
      }),
    ],
  ] as const)("requires a new sandbox when routing is %s (#13863)", (_label, recorded, desired) => {
    const sandbox = entry(recorded);
    const before = structuredClone(sandbox);
    const input = {
      agentName: "hermes",
      entry: sandbox,
      env: environment(desired),
      recreate: false,
      sandboxState: "ready",
    };
    expect(() => assertHermesSwitchyardRoutingReusable(input)).toThrow("new sandbox name");
    expect(sandbox).toEqual(before);
    expect(() => assertHermesSwitchyardRoutingReusable({ ...input, recreate: true })).toThrow(
      "new sandbox name",
    );
    expect(sandbox).toEqual(before);
  });

  it("rejects an unreadable stored profile before reuse (#13862)", () => {
    const sandbox = entry(ROUTING);
    sandbox.workload.encodedProfile = "invalid";
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: sandbox,
        env: {},
        recreate: false,
        sandboxState: "ready",
      }),
    ).toThrow("Preserve this sandbox and onboard with a new sandbox name");
  });

  it("requires a new sandbox when a legacy Hermes sandbox has no routing profile (#13863)", () => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: { name: "legacy", agent: "hermes" },
        env: environment(ROUTING),
        recreate: false,
        sandboxState: "ready",
      }),
    ).toThrow("new sandbox name");
  });

  it("preserves ordinary legacy reuse and ignores other agents (#13862)", () => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: { name: "legacy", agent: "hermes" },
        env: {},
        recreate: false,
        sandboxState: "ready",
      }),
    ).not.toThrow();
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "openclaw",
        entry: null,
        env: environment(ROUTING),
        recreate: false,
        sandboxState: "ready",
      }),
    ).not.toThrow();
  });
});
