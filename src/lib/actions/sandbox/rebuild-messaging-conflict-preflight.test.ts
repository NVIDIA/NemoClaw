// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * #5954: `channels start`/rebuild must detect a shared messaging credential
 * BEFORE backup/delete, so a conflicting rebuild aborts with the sandbox still
 * intact instead of being destroyed and then failing to recreate.
 */

import { describe, expect, it, vi } from "vitest";
import type { ConflictRegistryEntry } from "../../messaging/applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { MessagingConflictGuardDeps } from "../../onboard/messaging-conflict-guard";
import { preflightRebuildMessagingConflicts } from "./rebuild-messaging-conflict-preflight";

const TEAMS_SECRET_KEY = "MSTEAMS_APP_PASSWORD";

function teamsPlan(sandboxName: string, credentialHash: string): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "teams",
        displayName: "teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "teams",
        providerEnvKey: TEAMS_SECRET_KEY,
        credentialAvailable: true,
        credentialHash,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  } as unknown as SandboxMessagingPlan;
}

function registryWith(entries: ConflictRegistryEntry[]): RegistryStub {
  return {
    listSandboxes: () => ({ sandboxes: entries }),
  };
}

type RegistryStub = { listSandboxes: () => { sandboxes: ConflictRegistryEntry[] } };

function makeDeps(
  overrides: Partial<Parameters<typeof preflightRebuildMessagingConflicts>[1]> = {},
) {
  const log = vi.fn();
  const error = vi.fn();
  const bail = vi.fn((message: string) => {
    throw new Error(message);
  }) as unknown as (message: string, code?: number) => never;
  return {
    log,
    error,
    bail,
    deps: {
      sandboxName: "my-assistant",
      gatewayName: "nemoclaw",
      registry: registryWith([]) as never,
      cliName: () => "nemoclaw",
      log,
      error,
      bail,
      ...overrides,
    },
  };
}

describe("preflightRebuildMessagingConflicts (#5954)", () => {
  it("does nothing (no guard call) when there is no staged plan", async () => {
    const enforce = vi.fn(async () => {});
    const { deps } = makeDeps({ enforceMessagingChannelConflicts: enforce });

    await preflightRebuildMessagingConflicts(null, deps);

    expect(enforce).not.toHaveBeenCalled();
  });

  it("runs the guard with abort-on-conflict (non-interactive) semantics", async () => {
    let captured: MessagingConflictGuardDeps | undefined;
    const enforce = vi.fn(async (guardDeps: MessagingConflictGuardDeps) => {
      captured = guardDeps;
    });
    const plan = teamsPlan("my-assistant", "hash-abc");
    const { deps } = makeDeps({ enforceMessagingChannelConflicts: enforce });

    await preflightRebuildMessagingConflicts(plan, deps);

    expect(enforce).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    const passed = captured as MessagingConflictGuardDeps;
    expect(passed.currentPlan).toBe(plan);
    expect(passed.isNonInteractive()).toBe(true);
    await expect(passed.promptContinue()).resolves.toBe(false);
  });

  it("aborts via bail (sandbox preserved) when another sandbox shares the credential", async () => {
    // Real guard + a registry where 'hermes' already holds the same Teams
    // credential hash → matching-token conflict must abort the rebuild.
    const plan = teamsPlan("my-assistant", "shared-hash");
    const registry = registryWith([
      { name: "my-assistant", messaging: { plan } },
      { name: "hermes", messaging: { plan: teamsPlan("hermes", "shared-hash") } },
    ]);
    const { deps, bail, log } = makeDeps({ registry: registry as never });

    await expect(preflightRebuildMessagingConflicts(plan, deps)).rejects.toThrow(
      /messaging channel conflict/i,
    );
    expect(bail).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join("\n")).toContain("uses the same teams credential");
  });

  it("proceeds (no bail) when no other sandbox shares the credential", async () => {
    const plan = teamsPlan("my-assistant", "unique-hash");
    const registry = registryWith([{ name: "my-assistant", messaging: { plan } }]);
    const { deps, bail } = makeDeps({ registry: registry as never });

    await preflightRebuildMessagingConflicts(plan, deps);

    expect(bail).not.toHaveBeenCalled();
  });
});
