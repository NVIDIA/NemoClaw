// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const readiness = vi.hoisted(() => ({
  http: vi.fn(async () => false),
  https: vi.fn(async () => true),
}));

vi.mock("./gateway-http-readiness", () => ({
  isGatewayHttpReady: readiness.http,
  isDockerDriverGatewayHttpReady: readiness.https,
  waitForGatewayHttpReady: async (options: { probe?: () => Promise<boolean> } = {}) =>
    options.probe?.() ?? false,
}));

import { createGatewayHostRuntime, type GatewayHostRuntimeDeps } from "./gateway-host-runtime";
import { GATEWAY_MANAGEMENT_ENV_VAR } from "./gateway-management";
import type { PortProbeResult } from "./preflight";

const ORIGINAL_ENV = { ...process.env };
const STATE_DIR = "/var/lib/openshell/gateway";
const SERVICE_NAME = "openshell-gateway.service";
const EXEC_PATH = "/opt/platform/gatewayd";

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  readiness.http.mockClear();
  readiness.https.mockClear();
});

function createDeps(): GatewayHostRuntimeDeps {
  return {
    applyOverlayfsAutoFix: () => null,
    checkGatewayPortAvailable: async () => ({ ok: false }) as PortProbeResult,
    gatewayName: () => "nemoclaw",
    gatewayPort: () => 8080,
    getGatewayPortListenerRawScan: () => ({ pids: [4242], complete: true }),
    getInstalledOpenshellVersion: () => "0.0.90",
    isGatewayHealthy: () => true,
    readProcCgroup: () => `0::/system.slice/${SERVICE_NAME}\n`,
    readProcExe: () => EXEC_PATH,
    resolveOpenShellGatewayBinary: () => EXEC_PATH,
    runCaptureOpenshell: () => "healthy",
    runOpenshell: () => ({ status: 0 }),
    spawnSyncImpl: (() => ({ status: 0, stdout: "active\n", stderr: "" })) as never,
    waitForGatewayHttpReady: async () => false,
  };
}

function declareHttpsExternalSupervision() {
  process.env[GATEWAY_MANAGEMENT_ENV_VAR] = "/etc/nemoclaw/gateway-management.json";
  const declaration = JSON.stringify({
    version: 1,
    mode: "externally-supervised",
    endpoint: "https://127.0.0.1:8080",
    stateDir: STATE_DIR,
    supervisor: {
      kind: "systemd-system",
      serviceName: SERVICE_NAME,
      execPath: EXEC_PATH,
    },
    requiredCapabilities: ["gateway.health"],
  });
  vi.spyOn(fs, "readFileSync").mockReturnValue(declaration as never);
  vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as never);
  vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
}

describe("externally supervised HTTPS gateway readiness", () => {
  it("uses the production mTLS gRPC probe and the declared TLS bundle (#6576)", async () => {
    declareHttpsExternalSupervision();
    const runtime = createGatewayHostRuntime(createDeps());
    const owner = runtime.getGatewayOwner();

    const probe = await runtime.probeGatewayAttachment(owner);

    expect(probe.httpReady).toBe(true);
    expect(readiness.http).not.toHaveBeenCalled();
    expect(readiness.https).toHaveBeenCalledWith(
      undefined,
      "https://127.0.0.1:8080/openshell.v1.OpenShell/Health",
    );
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBe(`${STATE_DIR}/tls`);
    expect(fs.statSync).toHaveBeenCalledTimes(3);
    expect(fs.accessSync).toHaveBeenCalledTimes(3);
  });

  it("fails before probing when the declared client TLS bundle is unreadable (#6576)", async () => {
    declareHttpsExternalSupervision();
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error("EACCES");
    });
    const runtime = createGatewayHostRuntime(createDeps());

    await expect(runtime.probeGatewayAttachment(runtime.getGatewayOwner())).rejects.toThrow(
      /TLS file is missing or unreadable/,
    );
    expect(readiness.https).not.toHaveBeenCalled();
  });
});
