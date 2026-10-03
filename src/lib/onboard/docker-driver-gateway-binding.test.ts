// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readDockerDriverGatewayBinding,
  restoreDockerDriverGatewayBinding,
  writeDockerDriverGatewayBinding,
} from "./docker-driver-gateway-binding";

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-binding-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("Docker-driver gateway binding persistence", () => {
  it("round-trips a custom state directory and Docker network by gateway port", () => {
    const home = tempHome();
    const stateDir = path.join(home, "custom-gateway-18080");
    writeDockerDriverGatewayBinding(home, 18080, {
      stateDir,
      dockerNetworkName: "mvca-nemoclaw-b2",
    });

    expect(readDockerDriverGatewayBinding(home, 18080)).toEqual({
      stateDir,
      dockerNetworkName: "mvca-nemoclaw-b2",
    });
    const file = path.join(home, ".local/state/nemoclaw/gateway-runtime-bindings.json");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("restores only missing environment values and preserves explicit overrides", () => {
    const home = tempHome();
    writeDockerDriverGatewayBinding(home, 18080, {
      stateDir: path.join(home, "custom-gateway-18080"),
      dockerNetworkName: "mvca-nemoclaw-b2",
    });
    const env = {
      OPENSHELL_DOCKER_NETWORK_NAME: "operator-selected-network",
    } as NodeJS.ProcessEnv;

    restoreDockerDriverGatewayBinding(env, home, 18080);

    expect(env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBe(
      path.join(home, "custom-gateway-18080"),
    );
    expect(env.OPENSHELL_DOCKER_NETWORK_NAME).toBe("operator-selected-network");
  });

  it("ignores malformed or symlinked receipts instead of changing startup configuration", () => {
    const home = tempHome();
    const dir = path.join(home, ".local/state/nemoclaw");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const receipt = path.join(dir, "gateway-runtime-bindings.json");
    const foreign = path.join(home, "foreign.json");
    fs.writeFileSync(foreign, JSON.stringify({ "18080": { stateDir: "/tmp/foreign", dockerNetworkName: "foreign" } }));
    fs.symlinkSync(foreign, receipt);

    const env = {} as NodeJS.ProcessEnv;
    expect(restoreDockerDriverGatewayBinding(env, home, 18080)).toBeNull();
    expect(env).toEqual({});
  });
});
