// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

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
    endpointUrl: "http://host.openshell.internal:4100/v1",
    routerPid: 4242,
    routerCredentialHash: "hash",
  } as Session;
  const deps = {
    findPidForPort: vi.fn(() => null),
    isRoutedProvider: vi.fn((provider: string | null | undefined) => provider === "nvidia-router"),
    listSandboxes: vi.fn(() => ({ sandboxes: [] as SandboxEntry[], defaultSandbox: null })),
    loadSession: vi.fn(() => session),
    log: vi.fn(),
    ownsPort: vi.fn(() => true),
    stopProcess: vi.fn(async () => undefined),
    updateSession: vi.fn((mutator: (current: Session) => Session | void) => {
      mutator(session);
      return session;
    }),
    warn: vi.fn(),
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
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("does nothing for a sandbox without a routed provider", async () => {
    const { deps } = createDeps();

    await stopModelRouterForDestroyedSandbox(
      { name: "alpha", provider: "ollama-local" } as SandboxEntry,
      deps,
    );

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it("does nothing when the registry entry is missing", async () => {
    const { deps } = createDeps();

    await stopModelRouterForDestroyedSandbox(null, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it("keeps the router while another registered routed sandbox remains", async () => {
    const { deps } = createDeps({
      listSandboxes: vi.fn(() => ({
        sandboxes: [
          {
            name: "beta",
            provider: "nvidia-router",
            endpointUrl: "http://host.openshell.internal:4100/v1",
          } as SandboxEntry,
        ],
        defaultSandbox: null,
      })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it("stops the target router when a routed peer uses a different port", async () => {
    const { deps } = createDeps({
      listSandboxes: vi.fn(() => ({
        sandboxes: [
          {
            name: "beta",
            provider: "nvidia-router",
            endpointUrl: "http://host.openshell.internal:4200/v1",
          } as SandboxEntry,
        ],
        defaultSandbox: null,
      })),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).toHaveBeenCalledWith(4242, 4100);
  });

  it("recovers an orphaned router by port scan when the recorded PID does not own the port", async () => {
    const { deps, session } = createDeps({
      ownsPort: vi.fn(() => false),
      findPidForPort: vi.fn(() => 5151),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.findPidForPort).toHaveBeenCalledWith(4100);
    expect(deps.stopProcess).toHaveBeenCalledWith(5151, 4100);
    expect(session.routerPid).toBeNull();
  });

  it("clears a stale recorded PID when no router process is found", async () => {
    const { deps, session } = createDeps({
      ownsPort: vi.fn(() => false),
      findPidForPort: vi.fn(() => null),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(session.routerPid).toBeNull();
    expect(session.routerCredentialHash).toBeNull();
  });

  it("clears a stale credential hash when the session records no router PID (#9098)", async () => {
    const session = {
      sessionId: "session-alpha",
      sandboxName: "alpha",
      endpointUrl: "http://host.openshell.internal:4100/v1",
      routerPid: null,
      routerCredentialHash: "stale",
    } as Session;
    const { deps } = createDeps({
      loadSession: vi.fn(() => session),
      ownsPort: vi.fn(() => false),
      updateSession: vi.fn((mutator: (current: Session) => Session | void) => {
        mutator(session);
        return session;
      }),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(session.routerPid).toBeNull();
    expect(session.routerCredentialHash).toBeNull();
  });

  it("does not clear session identity for a different routed sandbox", async () => {
    const session = {
      sessionId: "session-beta",
      sandboxName: "beta",
      endpointUrl: "http://host.openshell.internal:4200/v1",
      routerPid: 5252,
      routerCredentialHash: "beta-hash",
    } as Session;
    const { deps } = createDeps({
      loadSession: vi.fn(() => session),
      ownsPort: vi.fn(() => false),
      findPidForPort: vi.fn(() => 5151),
      updateSession: vi.fn((mutator: (current: Session) => Session | void) => {
        mutator(session);
        return session;
      }),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).toHaveBeenCalledWith(5151, 4100);
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(session).toMatchObject({ routerPid: 5252, routerCredentialHash: "beta-hash" });
  });

  it("leaves the session untouched when it records no router PID and no orphan exists", async () => {
    const { deps } = createDeps({
      loadSession: vi.fn(
        () =>
          ({
            sessionId: "session-beta",
            sandboxName: "beta",
            endpointUrl: "http://host.openshell.internal:4200/v1",
            routerPid: null,
          }) as Session,
      ),
      ownsPort: vi.fn(() => false),
    });

    await stopModelRouterForDestroyedSandbox(routedSandbox, deps);

    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it("warns and keeps the recorded PID when the stop fails, so uninstall can still find it", async () => {
    const { deps, session } = createDeps({
      stopProcess: vi.fn(async () => {
        throw new Error("shutdown did not converge");
      }),
    });

    await expect(stopModelRouterForDestroyedSandbox(routedSandbox, deps)).resolves.toBeUndefined();

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("shutdown did not converge"));
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("kill 4242"));
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(session.routerPid).toBe(4242);
  });
});
