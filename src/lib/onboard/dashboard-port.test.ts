// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  OpenShellForwardAdapter,
  OpenShellForwardObservation,
} from "../adapters/openshell/forward";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import {
  createOpenShellForwardPortObserver,
  createDashboardPortScopedSandboxEntryPoints,
  type DashboardPortReservationScope,
  findAvailableDashboardPortFromObservations,
  getRegistryOccupiedDashboardPorts,
  hasExplicitDashboardPortOverride,
  preflightDashboardPortRangeAvailability,
  reserveCreateSandboxDashboardPort,
  reserveDashboardPort,
  reservePortAfterOwnedForwardDelete,
  resolveCreateSandboxDashboardPortFromObservations,
  withDashboardPortReservationLock,
  withDashboardPortReservationScope,
} from "./dashboard-port";

describe("dashboard-port override intent", () => {
  it.each([
    [undefined, false],
    ["", false],
    [" \t ", false],
    ["18789", true],
    [" 18789 ", true],
  ] as const)("classifies %j as explicit=%s", (value, expected) => {
    expect(hasExplicitDashboardPortOverride(value)).toBe(expected);
  });
});

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

async function listenOnLoopback(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenAndCloseOnLoopback(port: number): Promise<void> {
  const server = await listenOnLoopback(port);
  await closeServer(server);
}

async function unusedLoopbackPort(): Promise<number> {
  const server = await listenOnLoopback(0);
  const address = server.address();
  assert.ok(
    address && typeof address !== "string",
    "loopback listener did not report a TCP address",
  );
  await closeServer(server);
  return address.port;
}

describe("typed OpenShell dashboard-port observation", () => {
  it("binds an exact identity factory to one read-only adapter request", async () => {
    const observeForwards = vi.fn<OpenShellForwardAdapter["observeForwards"]>(
      async ({ forwards }) => forwards.map((forward) => ({ state: "absent" as const, forward })),
    );
    const observer = createOpenShellForwardPortObserver({
      adapter: { observeForwards },
      forwardForPort: (port) => ({
        gatewayEndpoint: "https://127.0.0.1:9090",
        gatewayName: "nemoclaw-9090",
        workspace: "default",
        sandboxName: "cursor",
        localHost: "0.0.0.0",
        port,
      }),
    });

    await expect(observer([18789, 18790])).resolves.toEqual([
      {
        state: "absent",
        forward: {
          gatewayEndpoint: "https://127.0.0.1:9090",
          gatewayName: "nemoclaw-9090",
          workspace: "default",
          sandboxName: "cursor",
          localHost: "0.0.0.0",
          port: 18789,
        },
      },
      {
        state: "absent",
        forward: {
          gatewayEndpoint: "https://127.0.0.1:9090",
          gatewayName: "nemoclaw-9090",
          workspace: "default",
          sandboxName: "cursor",
          localHost: "0.0.0.0",
          port: 18790,
        },
      },
    ]);
    expect(observeForwards).toHaveBeenCalledOnce();
  });

  it.each(["owned", "stale"] as const)("reuses an exact %s forward", (state) => {
    expect(
      findAvailableDashboardPortFromObservations("cursor", 18789, [
        forwardObservation("cursor", 18789, state),
      ]),
    ).toBe(18789);
  });

  it("skips a preferred port with foreign ownership", () => {
    expect(
      findAvailableDashboardPortFromObservations("cursor", 18789, [
        forwardObservation("cursor", 18789, "foreign"),
        forwardObservation("cursor", 18790, "absent"),
      ]),
    ).toBe(18790);
  });

  it("blocks allocation when ownership is indeterminate", () => {
    expect(() =>
      findAvailableDashboardPortFromObservations("cursor", 18789, [
        forwardObservation("cursor", 18789, "indeterminate"),
        forwardObservation("cursor", 18790, "absent"),
      ]),
    ).toThrow(/could not prove OpenShell forward ownership/i);
  });

  it("treats missing observations as unverified instead of absent", () => {
    expect(() => findAvailableDashboardPortFromObservations("cursor", 18789, [])).toThrow(
      /unverified OpenShell forward ownership/,
    );
  });

  it("rejects an adapter response that does not match its requested identities", async () => {
    const observer = createOpenShellForwardPortObserver({
      adapter: {
        observeForwards: async () => [forwardObservation("other", 18789, "absent")],
      },
      forwardForPort: (port) => ({
        gatewayEndpoint: "https://127.0.0.1:9090",
        gatewayName: "nemoclaw-9090",
        workspace: "default",
        sandboxName: "cursor",
        localHost: "127.0.0.1",
        port,
      }),
    });

    await expect(observer([18789])).rejects.toThrow(/incomplete forward ownership evidence/);
  });
});

describe("resolveCreateSandboxDashboardPortFromObservations", () => {
  it("lets --control-ui-port override CHAT_UI_URL, registry, agent, and default ports", () => {
    let preferredSeen: number | null = null;
    const result = resolveCreateSandboxDashboardPortFromObservations({
      sandboxName: "cursor",
      controlUiPort: 19000,
      chatUiUrlEnv: "http://127.0.0.1:18790",
      persistedPort: 18791,
      agentForwardPort: 18792,
      defaultPort: 18793,
      forwardObservations: [],
      findAvailablePort: (_sandboxName, preferredPort) => {
        preferredSeen = preferredPort;
        return preferredPort;
      },
    });

    assert.equal(preferredSeen, 19000);
    assert.equal(result.preferredPort, 19000);
    assert.equal(result.effectivePort, 19000);
    assert.equal(result.chatUiUrl, "http://127.0.0.1:19000");
  });

  it("uses CHAT_UI_URL port before registry and rewrites the URL to the allocated port", () => {
    const warnings: string[] = [];
    const result = resolveCreateSandboxDashboardPortFromObservations({
      sandboxName: "cursor",
      controlUiPort: null,
      chatUiUrlEnv: "https://chat.example.test:18790/ui/",
      persistedPort: 18791,
      agentForwardPort: 18792,
      defaultPort: 18793,
      forwardObservations: [],
      findAvailablePort: (sandboxName, preferredPort, forwardObservations) => {
        assert.equal(sandboxName, "cursor");
        assert.equal(preferredPort, 18790);
        assert.deepEqual(forwardObservations, []);
        return 18794;
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(result.preferredPort, 18790);
    assert.equal(result.effectivePort, 18794);
    assert.equal(result.chatUiUrl, "https://chat.example.test:18794/ui");
    assert.deepEqual(warnings, ["  ! Port 18790 is taken. Using port 18794 instead."]);
  });

  it("falls back through registry, agent, and default ports", () => {
    const preferredPorts: number[] = [];
    const resolve = (persistedPort: number | null, agentForwardPort: number | null | undefined) =>
      resolveCreateSandboxDashboardPortFromObservations({
        sandboxName: "cursor",
        controlUiPort: null,
        chatUiUrlEnv: null,
        persistedPort,
        agentForwardPort,
        defaultPort: 18793,
        forwardObservations: [],
        findAvailablePort: (_sandboxName, preferredPort) => {
          preferredPorts.push(preferredPort);
          return preferredPort;
        },
      });

    assert.equal(resolve(18791, 18792).preferredPort, 18791);
    assert.equal(resolve(null, 18792).preferredPort, 18792);
    assert.equal(resolve(null, null).preferredPort, 18793);
    assert.deepEqual(preferredPorts, [18791, 18792, 18793]);
  });

  it("normalizes schemeless CHAT_UI_URL values before preserving their host", () => {
    const result = resolveCreateSandboxDashboardPortFromObservations({
      sandboxName: "cursor",
      controlUiPort: null,
      chatUiUrlEnv: "remote.example.test:18790",
      persistedPort: null,
      agentForwardPort: null,
      defaultPort: 18789,
      forwardObservations: [],
      findAvailablePort: (_sandboxName, preferredPort) => preferredPort,
    });

    assert.equal(result.preferredPort, 18790);
    assert.equal(result.chatUiUrl, "http://remote.example.test:18790");
  });

  it("ignores malformed CHAT_UI_URL when rewriting the dashboard URL", () => {
    const result = resolveCreateSandboxDashboardPortFromObservations({
      sandboxName: "cursor",
      controlUiPort: null,
      chatUiUrlEnv: "https://example.test:abc",
      persistedPort: 18791,
      agentForwardPort: null,
      defaultPort: 18789,
      forwardObservations: [],
      findAvailablePort: (_sandboxName, preferredPort) => preferredPort,
    });

    assert.equal(result.preferredPort, 18791);
    assert.equal(result.chatUiUrl, "http://127.0.0.1:18791");
  });

  it("ignores malformed CHAT_UI_URL when --control-ui-port supplies the URL", () => {
    const result = resolveCreateSandboxDashboardPortFromObservations({
      sandboxName: "cursor",
      controlUiPort: 19000,
      chatUiUrlEnv: "https://example.test:abc",
      persistedPort: 18791,
      agentForwardPort: null,
      defaultPort: 18789,
      forwardObservations: [],
      findAvailablePort: (_sandboxName, preferredPort) => preferredPort,
    });

    assert.equal(result.preferredPort, 19000);
    assert.equal(result.chatUiUrl, "http://127.0.0.1:19000");
  });
});

describe("dashboard port reservation", () => {
  it("scopes sandbox creation and distinguishes the temporary runtime path", async () => {
    const events: string[] = [];
    const createSandboxWithBaseImageResolution = vi.fn(
      async (
        baseImageResolutionContext: { fresh: boolean },
        portableRuntimeAuthority: { socketPath: string } | null,
        computePlan: { sequence: number },
        managedWorkloadRebuild: null,
        temporaryManagedRuntime: boolean,
        temporaryManagedRuntimeCatalog: null,
        dashboardPortReservationScope: DashboardPortReservationScope,
        sandboxName: string,
      ) => {
        events.push("create sandbox");
        return {
          baseImageResolutionContext,
          portableRuntimeAuthority,
          computePlan,
          managedWorkloadRebuild,
          temporaryManagedRuntime,
          temporaryManagedRuntimeCatalog,
          dashboardPortReservationScope,
          sandboxName,
        };
      },
    );
    let sequence = 0;
    const entryPoints = createDashboardPortScopedSandboxEntryPoints({
      createBaseImageResolutionContext: () => {
        events.push("create base-image context");
        return { fresh: false };
      },
      createSandboxWithBaseImageResolution,
      resolvePortableRuntimeContext: () => ({ socketPath: "/run/user/1001/podman.sock" }),
      resolveComputePlan: () => {
        events.push("resolve compute plan");
        return { sequence: ++sequence };
      },
    });

    await expect(entryPoints.createSandbox("standard")).resolves.toMatchObject({
      baseImageResolutionContext: { fresh: false },
      portableRuntimeAuthority: { socketPath: "/run/user/1001/podman.sock" },
      computePlan: { sequence: 1 },
      managedWorkloadRebuild: null,
      temporaryManagedRuntime: false,
      temporaryManagedRuntimeCatalog: null,
      dashboardPortReservationScope: { current: null, release: expect.any(Function) },
      sandboxName: "standard",
    });
    await expect(
      entryPoints.createSandboxWithTemporaryManagedRuntime("temporary"),
    ).resolves.toMatchObject({
      baseImageResolutionContext: { fresh: false },
      portableRuntimeAuthority: { socketPath: "/run/user/1001/podman.sock" },
      computePlan: { sequence: 2 },
      managedWorkloadRebuild: null,
      temporaryManagedRuntime: true,
      temporaryManagedRuntimeCatalog: null,
      dashboardPortReservationScope: { current: null, release: expect.any(Function) },
      sandboxName: "temporary",
    });
    expect(createSandboxWithBaseImageResolution).toHaveBeenCalledTimes(2);
    expect(createSandboxWithBaseImageResolution.mock.calls[0]?.[6]).not.toBe(
      createSandboxWithBaseImageResolution.mock.calls[1]?.[6],
    );
    expect(events).toEqual([
      "resolve compute plan",
      "create base-image context",
      "create sandbox",
      "resolve compute plan",
      "create base-image context",
      "create sandbox",
    ]);
  });

  it("rejects both entry-point promises when synchronous setup fails", async () => {
    const setupFailure = new Error("compute plan unavailable");
    const entryPoints = createDashboardPortScopedSandboxEntryPoints<
      [string],
      string,
      { fresh: boolean },
      null,
      { sequence: number }
    >({
      createBaseImageResolutionContext: () => ({ fresh: false }),
      createSandboxWithBaseImageResolution: async () => "unreachable",
      resolvePortableRuntimeContext: () => null,
      resolveComputePlan: () => {
        throw setupFailure;
      },
    });

    const standard = entryPoints.createSandbox("standard");
    const temporary = entryPoints.createSandboxWithTemporaryManagedRuntime("temporary");

    await expect(standard).rejects.toBe(setupFailure);
    await expect(temporary).rejects.toBe(setupFailure);
  });

  it("holds the selected port during creation and releases it after failure (#8798)", async () => {
    const port = await unusedLoopbackPort();

    await assert.rejects(
      withDashboardPortReservationScope(async (scope) => {
        scope.current = await reserveDashboardPort(port);
        await assert.rejects(
          listenAndCloseOnLoopback(port),
          (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
        );
        throw new Error("sandbox build failed");
      }),
      /sandbox build failed/,
    );

    const listener = await listenOnLoopback(port);
    await closeServer(listener);
  });

  it("releases the selected port when finalization calls the extracted scope callback (#9568)", async () => {
    const port = await unusedLoopbackPort();

    await withDashboardPortReservationScope(async (scope) => {
      scope.current = await reserveDashboardPort(port);
      await assert.rejects(
        listenAndCloseOnLoopback(port),
        (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
      );

      const finalizationDashboard = { releasePort: scope.release };
      await finalizationDashboard.releasePort();

      assert.equal(scope.current, null);
      const listener = await listenOnLoopback(port);
      try {
        assert.equal(listener.listening, true);
      } finally {
        await closeServer(listener);
      }
    });
  });

  it("reselects before sandbox creation when a listener wins the allocation race (#8798)", async () => {
    const attempts: number[] = [];
    const warnings: string[] = [];
    const released: number[] = [];
    const result = await reserveCreateSandboxDashboardPort(
      {
        sandboxName: "cursor",
        controlUiPort: null,
        chatUiUrlEnv: null,
        persistedPort: null,
        agentForwardPort: null,
        defaultPort: 18789,
        observeForwardPorts: observePorts("cursor"),
        registryOccupiedPorts: new Map(),
        findAvailablePort: (_sandboxName, preferredPort, _observations, occupied) =>
          occupied?.has(String(preferredPort)) ? 18790 : preferredPort,
        warn: (message) => warnings.push(message),
      },
      async (port) => {
        const attempt = attempts.length;
        attempts.push(port);
        return attempt === 0
          ? Promise.reject(Object.assign(new Error("address in use"), { code: "EADDRINUSE" }))
          : Promise.resolve({
              port,
              release: async () => {
                released.push(port);
              },
            });
      },
    );

    assert.deepEqual(attempts, [18789, 18790]);
    assert.equal(result.effectivePort, 18790);
    assert.equal(result.chatUiUrl, "http://127.0.0.1:18790");
    assert.deepEqual(warnings, ["  ! Port 18789 is taken. Using port 18790 instead."]);
    await result.reservation?.release();
    assert.deepEqual(released, [18790]);
  });

  it("defers a persisted port reservation only for the exact owned forward", async () => {
    const reservePort = vi.fn();
    const observeForwardPorts = observePorts("cursor", new Map([[18789, "owned"]]));

    const result = await reserveCreateSandboxDashboardPort(
      {
        sandboxName: "cursor",
        controlUiPort: null,
        chatUiUrlEnv: null,
        persistedPort: 18789,
        agentForwardPort: null,
        observeForwardPorts,
        registryOccupiedPorts: new Map(),
      },
      reservePort,
    );

    expect(result).toMatchObject({
      effectivePort: 18789,
      preferredPort: 18789,
      reservation: null,
    });
    expect(observeForwardPorts).toHaveBeenCalledOnce();
    expect(reservePort).not.toHaveBeenCalled();
  });

  it("retries only EADDRINUSE while an owned forward listener retires", async () => {
    const release = vi.fn(async () => undefined);
    const reservePort = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("still bound"), { code: "EADDRINUSE" }))
      .mockRejectedValueOnce(Object.assign(new Error("still bound"), { code: "EADDRINUSE" }))
      .mockResolvedValueOnce({ port: 18789, release });
    const sleep = vi.fn();

    const reservation = await reservePortAfterOwnedForwardDelete(18789, {
      reservePort,
      sleep,
    });

    expect(reservation.port).toBe(18789);
    expect(reservePort.mock.calls).toEqual([[18789], [18789], [18789]]);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    await reservation.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not retry a non-collision reservation failure", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const reservePort = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn();

    await expect(reservePortAfterOwnedForwardDelete(18789, { reservePort, sleep })).rejects.toBe(
      failure,
    );
    expect(reservePort).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rebinds only a dashboard port deferred for an owned forward", async () => {
    const release = vi.fn(async () => undefined);
    const reservePort = vi.fn(async (port: number) => ({ port, release }));

    await withDashboardPortReservationScope(async (scope) => {
      scope.deferOwnedForwardPort(18789);
      await scope.rebindAfterOwnedForwardDelete({ reservePort, sleep: vi.fn() });
      expect(scope.current?.port).toBe(18789);
    });

    expect(reservePort).toHaveBeenCalledExactlyOnceWith(18789);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("typed dashboard-port multi-gateway registry occupancy", () => {
  it("treats ports persisted to sibling sandboxes in the registry as occupied", () => {
    const registryOccupied = new Map<string, string>([["18789", "instance-a"]]);

    assert.equal(
      findAvailableDashboardPortFromObservations(
        "instance-b",
        18789,
        [
          forwardObservation("instance-b", 18789, "absent"),
          forwardObservation("instance-b", 18790, "absent"),
        ],
        registryOccupied,
      ),
      18790,
    );
  });

  it("does not block the current sandbox from reusing its own registry-persisted port", () => {
    const registryOccupied = new Map<string, string>([["18789", "instance-a"]]);

    assert.equal(
      findAvailableDashboardPortFromObservations(
        "instance-a",
        18789,
        [forwardObservation("instance-a", 18789, "owned")],
        registryOccupied,
      ),
      18789,
    );
  });

  it("ignores registry entries with null or invalid dashboard ports", () => {
    const noPorts = new Map<string, string>();

    assert.equal(
      findAvailableDashboardPortFromObservations(
        "instance-b",
        18789,
        [forwardObservation("instance-b", 18789, "absent")],
        noPorts,
      ),
      18789,
    );
  });

  it("includes registry-owned ports in the exhaustion error so the operator can see who holds them", () => {
    const registryOccupied = new Map<string, string>();
    const observations: OpenShellForwardObservation[] = [];
    for (let port = 18789; port <= 18799; port += 1) {
      registryOccupied.set(String(port), port === 18799 ? "instance-z" : `instance-${port}`);
      observations.push(forwardObservation("instance-y", port, "absent"));
    }

    assert.throws(
      () =>
        findAvailableDashboardPortFromObservations(
          "instance-y",
          18789,
          observations,
          registryOccupied,
        ),
      /18799 → instance-z/,
    );
  });
});

describe("getRegistryOccupiedDashboardPorts", () => {
  it("aggregates a sibling gateway registry when host bind probes report the port free", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-host-index-"));
    try {
      vi.stubEnv("HOME", home);
      const defaultRoot = path.join(home, ".nemoclaw");
      const siblingRoot = path.join(defaultRoot, "gateways", "9123");
      fs.mkdirSync(siblingRoot, { recursive: true });
      fs.writeFileSync(
        path.join(defaultRoot, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "instance-b",
          sandboxes: {
            "instance-b": {
              name: "instance-b",
              gatewayName: "nemoclaw",
              gatewayPort: 8080,
              dashboardPort: 18790,
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(siblingRoot, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "instance-a",
          sandboxes: {
            "instance-a": {
              name: "instance-a",
              gatewayName: "nemoclaw-9123",
              gatewayPort: 9123,
              dashboardPort: 18789,
            },
          },
        }),
      );

      const occupied = getRegistryOccupiedDashboardPorts("instance-b");
      assert.equal(occupied.get("18789"), "instance-a (gateway 9123)");
      assert.equal(
        findAvailableDashboardPortFromObservations(
          "instance-b",
          18789,
          [
            forwardObservation("instance-b", 18789, "absent"),
            forwardObservation("instance-b", 18790, "absent"),
          ],
          occupied,
        ),
        18790,
      );
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns a port→sandbox map for every sibling sandbox with a persisted dashboard port", () => {
    const occupied = getRegistryOccupiedDashboardPorts("current", () => ({
      sandboxes: [
        { name: "alpha", dashboardPort: 18789 },
        { name: "beta", dashboardPort: 18790 },
        { name: "current", dashboardPort: 18791 },
      ],
    }));

    assert.equal(occupied.size, 2);
    assert.equal(occupied.get("18789"), "alpha");
    assert.equal(occupied.get("18790"), "beta");
    assert.equal(occupied.has("18791"), false);
  });

  it("skips sandboxes with null, undefined, or non-numeric dashboardPort values", () => {
    const occupied = getRegistryOccupiedDashboardPorts("current", () => ({
      sandboxes: [
        { name: "alpha", dashboardPort: null },
        { name: "beta", dashboardPort: undefined },
        { name: "gamma" },
        { name: "delta", dashboardPort: 18790 },
      ],
    }));

    assert.equal(occupied.size, 1);
    assert.equal(occupied.get("18790"), "delta");
  });

  it("propagates registry read errors so the allocator does not silently hand out a colliding port", () => {
    assert.throws(
      () =>
        getRegistryOccupiedDashboardPorts("current", () => {
          throw new Error("registry locked");
        }),
      /registry locked/,
    );
  });
});

describe("dashboard port reservation lock", () => {
  it("serializes onboard and restore ownership across different gateways", async () => {
    const stateDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "nemoclaw-dashboard-port-lock-"),
    );
    let releaseOnboard!: () => void;
    const onboardReleased = new Promise<void>((resolve) => {
      releaseOnboard = resolve;
    });
    let reportOnboardEntered!: () => void;
    const onboardEntered = new Promise<void>((resolve) => {
      reportOnboardEntered = resolve;
    });
    const events: string[] = [];
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      const onboard = withDashboardPortReservationLock(
        () =>
          withGatewayRouteMutationLock(
            "gateway-a",
            async () => {
              events.push("onboard-gateway-a-select");
              reportOnboardEntered();
              await onboardReleased;
              events.push("onboard-gateway-a-register");
            },
            options,
          ),
        options,
      );
      await onboardEntered;
      const restore = withDashboardPortReservationLock(
        () =>
          withGatewayRouteMutationLock(
            "gateway-b",
            () => {
              events.push("restore-gateway-b-select");
              events.push("restore-gateway-b-register");
            },
            options,
          ),
        options,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(events, ["onboard-gateway-a-select"]);
      releaseOnboard();
      await Promise.all([onboard, restore]);
      assert.deepEqual(events, [
        "onboard-gateway-a-select",
        "onboard-gateway-a-register",
        "restore-gateway-b-select",
        "restore-gateway-b-register",
      ]);
    } finally {
      releaseOnboard();
      await fsPromises.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("releases a failed reservation so the next allocator can proceed", async () => {
    const stateDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "nemoclaw-dashboard-port-lock-"),
    );
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      await assert.rejects(
        withDashboardPortReservationLock(() => {
          throw new Error("onboard allocation failed");
        }, options),
        /onboard allocation failed/,
      );
      assert.equal(
        await withDashboardPortReservationLock(() => "restore acquired", options),
        "restore acquired",
      );
    } finally {
      await fsPromises.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("preflightDashboardPortRangeAvailability (#3953)", () => {
  const allBound = (_p: number) => true;
  const noneBound = (_p: number) => false;
  const someBound = (...bound: number[]) => {
    const set = new Set(bound);
    return (p: number) => set.has(p);
  };

  it("exits 1 with the canonical message when every port in the range is bound", () => {
    let exitCode: number | undefined;
    const exitFn = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code ?? 0}__`);
    }) as (code?: number) => never;
    const stderrChunks: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => {
      stderrChunks.push(msg);
    };
    try {
      assert.throws(() => preflightDashboardPortRangeAvailability(allBound, exitFn), /__exit_1__/);
    } finally {
      console.error = origError;
    }
    assert.equal(exitCode, 1);
    const combined = stderrChunks.join("\n");
    assert.match(combined, /All dashboard ports in range 18789-18799 are occupied:/);
    assert.match(combined, /  18789 → non-OpenShell host listener/);
    assert.match(combined, /  18799 → non-OpenShell host listener/);
    assert.match(combined, /--control-ui-port <N>/);
  });

  it("returns without exiting when at least one port in the range is free", () => {
    // Even if 10 of 11 ports are bound, the one free port short-circuits success.
    const bound = someBound(18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796, 18797, 18798);
    preflightDashboardPortRangeAvailability(bound, (() => {
      throw new Error("exitFn must not be called when a port is free");
    }) as (code?: number) => never);
  });

  it("returns without exiting when no port is bound", () => {
    preflightDashboardPortRangeAvailability(noneBound, (() => {
      throw new Error("exitFn must not be called when no port is bound");
    }) as (code?: number) => never);
  });
});
