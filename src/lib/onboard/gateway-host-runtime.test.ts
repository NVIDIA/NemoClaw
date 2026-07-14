// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayHostRuntime, type GatewayHostRuntimeDeps } from "./gateway-host-runtime";
import { GATEWAY_MANAGEMENT_ENV_VAR } from "./gateway-management";
import { evaluateGatewayAttachment } from "./gateway-ownership";
import type { PortProbeResult } from "./preflight";

const SYSTEMD_GATEWAY_EXEC = "/usr/local/bin/openshell-gateway";
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
    gatewayPort: () => 8080,
    // A systemd-supervised gateway is an ordinary executable: the Docker-driver
    // filtered scan would return no pids at all, which is why the probe must use
    // the raw enumeration.
    getGatewayPortListenerRawScan: () => ({ pids: [SYSTEMD_GATEWAY_PID], complete: true }),
    getInstalledOpenshellVersion: () => "0.0.72",
    resolveOpenShellGatewayBinary: () => SYSTEMD_GATEWAY_EXEC,
    spawnSyncImpl: (() => ({ status: 0, stdout: "active\n", stderr: "" })) as never,
    probeGatewayHttpReady: async () => true,
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

  it("fails closed on a malformed declaration rather than self-managing (#6576)", () => {
    declareExternalSupervision({ ...DECLARATION, version: 99 });

    expect(() => createGatewayHostRuntime(createDeps()).getGatewayOwner()).toThrow(
      /Invalid gateway management declaration/,
    );
  });

  it("re-resolves the owner per call, so an installed packaged service is seen (#6576)", () => {
    const runtime = createGatewayHostRuntime(createDeps());

    expect(runtime.getGatewayOwner()).toMatchObject({ mode: "nemoclaw-managed" });

    declareExternalSupervision();

    expect(runtime.getGatewayOwner()).toMatchObject({ mode: "externally-supervised" });
  });
});

describe("gateway host runtime attachment probe", () => {
  it("attaches to a real systemd-supervised gateway listener (#6576)", async () => {
    declareExternalSupervision();
    const runtime = createGatewayHostRuntime(createDeps());
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    // The declared systemd process carries no Docker-driver markers, so it must
    // still be enumerated and matched by its declared executable.
    expect(probe).toMatchObject({
      gatewayPort: 8080,
      httpReady: true,
      portOccupied: true,
      listenerPids: [SYSTEMD_GATEWAY_PID],
      listenerScanComplete: true,
      supervisorActive: true,
    });
    expect(
      evaluateGatewayAttachment(owner, { ...probe, listenerExecPath: SYSTEMD_GATEWAY_EXEC }),
    ).toMatchObject({ ok: true });
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
  });

  it("reads the authoritative gateway port lazily, not at construction (#6576)", () => {
    let port = 8080;
    const runtime = createGatewayHostRuntime(createDeps({ gatewayPort: () => port }));

    port = 9443;

    expect(runtime.getGatewayStartEnv()).toMatchObject({ OPENSHELL_SERVER_PORT: "9443" });
  });
});
