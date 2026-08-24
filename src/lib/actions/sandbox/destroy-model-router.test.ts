// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { GatewayRegistryEntry } from "../../state/gateway-registry";
import type { Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import {
  resolveDestroyedSandboxRouterPort,
  stopModelRouterForDestroyedSandbox,
  type StopModelRouterForDestroyedSandboxDeps,
} from "./destroy-preflight";

const routedSandbox = {
  name: "alpha",
  provider: "nvidia-router",
  endpointUrl: "http://host.openshell.internal:4100/v1",
} as SandboxEntry;

function createDeps(overrides: Partial<StopModelRouterForDestroyedSandboxDeps> = {}) {
  const session = {
    sessionId: "session-alpha",
    sandboxName: "alpha",
    endpointUrl: routedSandbox.endpointUrl,
    routerPid: 4242,
    routerCredentialHash: "hash",
  } as Session;
  const deps: StopModelRouterForDestroyedSandboxDeps = {
    acquireOnboardLock: vi.fn(() => ({
      acquired: true,
      lockFile: "/tmp/onboard.lock",
      stale: false,
    })),
    compareAndSwapSession: vi.fn((matches, mutator) => {
      return matches(session) ? (mutator(session), "updated") : "mismatch";
    }),
    expectedSession: session,
    inspectProcessForPort: vi.fn(() => ({ status: "absent" as const })),
    isHealthy: vi.fn(async () => false),
    isRoutedProvider: vi.fn((provider: string | null | undefined) => provider === "nvidia-router"),
    listHostRegistryEntries: vi.fn(() => []),
    loadSession: vi.fn(() => session),
    log: vi.fn(),
    ownsPort: vi.fn(() => true),
    releaseOnboardLock: vi.fn(),
    stopProcess: vi.fn(async () => undefined),
    warn: vi.fn(),
    withModelRouterPortLifecycleLock: async <T>(_port: number, operation: () => Promise<T> | T) =>
      await operation(),
    ...overrides,
  };
  return { deps, session };
}

describe("resolveDestroyedSandboxRouterPort", () => {
  it("parses the router port from the sandbox endpoint URL", () => {
    expect(resolveDestroyedSandboxRouterPort("http://host.openshell.internal:4100/v1")).toBe(4100);
  });

  it("falls back to port 4000 for a missing or unparseable endpoint", () => {
    expect(resolveDestroyedSandboxRouterPort(null)).toBe(4000);
    expect(resolveDestroyedSandboxRouterPort("not a url")).toBe(4000);
    expect(resolveDestroyedSandboxRouterPort("http://host.openshell.internal/v1")).toBe(4000);
  });
});

describe("stopModelRouterForDestroyedSandbox", () => {
  it("stops the tracked router and clears its session identity for the last routed sandbox (#9098)", async () => {
    const { deps, session } = createDeps();

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).toHaveBeenCalledWith(4242, 4100);
    expect(session.routerPid).toBeNull();
    expect(session.routerCredentialHash).toBeNull();
    expect(session.sandboxName).toBeNull();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("does nothing for a sandbox without a routed provider", async () => {
    const { deps } = createDeps();

    await stopModelRouterForDestroyedSandbox(
      { name: "alpha", provider: "ollama-local" } as SandboxEntry,
      deps,
    );

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).not.toHaveBeenCalled();
  });

  it("does nothing when the registry entry is missing", async () => {
    const { deps } = createDeps();

    await stopModelRouterForDestroyedSandbox(null, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).not.toHaveBeenCalled();
  });

  it("keeps the router while a sandbox in another gateway state root uses the same port", async () => {
    const { deps, session } = createDeps({
      listHostRegistryEntries: vi.fn(() => [
        {
          entry: {
            name: "beta",
            provider: "nvidia-router",
            endpointUrl: routedSandbox.endpointUrl,
          } as GatewayRegistryEntry,
          gatewayPort: 9090,
          registryFile: "/tmp/gateways/9090/sandboxes.json",
          stateRoot: "/tmp/gateways/9090",
        },
      ]),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).toHaveBeenCalledOnce();
    expect(session.sandboxName).toBeNull();
  });

  it("stops the router when a routed peer uses another port", async () => {
    const { deps } = createDeps({
      listHostRegistryEntries: vi.fn(() => [
        {
          entry: {
            name: "beta",
            provider: "nvidia-router",
            endpointUrl: "http://host.openshell.internal:4200/v1",
          } as GatewayRegistryEntry,
          gatewayPort: 9090,
          registryFile: "/tmp/gateways/9090/sandboxes.json",
          stateRoot: "/tmp/gateways/9090",
        },
      ]),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).toHaveBeenCalledWith(4242, 4100);
  });

  it("recovers an orphaned router by port scan when the recorded PID does not own the port", async () => {
    const { deps, session } = createDeps({
      ownsPort: vi.fn(() => false),
      inspectProcessForPort: vi.fn(() => ({ status: "found" as const, pid: 5151 })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.inspectProcessForPort).toHaveBeenCalledWith(4100);
    expect(deps.stopProcess).toHaveBeenCalledWith(5151, 4100);
    expect(session.routerPid).toBeNull();
  });

  it("stops a target-port orphan without clearing another sandbox session", async () => {
    const unrelatedSession = {
      sandboxName: "beta",
      endpointUrl: "http://host.openshell.internal:4200/v1",
      routerPid: 6262,
      routerCredentialHash: "beta-hash",
    } as Session;
    const { deps } = createDeps({
      expectedSession: unrelatedSession,
      loadSession: vi.fn(() => unrelatedSession),
      ownsPort: vi.fn(() => false),
      inspectProcessForPort: vi.fn(() => ({ status: "found" as const, pid: 5151 })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).toHaveBeenCalledWith(5151, 4100);
    expect(deps.compareAndSwapSession).not.toHaveBeenCalled();
    expect(unrelatedSession.routerPid).toBe(6262);
    expect(unrelatedSession.routerCredentialHash).toBe("beta-hash");
  });

  it("clears the destroyed sandbox association without clearing another router port", async () => {
    const reusedNameSession = {
      sessionId: "replacement-session",
      updatedAt: "2026-08-14T00:01:00.000Z",
      sandboxName: "alpha",
      endpointUrl: "http://host.openshell.internal:4200/v1",
      routerPid: 6262,
      routerCredentialHash: "new-hash",
    } as Session;
    const compareAndSwapSession = vi.fn(
      (matches: (current: Session) => boolean, mutator: (current: Session) => Session | void) => {
        return matches(reusedNameSession)
          ? (mutator(reusedNameSession), "updated")
          : "mismatch";
      },
    );
    const { deps } = createDeps({
      compareAndSwapSession,
      expectedSession: reusedNameSession,
      loadSession: vi.fn(() => reusedNameSession),
      ownsPort: vi.fn(() => false),
      inspectProcessForPort: vi.fn(() => ({ status: "absent" as const })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(compareAndSwapSession).toHaveBeenCalledOnce();
    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(reusedNameSession.sandboxName).toBeNull();
    expect(reusedNameSession.routerPid).toBe(6262);
    expect(reusedNameSession.routerCredentialHash).toBe("new-hash");
  });

  it("does not clear router identity after the session changes", async () => {
    const replacementSession = {
      sessionId: "session-beta",
      sandboxName: "beta",
      endpointUrl: "http://host.openshell.internal:4200/v1",
      routerPid: 6262,
      routerCredentialHash: "new-hash",
    } as Session;
    const { deps } = createDeps({ loadSession: vi.fn(() => replacementSession) });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(replacementSession).toMatchObject({
      sandboxName: "beta",
      routerPid: 6262,
      routerCredentialHash: "new-hash",
    });
    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).not.toHaveBeenCalled();
  });

  it("keeps session identity while another onboarding run owns the session lock", async () => {
    const { deps, session } = createDeps({
      acquireOnboardLock: vi.fn(() => ({
        acquired: false,
        lockFile: "/tmp/onboard.lock",
        stale: false,
        holderPid: 6262,
        holderStartedAt: "2026-08-14T00:00:00.000Z",
        holderCommand: "replacement nemoclaw onboard process",
      })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(session.routerPid).toBe(4242);
    expect(session.routerCredentialHash).toBe("hash");
    expect(session.sandboxName).toBe("alpha");
    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("owns the session lock"));
  });

  it("clears a stale recorded PID when no router process is found", async () => {
    const { deps, session } = createDeps({
      ownsPort: vi.fn(() => false),
      inspectProcessForPort: vi.fn(() => ({ status: "absent" as const })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(session.routerPid).toBeNull();
    expect(session.routerCredentialHash).toBeNull();
  });

  it("keeps router recovery identity when process inventory is unavailable", async () => {
    const { deps, session } = createDeps({
      ownsPort: vi.fn(() => false),
      inspectProcessForPort: vi.fn(() => ({ status: "unavailable" as const })),
      isHealthy: vi.fn(async () => true),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).toHaveBeenCalledOnce();
    expect(session.routerPid).toBe(4242);
    expect(session.routerCredentialHash).toBe("hash");
    expect(session.sandboxName).toBeNull();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("process inventory"));
  });

  it("keeps router recovery identity when no process is visible but the router port stays healthy", async () => {
    const { deps, session } = createDeps({
      ownsPort: vi.fn(() => false),
      inspectProcessForPort: vi.fn(() => ({ status: "absent" as const })),
      isHealthy: vi.fn(async () => true),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.compareAndSwapSession).toHaveBeenCalledOnce();
    expect(session.routerPid).toBe(4242);
    expect(session.routerCredentialHash).toBe("hash");
    expect(session.sandboxName).toBeNull();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("healthy port 4100"));
  });

  it("clears a stale credential hash when the session records no router PID (#9098)", async () => {
    const session = {
      sessionId: "session-alpha",
      sandboxName: "alpha",
      endpointUrl: routedSandbox.endpointUrl,
      routerPid: null,
      routerCredentialHash: "stale",
    } as Session;
    const { deps } = createDeps({
      expectedSession: session,
      loadSession: vi.fn(() => session),
      ownsPort: vi.fn(() => false),
      compareAndSwapSession: vi.fn((matches, mutator) => {
        return matches(session) ? (mutator(session), "updated") : "mismatch";
      }),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(session.routerPid).toBeNull();
    expect(session.routerCredentialHash).toBeNull();
  });

  it("clears the destroyed sandbox association when no router identity remains", async () => {
    const session = {
      sessionId: "session-alpha",
      sandboxName: "alpha",
      endpointUrl: routedSandbox.endpointUrl,
      routerPid: null,
      routerCredentialHash: null,
    } as Session;
    const { deps } = createDeps({
      expectedSession: session,
      loadSession: vi.fn(() => session),
      ownsPort: vi.fn(() => false),
      compareAndSwapSession: vi.fn((matches, mutator) => {
        return matches(session) ? (mutator(session), "updated") : "mismatch";
      }),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.compareAndSwapSession).toHaveBeenCalledOnce();
    expect(session.sandboxName).toBeNull();
  });

  it("warns and keeps the recorded PID when the stop fails, so uninstall can still find it", async () => {
    const { deps, session } = createDeps({
      stopProcess: vi.fn(async () => {
        throw new Error("shutdown did not converge");
      }),
    });

    await expect(stopModelRouterForDestroyedSandbox(routedSandbox, deps)).resolves.toBe(true);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("shutdown did not converge"));
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("Inspect PID 4242"));
    expect(deps.warn).not.toHaveBeenCalledWith(expect.stringContaining("kill 4242"));
    expect(deps.compareAndSwapSession).toHaveBeenCalledOnce();
    expect(session.routerPid).toBe(4242);
    expect(session.sandboxName).toBeNull();
  });

  it("does not recommend a PID stop when ownership changes after a failed shutdown", async () => {
    let ownershipChecks = 0;
    const { deps } = createDeps({
      ownsPort: vi.fn(() => {
        ownershipChecks += 1;
        return ownershipChecks === 1;
      }),
      stopProcess: vi.fn(async () => {
        throw new Error("ownership changed during shutdown");
      }),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("Do not stop it by PID"));
    expect(deps.warn).not.toHaveBeenCalledWith(expect.stringContaining("kill 4242"));
  });
});
