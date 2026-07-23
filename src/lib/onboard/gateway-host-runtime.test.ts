// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayHostRuntime, type GatewayHostRuntimeDeps } from "./gateway-host-runtime";
import { GATEWAY_MANAGEMENT_ENV_VAR } from "./gateway-management";
import { evaluateGatewayAttachment } from "./gateway-ownership";
import type { PortProbeResult } from "./preflight";

// Intentionally does not match the legacy OpenShell process-name allowlist.
// A declared external owner may use any absolute executable path; exact
// downstream attachment validation, not its basename, establishes identity.
const SYSTEMD_GATEWAY_EXEC = "/opt/platform/gatewayd";
const SYSTEMD_GATEWAY_PID = 4242;

const DECLARATION = {
  version: 1,
  mode: "externally-supervised",
  endpoint: "http://127.0.0.1:8080",
  stateDir: "/var/lib/openshell/gateway",
  supervisor: {
    kind: "systemd-system",
    serviceName: "openshell-gateway.service",
    execPath: SYSTEMD_GATEWAY_EXEC,
  },
  requiredCapabilities: ["gateway.health"],
};

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

/** The port is held, so the independent port probe reports it as unavailable. */
const OCCUPIED_PORT: PortProbeResult = { ok: false } as PortProbeResult;

function createDeps(overrides: Partial<GatewayHostRuntimeDeps> = {}): GatewayHostRuntimeDeps {
  return {
    applyOverlayfsAutoFix: () => null,
    checkGatewayPortAvailable: async () => OCCUPIED_PORT,
    gatewayName: () => "nemoclaw",
    gatewayPort: () => 8080,
    // A systemd-supervised gateway is an ordinary executable: the Docker-driver
    // filtered scan would return no pids at all, which is why the probe must use
    // the raw enumeration.
    getGatewayPortListenerRawScan: () => ({ pids: [SYSTEMD_GATEWAY_PID], complete: true }),
    getInstalledOpenshellVersion: () => "0.0.72",
    isGatewayHealthy: () => true,
    runCaptureOpenshell: () => "healthy",
    runOpenshell: () => ({ status: 0 }),
    resolveOpenShellGatewayBinary: () => SYSTEMD_GATEWAY_EXEC,
    spawnSyncImpl: (() => ({ status: 0, stdout: "active\n", stderr: "" })) as never,
    probeGatewayHttpReady: async () => true,
    // Realistic /proc content for the declared systemd listener, so the probe
    // produces listenerExecPath and listenerSupervisorMatch itself rather than a
    // test overwriting them.
    readProcExe: () => SYSTEMD_GATEWAY_EXEC,
    readProcCgroup: () => `0::/system.slice/${DECLARATION.supervisor.serviceName}\n`,
    readProcStartTime: () => "710024",
    waitForGatewayHttpReady: async () => true,
    ...overrides,
  };
}

function declareExternalSupervision(declaration: unknown = DECLARATION) {
  process.env[GATEWAY_MANAGEMENT_ENV_VAR] = "/etc/nemoclaw/gateway-management.json";
  vi.spyOn(require("node:fs") as typeof import("node:fs"), "readFileSync").mockReturnValue(
    JSON.stringify(declaration) as never,
  );
}

describe("gateway host runtime ownership", () => {
  it("resolves the declared external supervisor as the lifecycle owner (#6576)", () => {
    declareExternalSupervision();

    expect(createGatewayHostRuntime(createDeps()).getGatewayOwner()).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "externally-supervised",
      source: "declared",
      supervisor: { serviceName: "openshell-gateway.service" },
    });
  });

  it("refuses to start a gateway the declared supervisor owns (#6576)", () => {
    declareExternalSupervision();

    expect(() => createGatewayHostRuntime(createDeps()).assertGatewayStartAllowed(false)).toThrow(
      /openshell-gateway\.service/,
    );
  });

  it("binds a recovery guard to its explicit gateway target (#6576)", () => {
    const runtime = createGatewayHostRuntime(createDeps());

    runtime.assertGatewayStartAllowed(false, {
      gatewayName: "nemoclaw-8090",
      gatewayPort: 8090,
    });

    expect(() => runtime.getGatewayOwner()).toThrow(/authority changed during this run/);
  });

  it("fails closed on a malformed declaration rather than self-managing (#6576)", () => {
    declareExternalSupervision({ ...DECLARATION, version: 99 });

    expect(() => createGatewayHostRuntime(createDeps()).getGatewayOwner()).toThrow(
      /Invalid gateway management declaration/,
    );
  });

  it("fails closed on unsupported capabilities before probing an external listener (#6576)", () => {
    declareExternalSupervision({
      ...DECLARATION,
      requiredCapabilities: ["gateway.teleport"],
    });
    const checkGatewayPortAvailable = vi.fn().mockResolvedValue(OCCUPIED_PORT);
    const runtime = createGatewayHostRuntime(createDeps({ checkGatewayPortAvailable }));

    expect(() => runtime.getGatewayOwner()).toThrow(/unsupported capability/);
    expect(checkGatewayPortAvailable).not.toHaveBeenCalled();
  });

  it("binds one authority for the run and returns it on later calls (#6576)", () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(createDeps());

    const first = runtime.getGatewayOwner();
    const second = runtime.getGatewayOwner();

    expect(first).toMatchObject({ mode: "externally-supervised" });
    expect(second).toEqual(first);
  });

  it("allows capability reordering but fails closed when required capabilities drift (#6576)", () => {
    process.env[GATEWAY_MANAGEMENT_ENV_VAR] = "/etc/nemoclaw/gateway-management.json";
    let requiredCapabilities = ["sandbox.create", "gateway.health"];
    vi.spyOn(require("node:fs") as typeof import("node:fs"), "readFileSync").mockImplementation(
      () => JSON.stringify({ ...DECLARATION, requiredCapabilities }) as never,
    );
    const runtime = createGatewayHostRuntime(createDeps());

    const first = runtime.getGatewayOwner();
    requiredCapabilities = ["gateway.health", "sandbox.create", "sandbox.create"];

    expect(runtime.getGatewayOwner()).toEqual(first);

    requiredCapabilities = ["gpu.passthrough"];
    expect(() => runtime.getGatewayOwner()).toThrow(/authority changed during this run/);
  });

  it("fails closed when the authority would change mid-run instead of switching (#6576)", () => {
    const runtime = createGatewayHostRuntime(createDeps());
    expect(runtime.getGatewayOwner()).toMatchObject({ mode: "nemoclaw-managed" });

    // The declaration appears after the owner was already bound: silently
    // adopting it would open a check/use gap between preflight and the FSM.
    declareExternalSupervision();

    expect(() => runtime.getGatewayOwner()).toThrow(/authority changed during this run/);
  });
});

describe("gateway host runtime attachment probe", () => {
  it("rejects a mismatched endpoint port before any host or HTTP probe (#6576)", async () => {
    declareExternalSupervision({
      ...DECLARATION,
      endpoint: "http://127.0.0.1:9443",
    });
    const checkGatewayPortAvailable = vi.fn().mockResolvedValue(OCCUPIED_PORT);
    const probeGatewayHttpReady = vi.fn().mockResolvedValue(true);
    const getGatewayPortListenerRawScan = vi.fn(() => ({
      pids: [SYSTEMD_GATEWAY_PID],
      complete: true,
    }));
    const runtime = createGatewayHostRuntime(
      createDeps({
        checkGatewayPortAvailable,
        getGatewayPortListenerRawScan,
        probeGatewayHttpReady,
      }),
    );
    const owner = runtime.getGatewayOwner();

    await expect(runtime.probeGatewayAttachment(owner)).rejects.toMatchObject({
      code: "endpoint_port_mismatch",
    });
    expect(checkGatewayPortAvailable).not.toHaveBeenCalled();
    expect(probeGatewayHttpReady).not.toHaveBeenCalled();
    expect(getGatewayPortListenerRawScan).not.toHaveBeenCalled();
  });

  it("attaches to a real systemd-supervised gateway listener (#6576)", async () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(createDeps());
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    // The declared systemd process carries no Docker-driver markers, so it must
    // still be enumerated, resolved to its executable, and bound to the unit's
    // cgroup — all produced by the probe, then evaluated without overwriting.
    expect(probe).toMatchObject({
      gatewayPort: 8080,
      httpReady: true,
      portOccupied: true,
      listenerPids: [SYSTEMD_GATEWAY_PID],
      listenerScanComplete: true,
      listenerStartTime: "710024",
      supervisorActive: true,
      listenerExecPath: SYSTEMD_GATEWAY_EXEC,
      listenerSupervisorMatch: true,
    });
    expect(evaluateGatewayAttachment(owner, probe)).toMatchObject({ ok: true });
  });

  it("rejects a same-binary listener outside the declared unit's cgroup (#6576)", async () => {
    declareExternalSupervision();
    // Same executable, answering health, supervisor active — but the PID lives
    // in a login session scope, not the unit. Exec-path match alone would accept
    // it; cgroup binding must not.
    const runtime = createGatewayHostRuntime(
      createDeps({
        readProcCgroup: () => "0::/user.slice/user-1000.slice/session-7.scope\n",
      }),
    );
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerExecPath).toBe(SYSTEMD_GATEWAY_EXEC);
    expect(probe.listenerSupervisorMatch).toBe(false);
    expect(evaluateGatewayAttachment(owner, probe)).toMatchObject({
      ok: false,
      code: "identity_mismatch",
    });
  });

  it("rejects a same-named user unit when the system manager is declared (#6576)", async () => {
    declareExternalSupervision();
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(
      createDeps({
        readProcCgroup: () =>
          `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${DECLARATION.supervisor.serviceName}\n`,
        runOpenshell,
      }),
    );
    const owner = runtime.getGatewayOwner();
    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerSupervisorMatch).toBe(false);
    await expect(runtime.attachGateway(owner, probe)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a same-named system unit when the user manager is declared (#6576)", async () => {
    declareExternalSupervision({
      ...DECLARATION,
      supervisor: { ...DECLARATION.supervisor, kind: "systemd-user" },
    });
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(
      createDeps({
        readProcCgroup: () => `0::/system.slice/${DECLARATION.supervisor.serviceName}\n`,
        runOpenshell,
      }),
    );
    const owner = runtime.getGatewayOwner();
    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerSupervisorMatch).toBe(false);
    await expect(runtime.attachGateway(owner, probe)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a listener whose executable differs from the arbitrary declared path (#6576)", async () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(
      createDeps({ readProcExe: () => "/opt/platform/impostor-gateway" }),
    );
    const owner = runtime.getGatewayOwner();

    expect(
      evaluateGatewayAttachment(owner, await runtime.probeGatewayAttachment(owner)),
    ).toMatchObject({ ok: false, code: "identity_mismatch" });
  });

  it("rejects an exact external listener that fails the declared health probe (#6576)", async () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(
      createDeps({ probeGatewayHttpReady: async () => false }),
    );
    const owner = runtime.getGatewayOwner();

    expect(
      evaluateGatewayAttachment(owner, await runtime.probeGatewayAttachment(owner)),
    ).toMatchObject({ ok: false, code: "gateway_unreachable" });
  });

  it("fails closed when the listener cgroup cannot be read (#6576)", async () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(createDeps({ readProcCgroup: () => null }));
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerSupervisorMatch).toBeNull();
    expect(evaluateGatewayAttachment(owner, probe)).toMatchObject({
      ok: false,
      code: "unknown_listener",
    });
  });

  it("fails closed when the listener PID changes during identity verification (#6576)", async () => {
    declareExternalSupervision();
    const getGatewayPortListenerRawScan = vi
      .fn()
      .mockReturnValueOnce({ pids: [SYSTEMD_GATEWAY_PID], complete: true })
      .mockReturnValueOnce({ pids: [4343], complete: true });
    const runtime = createGatewayHostRuntime(createDeps({ getGatewayPortListenerRawScan }));
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerPids).toEqual([4343]);
    expect(probe.listenerExecPath).toBeNull();
    expect(probe.listenerSupervisorMatch).toBeNull();
    expect(evaluateGatewayAttachment(owner, probe)).toMatchObject({
      ok: false,
      code: "unknown_listener",
    });
  });

  it("fails closed when a PID is reused while its identity is read (#6576)", async () => {
    declareExternalSupervision();
    const readProcStartTime = vi.fn().mockReturnValueOnce("710024").mockReturnValueOnce("710025");
    const runtime = createGatewayHostRuntime(createDeps({ readProcStartTime }));
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerExecPath).toBeNull();
    expect(probe.listenerSupervisorMatch).toBeNull();
    expect(evaluateGatewayAttachment(owner, probe)).toMatchObject({
      ok: false,
      code: "unknown_listener",
    });
  });

  it("fails closed when the listener PID is reused between identity and port confirmation (#6576)", async () => {
    declareExternalSupervision();
    const readProcStartTime = vi
      .fn()
      .mockReturnValueOnce("710024")
      .mockReturnValueOnce("710024")
      .mockReturnValueOnce("710025")
      .mockReturnValueOnce("710025");
    const runtime = createGatewayHostRuntime(createDeps({ readProcStartTime }));
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.listenerStartTime).toBeNull();
    expect(probe.listenerExecPath).toBeNull();
    expect(probe.listenerSupervisorMatch).toBeNull();
    expect(evaluateGatewayAttachment(owner, probe)).toMatchObject({
      ok: false,
      code: "unknown_listener",
    });
  });

  it("reports an unprobeable supervisor rather than guessing (#6576)", async () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(
      createDeps({
        spawnSyncImpl: (() => ({ error: new Error("spawn ETIMEDOUT"), status: null })) as never,
      }),
    );

    const probe = await runtime.probeGatewayAttachment(runtime.getGatewayOwner());

    expect(probe.supervisorActive).toBeNull();
    expect(evaluateGatewayAttachment(runtime.getGatewayOwner(), probe)).toMatchObject({
      ok: false,
      code: "supervisor_inactive",
    });
  });

  it("reads the authoritative gateway port lazily, not at construction (#6576)", () => {
    let port = 8080;
    const runtime = createGatewayHostRuntime(createDeps({ gatewayPort: () => port }));

    port = 9443;

    expect(runtime.getGatewayStartEnv()).toMatchObject({ OPENSHELL_SERVER_PORT: "9443" });
  });

  it("registers and selects the exact declared endpoint without prior gateway metadata (#6576)", async () => {
    declareExternalSupervision();
    process.env.OPENSHELL_GATEWAY = "ambient-sibling";
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(createDeps({ runOpenshell }));

    const owner = runtime.getGatewayOwner();
    const expectedProbe = await runtime.probeGatewayAttachment(owner);
    await runtime.attachGateway(owner, expectedProbe);

    expect(runOpenshell.mock.calls).toEqual([
      [
        ["gateway", "add", "http://127.0.0.1:8080", "--local", "--name", "nemoclaw"],
        { ignoreError: true, suppressOutput: true },
      ],
      [["gateway", "select", "nemoclaw"], { ignoreError: true, suppressOutput: true }],
    ]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw");
  });

  it("rejects changed authority before gateway registration (#6576)", async () => {
    process.env[GATEWAY_MANAGEMENT_ENV_VAR] = "/etc/nemoclaw/gateway-management.json";
    let declaration = DECLARATION;
    vi.spyOn(require("node:fs") as typeof import("node:fs"), "readFileSync").mockImplementation(
      () => JSON.stringify(declaration) as never,
    );
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(createDeps({ runOpenshell }));
    const owner = runtime.getGatewayOwner();
    const expectedProbe = await runtime.probeGatewayAttachment(owner);
    declaration = {
      ...DECLARATION,
      supervisor: {
        ...DECLARATION.supervisor,
        execPath: "/opt/platform/replacement-gatewayd",
      },
    };

    await expect(runtime.attachGateway(owner, expectedProbe)).rejects.toThrow(
      /authority changed during this run/,
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("replaces stale registration before selecting the declared endpoint (#6576)", async () => {
    declareExternalSupervision();
    const statuses = [1, 0, 0];
    const runOpenshell = vi.fn((_args: string[]) => ({ status: statuses.shift() ?? 0 }));
    const runtime = createGatewayHostRuntime(createDeps({ runOpenshell }));

    const owner = runtime.getGatewayOwner();
    const expectedProbe = await runtime.probeGatewayAttachment(owner);
    await runtime.attachGateway(owner, expectedProbe);

    expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["gateway", "add", "http://127.0.0.1:8080", "--local", "--name", "nemoclaw"],
      ["gateway", "remove", "nemoclaw"],
      ["gateway", "add", "http://127.0.0.1:8080", "--local", "--name", "nemoclaw"],
      ["gateway", "select", "nemoclaw"],
    ]);
  });

  it("removes the attempted registration when exact gateway selection is unhealthy (#6576)", async () => {
    declareExternalSupervision();
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(
      createDeps({ isGatewayHealthy: () => false, runOpenshell }),
    );

    const owner = runtime.getGatewayOwner();
    const expectedProbe = await runtime.probeGatewayAttachment(owner);

    await expect(runtime.attachGateway(owner, expectedProbe)).rejects.toThrow(
      /Failed to register and select/,
    );
    expect(runOpenshell).toHaveBeenLastCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(process.env.OPENSHELL_GATEWAY).toBeUndefined();
  });

  it("removes the registration when the listener changes during attachment (#6576)", async () => {
    declareExternalSupervision();
    const getGatewayPortListenerRawScan = vi
      .fn()
      .mockReturnValueOnce({ pids: [SYSTEMD_GATEWAY_PID], complete: true })
      .mockReturnValueOnce({ pids: [SYSTEMD_GATEWAY_PID], complete: true })
      .mockReturnValueOnce({ pids: [4343], complete: true })
      .mockReturnValueOnce({ pids: [4343], complete: true });
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(
      createDeps({ getGatewayPortListenerRawScan, runOpenshell }),
    );
    const owner = runtime.getGatewayOwner();
    const expectedProbe = await runtime.probeGatewayAttachment(owner);

    await expect(runtime.attachGateway(owner, expectedProbe)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(runOpenshell).toHaveBeenLastCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(process.env.OPENSHELL_GATEWAY).toBeUndefined();
  });

  it("removes the registration when the listener process generation changes (#6576)", async () => {
    declareExternalSupervision();
    const readProcStartTime = vi
      .fn()
      .mockReturnValueOnce("710024")
      .mockReturnValueOnce("710024")
      .mockReturnValueOnce("710024")
      .mockReturnValueOnce("710024")
      .mockReturnValueOnce("710025")
      .mockReturnValueOnce("710025")
      .mockReturnValueOnce("710025")
      .mockReturnValueOnce("710025");
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0 }));
    const runtime = createGatewayHostRuntime(createDeps({ readProcStartTime, runOpenshell }));
    const owner = runtime.getGatewayOwner();
    const expectedProbe = await runtime.probeGatewayAttachment(owner);

    await expect(runtime.attachGateway(owner, expectedProbe)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(runOpenshell).toHaveBeenLastCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(process.env.OPENSHELL_GATEWAY).toBeUndefined();
  });
});
