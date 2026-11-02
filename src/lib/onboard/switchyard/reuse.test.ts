// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_ROUTING_ENV,
  type HermesSwitchyardRoutingIntent,
} from "../../hermes-switchyard-routing";
import type { SandboxEntry } from "../../state/registry";
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
    agentConfig: { ...agentConfig, switchyardRouting: routing },
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

describe("Hermes Switchyard sandbox reuse", () => {
  it("rejects changed routing before restoring an accepted replacement (#13862)", async () => {
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
      getSandbox: () => entry(ROUTING),
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
    ).resolves.toMatchObject({ dashboardPort: 0 });
    expect(releaseDashboardPort).toHaveBeenCalledOnce();
  });

  it.each([
    ["enabled", ROUTING],
    ["disabled", null],
  ] as const)("reuses a sandbox with matching %s routing (#13862)", (_label, routing) => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: entry(routing),
        env: environment(routing),
        recreate: false,
        sandboxState: "ready",
      }),
    ).not.toThrow();
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
  ] as const)("requires recreation when routing is %s (#13862)", (_label, recorded, desired) => {
    const sandbox = entry(recorded);
    const before = structuredClone(sandbox);
    const input = {
      agentName: "hermes",
      entry: sandbox,
      env: environment(desired),
      recreate: false,
      sandboxState: "ready",
    };
    expect(() => assertHermesSwitchyardRoutingReusable(input)).toThrow("--recreate-sandbox");
    expect(sandbox).toEqual(before);
    expect(() => assertHermesSwitchyardRoutingReusable({ ...input, recreate: true })).not.toThrow();
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
    ).toThrow("Cannot verify");
  });

  it("requires recreation when a legacy Hermes sandbox has no routing profile (#13862)", () => {
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "hermes",
        entry: { name: "legacy", agent: "hermes" },
        env: environment(ROUTING),
        recreate: false,
        sandboxState: "ready",
      }),
    ).toThrow("--recreate-sandbox");
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
