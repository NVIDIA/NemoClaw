// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readDockerDriverGatewayBinding,
  resolveDockerDriverGatewayBinding,
  writeDockerDriverGatewayBinding,
} from "./state-dir";

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
    writeDockerDriverGatewayBinding(home, 28080, {
      stateDir: path.join(home, "other-gateway"),
      dockerNetworkName: "other-network",
    });
    expect(readDockerDriverGatewayBinding(home, 18080)).toEqual({
      stateDir,
      dockerNetworkName: "mvca-nemoclaw-b2",
    });
    expect(readDockerDriverGatewayBinding(home, 28080)?.dockerNetworkName).toBe("other-network");
    const file = path.join(home, ".local/state/nemoclaw/gateway-runtime-bindings/18080.json");
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

    const binding = resolveDockerDriverGatewayBinding(env, home, 18080);

    expect(binding.stateDir).toBe(path.join(home, "custom-gateway-18080"));
    expect(binding.dockerNetworkName).toBe("operator-selected-network");
    expect(env).toEqual({ OPENSHELL_DOCKER_NETWORK_NAME: "operator-selected-network" });
    env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = " ";
    expect(resolveDockerDriverGatewayBinding(env, home, 18080).stateDir).toBe(
      path.join(home, "custom-gateway-18080"),
    );
    expect(env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBe(" ");
  });

  it("ignores malformed or symlinked receipts instead of changing startup configuration", () => {
    const home = tempHome();
    const dir = path.join(home, ".local/state/nemoclaw/gateway-runtime-bindings");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const receipt = path.join(dir, "18080.json");
    const foreign = path.join(home, "foreign.json");
    fs.writeFileSync(
      foreign,
      JSON.stringify({ stateDir: "/tmp/foreign", dockerNetworkName: "foreign" }),
    );
    fs.symlinkSync(foreign, receipt);

    const env = {} as NodeJS.ProcessEnv;
    expect(readDockerDriverGatewayBinding(home, 18080)).toBeNull();
    expect(resolveDockerDriverGatewayBinding(env, home, 18080)).toEqual({
      stateDir: undefined,
      dockerNetworkName: undefined,
    });
    expect(env).toEqual({});
    fs.unlinkSync(receipt);
    fs.writeFileSync(receipt, JSON.stringify({ stateDir: home, dockerNetworkName: "foreign" }), {
      mode: 0o600,
    });
    expect(readDockerDriverGatewayBinding(home, 18080)).toBeNull();
    expect(resolveDockerDriverGatewayBinding(env, home, 18080)).toEqual({
      stateDir: undefined,
      dockerNetworkName: undefined,
    });
  });
});
