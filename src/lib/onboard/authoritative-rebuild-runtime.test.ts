// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthoritativeRebuildRuntimePreflight } from "./authoritative-rebuild-runtime";

const mocks = vi.hoisted(() => ({
  assertAuthConfigSafe: vi.fn(),
  buildRuntimeIdentity: vi.fn(),
  ensureLocalTlsBundle: vi.fn(),
  preflightResourceProfile: vi.fn(),
  resolveDriftGatewayBin: vi.fn(),
  runFatalRuntimePreflight: vi.fn(),
}));

vi.mock("./fatal-runtime-preflight", () => ({
  runFatalOnboardRuntimePreflight: mocks.runFatalRuntimePreflight,
}));
vi.mock("./resource-profile-selection", () => ({
  preflightAuthoritativeResourceProfile: mocks.preflightResourceProfile,
}));
vi.mock("./docker-driver-gateway-local-tls", () => ({
  ensureDockerDriverGatewayLocalTlsBundle: mocks.ensureLocalTlsBundle,
}));
vi.mock("./docker-driver-gateway-env", () => ({
  assertDockerDriverGatewayAuthConfigSafe: mocks.assertAuthConfigSafe,
}));
vi.mock("./docker-driver-gateway-launch", () => ({
  buildDockerDriverGatewayRuntimeIdentity: mocks.buildRuntimeIdentity,
  resolveDriftGatewayBin: mocks.resolveDriftGatewayBin,
}));

type RuntimeState = {
  dashboardPort: number | null;
  gatewayName: string;
  gatewayPort: number;
  nonInteractive: boolean;
};

const target = {
  authoritativeResumeConfig: true as const,
  model: "model-a",
  provider: "provider-a",
  sandboxName: "alpha",
  targetGatewayName: "nemoclaw-31818",
  targetGatewayPort: 31818,
  authoritativeResourceProfile: null,
};

function harness(
  isDockerDriverGatewayHttpReady = async () => true,
  previousLocalTlsDir: string | null = "/tmp/original-tls",
) {
  const previous: RuntimeState = {
    dashboardPort: 4444,
    gatewayName: "previous",
    gatewayPort: 31999,
    nonInteractive: false,
  };
  let state = { ...previous };
  const env = {
    OPENSHELL_GATEWAY: "original",
    ...(previousLocalTlsDir === null ? {} : { OPENSHELL_LOCAL_TLS_DIR: previousLocalTlsDir }),
  } as NodeJS.ProcessEnv;
  const getDockerDriverGatewayRuntimeDrift = vi.fn(() => null);
  const preflight = createAuthoritativeRebuildRuntimePreflight({
    getRuntimeState: () => ({ ...state }),
    setRuntimeState: (next) => {
      state = { ...next };
    },
    ensureOpenshell: vi.fn(),
    getOpenshellBinary: () => "/bin/openshell",
    runCaptureOpenshell: (args) => (args[0] === "--version" ? "openshell 0.0.72" : ""),
    isGatewayHttpReady: async () => true,
    isDockerDriverGatewayHttpReady,
    inferenceRouteReady: () => true,
    checkPort: async () => ({ ok: true }),
    resolveOpenShellGatewayBinary: () => "/bin/openshell-gateway",
    resolveOpenShellSandboxBinary: () => "/bin/openshell-sandbox",
    getDockerDriverGatewayStateDir: () => "/tmp/gateway-state",
    getDockerDriverGatewayEnv: () => ({ OPENSHELL_LOCAL_TLS_DIR: "/tmp/tls" }),
    getDockerDriverGatewayPid: () => 123,
    isDockerDriverGatewayProcessAlive: () => true,
    getDockerDriverGatewayRuntimeDrift,
    env,
  });
  return { env, getDockerDriverGatewayRuntimeDrift, preflight, previous, state: () => state };
}

describe("authoritative rebuild runtime preflight", () => {
  beforeEach(() => {
    mocks.runFatalRuntimePreflight.mockReturnValue({
      gpu: null,
      host: {},
      sandboxGpuConfig: {},
    });
    mocks.buildRuntimeIdentity.mockReturnValue({
      desiredEnv: { OPENSHELL_LOCAL_TLS_DIR: "/tmp/tls" },
      identityGatewayBin: "/bin/openshell-gateway",
    });
    mocks.resolveDriftGatewayBin.mockReturnValue(null);
  });

  it("preserves a null compat drift binary and restores scoped state (#6195)", async () => {
    const test = harness();

    await test.preflight(target);

    expect(test.getDockerDriverGatewayRuntimeDrift).toHaveBeenCalledWith(
      123,
      { OPENSHELL_LOCAL_TLS_DIR: "/tmp/tls" },
      null,
    );
    expect(test.state()).toEqual(test.previous);
    expect(test.env.OPENSHELL_GATEWAY).toBe("original");
    expect(test.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/tmp/tls");
  });

  it("restores gateway state after an awaited transport rejection (#6195)", async () => {
    const test = harness(async () => false);

    await expect(test.preflight(target)).rejects.toThrow(
      "Target gateway 'nemoclaw-31818' is not HTTPS/mTLS-ready.",
    );

    expect(test.state()).toEqual(test.previous);
    expect(test.env.OPENSHELL_GATEWAY).toBe("original");
    expect(test.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/tmp/original-tls");
  });

  it("removes target TLS state after rejection when the caller had none (#6195)", async () => {
    const test = harness(async () => false, null);

    await expect(test.preflight(target)).rejects.toThrow(
      "Target gateway 'nemoclaw-31818' is not HTTPS/mTLS-ready.",
    );

    expect(test.state()).toEqual(test.previous);
    expect(test.env.OPENSHELL_LOCAL_TLS_DIR).toBeUndefined();
  });
});
