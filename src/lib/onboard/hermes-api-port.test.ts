// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellForwardObservation } from "../adapters/openshell/forward";
import {
  createHermesApiPortScopedSandboxEntryPoints,
  createHermesApiPortReservationScope,
  findAvailableHermesApiPortFromObservations,
  HERMES_API_PORT_ENV,
  type HermesApiPortReservationScope,
  readHermesApiPort,
  reserveCreateSandboxHermesApiPort,
  resolveOnboardHermesApiPort,
  resolveSandboxHermesApiPort,
  resolveVerifyAgentApiPort,
  retargetHermesApiPortInUrl,
  withHermesApiPortReservationScope,
} from "./hermes-api-port";

function forwardObservation(
  sandboxName: string,
  port: number,
  state: "absent" | "foreign" | "owned" | "stale" | "indeterminate",
): OpenShellForwardObservation {
  const forward = {
    gatewayEndpoint: "https://127.0.0.1:9090",
    gatewayName: "nemoclaw-9090",
    workspace: "default",
    sandboxName,
    localHost: "127.0.0.1" as const,
    port,
  };
  return state === "indeterminate"
    ? {
        state,
        forward,
        error: {
          kind: "ownership",
          message: "NemoClaw could not prove OpenShell forward ownership.",
        },
      }
    : { state, forward };
}

function observePorts(
  sandboxName: string,
  states: ReadonlyMap<number, Parameters<typeof forwardObservation>[2]> = new Map(),
) {
  return vi.fn(async (ports: readonly number[]) =>
    ports.map((port) => forwardObservation(sandboxName, port, states.get(port) ?? "absent")),
  );
}

describe("Hermes API and dashboard port creation scopes", () => {
  it("gives each sandbox creation both fresh reservation scopes", async () => {
    const createSandboxWithBaseImageResolution = vi.fn(
      async (
        _baseImageResolutionContext: { fresh: boolean },
        portableRuntimeAuthority: { socketPath: string },
        _computePlan: { sequence: number },
        _managedWorkloadRebuild: null,
        temporaryManagedRuntime: boolean,
        _temporaryManagedRuntimeCatalog: null,
        dashboardPortReservationScope: { current: unknown },
        hermesApiPortReservationScope: HermesApiPortReservationScope,
        sandboxName: string,
      ) => ({
        dashboardPortReservationScope,
        hermesApiPortReservationScope,
        portableRuntimeAuthority,
        sandboxName,
        temporaryManagedRuntime,
      }),
    );
    let sequence = 0;
    const entryPoints = createHermesApiPortScopedSandboxEntryPoints({
      createBaseImageResolutionContext: () => ({ fresh: false }),
      createSandboxWithBaseImageResolution,
      resolvePortableRuntimeContext: () => ({ socketPath: "/run/user/1001/podman.sock" }),
      resolveComputePlan: () => ({ sequence: ++sequence }),
    });

    const standard = await entryPoints.createSandbox("standard");
    const temporary = await entryPoints.createSandboxWithTemporaryManagedRuntime("temporary");

    expect(standard).toMatchObject({ sandboxName: "standard", temporaryManagedRuntime: false });
    expect(standard.portableRuntimeAuthority).toEqual({
      socketPath: "/run/user/1001/podman.sock",
    });
    expect(temporary).toMatchObject({ sandboxName: "temporary", temporaryManagedRuntime: true });
    expect(standard.dashboardPortReservationScope).not.toBe(
      temporary.dashboardPortReservationScope,
    );
    expect(standard.hermesApiPortReservationScope).not.toBe(
      temporary.hermesApiPortReservationScope,
    );
  });
});

describe("readHermesApiPort", () => {
  it("falls back to the range start when unset", () => {
    expect(readHermesApiPort({})).toBe(8642);
  });

  it.each(["8641", "8653", "9000", "08642", "²"])(
    "rejects %s outside the allocated Hermes API-port range",
    (value) => {
      expect(() => readHermesApiPort({ [HERMES_API_PORT_ENV]: value })).toThrow(
        /integer from 8642 through 8652/,
      );
    },
  );
});

describe("findAvailableHermesApiPortFromObservations", () => {
  it.each(["owned", "stale"] as const)("keeps an exact %s forward", (state) => {
    expect(
      findAvailableHermesApiPortFromObservations(
        "beta",
        8642,
        [forwardObservation("beta", 8642, state)],
        new Map(),
      ),
    ).toBe(8642);
  });

  it("skips a port with foreign ownership evidence", () => {
    expect(
      findAvailableHermesApiPortFromObservations(
        "beta",
        8642,
        [forwardObservation("beta", 8642, "foreign"), forwardObservation("beta", 8643, "absent")],
        new Map(),
      ),
    ).toBe(8643);
  });

  it("blocks allocation when ownership is indeterminate", () => {
    expect(() =>
      findAvailableHermesApiPortFromObservations(
        "beta",
        8642,
        [
          forwardObservation("beta", 8642, "indeterminate"),
          forwardObservation("beta", 8643, "absent"),
        ],
        new Map(),
      ),
    ).toThrow(/could not prove OpenShell forward ownership/i);
  });
});

describe("reserveCreateSandboxHermesApiPort", () => {
  it("keeps concurrent selections distinct before either host forward exists", async () => {
    const firstRelease = vi.fn(async () => undefined);
    const secondRelease = vi.fn(async () => undefined);
    const reservePort = vi
      .fn()
      .mockResolvedValueOnce({ port: 8642, release: firstRelease })
      .mockRejectedValueOnce(
        Object.assign(new Error("port 8642 is already held"), { code: "EADDRINUSE" }),
      )
      .mockResolvedValueOnce({ port: 8643, release: secondRelease });
    const firstEnv: NodeJS.ProcessEnv = {};
    const secondEnv: NodeJS.ProcessEnv = {};

    const first = await reserveCreateSandboxHermesApiPort({
      sandboxName: "alpha",
      env: firstEnv,
      getSandbox: () => undefined,
      observeForwardPorts: observePorts("alpha"),
      registryOccupiedPorts: new Map(),
      reservePort,
    });
    const second = await reserveCreateSandboxHermesApiPort({
      sandboxName: "beta",
      env: secondEnv,
      getSandbox: () => undefined,
      observeForwardPorts: observePorts("beta"),
      registryOccupiedPorts: new Map(),
      reservePort,
    });

    expect(first.effectivePort).toBe(8642);
    expect(second.effectivePort).toBe(8643);
    expect(reservePort.mock.calls).toEqual([[8642], [8642], [8643]]);
    expect(firstEnv[HERMES_API_PORT_ENV]).toBe("8642");
    expect(secondEnv[HERMES_API_PORT_ENV]).toBe("8643");
    await Promise.all([first.reservation?.release(), second.reservation?.release()]);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it("allocates past a busy default when only a route-only reservation exists (#9291)", async () => {
    const release = vi.fn(async () => undefined);
    const reservePort = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("port 8642 is already held"), { code: "EADDRINUSE" }),
      )
      .mockResolvedValueOnce({ port: 8643, release });
    const env: NodeJS.ProcessEnv = {};

    const selection = await reserveCreateSandboxHermesApiPort({
      sandboxName: "beta",
      env,
      getSandbox: () => ({ pendingRouteReservation: true }),
      observeForwardPorts: observePorts("beta"),
      registryOccupiedPorts: new Map(),
      reservePort,
    });

    expect(selection.effectivePort).toBe(8643);
    expect(env[HERMES_API_PORT_ENV]).toBe("8643");
    expect(reservePort.mock.calls).toEqual([[8642], [8643]]);
    await selection.reservation?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports EADDRINUSE for a durable sandbox without a port instead of allocating (#9291)", async () => {
    const reservePort = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("port 8642 is already held"), { code: "EADDRINUSE" }),
      );
    const env: NodeJS.ProcessEnv = {};

    await expect(
      reserveCreateSandboxHermesApiPort({
        sandboxName: "beta",
        env,
        getSandbox: () => ({}),
        observeForwardPorts: observePorts("beta"),
        registryOccupiedPorts: new Map(),
        reservePort,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(reservePort.mock.calls).toEqual([[8642]]);
    expect(env[HERMES_API_PORT_ENV]).toBe("8642");
  });

  it("reports EADDRINUSE for a created sandbox that still has pendingRouteReservation (#9291)", async () => {
    const reservePort = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("port 8642 is already held"), { code: "EADDRINUSE" }),
      );
    const env: NodeJS.ProcessEnv = {};

    await expect(
      reserveCreateSandboxHermesApiPort({
        sandboxName: "beta",
        env,
        getSandbox: () => ({
          pendingRouteReservation: true,
          createdAt: "2026-08-17T00:00:00.000Z",
        }),
        observeForwardPorts: observePorts("beta"),
        registryOccupiedPorts: new Map(),
        reservePort,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(reservePort.mock.calls).toEqual([[8642]]);
    expect(env[HERMES_API_PORT_ENV]).toBe("8642");
  });

  it("defers a durable port reservation only for the exact owned forward", async () => {
    const reservePort = vi.fn();
    const observeForwardPorts = observePorts("beta", new Map([[8643, "owned"]]));

    const selection = await reserveCreateSandboxHermesApiPort({
      sandboxName: "beta",
      env: {},
      getSandbox: () => ({ hermesApiPort: 8643 }),
      observeForwardPorts,
      registryOccupiedPorts: new Map(),
      reservePort,
    });

    expect(selection).toEqual({ effectivePort: 8643, reservation: null });
    expect(observeForwardPorts).toHaveBeenCalledOnce();
    expect(reservePort).not.toHaveBeenCalled();
  });

  it("reports pinned foreign ownership before range exhaustion", async () => {
    const reservePort = vi.fn();
    const observeForwardPorts = observePorts(
      "beta",
      new Map(Array.from({ length: 11 }, (_, index) => [8642 + index, "foreign" as const])),
    );

    await expect(
      reserveCreateSandboxHermesApiPort({
        sandboxName: "beta",
        env: { [HERMES_API_PORT_ENV]: "8642" },
        getSandbox: () => undefined,
        observeForwardPorts,
        registryOccupiedPorts: new Map(),
        reservePort,
      }),
    ).rejects.toThrow(
      "Cannot allocate Hermes API port 8642: OpenShell forward ownership is not proven.",
    );
    expect(observeForwardPorts).toHaveBeenCalledWith([8642]);
    expect(reservePort).not.toHaveBeenCalled();
  });

  it("releases a held port when sandbox preparation fails", async () => {
    const release = vi.fn(async () => undefined);

    await expect(
      withHermesApiPortReservationScope(async (scope) => {
        scope.current = { port: 8642, release };
        throw new Error("sandbox preparation failed");
      }),
    ).rejects.toThrow(/sandbox preparation failed/);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rebinds an owned forward after sandbox deletion", async () => {
    const env: NodeJS.ProcessEnv = {};
    const scope = createHermesApiPortReservationScope();
    let observationCount = 0;
    const observeForwardPorts = vi.fn(async (ports: readonly number[]) => {
      const ownedForwardStillExists = observationCount++ === 0;
      return ports.map((port) =>
        forwardObservation(
          "beta",
          port,
          ownedForwardStillExists && port === 8643 ? "owned" : "absent",
        ),
      );
    });
    const input = {
      agentName: "hermes",
      sandboxName: "beta",
      env,
      getSandbox: () => ({ hermesApiPort: 8643 }),
      observeForwardPorts,
      reservePort: async (port: number) => ({ port, release: vi.fn(async () => undefined) }),
      warn: vi.fn(),
    };

    await scope.selectAndReserve(input);
    expect(scope.effectivePort).toBe(8643);
    expect(scope.current).toBeNull();

    await scope.rebindAfterOwnedForwardDelete(input);
    expect(scope.current?.port).toBe(8643);
    expect(observeForwardPorts).toHaveBeenCalledOnce();
    await scope.release();
  });

  it("releases only before the matching Hermes API forward", async () => {
    const release = vi.fn(async () => undefined);
    const scope = createHermesApiPortReservationScope();
    scope.current = { port: 8643, release };

    await scope.releaseBeforeForward("hermes", 18789);
    await scope.releaseBeforeForward("openclaw", 8643);
    expect(release).not.toHaveBeenCalled();

    await scope.releaseBeforeForward("hermes", 8643);
    expect(release).toHaveBeenCalledOnce();
    expect(scope.current).toBeNull();
  });
});

describe("resolveOnboardHermesApiPort", () => {
  it("prefers an explicit environment value and republishes it", () => {
    const env = { [HERMES_API_PORT_ENV]: "8650" };
    expect(resolveOnboardHermesApiPort("beta", { env, getSandbox: () => undefined })).toBe(8650);
    expect(env[HERMES_API_PORT_ENV]).toBe("8650");
  });

  it("rejects a conflicting existing-sandbox override before forward setup", () => {
    const env = { [HERMES_API_PORT_ENV]: "8644" };

    expect(() =>
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => ({ hermesApiPort: 8643 }),
      }),
    ).toThrow(/serves its OpenAI-compatible API on port 8643.*--recreate-sandbox/);
  });

  it("applies a conflicting override only at a create or registration boundary", () => {
    const env = { [HERMES_API_PORT_ENV]: "8644" };

    expect(
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => ({ hermesApiPort: 8643 }),
        allowRegisteredOverride: true,
      }),
    ).toBe(8644);
    expect(env[HERMES_API_PORT_ENV]).toBe("8644");
  });

  it("accepts an explicit value that matches the registered port", () => {
    const env = { [HERMES_API_PORT_ENV]: "8643" };

    expect(
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => ({ hermesApiPort: 8643 }),
      }),
    ).toBe(8643);
  });

  it("keeps a registered sandbox without a port on the default instead of allocating", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => ({}),
      }),
    ).toBe(8642);
    expect(env[HERMES_API_PORT_ENV]).toBe("8642");
  });

  it("requires typed observation before selecting for a route-only reservation (#9291)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() =>
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => ({ pendingRouteReservation: true }),
      }),
    ).toThrow(/must be reserved from typed OpenShell forward observations/);
    expect(env[HERMES_API_PORT_ENV]).toBeUndefined();
  });

  it("prefers the registered port over a fresh allocation", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => ({ hermesApiPort: 8643 }),
      }),
    ).toBe(8643);
    expect(env[HERMES_API_PORT_ENV]).toBe("8643");
  });

  it("uses the fresh typed reservation published for later consumers", () => {
    const env: NodeJS.ProcessEnv = { [HERMES_API_PORT_ENV]: "8644" };
    expect(
      resolveOnboardHermesApiPort("beta", {
        env,
        getSandbox: () => undefined,
      }),
    ).toBe(8644);
    expect(env[HERMES_API_PORT_ENV]).toBe("8644");
  });
});

describe("resolveSandboxHermesApiPort", () => {
  it("keeps the default for a sandbox registered without a port", () => {
    expect(resolveSandboxHermesApiPort({})).toBe(8642);
  });

  it("uses the registered port", () => {
    expect(resolveSandboxHermesApiPort({ hermesApiPort: 8645 })).toBe(8645);
  });
});

describe("retargetHermesApiPortInUrl", () => {
  it("retargets a manifest URL at the sandbox's own port", () => {
    expect(retargetHermesApiPortInUrl("http://localhost:8642/health", 8643)).toBe(
      "http://localhost:8643/health",
    );
  });

  it("leaves a URL that names another port alone", () => {
    expect(retargetHermesApiPortInUrl("http://localhost:18789/health", 8643)).toBe(
      "http://localhost:18789/health",
    );
  });

  it("leaves the URL alone for a sandbox on the default port", () => {
    expect(retargetHermesApiPortInUrl("http://localhost:8642/health", 8642)).toBe(
      "http://localhost:8642/health",
    );
  });
});

describe("resolveVerifyAgentApiPort (#9290)", () => {
  const hermes = { name: "hermes", healthProbe: { port: 8642 } };

  it("targets the port this Hermes sandbox actually owns", () => {
    // A second Hermes sandbox serves its API on a reallocated port; probing the
    // manifest default would report a sibling sandbox's port as unreachable.
    expect(
      resolveVerifyAgentApiPort("second", hermes, { getSandbox: () => ({ hermesApiPort: 8643 }) }),
    ).toBe(8643);
  });

  it("falls back to the manifest default when the sandbox is not registered yet", () => {
    expect(resolveVerifyAgentApiPort("fresh", hermes, { getSandbox: () => null })).toBe(8642);
  });

  it("keeps a non-Hermes agent's declared probe port", () => {
    expect(
      resolveVerifyAgentApiPort(
        "sb",
        { name: "other", healthProbe: { port: 9000 } },
        {
          getSandbox: () => ({ hermesApiPort: 8643 }),
        },
      ),
    ).toBe(9000);
  });

  it("returns undefined when the agent declares no health probe port", () => {
    expect(resolveVerifyAgentApiPort("sb", { name: "openclaw" }, { getSandbox: () => null })).toBe(
      undefined,
    );
    expect(resolveVerifyAgentApiPort("sb", null, { getSandbox: () => null })).toBe(undefined);
  });
});
