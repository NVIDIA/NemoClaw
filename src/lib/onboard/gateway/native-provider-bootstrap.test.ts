// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDockerDriverGatewayStart,
  type DockerDriverGatewayStartDeps,
} from "./docker-driver-start";
import { buildDockerDriverGatewayEnv } from "../docker-driver-gateway-env";
import { flowDeps } from "../external-component/onboarding";
import * as cutover from "../docker-driver-gateway-cutover";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-gateway-"));
  roots.push(stateDir);
  vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", "");
  const initialize = vi.fn<() => Promise<"disabled" | void>>(async () => {});
  const port = vi.fn(async () => ({ ok: true }));
  const managed = vi
    .spyOn(cutover, "runDockerDriverGatewayManagedFallback")
    .mockResolvedValue("managed");
  // The cutover owner is mocked; unexpected use of a live dependency fails the test.
  const buildEnv = () =>
    buildDockerDriverGatewayEnv({
      platform: "linux",
      gatewayPort: 8080,
      stateDir,
      getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:test",
      resolveSandboxBin: () => null,
    });
  const getEnv = vi.fn(buildEnv);
  const gatewayName = vi.fn(() => "selected");
  const deps = {
    initializeNativeProviderPolicy: initialize,
    gatewayName,
    gatewayPort: () => 8080,
    gatewayBinding: { resolveGatewayStateDirForPort: () => stateDir },
    getDockerDriverGatewayStateDir: () => stateDir,
    resolveOpenShellGatewayBinary: () => null,
    getDockerDriverGatewayEnv: getEnv,
    runCaptureOpenshell: () => "",
    checkGatewayPortAvailable: port,
    createGatewayServicePortOwnership: () => ({}),
    runner: {},
  } as unknown as DockerDriverGatewayStartDeps;
  return {
    stateDir,
    getEnv,
    gatewayName,
    prepare: () =>
      flowDeps({ collectGatewayReadiness: async () => undefined }, buildEnv, (() => {
        throw new Error("unexpected sandbox inspection");
      }) as never).configureExternalComponentGateway(null),
    initialize,
    port,
    managed,
    start: createDockerDriverGatewayStart(deps).startDockerDriverGateway,
  };
}

describe("native policy initialization ownership", () => {
  it("initializes composition after the fresh gateway owner reports healthy (#12558)", async () => {
    const f = fixture();
    await f.start();
    expect(f.initialize).toHaveBeenCalledExactlyOnceWith("selected", expect.any(Function));
    expect(f.managed.mock.invocationCallOrder[0]).toBeLessThan(
      f.initialize.mock.invocationCallOrder[0],
    );
  });
  it("keeps creation authority through the real onboarding preparation (#12558)", async () => {
    const f = fixture();
    await f.prepare();
    expect(fs.existsSync(path.join(f.stateDir, "openshell-gateway.toml"))).toBe(true);
    await f.start();
    expect(f.initialize).toHaveBeenCalledExactlyOnceWith("selected", expect.any(Function));
  });
  it("does not reuse creation authority for a second startup (#12558)", async () => {
    const f = fixture();
    await f.prepare();
    await f.start();
    await f.start();
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });
  it("fails startup if prepared configuration changes during launch (#12558)", async () => {
    const f = fixture();
    f.managed.mockImplementation(async () => {
      fs.appendFileSync(path.join(f.stateDir, "openshell-gateway.toml"), "\n# changed");
      return "managed";
    });
    await expect(f.start()).rejects.toThrow("configuration changed");
    expect(f.initialize).not.toHaveBeenCalled();
  });
  it("does not activate another gateway selected during startup (#12558)", async () => {
    const f = fixture();
    f.managed.mockImplementation(async () => {
      f.gatewayName.mockReturnValue("sibling");
      return "managed";
    });
    await expect(f.start()).rejects.toThrow("configuration changed");
    expect(f.initialize).not.toHaveBeenCalled();
  });
  it.each(["openshell.db", "openshell-gateway.toml", "runtime.json", "jwt"])(
    "does not activate composition when existing state contains %s (#12558)",
    async (file) => {
      const f = fixture();
      fs.writeFileSync(path.join(f.stateDir, file), "existing");
      f.getEnv.mockImplementation(() => ({ OPENSHELL_GRPC_ENDPOINT: "http://127.0.0.1:8080" }));
      await f.start();
      expect(f.initialize).not.toHaveBeenCalled();
    },
  );
  it("does not activate a gateway reused from an occupied port (#12558)", async () => {
    const f = fixture();
    f.port.mockResolvedValue({ ok: false });
    await f.start();
    expect(f.initialize).not.toHaveBeenCalled();
  });
  it("does not activate composition on the reused cutover path (#12558)", async () => {
    const f = fixture();
    f.managed.mockResolvedValue("reused");
    await f.start();
    expect(f.initialize).not.toHaveBeenCalled();
  });
  it("allows healthy startup with a warning when composition is verified disabled (#12558)", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.initialize.mockResolvedValue("disabled");
    await expect(f.start()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });
  it("rejects changed creation authority before allowing disabled composition (#12558)", async () => {
    const f = fixture();
    await f.prepare();
    f.initialize.mockImplementation(async () => {
      fs.appendFileSync(path.join(f.stateDir, "openshell-gateway.toml"), "\n# changed");
      return "disabled";
    });
    await expect(f.start()).rejects.toThrow("configuration changed");
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });
  it("does not return startup success when initialization cannot be verified (#12558)", async () => {
    const f = fixture();
    f.initialize.mockRejectedValue(new Error("settings unavailable"));
    await expect(f.start()).rejects.toThrow("settings unavailable");
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });
});
