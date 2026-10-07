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
  const initialize = vi.fn(async () => {});
  const port = vi.fn(async () => ({ ok: true }));
  const managed = vi
    .spyOn(cutover, "runDockerDriverGatewayManagedFallback")
    .mockResolvedValue("managed");
  // The cutover owner is mocked; unexpected use of a live dependency fails the test.
  const deps = {
    initializeNativeProviderPolicy: initialize,
    gatewayName: () => "selected",
    gatewayPort: () => 8080,
    gatewayBinding: { resolveGatewayStateDirForPort: () => stateDir },
    getDockerDriverGatewayStateDir: () => stateDir,
    resolveOpenShellGatewayBinary: () => null,
    getDockerDriverGatewayEnv: () => ({}),
    runCaptureOpenshell: () => "",
    checkGatewayPortAvailable: port,
    createGatewayServicePortOwnership: () => ({}),
    runner: {},
  } as unknown as DockerDriverGatewayStartDeps;
  return {
    stateDir,
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
  it.each(["openshell.db", "openshell-gateway.toml", "runtime.json", "jwt"])(
    "does not activate composition when existing state contains %s (#12558)",
    async (file) => {
      const f = fixture();
      fs.writeFileSync(path.join(f.stateDir, file), "existing");
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
  it("does not return startup success when initialization cannot be verified (#12558)", async () => {
    const f = fixture();
    f.initialize.mockRejectedValue(new Error("settings unavailable"));
    await expect(f.start()).rejects.toThrow("settings unavailable");
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });
});
