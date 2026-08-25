// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxQuarantineFence, SandboxRegistry } from "./registry/types";

const state = vi.hoisted(() => ({
  registry: {
    sandboxes: {},
    defaultSandbox: null,
  } as SandboxRegistry,
}));

vi.mock("./registry/lock", () => ({ withLock: <T>(operation: () => T): T => operation() }));
vi.mock("./registry/persistence", () => ({
  load: () => state.registry,
  saveDurable: (value: SandboxRegistry) => {
    state.registry = structuredClone(value);
  },
}));

import {
  beginSandboxQuarantine,
  releaseSandboxQuarantine,
  updateSandboxQuarantine,
} from "./registry/quarantine-operations";

function fence(overrides: Partial<SandboxQuarantineFence> = {}): SandboxQuarantineFence {
  return {
    schemaVersion: 1,
    fenceId: "00000000-0000-4000-8000-000000000001",
    requestIdentity: "a".repeat(64),
    reason: "incident investigation",
    createdAt: "2026-08-25T04:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    phase: "fenced",
    target: {
      sandboxName: "alpha",
      providerId: "docker",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "registry-generation-1",
      liveIdentityFingerprint: "b".repeat(64),
      providerHandle: "c".repeat(64),
      providerLifecycleGeneration: "provider-generation-1",
      runtime: { kind: "docker-container", handle: "d".repeat(64) },
    },
    attempts: [],
    ...overrides,
  };
}

beforeEach(() => {
  state.registry = {
    defaultSandbox: "alpha",
    sandboxes: {
      alpha: {
        name: "alpha",
        openshellDriver: "docker",
        lifecycleGeneration: "registry-generation-1",
        lifecycleLiveIdentityFingerprint: "b".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      },
    },
  };
});

describe("sandbox quarantine registry transaction", () => {
  it("publishes one fence and reconciles only the same request identity (#10140)", () => {
    const first = fence();

    expect(beginSandboxQuarantine("alpha", first).status).toBe("started");
    expect(beginSandboxQuarantine("alpha", first).status).toBe("existing");
    expect(
      beginSandboxQuarantine(
        "alpha",
        fence({
          fenceId: "00000000-0000-4000-8000-000000000002",
          requestIdentity: "e".repeat(64),
        }),
      ).status,
    ).toBe("conflict");
    expect(
      beginSandboxQuarantine("alpha", fence({ reason: "same key, different request" })).status,
    ).toBe("conflict");
    expect(state.registry.sandboxes.alpha?.quarantine).toEqual(first);
  });

  it("rejects a stale registry generation before fence publication (#10140)", () => {
    const result = beginSandboxQuarantine(
      "alpha",
      fence({
        target: { ...fence().target, lifecycleGeneration: "replacement-generation" },
      }),
    );

    expect(result.status).toBe("stale");
    expect(state.registry.sandboxes.alpha?.quarantine).toBeUndefined();
  });

  it("rejects a stale gateway binding before fence publication (#10140)", () => {
    state.registry.sandboxes.alpha = {
      ...state.registry.sandboxes.alpha!,
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
    };

    const result = beginSandboxQuarantine("alpha", fence());

    expect(result.status).toBe("stale");
    expect(state.registry.sandboxes.alpha?.quarantine).toBeUndefined();
  });

  it("rejects a changed gateway name even when its port is unchanged (#10140)", () => {
    state.registry.sandboxes.alpha = {
      ...state.registry.sandboxes.alpha!,
      gatewayName: "replacement-gateway",
    };

    expect(beginSandboxQuarantine("alpha", fence()).status).toBe("stale");
    expect(state.registry.sandboxes.alpha?.quarantine).toBeUndefined();
  });

  it("updates and releases only the exact active fence (#10140)", () => {
    const active = fence();
    expect(beginSandboxQuarantine("alpha", active).status).toBe("started");
    const completed = { ...active, phase: "quarantined" as const };

    expect(updateSandboxQuarantine("alpha", completed)).toBe(true);
    expect(releaseSandboxQuarantine("alpha", "00000000-0000-4000-8000-000000000002")).toBe(false);
    expect(releaseSandboxQuarantine("alpha", active.fenceId)).toBe(true);
    expect(state.registry.sandboxes.alpha?.quarantine).toBeUndefined();
  });

  it("refuses release after the registered target authority changes (#10140)", () => {
    const active = fence();
    expect(beginSandboxQuarantine("alpha", active).status).toBe("started");
    state.registry.sandboxes.alpha = {
      ...state.registry.sandboxes.alpha!,
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
    };

    expect(releaseSandboxQuarantine("alpha", active.fenceId)).toBe(false);
    expect(state.registry.sandboxes.alpha?.quarantine).toEqual(active);
  });

  it("refuses journal updates and release after same-port gateway replacement (#10140)", () => {
    const active = fence();
    expect(beginSandboxQuarantine("alpha", active).status).toBe("started");
    state.registry.sandboxes.alpha = {
      ...state.registry.sandboxes.alpha!,
      gatewayName: "replacement-gateway",
    };

    expect(updateSandboxQuarantine("alpha", { ...active, phase: "partial" })).toBe(false);
    expect(releaseSandboxQuarantine("alpha", active.fenceId)).toBe(false);
    expect(state.registry.sandboxes.alpha?.quarantine).toEqual(active);
  });
});
